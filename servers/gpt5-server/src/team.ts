import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { fleetAgents, fleetSelf, type FleetAgent } from './fleet.js';
import { dirname, join } from 'path';
import {
  Target, resolveTarget, targetExec, targetPathExists, targetReadFile, targetTry, targetWriteFile,
} from './targets.js';
import {
  SessMeta, StartOpts, getSession, sessionEvents, sessionFinalMessage,
  sessionChangedFiles, startSession,
} from './codexSession.js';
import {
  annotateEmployeeWithPool, buildDirectory, buildPoolsSummary, evaluatePoolGate, readPoolsFile,
} from './pools.js';

const LIBRARY_REPO = process.env.GPT5_CAPABILITY_REPO || 'Realcryptoplato/team-agent-capabilities';
const LOCAL_LIBRARY_OVERRIDE = process.env.GPT5_CAPABILITY_LIBRARY;
const LOCAL_DEVELOPMENT_LIBRARY = '/Users/greg/repos/team-agent-capabilities';
const LOCAL_TEAM_JOBS = join(homedir(), '.gpt5mcp', 'team-jobs');
const targetHomeCache = new Map<string, string>();
const LIBRARY_SYNC_CACHE_MS = 120_000;
const librarySyncCache = new Map<string, {
  checkedAt: number;
  value: { target: string; path: string; commit: string; changed: boolean };
}>();

export type EmployeeStatus = 'active' | 'archived';
export type EmployeeSandbox = 'read-only' | 'workspace-write' | 'danger-full-access';
export type EmployeeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export interface BridgeBinding {
  port: number;
  botUsername?: string;
  notifyTelegram: boolean;
}

export interface EmployeeManifest {
  schemaVersion: 1;
  name: string;
  slug: string;
  target: string;
  workspace: string;
  repo?: string;
  branch?: string;
  rolePack: string;
  skills: string[];
  plugins: string[];
  charter: string;
  model?: string;
  reasoningEffort: EmployeeEffort;
  sandbox: EmployeeSandbox;
  status: EmployeeStatus;
  createdAt: string;
  updatedAt: string;
  threadId?: string;
  bridge?: BridgeBinding;
  // Populated from pools.json when the employee's slug appears there; absent otherwise.
  pool?: string;
  poolStatus?: 'green' | 'yellow' | 'red' | 'unknown';
  poolNote?: string;
  fallback?: string[];
  runtime?: string;
  bestFor?: string;
}

export interface SkillRef {
  name: string;
  path: string;
  version?: string;
}

export interface HireArgs {
  name: string;
  target?: string;
  workspace: string;
  repo?: string;
  branch?: string;
  rolePack?: string;
  skills?: string[];
  plugins?: string[];
  charter?: string;
  model?: string;
  reasoningEffort?: EmployeeEffort;
  sandbox?: EmployeeSandbox;
  bridgePort?: number;
  botUsername?: string;
  notifyTelegram?: boolean;
}

export interface UpdateArgs {
  name: string;
  target?: string;
  workspace?: string;
  rolePack?: string;
  skills?: string[];
  plugins?: string[];
  charter?: string;
  model?: string;
  reasoningEffort?: EmployeeEffort;
  sandbox?: EmployeeSandbox;
  bridgePort?: number | null;
  botUsername?: string;
  notifyTelegram?: boolean;
}

export interface TeamDispatchArgs {
  employee: string;
  target?: string;
  prompt: string;
  model?: string;
  sandbox?: EmployeeSandbox;
  reasoningEffort?: EmployeeEffort;
  label?: string;
  syncLibrary?: boolean;
  extraSkills?: string[];
  force?: boolean;
}

export interface TeamCapabilityManifest {
  schemaVersion: 1;
  target: string;
  library: { path: string; commit: string };
  defaults: {
    model?: string;
    reasoningEffort?: EmployeeEffort;
    sandbox?: EmployeeSandbox;
  };
  workflow: string[];
  rolePacks: Array<{
    id: string;
    description: string;
    skills: string[];
    plugins: string[];
    defaults: {
      model?: string;
      reasoningEffort?: EmployeeEffort;
      sandbox?: EmployeeSandbox;
    };
  }>;
  approvedSkills: Array<{
    id: string;
    version: string;
    trust?: string;
    description?: string;
  }>;
  approvedPlugins: Array<{
    id: string;
    source?: string;
    reason?: string;
  }>;
  employees: EmployeeManifest[];
  pools: ReturnType<typeof buildPoolsSummary>;
  directory: ReturnType<typeof buildDirectory>;
}

interface ApprovedSkill {
  id: string;
  path: string;
  version: string;
  trust?: string;
}

interface TeamJob {
  schemaVersion: 1;
  id: string;
  kind: 'codex' | 'bridge';
  employee: string;
  employeeSlug: string;
  target: string;
  createdAt: string;
  codexJobId?: string;
  bridgeJobPath?: string;
  skills: SkillRef[];
  libraryCommit?: string;
  model?: string;
  reasoningEffort?: EmployeeEffort;
  harvest?: {
    skillName: string;
    topic: string;
  };
}

interface HarvestMaterialization {
  status: 'written' | 'already-exists' | 'not-found';
  path?: string;
  note?: string;
}

function slugify(value: string): string {
  const slug = value.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug || slug.length > 64) throw new Error('employee name must produce a 1-64 character slug');
  return slug;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function skillDescription(markdown: string): string | undefined {
  const frontmatter = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const raw = frontmatter?.[1].match(/^description:\s*(.+)$/m)?.[1].trim();
  if (!raw) return undefined;
  if (raw.startsWith('"') && raw.endsWith('"')) {
    try { return JSON.parse(raw); } catch {}
  }
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw;
}

function githubRepoSlug(value: string): string | undefined {
  const trimmed = value.trim().replace(/\.git$/, '');
  const ssh = trimmed.match(/^git@github\.com:(.+\/.+)$/i);
  const https = trimmed.match(/^https?:\/\/github\.com\/(.+\/.+)$/i);
  const candidate = ssh?.[1] || https?.[1] || trimmed;
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate)
    ? candidate.toLowerCase()
    : undefined;
}

