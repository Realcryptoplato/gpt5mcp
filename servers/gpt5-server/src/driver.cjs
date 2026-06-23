#!/usr/bin/env node
/*
 * Codex app-server session driver (CommonJS, no build step).
 *
 * Owns one `codex app-server` child over stdio, drives the JSON-RPC protocol:
 *   initialize -> thread/start -> turn/start, then watches <dir>/control.jsonl
 *   for { cmd: "steer", text } / { cmd: "interrupt" } and issues turn/steer /
 *   turn/interrupt against the active turn.
 *
 * Streams app-server notifications (assistant deltas, turn lifecycle) into
 * <dir>/events.jsonl and keeps <dir>/meta.json current with {state, threadId,
 * turnId}. Exits when the turn completes (or on interrupt+completion).
 *
 * Args: --dir <sessionDir> --cwd <cwd> --model <model> [--effort <level>]
 * The initial prompt is passed via env CODEX_SESSION_PROMPT.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const DIR = arg('--dir');
const CWD = arg('--cwd', process.cwd());
const MODEL = arg('--model', 'gpt-5.5');
const EFFORT = arg('--effort', null);
const SANDBOX = arg('--sandbox', 'danger-full-access'); // danger-full-access | workspace-write | read-only
const PROMPT = process.env.CODEX_SESSION_PROMPT || '';

function sandboxPolicy() {
  if (SANDBOX === 'read-only') return { type: 'readOnly', networkAccess: false };
  if (SANDBOX === 'workspace-write') return { type: 'workspaceWrite' };
  return { type: 'dangerFullAccess' };
}

const metaPath = path.join(DIR, 'meta.json');
const controlPath = path.join(DIR, 'control.jsonl');
const eventsPath = path.join(DIR, 'events.jsonl');

function readMeta() { try { return JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { return {}; } }
function writeMeta(patch) {
  const m = Object.assign(readMeta(), patch);
  fs.writeFileSync(metaPath, JSON.stringify(m, null, 2));
  return m;
}
function logEvent(obj) {
  try { fs.appendFileSync(eventsPath, JSON.stringify(obj) + '\n'); } catch (_) {}
}

// ---- app-server child + JSON-RPC plumbing -------------------------------
// Capture stderr (don't just inherit) so we can surface WHY a job failed
// (config errors, codex crashes, bad cwd) into the job's error field.
let stderrTail = '';
function appendStderr(s) {
  stderrTail = (stderrTail + s).slice(-4000); // keep the last ~4KB
}
const child = spawn('codex', ['app-server'], {
  cwd: CWD, stdio: ['pipe', 'pipe', 'pipe'], env: process.env,
});
child.stderr.on('data', (d) => { const s = d.toString(); appendStderr(s); try { fs.appendFileSync(path.join(DIR, 'driver.log'), s); } catch (_) {} });
let childExited = null;
child.on('exit', (code, sig) => { childExited = { code, sig }; });
child.on('error', (e) => { appendStderr(`\n[spawn error] ${e.message}\n`); });

let nextId = 1;
const pending = new Map(); // id -> {resolve, timer}
// send() now rejects on timeout so a dead/unresponsive app-server surfaces an
// error instead of hanging silently.
function send(method, params, timeoutMs = 60000) {
  const id = nextId++;
  const msg = { id, method, params: params || {} };
  try { child.stdin.write(JSON.stringify(msg) + '\n'); }
  catch (e) { return Promise.reject(new Error(`write to app-server failed: ${e.message}`)); }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      const hint = childExited ? ` (app-server exited code=${childExited.code})` : '';
      reject(new Error(`${method} timed out after ${timeoutMs}ms${hint}. stderr tail:\n${stderrTail.trim().slice(-800)}`));
    }, timeoutMs);
    pending.set(id, { resolve, timer });
  });
}

let threadId = null;
let turnId = null;
let turnActive = false;
let turnFailure = null;

// line-buffered stdout parse
let buf = '';
child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.id !== undefined && (d.result !== undefined || d.error !== undefined)) {
      const p = pending.get(d.id); pending.delete(d.id);
      if (p) { clearTimeout(p.timer); p.resolve(d); }
    } else if (d.method) {
      handleNotification(d);
    }
  }
});

let finalMessage = '';
function pluckText(p) {
  if (!p || typeof p !== 'object') return undefined;
  if (typeof p.delta === 'string') return p.delta;
  if (typeof p.text === 'string') return p.text;
  if (typeof p.message === 'string') return p.message;
  // item/completed carries an item with content
  const item = p.item || p;
  if (item && typeof item.text === 'string') return item.text;
  if (item && Array.isArray(item.content)) {
    return item.content.map((c) => (c && (c.text || c.delta)) || '').join('');
  }
  return undefined;
}

function handleNotification(d) {
  const m = d.method;
  // Record the interesting ones into events.jsonl (skip noisy startup spam).
  if (/mcpServer\/startupStatus|remoteControl\//.test(m)) return;
  const p = d.params || {};
  if (m === 'turn/started') { turnActive = true; }
  if (m === 'turn/completed' || m === 'turn/failed' || m === 'turn/aborted') {
    turnActive = false;
    if (m === 'turn/failed' || m === 'turn/aborted') {
      // capture WHY the turn failed so codex_result isn't empty
      const reason = (p && (p.error || p.reason || p.message)) || pluckText(p) || m;
      turnFailure = typeof reason === 'string' ? reason : JSON.stringify(reason);
    }
  }
  // Track the latest assistant message as the running "final message".
  const text = pluckText(p);
  if ((m === 'item/completed' || /agentMessage/.test(m)) && text) {
    finalMessage = text;
    try { fs.writeFileSync(path.join(DIR, 'last-message.txt'), finalMessage); } catch (_) {}
  }
  logEvent({ t: Date.now(), method: m, text: text ? text.slice(0, 500) : undefined });
}

// ---- control file watcher (steer / interrupt) ---------------------------
let controlOffset = 0;
function pollControl() {
  let data = '';
  try { data = fs.readFileSync(controlPath, 'utf8'); } catch { return; }
  if (data.length <= controlOffset) return;
  const fresh = data.slice(controlOffset);
  controlOffset = data.length;
  for (const line of fresh.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let cmd; try { cmd = JSON.parse(s); } catch { continue; }
    if (cmd.cmd === 'steer' && threadId && turnId) {
      logEvent({ t: Date.now(), method: 'client/steer', text: cmd.text });
      send('turn/steer', {
        threadId, expectedTurnId: turnId,
        input: [{ type: 'text', text: cmd.text }],
      }).then((r) => {
        if (r && r.error) logEvent({ t: Date.now(), method: 'client/steer/error', text: JSON.stringify(r.error) });
      });
    } else if (cmd.cmd === 'interrupt' && threadId) {
      logEvent({ t: Date.now(), method: 'client/interrupt' });
      send('turn/interrupt', { threadId, turnId }).catch(() => {});
    }
  }
}
const controlTimer = setInterval(pollControl, 700);

// ---- main flow ----------------------------------------------------------
function rpcError(label, d) {
  // d is a JSON-RPC response; if it carries an error, throw with detail + stderr.
  if (d && d.error) {
    const msg = typeof d.error === 'object' ? (d.error.message || JSON.stringify(d.error)) : String(d.error);
    throw new Error(`${label} error: ${msg}${stderrTail ? `\nstderr tail:\n${stderrTail.trim().slice(-800)}` : ''}`);
  }
  return d;
}

(async () => {
  try {
    rpcError('initialize', await send('initialize', { clientInfo: { name: 'gpt5-server-driver', version: '1.0' } }, 30000));
    const ts = rpcError('thread/start', await send('thread/start', { cwd: CWD }, 30000));
    threadId = ts.result && ts.result.thread && ts.result.thread.id;
    if (!threadId) {
      throw new Error(`thread/start returned no thread id (cwd=${CWD} may be invalid)`
        + `${stderrTail ? `\nstderr tail:\n${stderrTail.trim().slice(-800)}` : ''}`);
    }
    writeMeta({ threadId, state: 'running' });

    const turnParams = {
      threadId,
      input: [{ type: 'text', text: PROMPT }],
      sandboxPolicy: sandboxPolicy(),
      approvalPolicy: 'never',
    };
    if (EFFORT) turnParams.effort = EFFORT;
    const turn = rpcError('turn/start', await send('turn/start', turnParams, 30000));
    turnId = turn.result && (turn.result.turnId || turn.result.turn && turn.result.turn.id);
    turnActive = true;
    writeMeta({ turnId, state: 'running' });

    // Wait for the turn to finish (turnActive flipped by notifications). Bail if
    // the app-server dies so we don't hang.
    await new Promise((resolve) => {
      const iv = setInterval(() => {
        if (!turnActive || childExited) { clearInterval(iv); resolve(); }
      }, 800);
    });

    if (turnFailure) {
      writeMeta({ state: 'failed', error: `turn failed: ${turnFailure}`, endedAt: new Date().toISOString() });
      logEvent({ t: Date.now(), method: 'driver/turn-failed', text: turnFailure });
    } else if (childExited && !finalMessage) {
      writeMeta({ state: 'failed', error: `app-server exited (code=${childExited.code}) before turn completed.`
        + `${stderrTail ? `\nstderr tail:\n${stderrTail.trim().slice(-800)}` : ''}`, endedAt: new Date().toISOString() });
    } else {
      writeMeta({ state: 'completed', endedAt: new Date().toISOString() });
    }
  } catch (e) {
    writeMeta({ state: 'failed', error: String(e && e.message || e), endedAt: new Date().toISOString() });
    logEvent({ t: Date.now(), method: 'driver/error', text: String(e && e.message || e) });
  } finally {
    clearInterval(controlTimer);
    try { child.stdin.end(); } catch (_) {}
    setTimeout(() => { try { child.kill(); } catch (_) {} process.exit(0); }, 500);
  }
})();
