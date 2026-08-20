// Fleet roster: the shared, git-distributed source of truth for who exists.
//
// WHY THIS EXISTS
// The roster used to live only in ~/.gpt5mcp/team/employees on each machine, so
// every host had its own invisible copy. A laptop asking "does this agent
// already exist?" got "no" and hired a duplicate. Worse, employee records
// carried target:"mini" while the Mini called itself "local" and "mini" was in
// no targets.json -- so the field could not route and listEmployees ignored it.
//
// Declarations now come from a git repo every host pulls (fleet/employees/*.json)
// and identity is anchored to the Tailscale node ID, which is immutable and
// identical from every vantage point including the node's own. Runtime state
// stays in ~/.gpt5mcp, because it changes on every dispatch and would conflict.
//
// Everything here degrades to empty on any error: a missing or half-written
// roster must never take the MCP server down.
import { execFileSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface FleetHost {
  id: string;
  tailscaleId?: string;
  tailscaleIPs?: string[];
  sshUser?: string;
  aliases?: string[];
  reachability?: string;
}

export interface FleetAgent {
  slug: string;
  name: string;
  homeHost: string;
  lifecycle?: string;
  rolePack?: string;
  workspace?: string;
  model?: string;
  transport?: { kind?: string; port?: number; bot?: string };
  charter?: string;
}

/** Roster location. Override with FLEET_ROOT when the checkout is elsewhere. */
export function fleetRoot(): string {
  return process.env.FLEET_ROOT || join(homedir(), 'ai-company', 'fleet');
}

function readJson<T>(path: string): T | null {
  try { return JSON.parse(readFileSync(path, 'utf8')) as T; } catch { return null; }
}

export function fleetHosts(): FleetHost[] {
  const doc = readJson<{ hosts?: FleetHost[] }>(join(fleetRoot(), 'hosts.json'));
  return doc?.hosts ?? [];
}

export function fleetAgents(): FleetAgent[] {
  const dir = join(fleetRoot(), 'employees');
  if (!existsSync(dir)) return [];
  const out: FleetAgent[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    const a = readJson<FleetAgent>(join(dir, f));
    if (a?.slug) out.push(a);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

let selfCache: { id: string } | null | undefined;

/** This machine's Tailscale node ID. Hostnames are NOT usable for this: macOS
 *  reports "Ellas-Mac-mini" while the tailnet says "ellas-mac-mini-1". */
export function tailscaleSelfId(): string | null {
  if (selfCache !== undefined) return selfCache?.id ?? null;
  selfCache = null;
  for (const exe of ['tailscale', '/usr/local/bin/tailscale',
                     '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
    try {
      const out = execFileSync(exe, ['status', '--json'], {
        encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      const id = JSON.parse(out)?.Self?.ID;
      if (id) { selfCache = { id }; return id; }
    } catch { /* try the next path */ }
  }
  return null;
}

/** The fleet host record for THIS machine, matched by node ID only. */
export function fleetSelf(): FleetHost | null {
  const id = tailscaleSelfId();
  if (!id) return null;
  return fleetHosts().find((h) => h.tailscaleId && h.tailscaleId === id) ?? null;
}

const SELF_WORDS = new Set(['local', 'localhost', 'self', 'here', '127.0.0.1', '::1']);

export interface FleetResolution {
  host: FleetHost;
  isSelf: boolean;
  /** ssh spec, or null when the target is this machine */
  sshHost: string | null;
}

/** Resolve a name/alias/ip/user@host against the fleet roster.
 *  Returns null when the roster does not know it, so callers can fall through to
 *  the existing targets.json behaviour rather than hard-failing. */
export function resolveFleetHost(spec: string): FleetResolution | null {
  const hosts = fleetHosts();
  if (!hosts.length) return null;
  const low = spec.trim().toLowerCase();
  const me = fleetSelf();

  if (SELF_WORDS.has(low)) {
    return me ? { host: me, isSelf: true, sshHost: null } : null;
  }
  let match = hosts.find((h) => h.id.toLowerCase() === low)
    ?? hosts.find((h) => (h.aliases ?? []).some((a) => a.toLowerCase() === low))
    ?? hosts.find((h) => (h.tailscaleIPs ?? []).includes(spec));
  if (!match && low.includes('@')) {
    const bare = low.split('@')[1];
    match = hosts.find((h) => (h.tailscaleIPs ?? []).includes(bare)
      || h.id.toLowerCase() === bare);
  }
  if (!match) return null;
  // Never SSH to ourselves. This is the bug that made "mini" unusable ON the
  // Mini: a correct name that could only be expressed as "local".
  const isSelf = !!(me && match.tailscaleId && match.tailscaleId === me.tailscaleId);
  const ip = (match.tailscaleIPs ?? [])[0];
  return {
    host: match,
    isSelf,
    sshHost: isSelf || !ip || !match.sshUser ? null : `${match.sshUser}@${ip}`,
  };
}
