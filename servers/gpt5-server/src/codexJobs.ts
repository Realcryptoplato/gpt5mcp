// Async codex-exec worker: dispatch `codex exec` as a detached background job,
// then poll structured status / collect the result — the orchestrator dispatches
// like a subagent instead of blocking or tailing logs.
//
// Each job lives in its own dir under ~/.gpt5mcp/codex-jobs/<job_id>/:
//   spec.txt        the prompt/spec handed to codex
//   status.json     { id, state, pid, cwd, model, sandbox, startedAt, endedAt,
//                     exitCode, durationMs }
//   last-message.txt  codex's final message (via `codex exec -o`)
//   output.log      combined stdout/stderr stream (for the status tail)
//
// A detached child is spawned with stdio redirected to output.log; a tiny
// wrapper updates status.json on exit. The MCP process does NOT keep the child
// alive — jobs survive even if the server restarts (status is on disk).

import { spawn } from 'child_process';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, openSync,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const JOBS_ROOT = join(homedir(), '.gpt5mcp', 'codex-jobs');

export type JobState = 'running' | 'completed' | 'failed';

export interface JobStatus {
  id: string;
  state: JobState;
  pid?: number;
  cwd: string;
  model: string;
  sandbox: string;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  durationMs?: number;
  label?: string;
}

function jobDir(id: string): string {
  return join(JOBS_ROOT, id);
}

function statusPath(id: string): string {
  return join(jobDir(id), 'status.json');
}

function readStatus(id: string): JobStatus | null {
  try {
    return JSON.parse(readFileSync(statusPath(id), 'utf8'));
  } catch {
    return null;
  }
}

function writeStatus(id: string, s: JobStatus): void {
  writeFileSync(statusPath(id), JSON.stringify(s, null, 2));
}

/** Generate a short, collision-resistant job id without Date/Math.random ban issues. */
function newJobId(): string {
  // hrtime is allowed; format as base36 + a counter for uniqueness within a run.
  const t = process.hrtime.bigint().toString(36);
  jobCounter = (jobCounter + 1) % 100000;
  return `cx_${t}_${jobCounter.toString(36)}`;
}
let jobCounter = 0;

export interface DispatchOpts {
  prompt: string;
  cwd?: string;
  model?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  label?: string;
  reasoning_effort?: 'low' | 'medium' | 'high' | 'xhigh';
}

/**
 * Spawn a detached `codex exec` job. Returns the job id immediately — does NOT
 * wait for completion. The child runs independently; status.json is updated by
 * a wrapper shell that records the exit code + end time.
 */
export function dispatchCodex(opts: DispatchOpts): JobStatus {
  const id = newJobId();
  const dir = jobDir(id);
  mkdirSync(dir, { recursive: true });

  const cwd = opts.cwd || process.cwd();
  const model = opts.model || 'gpt-5.5';
  const sandbox = opts.sandbox || 'danger-full-access';
  const specPath = join(dir, 'spec.txt');
  const lastMsg = join(dir, 'last-message.txt');
  const logPath = join(dir, 'output.log');
  writeFileSync(specPath, opts.prompt, 'utf8');

  const startedAt = new Date().toISOString();
  const baseStatus: JobStatus = {
    id, state: 'running', cwd, model, sandbox, startedAt, label: opts.label,
  };
  writeStatus(id, baseStatus);

  // Build the codex argv. We bypass approvals so the worker runs unattended;
  // danger-full-access matches the user's delegated-worker setup.
  const sandboxFlag = sandbox === 'danger-full-access'
    ? ['--dangerously-bypass-approvals-and-sandbox']
    : ['--sandbox', sandbox, '--skip-git-repo-check'];
  const effortFlag = opts.reasoning_effort
    ? ['-c', `model_reasoning_effort="${opts.reasoning_effort}"`]
    : [];

  // Wrap codex in a shell so we can append the exit code to status.json after it
  // exits, WITHOUT keeping the MCP process attached. The prompt is passed via a
  // file to avoid argv-escaping issues.
  const codexArgs = [
    'exec', '-m', model, ...sandboxFlag, ...effortFlag,
    '-o', lastMsg,
    // prompt from stdin (trailing '-')
    '-',
  ].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');

  const wrapper = [
    `cd '${cwd.replace(/'/g, `'\\''`)}'`,
    // run codex, feeding the spec on stdin; capture combined output
    `codex ${codexArgs} < '${specPath}' >> '${logPath}' 2>&1`,
    `code=$?`,
    // patch status.json with exit info using node (always present)
    `node -e "const fs=require('fs');const p='${statusPath(id).replace(/'/g, `'\\''`)}';` +
      `const s=JSON.parse(fs.readFileSync(p,'utf8'));` +
      `s.exitCode=$code;s.state=$code===0?'completed':'failed';` +
      `s.endedAt=new Date().toISOString();` +
      `s.durationMs=Date.parse(s.endedAt)-Date.parse(s.startedAt);` +
      `fs.writeFileSync(p,JSON.stringify(s,null,2));"`,
  ].join('\n');

  const out = openSync(logPath, 'a');
  const child = spawn('/bin/bash', ['-c', wrapper], {
    cwd,
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env },
  });
  baseStatus.pid = child.pid;
  writeStatus(id, baseStatus);
  child.unref(); // let it outlive the MCP process

  return baseStatus;
}

/** Read current status; if the wrapper hasn't recorded an exit but the pid is
 *  gone, mark it failed (crash/kill) so callers don't wait forever. */
export function getStatus(id: string): JobStatus | null {
  const s = readStatus(id);
  if (!s) return null;
  if (s.state === 'running' && s.pid && !pidAlive(s.pid)) {
    s.state = 'failed';
    s.endedAt = s.endedAt || new Date().toISOString();
    s.exitCode = s.exitCode ?? null;
    writeStatus(id, s);
  }
  return s;
}

export function listJobs(): JobStatus[] {
  if (!existsSync(JOBS_ROOT)) return [];
  return readdirSync(JOBS_ROOT)
    .map((id) => getStatus(id))
    .filter((s): s is JobStatus => s !== null)
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

/** Tail of the combined output log (for status display). */
export function tailLog(id: string, maxBytes = 2000): string {
  const p = join(jobDir(id), 'output.log');
  try {
    const buf = readFileSync(p, 'utf8');
    return buf.length > maxBytes ? buf.slice(-maxBytes) : buf;
  } catch {
    return '';
  }
}

/** The final message codex wrote (its result), if finished. */
export function finalMessage(id: string): string {
  try {
    return readFileSync(join(jobDir(id), 'last-message.txt'), 'utf8').trim();
  } catch {
    return '';
  }
}

/** Files changed by the job, via git (best-effort; empty if not a git repo). */
export function changedFiles(id: string): string[] {
  const s = readStatus(id);
  if (!s) return [];
  try {
    const { execSync } = require('child_process');
    const out = execSync('git status --porcelain', {
      cwd: s.cwd, encoding: 'utf8', timeout: 5000,
    }) as string;
    return out.split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
