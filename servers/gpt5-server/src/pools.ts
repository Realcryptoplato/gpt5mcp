// Credit pool directory: an optional pools.json describing which credit pool
// backs each employee and whether that pool is safe to spend from right now.
// Absent or malformed data must never break team_manifest/team_list/team_dispatch,
// so every reader here degrades to "no pool data" instead of throwing.
import { Target, targetPathExists, targetReadFile } from './targets.js';

export type PoolStatus = 'green' | 'yellow' | 'red' | 'unknown';

export interface PoolInfo {
  provider?: string;
  plan?: string;
  status: PoolStatus;
  note?: string;
  dashboard?: string;
}

export interface PoolMember {
  host?: string;
  runtime?: string;
  model?: string;
  pool?: string;
  bestFor?: string;
  fallback: string[];
}

export interface PoolsFile {
  schemaVersion: 1;
  updatedAt?: string;
  updatedBy?: string;
  pools: Record<string, PoolInfo>;
  members: Record<string, PoolMember>;
}

export interface PoolHealth {
  green: number;
  yellow: number;
  red: number;
  unknown: number;
}

export interface PoolReadDeps {
  pathExists: (target: Target, path: string) => boolean;
  readFile: (target: Target, path: string) => string;
}

const DEFAULT_DEPS: PoolReadDeps = { pathExists: targetPathExists, readFile: targetReadFile };

function normalizeStatus(value: unknown): PoolStatus {
  return value === 'green' || value === 'yellow' || value === 'red' ? value : 'unknown';
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function poolsFilePath(teamRootPath: string): string {
  return `${teamRootPath}/pools.json`;
}

/** Read and validate pools.json. Never throws; returns null when absent or malformed. */
export function readPoolsFile(
  target: Target,
  teamRootPath: string,
  deps: PoolReadDeps = DEFAULT_DEPS,
): PoolsFile | null {
  try {
    const path = poolsFilePath(teamRootPath);
    if (!deps.pathExists(target, path)) return null;
    const raw = deps.readFile(target, path);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (
      !parsed || typeof parsed !== 'object'
      || !parsed.pools || typeof parsed.pools !== 'object'
      || !parsed.members || typeof parsed.members !== 'object'
    ) {
      console.error(`team pools: malformed pools.json on ${target.name} (expected pools/members objects); ignoring`);
      return null;
    }
    const pools: Record<string, PoolInfo> = {};
    for (const [id, value] of Object.entries<any>(parsed.pools)) {
      if (!value || typeof value !== 'object') continue;
      pools[id] = {
        provider: str(value.provider),
        plan: str(value.plan),
        status: normalizeStatus(value.status),
        note: str(value.note),
        dashboard: str(value.dashboard),
      };
    }
    const members: Record<string, PoolMember> = {};
    for (const [slug, value] of Object.entries<any>(parsed.members)) {
      if (!value || typeof value !== 'object') continue;
      members[slug] = {
        host: str(value.host),
        runtime: str(value.runtime),
        model: str(value.model),
        pool: str(value.pool),
        bestFor: str(value.bestFor),
        fallback: Array.isArray(value.fallback) ? value.fallback.filter((f: any) => typeof f === 'string') : [],
      };
    }
    return {
      schemaVersion: 1,
      updatedAt: str(parsed.updatedAt),
      updatedBy: str(parsed.updatedBy),
      pools,
      members,
    };
  } catch (error: any) {
    console.error(`team pools: failed to read pools.json on ${target.name}: ${error?.message || String(error)}`);
    return null;
  }
}

export function poolHealthSummary(pools: Record<string, PoolInfo>): PoolHealth {
  const counts: PoolHealth = { green: 0, yellow: 0, red: 0, unknown: 0 };
  for (const pool of Object.values(pools)) counts[pool.status] += 1;
  return counts;
}

/** Resolve one member's effective pool status. Unknown pool status counts as green-like ("unknown"). */
export function memberPoolStatus(poolsFile: PoolsFile | null, slug: string): {
  poolId?: string;
  status?: PoolStatus;
  note?: string;
  dashboard?: string;
  fallback: string[];
  runtime?: string;
  bestFor?: string;
} {
  const member = poolsFile?.members[slug];
  if (!member) return { fallback: [] };
  const info = member.pool ? poolsFile!.pools[member.pool] : undefined;
  return {
    poolId: member.pool,
    status: member.pool ? (info?.status ?? 'unknown') : undefined,
    note: info?.note,
    dashboard: info?.dashboard,
    fallback: member.fallback,
    runtime: member.runtime,
    bestFor: member.bestFor,
  };
}

/** Annotate one employee-like object with directory/pool metadata. Pure; no I/O. */
export function annotateEmployeeWithPool<T extends { slug: string }>(
  employee: T,
  poolsFile: PoolsFile | null,
): T & {
  pool?: string;
  poolStatus?: PoolStatus;
  poolNote?: string;
  fallback?: string[];
  runtime?: string;
  bestFor?: string;
} {
  if (!poolsFile || !poolsFile.members[employee.slug]) return employee;
  const info = memberPoolStatus(poolsFile, employee.slug);
  return {
    ...employee,
    pool: info.poolId,
    poolStatus: info.status,
    poolNote: info.note,
    fallback: info.fallback,
    runtime: info.runtime,
    bestFor: info.bestFor,
  };
}

export function buildPoolsSummary(poolsFile: PoolsFile | null): {
  pools: Record<string, PoolInfo>;
  health: PoolHealth;
  updatedAt?: string;
} {
  const pools = poolsFile?.pools ?? {};
  return { pools, health: poolHealthSummary(pools), updatedAt: poolsFile?.updatedAt };
}

export interface DirectoryEntry {
  host?: string;
  runtime?: string;
  model?: string;
  pool?: string;
  poolStatus?: PoolStatus;
  poolNote?: string;
  bestFor?: string;
  fallback: string[];
}

export function buildDirectory(poolsFile: PoolsFile | null): Record<string, DirectoryEntry> {
  const directory: Record<string, DirectoryEntry> = {};
  if (!poolsFile) return directory;
  for (const [slug, member] of Object.entries(poolsFile.members)) {
    const info = memberPoolStatus(poolsFile, slug);
    directory[slug] = {
      host: member.host,
      runtime: member.runtime,
      model: member.model,
      pool: member.pool,
      poolStatus: info.status,
      poolNote: info.note,
      bestFor: member.bestFor,
      fallback: member.fallback,
    };
  }
  return directory;
}

export interface PoolGateResult {
  blocked?: string;
  warning?: string;
}

/** Pure dispatch gate: decide whether a red/yellow pool should block or warn a dispatch. */
export function evaluatePoolGate(
  poolsFile: PoolsFile | null,
  employeeName: string,
  slug: string,
  force: boolean,
): PoolGateResult {
  const info = memberPoolStatus(poolsFile, slug);
  if (!info.status || info.status === 'green' || info.status === 'unknown') return {};
  const fallbackText = info.fallback.length ? info.fallback.join(', ') : 'none listed';
  const note = info.note || 'no note provided';
  if (info.status === 'red') {
    if (force) {
      return {
        warning: `${employeeName}'s credit pool ${info.poolId} is RED (${note}). `
          + `Use fallback: ${fallbackText}. Overridden with force=true.`,
      };
    }
    return {
      blocked: `${employeeName}'s credit pool ${info.poolId} is RED (${note}). `
        + `Use fallback: ${fallbackText}. Pass force=true to override.`,
    };
  }
  return {
    warning: `${employeeName}'s credit pool ${info.poolId} is YELLOW (${note}). Use fallback: ${fallbackText}.`,
  };
}
