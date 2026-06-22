// Steerable Codex jobs via the app-server protocol (thread/start -> turn/start
// -> turn/steer / turn/interrupt). Unlike codex exec (one-shot, no steering),
// the app-server keeps a long-lived thread we can inject guidance into mid-run.
//
// Design: each steerable job runs its own DETACHED `codex app-server` process,
// driven through a tiny persistent Node "driver" that owns the stdio pipe and
// exposes a control FIFO + a notifications log. The MCP tools talk to the driver
// (not the app-server directly) so they stay non-blocking and the session
// survives across MCP calls / a server restart.
//
//   ~/.gpt5mcp/codex-sessions/<job_id>/
//     meta.json       { id, threadId, turnId, cwd, model, state, startedAt, ... }
//     control.jsonl   commands appended by MCP tools (steer/interrupt)
//     events.jsonl    notifications streamed from the app-server (assistant
//                     deltas, turn started/completed, etc.) — the "what's going on"
//     driver.log      driver stderr
//
// The driver (driver.cjs, written next to this at build time) is spawned detached.

import { spawn } from 'child_process';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync,
  openSync,
} from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const SESS_ROOT = join(homedir(), '.gpt5mcp', 'codex-sessions');
const __dirname = dirname(fileURLToPath(import.meta.url));
// driver.cjs ships alongside the built index.js in build/
const DRIVER = join(__dirname, 'driver.cjs');

export type SessState = 'starting' | 'running' | 'completed' | 'failed';

export interface SessMeta {
  id: string;
  threadId?: string;
  turnId?: string;
  cwd: string;
  model: string;
  state: SessState;
  startedAt: string;
  endedAt?: string;
  label?: string;
  pid?: number;
  error?: string;
}

function sessDir(id: string) { return join(SESS_ROOT, id); }
function metaPath(id: string) { return join(sessDir(id), 'meta.json'); }
function controlPath(id: string) { return join(sessDir(id), 'control.jsonl'); }
function eventsPath(id: string) { return join(sessDir(id), 'events.jsonl'); }

function readMeta(id: string): SessMeta | null {
  try { return JSON.parse(readFileSync(metaPath(id), 'utf8')); } catch { return null; }
}

let sessCounter = 0;
function newId(): string {
  const t = process.hrtime.bigint().toString(36);
  sessCounter = (sessCounter + 1) % 100000;
  return `cs_${t}_${sessCounter.toString(36)}`;
}

export interface StartOpts {
  prompt: string;
  cwd?: string;
  model?: string;
  label?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh';
}

/** Spawn a detached steerable session; returns immediately (state: starting). */
export function startSession(opts: StartOpts): SessMeta {
  const id = newId();
  const dir = sessDir(id);
  mkdirSync(dir, { recursive: true });
  const cwd = opts.cwd || process.cwd();
  const model = opts.model || 'gpt-5.5';
  const meta: SessMeta = {
    id, cwd, model, state: 'starting',
    startedAt: new Date().toISOString(), label: opts.label,
  };
  writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
  writeFileSync(controlPath(id), '');
  writeFileSync(eventsPath(id), '');

  const log = openSync(join(dir, 'driver.log'), 'a');
  const child = spawn(process.execPath, [
    DRIVER,
    '--dir', dir,
    '--cwd', cwd,
    '--model', model,
    ...(opts.effort ? ['--effort', opts.effort] : []),
  ], {
    cwd,
    detached: true,
    stdio: ['ignore', log, log],
    env: { ...process.env, CODEX_SESSION_PROMPT: opts.prompt },
  });
  meta.pid = child.pid;
  writeFileSync(metaPath(id), JSON.stringify(meta, null, 2));
  child.unref();
  return meta;
}

/** Append a steer command for the driver to inject via turn/steer. */
export function steerSession(id: string, text: string): { ok: boolean; note: string } {
  const m = readMeta(id);
  if (!m) return { ok: false, note: `unknown session ${id}` };
  if (m.state === 'completed' || m.state === 'failed') {
    return { ok: false, note: `session ${id} is ${m.state}; nothing to steer` };
  }
  appendFileSync(controlPath(id), JSON.stringify({ cmd: 'steer', text }) + '\n');
  return { ok: true, note: `steer queued for ${id}; the driver injects it into the active turn` };
}

/** Append an interrupt command for the driver to send via turn/interrupt. */
export function interruptSession(id: string): { ok: boolean; note: string } {
  const m = readMeta(id);
  if (!m) return { ok: false, note: `unknown session ${id}` };
  appendFileSync(controlPath(id), JSON.stringify({ cmd: 'interrupt' }) + '\n');
  return { ok: true, note: `interrupt queued for ${id}` };
}

export function getSession(id: string): SessMeta | null {
  const m = readMeta(id);
  if (!m) return null;
  if ((m.state === 'starting' || m.state === 'running') && m.pid && !pidAlive(m.pid)) {
    m.state = 'failed';
    m.endedAt = m.endedAt || new Date().toISOString();
    writeFileSync(metaPath(id), JSON.stringify(m, null, 2));
  }
  return m;
}

export function listSessions(): SessMeta[] {
  if (!existsSync(SESS_ROOT)) return [];
  return readdirSync(SESS_ROOT)
    .map((id) => getSession(id))
    .filter((m): m is SessMeta => m !== null)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

/** Recent streamed events (assistant text, turn lifecycle) — the "what's going on". */
export function sessionEvents(id: string, maxLines = 40): any[] {
  try {
    const lines = readFileSync(eventsPath(id), 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-maxLines).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  } catch { return []; }
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
