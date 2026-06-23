// Steerable Codex jobs via the app-server protocol (thread/start -> turn/start
// -> turn/steer / turn/interrupt), runnable LOCALLY or on a REMOTE host (e.g. the
// Mac Mini over Tailscale).
//
// Each job runs a detached `driver.cjs` that owns a `codex app-server` thread.
// For a remote target the driver + codex run ON THE REMOTE, so the job keeps
// going after the laptop closes / Claude quits. All job state lives in a job dir
// (local or remote); the MCP tools reach it through a Target (fs locally, ssh
// remotely), so codex_status/steer/result reconnect any time from any session.
//
//   <root>/codex-sessions/<job_id>/   (<root> = ~/.gpt5mcp on whichever host runs it)
//     meta.json, control.jsonl, events.jsonl, last-message.txt, driver.log
//
// Locally we ALSO keep a tiny stub dir so we can find a remote job and know its
// host: ~/.gpt5mcp/codex-sessions/<job_id>/target.json = { host, remoteDir }.

import { spawn } from 'child_process';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, appendFileSync,
  openSync,
} from 'fs';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  Target, resolveTarget, targetExec, targetReadFile, targetAppend, targetPidAlive, targetTry,
  sanitizeCodexConfig,
} from './targets.js';

const LOCAL_ROOT = join(homedir(), '.gpt5mcp', 'codex-sessions');
const __dirname = dirname(fileURLToPath(import.meta.url));
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
  target?: string;   // target name (local | mini | user@host)
  host?: string;     // ssh host if remote
  repo?: string;
  branch?: string;
  configNote?: string;  // set if the codex config was auto-sanitized before launch
}

// --- local stub: how we locate a job + its host ---------------------------
function localStubDir(id: string) { return join(LOCAL_ROOT, id); }
interface Stub { host: string | null; remoteDir: string | null; }
function readStub(id: string): Stub {
  try { return JSON.parse(readFileSync(join(localStubDir(id), 'target.json'), 'utf8')); }
  catch { return { host: null, remoteDir: null }; }
}

/** The job dir path ON its host, and a Target to reach it. */
function jobLocation(id: string): { target: Target; dir: string } {
  const stub = readStub(id);
  if (stub.host && stub.remoteDir) {
    return { target: { name: stub.host, type: 'ssh', host: stub.host }, dir: stub.remoteDir };
  }
  return { target: { name: 'local', type: 'local' }, dir: localStubDir(id) };
}

function fileIn(dir: string, name: string) { return `${dir}/${name}`; }

function readMeta(id: string): SessMeta | null {
  const { target, dir } = jobLocation(id);
  const raw = target.type === 'local'
    ? (existsSync(fileIn(dir, 'meta.json')) ? readFileSync(fileIn(dir, 'meta.json'), 'utf8') : '')
    : targetReadFile(target, fileIn(dir, 'meta.json'));
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
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
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  target?: string;   // local | mini | user@host
  repo?: string;     // GitHub slug owner/name (remote: how to get the code)
  branch?: string;   // branch to work on (default main)
  requireCodexMatch?: boolean;  // remote: require local/remote codex major.minor match (default true)
}