function targetHome(target: Target): string {
  if (target.type === 'local') return homedir();
  const cacheKey = target.host || target.name;
  const cached = targetHomeCache.get(cacheKey);
  if (cached) return cached;
  const home = targetExec(target, 'printf %s "$HOME"').trim();
  if (!home.startsWith('/')) throw new Error(`could not resolve home directory on ${target.host}`);
  targetHomeCache.set(cacheKey, home);
  return home;
}

function teamRoot(target: Target): string {
  return `${targetHome(target)}/.gpt5mcp/team`;
}

function employeeDir(target: Target, slug: string): string {
  return `${teamRoot(target)}/employees/${slug}`;
}

function employeeManifestPath(target: Target, slug: string): string {
  return `${employeeDir(target, slug)}/manifest.json`;
}

function libraryRoot(target: Target): string {
  if (target.type === 'local') {
    if (LOCAL_LIBRARY_OVERRIDE) return LOCAL_LIBRARY_OVERRIDE;
    if (existsSync(LOCAL_DEVELOPMENT_LIBRARY)) return LOCAL_DEVELOPMENT_LIBRARY;
  }
  return `${targetHome(target)}/.gpt5mcp/team-agent-capabilities`;
}

function jsonOnTarget<T>(target: Target, path: string): T {
  const raw = targetReadFile(target, path);
  if (!raw) throw new Error(`missing file on ${target.name}: ${path}`);
  try {
    return JSON.parse(raw) as T;
  } catch (error: any) {
    throw new Error(`invalid JSON at ${path}: ${error?.message || String(error)}`);
  }
}

function writeJsonOnTarget(target: Target, path: string, value: unknown): void {
  targetWriteFile(target, path, `${JSON.stringify(value, null, 2)}\n`);
}

export function syncCapabilityLibrary(targetSpec?: string, ref = 'main', force = false): {
  target: string;
  path: string;
  commit: string;
  changed: boolean;
} {
  const target = resolveTarget(targetSpec);
  const root = libraryRoot(target);
  const cacheKey = `${target.name}:${ref}`;

  // The local development checkout is authoritative while it exists. Do not
  // pull over an operator's uncommitted work.
  if (target.type === 'local' && root === LOCAL_DEVELOPMENT_LIBRARY) {
    const commit = targetTry(target, `git -C ${shellQuote(root)} rev-parse HEAD`).out.trim() || '(uncommitted)';
    return { target: target.name, path: root, commit, changed: false };
  }

  const cached = librarySyncCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.checkedAt < LIBRARY_SYNC_CACHE_MS) {
    return { ...cached.value, changed: false };
  }

  const syncOutput = targetExec(
    target,
    [
      'set -e',
      `root=${shellQuote(root)}`,
      `ref=${shellQuote(ref)}`,
      'before=""',
      'if test -d "$root/.git"; then',
      '  before=$(git -C "$root" rev-parse HEAD 2>/dev/null || true)',
      '  git -C "$root" fetch origin "$ref" >/dev/null',
      '  git -C "$root" checkout "$ref" >/dev/null',
      '  git -C "$root" pull --ff-only origin "$ref" >/dev/null',
      'else',
      `  mkdir -p ${shellQuote(`${targetHome(target)}/.gpt5mcp`)}`,
      `  gh repo clone ${shellQuote(LIBRARY_REPO)} "$root" -- --branch "$ref" >/dev/null`,
      'fi',
      'commit=$(git -C "$root" rev-parse HEAD)',
      'node "$root/scripts/validate-library.mjs" >/dev/null',
      'printf "%s\\n%s\\n" "$before" "$commit"',
    ].join('\n'),
    120000,
  );
  const [before = '', commit = ''] = syncOutput.trimEnd().split('\n').slice(-2);
  if (!commit) throw new Error(`capability library sync returned no commit on ${target.name}`);
  const value = { target: target.name, path: root, commit, changed: before !== commit };
  librarySyncCache.set(cacheKey, { checkedAt: Date.now(), value });
  return value;
}

function readEmployee(target: Target, name: string): EmployeeManifest {
  const slug = slugify(name);
  const manifest = jsonOnTarget<EmployeeManifest>(target, employeeManifestPath(target, slug));
  if (manifest.status !== 'active') throw new Error(`employee ${manifest.name} is ${manifest.status}`);
  return manifest;
}

function saveEmployee(target: Target, manifest: EmployeeManifest): void {
  const dir = employeeDir(target, manifest.slug);
  targetExec(target, `mkdir -p ${shellQuote(dir)}`);
  writeJsonOnTarget(target, `${dir}/manifest.json`, manifest);
  targetWriteFile(target, `${dir}/CHARTER.md`, `# ${manifest.name}\n\n${manifest.charter.trim()}\n`);
  if (!targetPathExists(target, `${dir}/MEMORY.md`)) {
    targetWriteFile(target, `${dir}/MEMORY.md`, `# ${manifest.name} memory\n\n`);
  }
  if (!targetPathExists(target, `${dir}/state.json`)) {
    writeJsonOnTarget(target, `${dir}/state.json`, { schemaVersion: 1, lastJobId: null });
  }
}

