// Dispatch targets: local (this machine) or ssh (a remote host like the Mac Mini
// over Tailscale). A remote job's driver + codex run ON THE REMOTE, so it keeps
// running after the laptop closes / Claude quits; the local tools reach the
// remote job dir over SSH to poll, steer, and collect.

import { execFileSync, spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface Target {
  name: string;
  type: 'local' | 'ssh';
  host?: string;       // user@host for ssh
  workRoot?: string;   // base dir on the target for repos (e.g. ~/dev)
}

const TARGETS_FILE = join(homedir(), '.gpt5mcp', 'targets.json');

const BUILTIN: Record<string, Target> = {
  local: { name: 'local', type: 'local' },
};

/** Resolve a target spec: a preset name from targets.json, "local", or a raw
 *  user@host string (treated as ssh with workRoot ~/dev). */
export function resolveTarget(spec?: string): Target {
  if (!spec || spec === 'local') return BUILTIN.local;
  // load presets
  let presets: Record<string, Target> = {};
  try {
    if (existsSync(TARGETS_FILE)) {
      const raw = JSON.parse(readFileSync(TARGETS_FILE, 'utf8'));
      for (const [k, v] of Object.entries(raw)) presets[k] = { name: k, ...(v as any) };
    }
  } catch { /* ignore malformed config */ }
  if (presets[spec]) return presets[spec];
  if (spec.includes('@')) {
    return { name: spec, type: 'ssh', host: spec, workRoot: '~/dev' };
  }
  // unknown preset name -> fall back to local with a warning marker
  throw new Error(`unknown target "${spec}" (not in targets.json and not user@host)`);
}

const SSH_OPTS = ['-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=yes'];

/** Run a shell command on the target, return stdout (throws on failure). */
export function targetExec(t: Target, cmd: string, timeoutMs = 20000): string {
  if (t.type === 'local') {
    return execFileSync('/bin/bash', ['-c', cmd], { encoding: 'utf8', timeout: timeoutMs });
  }
  return execFileSync('ssh', [...SSH_OPTS, t.host!, cmd], { encoding: 'utf8', timeout: timeoutMs });
}

/** Try-exec: returns {ok, out} instead of throwing (for polling reads). */
export function targetTry(t: Target, cmd: string, timeoutMs = 20000): { ok: boolean; out: string } {
  try { return { ok: true, out: targetExec(t, cmd, timeoutMs) }; }
  catch (e: any) { return { ok: false, out: (e && (e.stdout || e.message)) || String(e) }; }
}

/** Read a file from the target ('' if missing). */
export function targetReadFile(t: Target, path: string): string {
  if (t.type === 'local') {
    try { return readFileSync(path, 'utf8'); } catch { return ''; }
  }
  const r = targetTry(t, `cat '${path.replace(/'/g, `'\\''`)}' 2>/dev/null`);
  return r.ok ? r.out : '';
}

/** Append a line to a file on the target (used for the control channel). */
export function targetAppend(t: Target, path: string, line: string): void {
  const esc = line.replace(/'/g, `'\\''`);
  const p = path.replace(/'/g, `'\\''`);
  targetExec(t, `printf '%s\\n' '${esc}' >> '${p}'`);
}

/** Check a remote pid is alive (local handled by caller). */
export function targetPidAlive(t: Target, pid: number): boolean {
  if (t.type === 'local') { try { process.kill(pid, 0); return true; } catch { return false; } }
  const r = targetTry(t, `kill -0 ${pid} 2>/dev/null && echo alive || echo dead`);
  return r.ok && /alive/.test(r.out);
}

/**
 * Ensure ~/.codex/config.toml on the target loads cleanly. The Codex desktop app
 * periodically rewrites config.toml with fields/values this CLI rejects (e.g.
 * historically `service_tier`), which breaks every job. We probe with
 * `codex exec --strict-config`; if it errors, we comment out each offending line
 * (backing the file up first) and re-probe. Returns a short report.
 *
 * Idempotent and safe: only comments out lines the CLI explicitly names as
 * unknown/invalid; never deletes or reorders anything else.
 */
export function sanitizeCodexConfig(t: Target): { ok: boolean; changed: boolean; report: string } {
  const CFG = '$HOME/.codex/config.toml';
  // Probe: run codex with --strict-config and capture stderr. We detect failure
  // by PARSING the output for "Error loading config.toml" rather than relying on
  // the exit code surviving the ssh/pipe wrapping (which it doesn't reliably).
  const probe = () => targetTry(
    t,
    `printf 'noop' | codex exec --strict-config --skip-git-repo-check --sandbox read-only - 2>&1 | ` +
    `grep -iE 'config\\.toml:[0-9]+:|Error loading config' || true`,
    45000,
  ).out;

  let out = probe();
  const bad = (s: string) => /config\.toml:\d+:|Error loading config/i.test(s);
  if (!bad(out)) return { ok: true, changed: false, report: 'config loads cleanly' };

  // Parse offending line numbers from messages like:
  //   /path/config.toml:220:1: unknown configuration field `x`
  //   config.toml:11:16: unknown variant `default` ... in `service_tier`
  const lines = new Set<number>();
  for (const m of out.matchAll(/config\.toml:(\d+):\d+:/g)) {
    lines.add(parseInt(m[1], 10));
  }
  if (lines.size === 0) {
    // Couldn't pinpoint a line — surface the raw error, don't guess-edit.
    return { ok: false, changed: false, report: `config rejected but no line located:\n${out.trim().slice(0, 400)}` };
  }

  // Safety: never comment out a [table] header line (would break the whole
  // section). Codex normally reports the offending field's own line; if it
  // points at a "[...]" header we bail with the error rather than corrupt config.
  const sorted = [...lines].sort((a, b) => a - b);
  for (const n of sorted) {
    const ln = targetTry(t, `sed -n '${n}p' ${CFG}`).out.trim();
    if (/^\s*\[/.test(ln)) {
      return { ok: false, changed: false,
        report: `config error points at a [table] header (line ${n}: ${ln}); not auto-editing. Fix manually:\n${out.trim().slice(0, 300)}` };
    }
  }

  // Back up once, then comment out each offending 1-based line with sed.
  const sedExprs = sorted.map((n) => `-e '${n}s/^/# [codex-sanitize] /'`).join(' ');
  const fix =
    `f=${CFG}; ` +
    `cp "$f" "$f.bak-sanitize" 2>/dev/null; ` +
    `sed -i '' ${sedExprs} "$f" 2>/dev/null || sed -i ${sedExprs} "$f"`;  // BSD then GNU sed
  targetExec(t, fix, 20000);

  out = probe();
  const stillBad = bad(out);
  return {
    ok: !stillBad,
    changed: true,
    report: !stillBad
      ? `commented out invalid config line(s): ${sorted.join(', ')} (backup: config.toml.bak-sanitize)`
      : `commented line(s) ${sorted.join(', ')} but config still rejected:\n${out.trim().slice(0, 300)}`,
  };
}

export { spawn };