/** Parse "codex-cli 0.142.0" -> "0.142.0". */
function parseCodexVersion(s: string): string | null {
  const m = s.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

/** The local codex version (or null if not found). */
function localCodexVersion(): string | null {
  try {
    const { execFileSync } = require('child_process');
    return parseCodexVersion(execFileSync('codex', ['--version'], { encoding: 'utf8', timeout: 8000 }));
  } catch { return null; }
}

/** Compare two semver-ish strings by major.minor only (patch is fine to differ). */
function majorMinorMatch(a: string, b: string): boolean {
  const pa = a.split('.'), pb = b.split('.');
  return pa[0] === pb[0] && pa[1] === pb[1];
}

export class DispatchPreflightError extends Error {}

/** Verify the remote host can run a compatible codex BEFORE we set up a job.
 *  Throws DispatchPreflightError with an actionable message on failure. */
function preflightRemoteCodex(target: Target, requireMatch: boolean): void {
  // codex present?
  const which = targetTry(target, 'command -v codex');
  if (!which.ok || !which.out.trim()) {
    throw new DispatchPreflightError(
      `Remote ${target.host} has no \`codex\` on PATH. Install it there ` +
      `(npm install -g @openai/codex) and \`codex login\`, then retry.`);
  }
  const remoteVerRaw = targetTry(target, 'codex --version').out;
  const remoteVer = parseCodexVersion(remoteVerRaw);
  if (!remoteVer) {
    throw new DispatchPreflightError(
      `Could not read remote codex version on ${target.host} (got: ${remoteVerRaw.trim().slice(0, 80)}).`);
  }
  if (requireMatch) {
    const localVer = localCodexVersion();
    if (localVer && !majorMinorMatch(localVer, remoteVer)) {
      throw new DispatchPreflightError(
        `Codex version skew: local ${localVer} vs ${target.host} ${remoteVer}. ` +
        `Update the remote: \`ssh ${target.host} 'npm install -g @openai/codex'\` ` +
        `(or pass require_codex_match=false to dispatch anyway).`);
    }
  }
}

/** Build the git/setup prelude prepended to a remote job's prompt so Codex
 *  bootstraps its own workdir (clone if missing, else fetch+checkout+pull),
 *  and is instructed to push a job branch + open a PR when done. */
function remotePrelude(repo: string | undefined, branch: string, jobBranch: string, workRoot: string): string {
  if (!repo) {
    return `You are running on a remote worker. Work under ${workRoot}. `
      + `If a specific repo is needed, the task below will say how to obtain it.\n\n`;
  }
  const name = repo.split('/').pop();
  return [
    `You are running on a REMOTE worker host. Follow this setup EXACTLY before the task:`,
    `1. mkdir -p ${workRoot} && cd ${workRoot}`,
    `2. If the directory "${name}" exists: cd ${name} && git fetch origin && git checkout ${branch} && git pull --ff-only`,
    `   else: gh repo clone ${repo} ${name} && cd ${name} && git checkout ${branch}`,
    `3. Create a working branch: git checkout -b ${jobBranch}`,
    `Then perform the task below in that repo.`,
    `WHEN DONE: commit your work, push the branch (git push -u origin ${jobBranch}),`,
    `and open a PR with: gh pr create --fill --head ${jobBranch}. Print the PR URL.`,
    ``,
    `=== TASK ===`,
    ``,
  ].join('\n');
}

/** Start a detached steerable session (local or remote). Returns immediately. */
export function startSession(opts: StartOpts): SessMeta {
  const id = newId();
  const target = resolveTarget(opts.target);
  const model = opts.model || 'gpt-5.5';
  const branch = opts.branch || 'main';
  const startedAt = new Date().toISOString();

  // local stub always exists (for discovery)
  const stubDir = localStubDir(id);
  mkdirSync(stubDir, { recursive: true });

  if (target.type === 'local') {
    const dir = stubDir;
    const cwd = opts.cwd || process.cwd();
    // Self-heal a config the Codex app may have rewritten with invalid fields.
    const san = sanitizeCodexConfig(target);
    const meta: SessMeta = {
      id, cwd, model, state: 'starting', startedAt, label: opts.label, target: 'local',
      ...(san.changed ? { configNote: san.report } : {}),
    };
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    writeFileSync(join(dir, 'control.jsonl'), '');
    writeFileSync(join(dir, 'events.jsonl'), '');
    writeFileSync(join(dir, 'target.json'), JSON.stringify({ host: null, remoteDir: null }));
    const log = openSync(join(dir, 'driver.log'), 'a');
    const child = spawn(process.execPath, [
      DRIVER, '--dir', dir, '--cwd', cwd, '--model', model,
      '--sandbox', opts.sandbox || 'danger-full-access',
      ...(opts.effort ? ['--effort', opts.effort] : []),
    ], { cwd, detached: true, stdio: ['ignore', log, log], env: { ...process.env, CODEX_SESSION_PROMPT: opts.prompt } });
    meta.pid = child.pid;
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    child.unref();
    return meta;
  }

  // --- remote (ssh) ---
  const host = target.host!;
  // PREFLIGHT: never dispatch to a missing / version-skewed codex. Throws
  // DispatchPreflightError with an actionable message (caller surfaces it).
  preflightRemoteCodex(target, opts.requireCodexMatch !== false);
  // Self-heal the remote codex config (the Codex app may have written invalid
  // fields that would break every job on that host).
  const remoteSan = sanitizeCodexConfig(target);
  if (!remoteSan.ok) {
    throw new DispatchPreflightError(
      `Remote ${host} codex config is invalid and could not be auto-fixed: ${remoteSan.report}`);
  }
  // Resolve absolute paths ON THE REMOTE once, so $HOME/~ never leak into
  // single-quoted contexts where they wouldn't expand.
  const remoteHome = targetExec(target, 'echo "$HOME"').trim();
  const workRootRaw = target.workRoot || '~/dev';
  const workRoot = workRootRaw.replace(/^~(?=\/|$)/, remoteHome);
  const remoteDir = `${remoteHome}/.gpt5mcp/codex-sessions/${id}`;
  const jobBranch = `codex/${id}`;
  const fullPrompt = remotePrelude(opts.repo, branch, jobBranch, workRoot) + opts.prompt;
  const cwd = opts.repo ? `${workRoot}/${opts.repo.split('/').pop()}` : workRoot;

  const meta: SessMeta = {
    id, cwd, model, state: 'starting', startedAt, label: opts.label,
    target: opts.target, host, repo: opts.repo, branch,
    ...(remoteSan.changed ? { configNote: remoteSan.report } : {}),
  };

  // 1) make the remote job dir, write meta + prompt + empty channels
  const mkRemote = `mkdir -p ${remoteDir} && cd ${remoteDir}`;
  targetExec(target, mkRemote);
  // write meta.json
  writeRemoteFile(target, `${remoteDir}/meta.json`, JSON.stringify(meta, null, 2));
  writeRemoteFile(target, `${remoteDir}/control.jsonl`, '');
  writeRemoteFile(target, `${remoteDir}/events.jsonl`, '');
  writeRemoteFile(target, `${remoteDir}/prompt.txt`, fullPrompt);

  // 2) copy the driver.cjs to the remote (small file)
  const driverSrc = readFileSync(DRIVER, 'utf8');
  writeRemoteFile(target, `${remoteDir}/driver.cjs`, driverSrc);

  // 3) launch the driver DETACHED on the remote (survives ssh disconnect).
  //    Resolve node + codex on the remote and prepend their dirs to PATH (a
  //    non-login nohup shell may lack /opt/homebrew/bin). nohup outlives the
  //    ssh session; prompt comes via env from the file.
  const nodeBin = targetTry(target, 'command -v node').out.trim() || 'node';
  const codexBin = targetTry(target, 'command -v codex').out.trim() || 'codex';
  const binDirs = Array.from(new Set([nodeBin, codexBin].map((p) => p.replace(/\/[^/]+$/, '')))).join(':');
  const launch =
    `cd ${remoteDir} && export PATH="${binDirs}:$PATH" && ` +
    `CODEX_SESSION_PROMPT="$(cat ${remoteDir}/prompt.txt)" ` +
    `nohup '${nodeBin}' ${remoteDir}/driver.cjs --dir ${remoteDir} --cwd '${cwd}' ` +
    `--model ${model} --sandbox ${opts.sandbox || 'danger-full-access'} ` +
    (opts.effort ? `--effort ${opts.effort} ` : '') +
    `>> ${remoteDir}/driver.log 2>&1 & echo $!`;
  const pidOut = targetExec(target, launch).trim();
  const pid = parseInt(pidOut.split('\n').pop() || '', 10);
  meta.pid = Number.isFinite(pid) ? pid : undefined;
  writeRemoteFile(target, `${remoteDir}/meta.json`, JSON.stringify(meta, null, 2));

  // 4) local stub points at the remote (absolute remote path)
  writeFileSync(join(stubDir, 'target.json'), JSON.stringify({ host, remoteDir }));
  writeFileSync(join(stubDir, 'meta-hint.json'), JSON.stringify(meta, null, 2));
  return meta;
}

function writeRemoteFile(t: Target, path: string, content: string): void {
  // base64 to survive quoting/newlines
  const b64 = Buffer.from(content, 'utf8').toString('base64');
  targetExec(t, `printf '%s' '${b64}' | base64 -d > '${path}'`);
}

export function steerSession(id: string, text: string): { ok: boolean; note: string } {
  const m = readMeta(id);
  if (!m) return { ok: false, note: `unknown job ${id}` };
  if (m.state === 'completed' || m.state === 'failed') {
    return { ok: false, note: `job ${id} is ${m.state}; nothing to steer` };
  }
  const { target, dir } = jobLocation(id);
  const line = JSON.stringify({ cmd: 'steer', text });
  if (target.type === 'local') appendFileSync(fileIn(dir, 'control.jsonl'), line + '\n');
  else targetAppend(target, fileIn(dir, 'control.jsonl'), line);
  return { ok: true, note: `steer queued for ${id}; the driver injects it into the active turn` };
}

export function interruptSession(id: string): { ok: boolean; note: string } {
  const m = readMeta(id);
  if (!m) return { ok: false, note: `unknown job ${id}` };
  const { target, dir } = jobLocation(id);
  const line = JSON.stringify({ cmd: 'interrupt' });
  if (target.type === 'local') appendFileSync(fileIn(dir, 'control.jsonl'), line + '\n');
  else targetAppend(target, fileIn(dir, 'control.jsonl'), line);
  return { ok: true, note: `interrupt queued for ${id}` };
}

export function getSession(id: string): SessMeta | null {
  const m = readMeta(id);
  if (!m) return null;
  if ((m.state === 'starting' || m.state === 'running') && m.pid) {
    const { target } = jobLocation(id);
    const alive = target.type === 'local'
      ? (() => { try { process.kill(m.pid!, 0); return true; } catch { return false; } })()
      : targetPidAlive(target, m.pid);
    if (!alive) {
      m.state = 'failed';
      m.endedAt = m.endedAt || new Date().toISOString();
      // best-effort persist (local only; remote meta is owned by the driver)
      if (target.type === 'local') {
        try { writeFileSync(join(localStubDir(id), 'meta.json'), JSON.stringify(m, null, 2)); } catch {}
      }
    }
  }
  return m;
}

export function listSessions(): SessMeta[] {
  if (!existsSync(LOCAL_ROOT)) return [];
  return readdirSync(LOCAL_ROOT)
    .map((id) => getSession(id))
    .filter((m): m is SessMeta => m !== null)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export function sessionEvents(id: string, maxLines = 40): any[] {
  const { target, dir } = jobLocation(id);
  const raw = target.type === 'local'
    ? (existsSync(fileIn(dir, 'events.jsonl')) ? readFileSync(fileIn(dir, 'events.jsonl'), 'utf8') : '')
    : targetReadFile(target, fileIn(dir, 'events.jsonl'));
  if (!raw) return [];
  return raw.trim().split('\n').filter(Boolean).slice(-maxLines)
    .map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
}

export function sessionFinalMessage(id: string): string {
  const { target, dir } = jobLocation(id);
  const raw = target.type === 'local'
    ? (existsSync(fileIn(dir, 'last-message.txt')) ? readFileSync(fileIn(dir, 'last-message.txt'), 'utf8') : '')
    : targetReadFile(target, fileIn(dir, 'last-message.txt'));
  return raw.trim();
}

export function sessionChangedFiles(id: string): string[] {
  const m = readMeta(id);
  if (!m) return [];
  const { target } = jobLocation(id);
  const cmd = `cd '${m.cwd}' 2>/dev/null && git status --porcelain 2>/dev/null || true`;
  const r = targetTry(target, cmd, 8000);
  if (!r.ok) return [];
  return r.out.split('\n').map((l) => l.trim()).filter(Boolean);
}