export function hireEmployee(args: HireArgs): EmployeeManifest {
  const target = resolveTarget(args.target);
  const slug = slugify(args.name);
  const path = employeeManifestPath(target, slug);
  if (targetPathExists(target, path)) throw new Error(`employee ${args.name} already exists on ${target.name}`);
  const expectedRepo = args.repo ? githubRepoSlug(args.repo) : undefined;
  if (args.repo && !expectedRepo) {
    throw new Error('repo must be a GitHub owner/name slug or GitHub clone URL');
  }
  if (!args.workspace.startsWith('/')) {
    throw new Error('workspace must be an absolute path on the target');
  }
  if (!targetPathExists(target, args.workspace, 'dir') && args.repo) {
    const parent = dirname(args.workspace);
    targetExec(target, `mkdir -p ${shellQuote(parent)}`);
    targetExec(
      target,
      `gh repo clone ${shellQuote(args.repo)} ${shellQuote(args.workspace)}` +
      (args.branch ? ` -- --branch ${shellQuote(args.branch)}` : ''),
      120000,
    );
  }
  if (!targetPathExists(target, args.workspace, 'dir')) {
    throw new Error(
      `workspace does not exist on ${target.name}: ${args.workspace}. ` +
      `Pass repo to clone it during hiring, or prepare the folder first.`,
    );
  }
  if (args.repo && !targetPathExists(target, `${args.workspace}/.git`, 'dir')) {
    throw new Error(`workspace exists but is not a git checkout: ${args.workspace}`);
  }
  if (args.repo) {
    const origin = targetTry(
      target,
      `git -C ${shellQuote(args.workspace)} remote get-url origin`,
    ).out.trim();
    const actualRepo = githubRepoSlug(origin);
    if (actualRepo !== expectedRepo) {
      throw new Error(
        `workspace origin does not match repo: expected ${expectedRepo}, found ${actualRepo || origin || '(none)'}`,
      );
    }
  }
  const library = syncCapabilityLibrary(args.target);
  const templatePath = `${library.path}/employees/templates/${args.rolePack || 'general'}.json`;
  const template = targetPathExists(target, templatePath)
    ? jsonOnTarget<any>(target, templatePath)
    : {};
  const resolvedBranch = args.repo
    ? targetTry(target, `git -C ${shellQuote(args.workspace)} branch --show-current`).out.trim()
    : '';
  const now = new Date().toISOString();
  const manifest: EmployeeManifest = {
    schemaVersion: 1,
    name: args.name.trim(),
    slug,
    target: target.name,
    workspace: args.workspace,
    ...(args.repo ? {
      repo: args.repo,
      ...(resolvedBranch ? { branch: resolvedBranch } : {}),
    } : {}),
    rolePack: args.rolePack || template.rolePack || 'general',
    skills: [...new Set(args.skills || [])],
    plugins: [...new Set(args.plugins || [])],
    charter: args.charter || template.charter || 'Operate as a durable managed team employee.',
    model: args.model || template.model,
    reasoningEffort: args.reasoningEffort || template.reasoningEffort || 'high',
    sandbox: args.sandbox || template.sandbox || 'danger-full-access',
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...(args.bridgePort ? {
      bridge: {
        port: args.bridgePort,
        botUsername: args.botUsername,
        notifyTelegram: args.notifyTelegram !== false,
      },
    } : {}),
  };
  // Resolve now so hiring fails before state is created when the pack or skill
  // is invalid, unapproved, or revoked.
  resolveEmployeeCapabilities(target, manifest, library.path);
  saveEmployee(target, manifest);
  return manifest;
}

export function updateEmployee(args: UpdateArgs): EmployeeManifest {
  const target = resolveTarget(args.target);
  const current = readEmployee(target, args.name);
  if (args.workspace && !args.workspace.startsWith('/')) {
    throw new Error('workspace must be an absolute path on the target');
  }
  if (args.workspace && !targetPathExists(target, args.workspace, 'dir')) {
    throw new Error(`workspace does not exist on ${target.name}: ${args.workspace}`);
  }
  const next: EmployeeManifest = {
    ...current,
    ...(args.workspace !== undefined ? { workspace: args.workspace } : {}),
    ...(args.rolePack !== undefined ? { rolePack: args.rolePack } : {}),
    ...(args.skills !== undefined ? { skills: [...new Set(args.skills)] } : {}),
    ...(args.plugins !== undefined ? { plugins: [...new Set(args.plugins)] } : {}),
    ...(args.charter !== undefined ? { charter: args.charter } : {}),
    ...(args.model !== undefined ? { model: args.model } : {}),
    ...(args.reasoningEffort !== undefined ? { reasoningEffort: args.reasoningEffort } : {}),
    ...(args.sandbox !== undefined ? { sandbox: args.sandbox } : {}),
    updatedAt: new Date().toISOString(),
  };
  if (args.bridgePort === null) delete next.bridge;
  else if (args.bridgePort !== undefined || args.botUsername !== undefined || args.notifyTelegram !== undefined) {
    next.bridge = {
      port: args.bridgePort || current.bridge?.port || 0,
      botUsername: args.botUsername ?? current.bridge?.botUsername,
      notifyTelegram: args.notifyTelegram ?? current.bridge?.notifyTelegram ?? true,
    };
    if (!next.bridge.port) throw new Error('bridge_port is required for a bridge employee');
  }
  const library = syncCapabilityLibrary(args.target);
  resolveEmployeeCapabilities(target, next, library.path);
  saveEmployee(target, next);
  return next;
}

function remoteCapabilitySnapshot(target: Target, root: string): {
  approved: { skills: ApprovedSkill[] };
  plugins: { plugins: Array<{ id: string; status: string; source?: string; reason?: string }> };
  template: any;
  roles: Array<{ pack: any; template: any }>;
  skillMarkdown: Record<string, string>;
  employees: EmployeeManifest[];
} {
  const python = `
import json
from pathlib import Path

root = Path(${JSON.stringify(root)})
team_root = Path(${JSON.stringify(teamRoot(target))})

def read_json(path):
    return json.loads(path.read_text())

approved = read_json(root / "registry" / "approved.json")
plugins = read_json(root / "registry" / "plugins.json")
template = read_json(root / "employees" / "templates" / "general.json")

roles = []
for path in sorted((root / "role-packs").glob("*.json")):
    pack = read_json(path)
    role_template_path = root / "employees" / "templates" / (str(pack["id"]) + ".json")
    role_template = read_json(role_template_path) if role_template_path.is_file() else template
    roles.append({"pack": pack, "template": role_template})

skill_markdown = {}
for skill in approved.get("skills", []):
    path = root / skill["path"]
    skill_markdown[skill["id"]] = path.read_text() if path.is_file() else ""

employees = []
employee_root = team_root / "employees"
if employee_root.is_dir():
    for path in sorted(employee_root.rglob("manifest.json")):
        try:
            employees.append(read_json(path))
        except Exception:
            pass

print(json.dumps({
    "approved": approved,
    "plugins": plugins,
    "template": template,
    "roles": roles,
    "skillMarkdown": skill_markdown,
    "employees": employees,
}))
`.trim();
  return JSON.parse(targetExec(target, `python3 -c ${shellQuote(python)}`, 60000));
}

export function getTeamCapabilityManifest(targetSpec?: string): TeamCapabilityManifest {
  const target = resolveTarget(targetSpec);
  const library = syncCapabilityLibrary(targetSpec);
  const poolsFile = readPoolsFile(target, teamRoot(target));
  const pools = buildPoolsSummary(poolsFile);
  const directory = buildDirectory(poolsFile);
  if (target.type === 'ssh') {
    const snapshot = remoteCapabilitySnapshot(target, library.path);
    return {
      schemaVersion: 1,
      target: target.name,
      library: { path: library.path, commit: library.commit },
      defaults: {
        model: snapshot.template.model,
        reasoningEffort: snapshot.template.reasoningEffort,
        sandbox: snapshot.template.sandbox,
      },
      workflow: [
        'Call team_manifest on the intended target, then team_list to reuse an existing employee when one fits.',
        'For a new employee, choose a role pack and an absolute workspace. Pass repo and optional branch to team_hire when the checkout does not exist; hiring clones it on the target.',
        'Use team_plugin_sync with install_missing=true when the selected role has approved plugin requirements.',
        'Call team_dispatch. Omit model/reasoning to use employee defaults, or override them for one assignment.',
        'Poll team_status and collect team_result. Repeated dispatches resume the same durable employee thread.',
        'Use team_skill_harvest to propose reusable learned workflow; harvested skills remain quarantined until audited.',
        'Use team_update for durable changes. team_fire archives recoverably unless purge=true is explicitly requested.',
        'Check directory/pools: avoid members whose pool is red; prefer the listed fallback.',
      ],
      rolePacks: snapshot.roles.map(({ pack, template }) => ({
        id: pack.id,
        description: pack.description || '',
        skills: pack.skills || [],
        plugins: pack.plugins || [],
        defaults: {
          model: template.model,
          reasoningEffort: template.reasoningEffort,
          sandbox: template.sandbox,
        },
      })).sort((a, b) => a.id.localeCompare(b.id)),
      approvedSkills: snapshot.approved.skills.map((skill) => ({
        id: skill.id,
        version: skill.version,
        trust: skill.trust,
        description: skillDescription(snapshot.skillMarkdown[skill.id] || ''),
      })),
      approvedPlugins: snapshot.plugins.plugins
        .filter((plugin) => plugin.status === 'approved')
        .map(({ id, source, reason }) => ({ id, source, reason })),
      employees: snapshot.employees
        .map((employee) => annotateEmployeeWithPool(employee, poolsFile))
        .sort((a, b) => a.name.localeCompare(b.name)),
      pools,
      directory,
    };
  }
  const approved = jsonOnTarget<{ skills: ApprovedSkill[] }>(
    target,
    `${library.path}/registry/approved.json`,
  );
  const plugins = jsonOnTarget<{
    plugins: Array<{ id: string; status: string; source?: string; reason?: string }>;
  }>(target, `${library.path}/registry/plugins.json`);
  const template = jsonOnTarget<any>(target, `${library.path}/employees/templates/general.json`);
  const roleFiles = target.type === 'local'
    ? readdirSync(join(library.path, 'role-packs'))
      .filter((name) => name.endsWith('.json'))
      .map((name) => `${library.path}/role-packs/${name}`)
    : targetExec(target, `find ${shellQuote(`${library.path}/role-packs`)} -maxdepth 1 -name '*.json' -type f`)
      .split('\n').map((value) => value.trim()).filter(Boolean);
  const rolePacks = roleFiles.map((path) => {
    const pack = jsonOnTarget<any>(target, path);
    const roleTemplatePath = `${library.path}/employees/templates/${pack.id}.json`;
    const roleTemplate = targetPathExists(target, roleTemplatePath)
      ? jsonOnTarget<any>(target, roleTemplatePath)
      : template;
    return {
      id: pack.id,
      description: pack.description || '',
      skills: pack.skills || [],
      plugins: pack.plugins || [],
      defaults: {
        model: roleTemplate.model,
        reasoningEffort: roleTemplate.reasoningEffort,
        sandbox: roleTemplate.sandbox,
      },
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  return {
    schemaVersion: 1,
    target: target.name,
    library: { path: library.path, commit: library.commit },
    defaults: {
      model: template.model,
      reasoningEffort: template.reasoningEffort,
      sandbox: template.sandbox,
    },
    workflow: [
      'Call team_manifest on the intended target, then team_list to reuse an existing employee when one fits.',
      'For a new employee, choose a role pack and an absolute workspace. Pass repo and optional branch to team_hire when the checkout does not exist; hiring clones it on the target.',
      'Use team_plugin_sync with install_missing=true when the selected role has approved plugin requirements.',
      'Call team_dispatch. Omit model/reasoning to use employee defaults, or override them for one assignment.',
      'Poll team_status and collect team_result. Repeated dispatches resume the same durable employee thread.',
      'Use team_skill_harvest to propose reusable learned workflow; harvested skills remain quarantined until audited.',
      'Use team_update for durable changes. team_fire archives recoverably unless purge=true is explicitly requested.',
      'Check directory/pools: avoid members whose pool is red; prefer the listed fallback.',
    ],
    rolePacks,
    approvedSkills: approved.skills.map((skill) => {
      const markdown = targetReadFile(target, `${library.path}/${skill.path}`) || '';
      return {
        id: skill.id,
        version: skill.version,
        trust: skill.trust,
        description: skillDescription(markdown),
      };
    }),
    approvedPlugins: plugins.plugins
      .filter((plugin) => plugin.status === 'approved')
      .map(({ id, source, reason }) => ({ id, source, reason })),
    employees: listEmployees(targetSpec, false),
    pools,
    directory,
  };
}

export function fireEmployee(name: string, targetSpec?: string, purge = false): {
  name: string;
  target: string;
  status: 'archived' | 'purged';
  archivePath?: string;
} {
  const target = resolveTarget(targetSpec);
  const manifest = readEmployee(target, name);
  const dir = employeeDir(target, manifest.slug);
  if (purge) {
    if (target.type === 'local') rmSync(dir, { recursive: true, force: false });
    else targetExec(target, `rm -rf -- ${shellQuote(dir)}`);
    return { name: manifest.name, target: target.name, status: 'purged' };
  }
  manifest.status = 'archived';
  manifest.updatedAt = new Date().toISOString();
  writeJsonOnTarget(target, `${dir}/manifest.json`, manifest);
  const archiveRoot = `${teamRoot(target)}/archive`;
  const archivePath = `${archiveRoot}/${manifest.slug}-${Date.now()}`;
  targetExec(target, `mkdir -p ${shellQuote(archiveRoot)} && mv ${shellQuote(dir)} ${shellQuote(archivePath)}`);
  return { name: manifest.name, target: target.name, status: 'archived', archivePath };
}

/** Fleet declarations rendered in EmployeeManifest shape.
 *
 *  These come from the git-distributed roster, so a laptop that has never hired
 *  anyone still sees every agent that exists -- which is the whole point: the
 *  duplicate hires happened because the answer to "does this already exist?" was
 *  computed from a registry only the hiring machine could see.
 */
function fleetEmployeeManifests(): EmployeeManifest[] {
  try {
    return fleetAgents().map((a: FleetAgent) => ({
      schemaVersion: 1,
      name: a.name,
      slug: a.slug,
      target: a.homeHost,
      workspace: a.workspace,
      rolePack: a.rolePack,
      skills: [],
      plugins: [],
      charter: a.charter,
      model: a.model,
      status: 'active',
      source: 'fleet',
      lifecycle: a.lifecycle,
      bridge: a.transport?.port
        ? { port: a.transport.port, botUsername: a.transport.bot }
        : undefined,
    } as unknown as EmployeeManifest));
  } catch { return []; }
}

export function listEmployees(targetSpec?: string, includeArchived = false): EmployeeManifest[] {
  const target = resolveTarget(targetSpec);
  const roots = [`${teamRoot(target)}/employees`];
  if (includeArchived) roots.push(`${teamRoot(target)}/archive`);
  const manifests: EmployeeManifest[] = [];
  for (const root of roots) {
    if (target.type === 'local') {
      if (!existsSync(root)) continue;
      const stack = [root];
      while (stack.length) {
        const dir = stack.pop()!;
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const file = join(dir, entry.name);
          if (entry.isDirectory()) stack.push(file);
          else if (entry.name === 'manifest.json') {
            try { manifests.push(JSON.parse(readFileSync(file, 'utf8'))); } catch {}
          }
        }
      }
    } else {
      const paths = targetExec(target, `find ${shellQuote(root)} -name manifest.json -type f 2>/dev/null || true`)
        .split('\n').map((value) => value.trim()).filter(Boolean);
      for (const path of paths) {
        try { manifests.push(jsonOnTarget<EmployeeManifest>(target, path)); } catch {}
      }
    }
  }
  // Union the shared roster with this host's local records.
  //
  // A local record only overrides a declaration when THIS host is the declared
  // home. Then the two describe the same agent and the local copy adds runtime
  // state (threadId, live status) that the declaration deliberately omits, so
  // dropping it would break session resumption.
  //
  // When the declaration is homed elsewhere, the local record is a stale copy
  // left over from before the roster -- or worse, an unrelated agent that merely
  // shares a name. Letting it win means a laptop's own "Henry" shadows the real
  // Henry on the Mini and dispatch silently goes to the wrong place. Observed:
  // doge1-2 shadowing Henry/Iris/Nora, and the Mini shadowing letta's Mike.
  const homeId = (() => { try { return fleetSelf()?.id ?? null; } catch { return null; } })();
  const bySlug = new Map<string, EmployeeManifest>();
  for (const m of fleetEmployeeManifests()) if (m.slug) bySlug.set(m.slug, m);
  for (const m of manifests) {
    if (!m.slug) continue;
    const declared = bySlug.get(m.slug) as (EmployeeManifest & { target?: string }) | undefined;
    if (!declared) {
      // No declaration anywhere: an agent only this machine knows about.
      bySlug.set(m.slug, { ...m, source: 'local-only' } as unknown as EmployeeManifest);
      continue;
    }
    if (homeId && declared.target === homeId) {
      bySlug.set(m.slug, { ...declared, ...m, source: 'fleet+local' } as unknown as EmployeeManifest);
    } else {
      // Keep the declaration authoritative; record that a shadowing copy exists.
      bySlug.set(m.slug, { ...declared, shadowedByLocalCopy: true } as unknown as EmployeeManifest);
    }
  }
  const poolsFile = readPoolsFile(target, teamRoot(target));
  return [...bySlug.values()]
    .map((m) => annotateEmployeeWithPool(m, poolsFile))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getEmployee(name: string, targetSpec?: string): EmployeeManifest & {
  resolvedSkills: SkillRef[];
  resolvedPlugins: string[];
  libraryCommit: string;
} {
  const target = resolveTarget(targetSpec);
  const manifest = readEmployee(target, name);
  const library = syncCapabilityLibrary(targetSpec);
  const capabilities = resolveEmployeeCapabilities(target, manifest, library.path);
  return {
    ...manifest,
    resolvedSkills: capabilities.skills,
    resolvedPlugins: capabilities.plugins,
    libraryCommit: library.commit,
  };
}

function resolveEmployeeCapabilities(
  target: Target,
  manifest: EmployeeManifest,
  root: string,
  extraSkills: string[] = [],
): { skills: SkillRef[]; plugins: string[] } {
  if (target.type === 'ssh') {
    const input = {
      rolePack: manifest.rolePack,
      skills: manifest.skills,
      plugins: manifest.plugins,
      extraSkills,
    };
    const python = `
import json
from pathlib import Path

root = Path(${JSON.stringify(root)})
request = json.loads(${JSON.stringify(JSON.stringify(input))})
approved = json.loads((root / "registry" / "approved.json").read_text())
revoked = {
    item["id"]
    for item in json.loads((root / "registry" / "revoked.json").read_text()).get("skills", [])
}
pack_path = root / "role-packs" / (request["rolePack"] + ".json")
if not pack_path.is_file():
    raise RuntimeError("unknown role pack: " + request["rolePack"])
pack = json.loads(pack_path.read_text())
ids = list(dict.fromkeys(pack.get("skills", []) + request["skills"] + request["extraSkills"]))
by_id = {skill["id"]: skill for skill in approved.get("skills", [])}
skills = []
for skill_id in ids:
    if skill_id in revoked:
        raise RuntimeError("skill is revoked: " + skill_id)
    if skill_id not in by_id:
        raise RuntimeError("skill is not approved: " + skill_id)
    skill = by_id[skill_id]
    path = root / skill["path"]
    if not path.is_file():
        raise RuntimeError("approved skill file is missing: " + str(path))
    skills.append({"name": skill_id, "path": str(path), "version": skill.get("version")})

plugins = list(dict.fromkeys(pack.get("plugins", []) + request["plugins"]))
approved_plugins = {
    plugin["id"]
    for plugin in json.loads((root / "registry" / "plugins.json").read_text()).get("plugins", [])
    if plugin.get("status") == "approved"
}
for plugin in plugins:
    if plugin not in approved_plugins:
        raise RuntimeError("plugin is not approved: " + plugin)

print(json.dumps({"skills": skills, "plugins": plugins}))
`.trim();
    return JSON.parse(targetExec(target, `python3 -c ${shellQuote(python)}`, 60000));
  }
  const approved = jsonOnTarget<{ skills: ApprovedSkill[] }>(target, `${root}/registry/approved.json`);
  const revoked = new Set(
    jsonOnTarget<{ skills: Array<{ id: string }> }>(target, `${root}/registry/revoked.json`)
      .skills.map((item) => item.id),
  );
  const packPath = `${root}/role-packs/${manifest.rolePack}.json`;
  if (!targetPathExists(target, packPath)) throw new Error(`unknown role pack: ${manifest.rolePack}`);
  const pack = jsonOnTarget<{ skills: string[]; plugins?: string[] }>(target, packPath);
  const ids = [...new Set([...(pack.skills || []), ...manifest.skills, ...extraSkills])];
  const byId = new Map(approved.skills.map((skill) => [skill.id, skill]));
  const skills = ids.map((id) => {
    if (revoked.has(id)) throw new Error(`skill is revoked: ${id}`);
    const skill = byId.get(id);
    if (!skill) throw new Error(`skill is not approved: ${id}`);
    const absolute = `${root}/${skill.path}`;
    if (!targetPathExists(target, absolute)) throw new Error(`approved skill file is missing: ${absolute}`);
    return { name: id, path: absolute, version: skill.version };
  });
  const plugins = [...new Set([...(pack.plugins || []), ...manifest.plugins])];
  const approvedPlugins = new Set(
    jsonOnTarget<{ plugins: Array<{ id: string; status: string }> }>(target, `${root}/registry/plugins.json`)
      .plugins.filter((plugin) => plugin.status === 'approved')
      .map((plugin) => plugin.id),
  );
  for (const plugin of plugins) {
    if (!approvedPlugins.has(plugin)) throw new Error(`plugin is not approved: ${plugin}`);
  }
  return {
    skills,
    plugins,
  };
}

export function syncEmployeePlugins(
  name: string,
  targetSpec?: string,
  installMissing = false,
): {
  employee: string;
  target: string;
  requirements: Array<{ id: string; installed: boolean; enabled: boolean; changed: boolean }>;
} {
  const target = resolveTarget(targetSpec);
  const manifest = readEmployee(target, name);
  const library = syncCapabilityLibrary(targetSpec);
  const capabilities = resolveEmployeeCapabilities(target, manifest, library.path);
  const readPluginList = () => targetExec(target, 'codex plugin list', 120000);
  let listing = readPluginList();
  const requirements = [];
  for (const id of capabilities.plugins) {
    const line = listing.split('\n').find((value) => value.trimStart().startsWith(`${id} `)) || '';
    let installed = /\binstalled\b/.test(line) && !/\bnot installed\b/.test(line);
    let enabled = installed && /\benabled\b/.test(line);
    let changed = false;
    if ((!installed || !enabled) && installMissing) {
      targetExec(target, `codex plugin add ${shellQuote(id)} --json`, 120000);
      listing = readPluginList();
      const updated = listing.split('\n').find((value) => value.trimStart().startsWith(`${id} `)) || '';
      installed = /\binstalled\b/.test(updated) && !/\bnot installed\b/.test(updated);
      enabled = installed && /\benabled\b/.test(updated);
      changed = true;
    }
    requirements.push({ id, installed, enabled, changed });
  }
  return { employee: manifest.name, target: target.name, requirements };
}

function employeePrompt(target: Target, manifest: EmployeeManifest, prompt: string, skills: SkillRef[]): string {
  const dir = employeeDir(target, manifest.slug);
  let charter = '';
  let memory = '';
  if (target.type === 'ssh') {
    const python = `
import json
from pathlib import Path
directory = Path(${JSON.stringify(dir)})
def read(name):
    path = directory / name
    return path.read_text() if path.is_file() else ""
print(json.dumps({"charter": read("CHARTER.md"), "memory": read("MEMORY.md")}))
`.trim();
    const files = JSON.parse(targetExec(target, `python3 -c ${shellQuote(python)}`, 60000));
    charter = String(files.charter || '').trim();
    memory = String(files.memory || '').trim();
  } else {
    charter = targetReadFile(target, `${dir}/CHARTER.md`).trim();
    memory = targetReadFile(target, `${dir}/MEMORY.md`).trim();
  }
  return [
    `You are ${manifest.name}, a managed long-lived team employee.`,
    `Assigned workspace: ${manifest.workspace}`,
    `Role pack: ${manifest.rolePack}`,
    `Attached skills: ${skills.map((skill) => `${skill.name}@${skill.version || 'unversioned'}`).join(', ') || 'none'}`,
    ``,
    `CHARTER`,
    charter || manifest.charter,
    ``,
    `DURABLE MEMORY`,
    memory || '(No durable memory recorded yet.)',
    ``,
    `TASK`,
    prompt,
  ].join('\n');
}

function writeTeamJob(job: TeamJob): void {
  mkdirSync(LOCAL_TEAM_JOBS, { recursive: true });
  writeFileSync(join(LOCAL_TEAM_JOBS, `${job.id}.json`), JSON.stringify(job, null, 2));
}

function readTeamJob(id: string): TeamJob | null {
  try { return JSON.parse(readFileSync(join(LOCAL_TEAM_JOBS, `${id}.json`), 'utf8')); }
  catch { return null; }
}

function fencedBlockAfter(message: string, label: string, language: string): string | null {
  const start = message.indexOf(label);
  if (start < 0) return null;
  const tail = message.slice(start + label.length);
  const fence = new RegExp('```' + language + '\\s*\\n([\\s\\S]*?)\\n```', 'i').exec(tail);
  return fence?.[1]?.trim() || null;
}

function markerBlock(message: string, name: string): string | null {
  const pattern = new RegExp(
    `---BEGIN_${name}---\\s*\\n([\\s\\S]*?)\\n---END_${name}---`,
    'i',
  );
  return pattern.exec(message)?.[1]?.trim() || null;
}

function materializeHarvest(job: TeamJob, message?: string): HarvestMaterialization | undefined {
  if (!job.harvest) return undefined;
  if (!message) return { status: 'not-found', note: 'completed without a harvest payload' };
  const skillName = job.harvest.skillName;
  const rawSkill = markerBlock(message, 'SKILL_MD')
    || fencedBlockAfter(message, '`SKILL.md`', 'md')
    || fencedBlockAfter(message, 'SKILL.md', 'markdown');
  if (!rawSkill) {
    return { status: 'not-found', note: 'final response did not contain a recognizable SKILL.md block' };
  }
  const root = LOCAL_LIBRARY_OVERRIDE
    || (existsSync(LOCAL_DEVELOPMENT_LIBRARY)
      ? LOCAL_DEVELOPMENT_LIBRARY
      : join(homedir(), '.gpt5mcp', 'team-agent-capabilities'));
  if (!existsSync(join(root, '.git'))) {
    return { status: 'not-found', note: `local capability library is unavailable at ${root}` };
  }
  const relativeDir = `candidates/session-harvest/${job.employeeSlug}/${skillName}`;
  const dir = join(root, relativeDir);
  const skillPath = join(dir, 'SKILL.md');
  if (existsSync(skillPath)) return { status: 'already-exists', path: skillPath };

  let skill = rawSkill;
  if (!skill.startsWith('---\n')) {
    const description = `Use when applying the harvested ${skillName.replace(/-/g, ' ')} workflow from ${job.employee}.`;
    skill = `---\nname: ${skillName}\ndescription: ${description}\n---\n\n${skill}`;
  }
  const rawProvenance = markerBlock(message, 'PROVENANCE_JSON')
    || fencedBlockAfter(message, '`PROVENANCE.json`', 'json')
    || fencedBlockAfter(message, 'PROVENANCE.json', 'json');
  let agentProvenance: Record<string, unknown> = {};
  try { if (rawProvenance) agentProvenance = JSON.parse(rawProvenance); } catch {}
  const provenance = {
    ...agentProvenance,
    schemaVersion: 1,
    sourceType: 'codex-session',
    sourceName: job.employee,
    sourceTarget: job.target,
    sourceThreadId: undefined,
    createdAt: new Date().toISOString(),
    containsTranscript: false,
    containsSecrets: false,
    confidence: agentProvenance.confidence || 'medium',
    suggestedRolePacks: agentProvenance.suggestedRolePacks || ['general'],
    notes: `Quarantined output captured by team_skill_harvest job ${job.id}; requires human audit before approval.`,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(skillPath, `${skill.trim()}\n`);
  writeFileSync(join(dir, 'PROVENANCE.json'), `${JSON.stringify(provenance, null, 2)}\n`);

  const registryPath = join(root, 'registry', 'candidates.json');
  try {
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    const skills = Array.isArray(registry.skills) ? registry.skills : [];
    if (!skills.some((item: any) => item.id === skillName && item.path === `${relativeDir}/SKILL.md`)) {
      skills.push({
        id: skillName,
        path: `${relativeDir}/SKILL.md`,
        source: `session:${job.employeeSlug}`,
        jobId: job.id,
        status: 'quarantined',
        reason: 'Generated from a durable session; requires semantic and security review.',
      });
      registry.skills = skills;
      writeFileSync(registryPath, `${JSON.stringify(registry, null, 2)}\n`);
    }
  } catch {}
  return { status: 'written', path: skillPath };
}

function newTeamJobId(prefix: 'te' | 'tb'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function dispatchBridge(
  target: Target,
  manifest: EmployeeManifest,
  prompt: string,
  skills: SkillRef[],
  libraryCommit: string,
  model: string | undefined,
  reasoningEffort: EmployeeEffort,
  label?: string,
): TeamJob {
  const id = newTeamJobId('tb');
  const remotePath = `${targetHome(target)}/.gpt5mcp/bridge-jobs/${id}.json`;
  const body = Buffer.from(JSON.stringify({
    job_id: id,
    prompt,
    label: label || `${manifest.name} MCP dispatch`,
    notify_telegram: manifest.bridge?.notifyTelegram !== false,
    model,
    reasoning_effort: reasoningEffort,
    cwd: manifest.workspace,
  }), 'utf8').toString('base64');
  const tokenPath = `${targetHome(target)}/.gpt5mcp/bridge-token`;
  const python = [
    `import base64,json,pathlib,urllib.request`,
    `body=base64.b64decode(${JSON.stringify(body)})`,
    `token=pathlib.Path(${JSON.stringify(tokenPath)}).read_text().strip()`,
    `req=urllib.request.Request(${JSON.stringify(`http://127.0.0.1:${manifest.bridge!.port}/dispatch`)},data=body,method="POST",headers={"Content-Type":"application/json","X-Dispatch-Token":token})`,
    `print(urllib.request.urlopen(req,timeout=15).read().decode())`,
  ].join(';');
  const response = targetExec(target, `python3 -c ${shellQuote(python)}`, 30000);
  const parsed = JSON.parse(response);
  if (parsed.job_id !== id) throw new Error(`bridge returned unexpected job id: ${response.slice(0, 300)}`);
  const job: TeamJob = {
    schemaVersion: 1,
    id,
    kind: 'bridge',
    employee: manifest.name,
    employeeSlug: manifest.slug,
    target: manifest.target,
    createdAt: new Date().toISOString(),
    bridgeJobPath: remotePath,
    skills,
    libraryCommit,
    model,
    reasoningEffort,
  };
  writeTeamJob(job);
  return job;
}

export function dispatchEmployee(args: TeamDispatchArgs): {
  job: TeamJob;
  session?: SessMeta;
  plugins: string[];
  poolWarning?: string;
} {
  const target = resolveTarget(args.target);
  const manifest = readEmployee(target, args.employee);
  const poolsFile = readPoolsFile(target, teamRoot(target));
  const gate = evaluatePoolGate(poolsFile, manifest.name, manifest.slug, args.force === true);
  if (gate.blocked) throw new Error(gate.blocked);
  const library = args.syncLibrary === false
    ? {
        target: target.name,
        path: libraryRoot(target),
        commit: targetTry(target, `git -C ${shellQuote(libraryRoot(target))} rev-parse HEAD`).out.trim(),
        changed: false,
      }
    : syncCapabilityLibrary(args.target);
  const capabilities = resolveEmployeeCapabilities(target, manifest, library.path, args.extraSkills);
  const prompt = employeePrompt(target, manifest, args.prompt, capabilities.skills);
  const model = args.model || manifest.model;
  const reasoningEffort = args.reasoningEffort || manifest.reasoningEffort;

  if (manifest.bridge) {
    const bridgePrompt = [
      ...capabilities.skills.map((skill) => (
        `Use the approved skill ${skill.name} by reading ${skill.path} before doing the task.`
      )),
      prompt,
    ].join('\n');
    return {
      job: dispatchBridge(
        target,
        manifest,
        bridgePrompt,
        capabilities.skills,
        library.commit,
        model,
        reasoningEffort,
        args.label,
      ),
      plugins: capabilities.plugins,
      poolWarning: gate.warning,
    };
  }

  const start: StartOpts = {
    prompt,
    cwd: manifest.workspace,
    model,
    sandbox: args.sandbox || manifest.sandbox,
    effort: reasoningEffort,
    label: args.label || `${manifest.name}: ${args.prompt.slice(0, 60)}`,
    target: manifest.target,
    threadId: manifest.threadId,
    skills: capabilities.skills,
    employee: manifest.slug,
  };
  const session = startSession(start);
  const id = newTeamJobId('te');
  const job: TeamJob = {
    schemaVersion: 1,
    id,
    kind: 'codex',
    employee: manifest.name,
    employeeSlug: manifest.slug,
    target: manifest.target,
    createdAt: new Date().toISOString(),
    codexJobId: session.id,
    skills: capabilities.skills,
    libraryCommit: library.commit,
    model,
    reasoningEffort,
  };
  writeTeamJob(job);
  return { job, session, plugins: capabilities.plugins, poolWarning: gate.warning };
}

function persistEmployeeThread(job: TeamJob, threadId?: string): void {
  if (!threadId) return;
  const target = resolveTarget(job.target);
  try {
    const manifest = readEmployee(target, job.employeeSlug);
    if (manifest.threadId === threadId) return;
    manifest.threadId = threadId;
    manifest.updatedAt = new Date().toISOString();
    saveEmployee(target, manifest);
  } catch {}
}

function bridgeJob(job: TeamJob): any {
  const target = resolveTarget(job.target);
  const raw = job.bridgeJobPath ? targetReadFile(target, job.bridgeJobPath) : '';
  if (!raw) return { job_id: job.id, state: 'queued' };
  try { return JSON.parse(raw); }
  catch { return { job_id: job.id, state: 'failed', error: 'invalid bridge job state' }; }
}

export function teamJobStatus(id: string, maxEvents = 40): any {
  const job = readTeamJob(id);
  if (!job) throw new Error(`unknown team job: ${id}`);
  if (job.kind === 'bridge') {
    return {
      ...bridgeJob(job),
      team_job_id: job.id,
      employee: job.employee,
      target: job.target,
      skills: job.skills,
      libraryCommit: job.libraryCommit,
    };
  }
  const session = getSession(job.codexJobId!);
  if (!session) throw new Error(`missing Codex job: ${job.codexJobId}`);
  persistEmployeeThread(job, session.threadId);
  return {
    team_job_id: job.id,
    employee: job.employee,
    target: job.target,
    state: session.state,
    codex_job_id: session.id,
    threadId: session.threadId,
    turnId: session.turnId,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    error: session.error,
    skills: job.skills,
    libraryCommit: job.libraryCommit,
    model: job.model,
    reasoningEffort: job.reasoningEffort,
    events: sessionEvents(session.id, maxEvents),
  };
}

export function teamJobResult(id: string): any {
  const job = readTeamJob(id);
  if (!job) throw new Error(`unknown team job: ${id}`);
  if (job.kind === 'bridge') {
    const state = bridgeJob(job);
    return {
      ...state,
      team_job_id: job.id,
      employee: job.employee,
      target: job.target,
      skills: job.skills,
      libraryCommit: job.libraryCommit,
      harvestCandidate: state.state === 'completed'
        ? materializeHarvest(job, state.result)
        : undefined,
    };
  }
  const session = getSession(job.codexJobId!);
  if (!session) throw new Error(`missing Codex job: ${job.codexJobId}`);
  persistEmployeeThread(job, session.threadId);
  if (session.state === 'starting' || session.state === 'running') {
    return { team_job_id: job.id, employee: job.employee, state: session.state };
  }
  const finalMessage = sessionFinalMessage(session.id);
  return {
    team_job_id: job.id,
    employee: job.employee,
    target: job.target,
    state: session.state,
    error: session.error,
    threadId: session.threadId,
    skills: job.skills,
    libraryCommit: job.libraryCommit,
    model: job.model,
    reasoningEffort: job.reasoningEffort,
    filesChanged: sessionChangedFiles(session.id),
    finalMessage,
    harvestCandidate: materializeHarvest(job, finalMessage),
  };
}

export function harvestEmployeeKnowledge(args: {
  employee: string;
  target?: string;
  skillName: string;
  topic: string;
  label?: string;
}): { job: TeamJob; session?: SessMeta; plugins: string[] } {
  const skillName = slugify(args.skillName);
  const result = dispatchEmployee({
    employee: args.employee,
    target: args.target,
    label: args.label || `${args.employee}: harvest ${skillName}`,
    extraSkills: ['harvest-session-knowledge'],
    prompt: [
      `Synthesize your durable knowledge about this topic into a candidate skill named ${skillName}:`,
      args.topic,
      ``,
      `Use the attached harvest-session-knowledge skill. Do not expose secrets or raw conversation text.`,
      `Write the candidate into the capability library when your sandbox permits it.`,
      `If the library is outside your writable roots, return the complete SKILL.md and PROVENANCE.json in your final response so the caller can submit it.`,
      `For reliable capture, wrap them exactly as:`,
      `---BEGIN_SKILL_MD---`,
      `(complete SKILL.md including YAML frontmatter)`,
      `---END_SKILL_MD---`,
      `---BEGIN_PROVENANCE_JSON---`,
      `(valid JSON)`,
      `---END_PROVENANCE_JSON---`,
      `Do not modify registry/approved.json.`,
    ].join('\n'),
  });
  const stored = readTeamJob(result.job.id)!;
  stored.harvest = { skillName, topic: args.topic };
  writeTeamJob(stored);
  result.job = stored;
  return result;
}
