#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { callGPT5, callGPT5WithMessages, generateImage } from './utils.js';
import {
  startSession, steerSession, interruptSession, getSession, listSessions,
  sessionEvents, sessionFinalMessage, sessionChangedFiles,
} from './codexSession.js';
import {
  dispatchEmployee, fireEmployee, getEmployee, harvestEmployeeKnowledge, hireEmployee,
  listEmployees, syncCapabilityLibrary, syncEmployeePlugins, teamJobResult, teamJobStatus,
  updateEmployee,
} from './team.js';

// Initialize environment from parent directory
import { dirname } from 'path';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const envPath = path.join(__dirname, '../../.env');
dotenv.config({ path: envPath });
console.error("Environment loaded from:", envPath);

// Schema definitions
const GPT5GenerateSchema = z.object({
  input: z.string().describe("The input text or prompt for GPT-5"),
  model: z.string().optional().describe("GPT-5 model variant to use (via Codex CLI). Omit to use the codex CLI's own configured default model — never hardcoded here."),
  instructions: z.string().optional().describe("System instructions for the model"),
  reasoning_effort: z.enum(['low', 'medium', 'high']).optional().describe("Reasoning effort level"),
  max_tokens: z.number().optional().describe("Maximum tokens to generate"),
  temperature: z.number().min(0).max(2).optional().describe("Temperature for randomness (0-2)"),
  top_p: z.number().min(0).max(1).optional().describe("Top-p sampling parameter")
});

const GPT5MessagesSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['user', 'developer', 'assistant']).describe("Message role"),
    content: z.string().describe("Message content")
  })).describe("Array of conversation messages"),
  model: z.string().optional().describe("GPT-5 model variant to use (via Codex CLI). Omit to use the codex CLI's own configured default model — never hardcoded here."),
  instructions: z.string().optional().describe("System instructions for the model"),
  reasoning_effort: z.enum(['low', 'medium', 'high']).optional().describe("Reasoning effort level"),
  max_tokens: z.number().optional().describe("Maximum tokens to generate"),
  temperature: z.number().min(0).max(2).optional().describe("Temperature for randomness (0-2)"),
  top_p: z.number().min(0).max(1).optional().describe("Top-p sampling parameter")
});


const GPT5ImageSchema = z.object({
  scene: z.string().describe("Detailed scene description for the image to generate"),
  out_path: z.string().describe("Absolute path where the PNG should be saved (e.g. /tmp/out/shot.png)"),
  aspect: z.enum(['9:16', '16:9', '1:1']).optional().default('9:16').describe("Aspect ratio")
});

// --- Codex worker: ONE steerable async engine (app-server sessions) ---
// codex_dispatch starts a detached, STEERABLE job and returns a job_id instantly
// (non-blocking). Every dispatched job can be watched (codex_status), steered
// mid-run (codex_steer), interrupted (codex_interrupt), and collected
// (codex_result) — all by the same job_id.
const CodexDispatchSchema = z.object({
  prompt: z.string().describe("The full spec/task for the Codex worker. Be tight and self-contained — Codex does the build/codemod/test grind unattended."),
  target: z.string().optional().default("local").describe("Where to run: 'local' (this machine, default), a preset like 'mini' (the Mac Mini over Tailscale), or a raw 'user@host'. REMOTE jobs survive the laptop closing — reconnect later with codex_status."),
  repo: z.string().optional().describe("REMOTE only: GitHub slug 'owner/name'. The remote worker clones it (or fetch+pulls if present) into its work root, works on a job branch, and opens a PR. Ignored for local."),
  branch: z.string().optional().describe("REMOTE only: base branch to start from (default 'main')."),
  require_codex_match: z.boolean().optional().default(true).describe("REMOTE only: refuse to dispatch unless the remote codex exists and its major.minor matches local (avoids running on an outdated/incompatible codex). Set false to override."),
  cwd: z.string().optional().describe("LOCAL only: working directory (defaults to server CWD). For remote, the workdir is derived from repo."),
  model: z.string().optional().describe("Codex model. Omit to use the codex CLI's own configured default model — never hardcoded here."),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional().default('danger-full-access').describe("Execution sandbox. danger-full-access = files + commands + network, unattended (default)."),
  reasoning_effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional().describe("Codex reasoning effort"),
  label: z.string().optional().describe("Short human label for the job")
});

const CodexDeploySchema = z.object({
  task: z.string().describe("The deployment or vendor-infra task. Do not include secret values."),
  deploy_type: z.enum([
    'appstore_status',
    'appstore_testflight',
    'cloudflare_pages',
    'cloudflare_worker',
    'vendor_infra',
    'custom',
  ]).describe("Deployment profile/guardrail set to apply."),
  target: z.string().optional().default("mini").describe("Where to run the deployment worker. Defaults to the Mac Mini target."),
  repo_path: z.string().optional().describe("Absolute path to an existing repo/worktree on the target host. Preferred for deploys."),
  repo: z.string().optional().describe("GitHub slug owner/name if the worker must clone/fetch it itself. For deploys, repo_path is preferred."),
  branch: z.string().optional().default("main").describe("Branch to checkout/fetch if repo is supplied and repo_path is not."),
  allow_mutations: z.boolean().optional().default(false).describe("If false, the worker must stop after read-only status/preflight/dry-run checks. Set true for actual deploy/upload/vendor mutations."),
  allow_app_store_submit: z.boolean().optional().default(false).describe("If false, never press/call final App Store submission/resubmission. Owner approval is required."),
  allow_browser_dashboard: z.boolean().optional().default(false).describe("If false, do not use Chrome/vendor dashboards; stop and report if browser login/dashboard work is required."),
  queue_entry: z.string().optional().describe("Optional vendor handoff queue entry id/app name/line reference to claim and update."),
  health_check_urls: z.array(z.string()).optional().default([]).describe("Public URLs to smoke-check after a scoped mutation."),
  asc_key_path: z.string().optional().default("/Users/ellaai/.codex/secrets/app-store-connect/AuthKey_J77JD8RJXF.p8").describe("Remote App Store Connect API private key path. Path only; never print contents."),
  env_candidate_path: z.string().optional().default("/Users/ellaai/.hermes/profiles/plato-eval/.env.cloudflare-candidate").describe("Remote candidate env file path. Source selectively; never print values."),
  model: z.string().optional().describe("Codex model. Omit to use the codex CLI's own configured default model — never hardcoded here."),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional().default('danger-full-access').describe("Execution sandbox. Deploy preflight may need commands/network; actual deploys need mutations explicitly allowed."),
  reasoning_effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional().default('high').describe("Codex reasoning effort"),
  label: z.string().optional().describe("Short human label for the deploy job")
});

const CodexStatusSchema = z.object({
  job_id: z.string().optional().describe("Job id to check (the value returned by codex_dispatch). Omit to list ALL jobs."),
  events: z.number().optional().default(40).describe("How many recent events to return (assistant text + turn lifecycle = what Codex is doing now)")
});

const CodexResultSchema = z.object({
  job_id: z.string().describe("Job id to collect the final result from")
});

const CodexSteerSchema = z.object({
  job_id: z.string().describe("Job id to steer (from codex_dispatch)"),
  text: z.string().describe("Guidance to inject into the running turn (e.g. 'stop, that's wrong — do X instead'). Codex picks it up mid-execution.")
});

const CodexInterruptSchema = z.object({
  job_id: z.string().describe("Job id to interrupt (sends turn/interrupt; keeps the thread)")
});

const TeamHireSchema = z.object({
  name: z.string().min(1).describe("Stable employee name, for example Sophia or a new hire such as Olivia"),
  target: z.string().optional().default("local").describe("Dispatch target that owns the employee state: local, mini, a preset, or user@host"),
  workspace: z.string().describe("Absolute workspace folder on the target"),
  role_pack: z.string().optional().default("general").describe("Role pack from the capability library"),
  skills: z.array(z.string()).optional().default([]).describe("Additional approved skill ids"),
  plugins: z.array(z.string()).optional().default([]).describe("Additional plugin ids recorded as requirements"),
  charter: z.string().optional().describe("Employee-specific role and boundaries"),
  model: z.string().optional().describe("Codex model override; omit for role/default configuration"),
  reasoning_effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  bridge_port: z.number().int().min(1).max(65535).optional().describe("Existing Telegram bridge port. When set, team_dispatch queues into that bridge's durable session."),
  telegram_bot: z.string().optional().describe("Safe bot username metadata, for example @MacMiniCodexIOS_bot"),
  notify_telegram: z.boolean().optional().default(true).describe("For bridge employees, also deliver progress/results to Telegram"),
});

const TeamUpdateSchema = z.object({
  name: z.string().min(1),
  target: z.string().optional().default("local"),
  workspace: z.string().optional(),
  role_pack: z.string().optional(),
  skills: z.array(z.string()).optional(),
  plugins: z.array(z.string()).optional(),
  charter: z.string().optional(),
  model: z.string().optional(),
  reasoning_effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  bridge_port: z.number().int().min(1).max(65535).nullable().optional().describe("Set a bridge port, or null to remove the bridge binding"),
  telegram_bot: z.string().optional(),
  notify_telegram: z.boolean().optional(),
});

const TeamEmployeeSchema = z.object({
  name: z.string().min(1),
  target: z.string().optional().default("local"),
});

const TeamListSchema = z.object({
  target: z.string().optional().default("local"),
  include_archived: z.boolean().optional().default(false),
});

const TeamFireSchema = z.object({
  name: z.string().min(1),
  target: z.string().optional().default("local"),
  purge: z.boolean().optional().default(false).describe("False archives recoverably. True permanently deletes this employee's local team state."),
});

const TeamDispatchSchema = z.object({
  employee: z.string().min(1),
  target: z.string().optional().default("local"),
  prompt: z.string().min(1),
  model: z.string().optional(),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
  reasoning_effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional(),
  label: z.string().optional(),
  sync_library: z.boolean().optional().default(true),
  extra_skills: z.array(z.string()).optional().default([]).describe("Additional approved skills for this one assignment"),
});

const TeamJobSchema = z.object({
  job_id: z.string().min(1).describe("Team job id returned by team_dispatch or team_skill_harvest"),
  events: z.number().int().min(1).max(200).optional().default(40),
});

const TeamHarvestSchema = z.object({
  employee: z.string().min(1).describe("Managed employee or existing Telegram-backed employee whose durable session should synthesize the knowledge"),
  target: z.string().optional().default("local"),
  skill_name: z.string().min(1).describe("Proposed lowercase skill name; normalized to hyphen-case"),
  topic: z.string().min(1).describe("What durable workflows or learned behavior to extract"),
  label: z.string().optional(),
});

const TeamLibrarySyncSchema = z.object({
  target: z.string().optional().default("local"),
  ref: z.string().optional().default("main").describe("Exact branch, tag, or ref to sync"),
});

const TeamPluginSyncSchema = z.object({
  employee: z.string().min(1),
  target: z.string().optional().default("local"),
  install_missing: z.boolean().optional().default(false).describe("Install missing approved plugins from their pinned marketplace selector"),
});


// Type definitions
type GPT5GenerateArgs = z.infer<typeof GPT5GenerateSchema>;
type GPT5ImageArgs = z.infer<typeof GPT5ImageSchema>;
type GPT5MessagesArgs = z.infer<typeof GPT5MessagesSchema>;
type CodexDispatchArgs = z.infer<typeof CodexDispatchSchema>;
type CodexDeployArgs = z.infer<typeof CodexDeploySchema>;
type CodexStatusArgs = z.infer<typeof CodexStatusSchema>;
type CodexResultArgs = z.infer<typeof CodexResultSchema>;
type CodexSteerArgs = z.infer<typeof CodexSteerSchema>;
type CodexInterruptArgs = z.infer<typeof CodexInterruptSchema>;
type TeamHireArgs = z.infer<typeof TeamHireSchema>;
type TeamUpdateArgs = z.infer<typeof TeamUpdateSchema>;
type TeamEmployeeArgs = z.infer<typeof TeamEmployeeSchema>;
type TeamListArgs = z.infer<typeof TeamListSchema>;
type TeamFireArgs = z.infer<typeof TeamFireSchema>;
type TeamDispatchToolArgs = z.infer<typeof TeamDispatchSchema>;
type TeamJobArgs = z.infer<typeof TeamJobSchema>;
type TeamHarvestArgs = z.infer<typeof TeamHarvestSchema>;
type TeamLibrarySyncArgs = z.infer<typeof TeamLibrarySyncSchema>;
type TeamPluginSyncArgs = z.infer<typeof TeamPluginSyncSchema>;

// Usage doc exposed as an MCP resource so connecting clients can fetch a
// human-readable README through the protocol (in addition to tools/list, which
// already exposes every tool's param schema).
const README = `# gpt5-server (MCP)

Drives the **Codex CLI** (ChatGPT OAuth) — no OPENAI_API_KEY, no credits.
Run \`codex login\` once if not authenticated. Model defaults to the codex CLI's own configured default (~/.codex/config.toml) unless overridden per call.

## Tools
- **gpt5_generate** { input, model? (defaults to the codex CLI's configured default), instructions?, reasoning_effort?, max_tokens?, temperature?, top_p? }
  → text. Single-prompt generation via \`codex exec\`.
- **gpt5_messages** { messages:[{role,content}], model? (defaults to the codex CLI's configured default), instructions?, reasoning_effort?, ... }
  → text. Multi-turn transcript rendered into one Codex prompt.
- **gpt5_image** { scene, out_path (absolute), aspect?=9:16|16:9|1:1 }
  → saves a PNG to out_path FOR FREE (Codex built-in image tool / gpt-image). Returns the saved path.

## Codex worker (ONE steerable async engine, subagent-style)
Every dispatched job runs a detached, STEERABLE app-server session. Dispatch is
non-blocking; you watch, course-correct, and collect by the same job_id.
- **codex_dispatch** { prompt, target?=local, repo?, branch?, cwd?, model?, sandbox?, reasoning_effort?, label? }
  -> { job_id, state } IMMEDIATELY (non-blocking).
  - **target** = 'local' (default), a preset like 'mini' (Mac Mini over Tailscale,
    from ~/.gpt5mcp/targets.json), or a raw 'user@host'. A REMOTE job's driver +
    codex run ON THE REMOTE, so it SURVIVES the laptop closing / Claude quitting —
    reconnect any time with codex_status (it reads the remote job dir over SSH).
  - **repo / branch** (remote only): the worker clones owner/name (or fetch+pulls
    if present) into its work root, works on a codex/<job_id> branch, and opens a
    PR when done. cwd is for LOCAL jobs.
  - **Preflight (remote):** before dispatch, the remote codex must exist and its
    major.minor must match local (so you never run on an outdated/incompatible
    codex). Mismatch -> dispatch fails with the fix command. Override with
    require_codex_match=false.
  - **Config self-heal (local + remote):** before launch, the codex config is
    probed with --strict-config; if the Codex desktop app rewrote it with an
    invalid top-level field (this has happened with service_tier), the offending
    line is backed up + commented out so the job isn't broken. A [table]-header
    error is reported, not auto-edited. Surfaced as configFixed in the result.
  - **Remote bootstrap robustness:** the work root is created/verified before
    launch (fast clear failure if it can't be made), a global git identity is set
    on the remote if missing (so freshly-cloned repos can commit), and the git
    prelude tells Codex to STOP + report stderr on any setup failure. Setup
    failures surface in codex_result's finalMessage (the failing command + its
    stderr) instead of an empty state:failed.
- **codex_status** { job_id?, events? } -> { state: starting|running|completed|failed, threadId,
  turnId, events[] }. The events are what Codex is doing now (assistant text + turn lifecycle).
  Omit job_id to list all jobs.
- **codex_steer** { job_id, text } -> injects guidance into the RUNNING turn (turn/steer),
  e.g. "stop, that's wrong — do X". Codex picks it up mid-execution. Works on ANY dispatched job.
- **codex_interrupt** { job_id } -> turn/interrupt (stop the turn, keep the thread).
- **codex_result** { job_id } -> { state, filesChanged, finalMessage } once finished.
Jobs persist under ~/.gpt5mcp/codex-sessions/ and survive a restart.
Pattern: dispatch -> watch on your own schedule -> steer if it's drifting -> collect.
- **codex_deploy** { task, deploy_type, target?=mini, repo_path?, repo?, branch?, allow_mutations?=false,
  allow_app_store_submit?=false, allow_browser_dashboard?=false, queue_entry?, health_check_urls? }
  -> starts the same steerable Codex worker with deployment guardrails for App Store/TestFlight,
  Cloudflare Pages/Workers, or vendor-infra queue work. Defaults to read-only/preflight; set
  allow_mutations=true for actual uploads/deploys. It never allows final App Store submission unless
  allow_app_store_submit=true. Secret values must stay in remote env files/dashboard secrets, never prompts.

## Managed team employees
Employees are target-scoped, pinned to an absolute workspace, and resume their
durable Codex thread. Approved skills are attached as native app-server skill
inputs; quarantined or revoked skills are rejected.
- **team_hire** / **team_update** / **team_list** / **team_get** / **team_fire**
  manage named employees. Fire archives by default; purge is explicit.
- **team_dispatch** starts a non-blocking employee job. Existing Telegram
  employees queue through their loopback-only authenticated bridge and can
  return the result to both the MCP job ledger and Telegram.
- **team_status** / **team_result** inspect and collect direct or bridge jobs.
- **team_library_sync** installs or updates the private versioned capability
  library on local or remote targets.
- **team_plugin_sync** checks an employee's approved plugin requirements and
  can install missing marketplace plugins explicitly.
- **team_skill_harvest** asks an existing durable session to synthesize learned
  workflow into a quarantined candidate skill for human audit and promotion.

## Notes
- Image gen is agentic (the model writes the file); allow up to ~4 min.
- API-only model snapshots are irrelevant here — the CLI session picks the backing model.
- Full machine-readable param schemas: call \`tools/list\`.
`;

function buildDeployPrompt(args: CodexDeployArgs): string {
  const urls = args.health_check_urls.length
    ? args.health_check_urls.map((u) => `- ${u}`).join('\n')
    : '- None supplied; infer only from repo/config/docs and report what was checked.';
  const repoSetup = args.repo_path
    ? [
        `Preferred repo/worktree on target host: ${args.repo_path}`,
        `Start by verifying it exists: cd '${args.repo_path}' && git status --short --branch.`,
      ].join('\n')
    : args.repo
      ? [
          `Repo slug to prepare on target host: ${args.repo}`,
          `Use ~/dev as work root unless a local convention says otherwise.`,
          `If the repo directory exists, fetch and checkout ${args.branch}; otherwise clone it, then checkout ${args.branch}.`,
        ].join('\n')
      : `No repo path/slug supplied. Work from the current target host context and stop if a repo is required.`;

  const deployRules: Record<CodexDeployArgs['deploy_type'], string> = {
    appstore_status: [
      `App Store profile: read-only status/preflight unless allow_mutations is true.`,
      `Use ASC env path only by reference: ${args.asc_key_path}. Never print private key contents.`,
      `Export ASC_KEY_ID=J77JD8RJXF, ASC_ISSUER_ID=5ed3a276-d6c0-43eb-ba70-13eed9b35a7e, ASC_KEY_PATH=${args.asc_key_path}, ASC_BETA_GROUP_NAME="External Beta" when running deployer status/preflight commands.`,
      `Check App Store subscription/paywall and AI/data-consent gates when relevant.`,
    ].join('\n'),
    appstore_testflight: [
      `App Store/TestFlight profile: archive/upload/TestFlight work is allowed only when allow_mutations is true.`,
      `Use ASC env path only by reference: ${args.asc_key_path}. Never print private key contents.`,
      `Export ASC_KEY_ID=J77JD8RJXF, ASC_ISSUER_ID=5ed3a276-d6c0-43eb-ba70-13eed9b35a7e, ASC_KEY_PATH=${args.asc_key_path}, ASC_BETA_GROUP_NAME="External Beta" before scripts/appstore-deploy.mjs commands.`,
      `Use --allow-provisioning-updates for automatic signing. Missing local distribution cert is not a blocker with automatic signing + ASC API credentials.`,
      `Do not final-submit App Store review/resubmission unless allow_app_store_submit is true.`,
    ].join('\n'),
    cloudflare_pages: [
      `Cloudflare Pages profile: deploy only when allow_mutations is true; otherwise run build/status/dry-run/read-only checks.`,
      `Candidate env path on target: ${args.env_candidate_path}. Source/select variables only if needed; never echo values.`,
      `Before Cloudflare/DNS/provider-secret mutations, read /Users/ellaai/ai-company/infra/CLOUDFLARE_VENDOR_CONTEXT.md and /Users/ellaai/ai-company/infra/imports/cloudflare-vendor-infra-status.md.`,
      `Prefer repo package scripts such as npm run cf:deploy over ad hoc wrangler commands.`,
    ].join('\n'),
    cloudflare_worker: [
      `Cloudflare Worker profile: deploy only when allow_mutations is true; otherwise run build/status/dry-run/read-only checks.`,
      `Candidate env path on target: ${args.env_candidate_path}. Source/select variables only if needed; never echo values.`,
      `Before Cloudflare/DNS/provider-secret mutations, read /Users/ellaai/ai-company/infra/CLOUDFLARE_VENDOR_CONTEXT.md and /Users/ellaai/ai-company/infra/imports/cloudflare-vendor-infra-status.md.`,
      `Inspect existing bindings/routes/secrets by name only before mutation; do not overwrite unrelated live app infra.`,
    ].join('\n'),
    vendor_infra: [
      `Vendor infra profile: use the shared queue protocol when a queue entry is supplied.`,
      `Queue path: /Users/greg/.codex/notes/vendor-handoff-queue.md may not exist on the Mini; if unavailable, use the repo/global notes available on the target and report the limitation.`,
      `If queue_entry is supplied, claim only that entry. Do not work on unrelated IN_PROGRESS or DONE entries.`,
      `Browser/dashboard work requires allow_browser_dashboard=true and an existing logged-in Chrome/vendor session on the target. If not available, stop and report the login/dashboard blocker.`,
      `Never write secrets to Markdown, queue files, GitHub, logs, or chat.`,
    ].join('\n'),
    custom: `Custom deployment profile. Apply the global rules below strictly and stop before any unclear or risky mutation.`,
  };

  return [
    `You are a remote deployment worker launched by the gpt5 MCP dispatcher.`,
    `Deploy type: ${args.deploy_type}`,
    `Mutation gate: allow_mutations=${args.allow_mutations}`,
    `App Store final submit gate: allow_app_store_submit=${args.allow_app_store_submit}`,
    `Browser/vendor dashboard gate: allow_browser_dashboard=${args.allow_browser_dashboard}`,
    args.queue_entry ? `Queue entry: ${args.queue_entry}` : `Queue entry: none supplied`,
    ``,
    `GLOBAL SAFETY RULES`,
    `- Do not print, paste, commit, or write secret values anywhere. Redact all token/key values in final output.`,
    `- If allow_mutations=false, do read-only checks, status, preflight, dry-run, and planning only. Stop before deploy/upload/dashboard/API mutations.`,
    `- If allow_mutations=true, mutate only the explicitly scoped app/resource from this task.`,
    `- For iOS/App Store subscription or AI/camera/vision/audio/transcript apps, verify the relevant App Store data-consent and subscription/paywall gates before any submission-related work.`,
    `- Do not press/call final App Store submission/resubmission unless allow_app_store_submit=true and the task explicitly asks for it.`,
    `- For Cloudflare/DNS/provider-secret work, inspect live app registry/context first and run scoped health checks after mutation.`,
    `- Prefer existing repo scripts and config over hand-written commands.`,
    `- Keep a concise audit trail: commands run, files changed, deploy IDs/build numbers, health checks, and blockers. Do not include secrets.`,
    ``,
    `REPO SETUP`,
    repoSetup,
    ``,
    `PROFILE RULES`,
    deployRules[args.deploy_type],
    ``,
    `POST-MUTATION HEALTH CHECK URLS`,
    urls,
    ``,
    `TASK`,
    args.task,
  ].join('\n');
}

// Main function
async function main() {
  // No OPENAI_API_KEY needed — this server drives the Codex CLI, which uses the
  // logged-in ChatGPT account. (Run `codex login` once if not authenticated.)

  // Create MCP server
  const server = new Server({
    name: "gpt5-server",
    version: "0.1.0"
  }, {
    capabilities: {
      tools: {},
      resources: {}
    }
  });

  // Set up error handling
  server.onerror = (error) => {
    console.error("MCP Server Error:", error);
  };

  process.on('SIGINT', async () => {
    await server.close();
    process.exit(0);
  });

  // Resource handlers — expose the usage README at usage://readme
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "usage://readme",
        name: "gpt5-server usage",
        description: "How to use this server's tools (Codex CLI / ChatGPT OAuth)",
        mimeType: "text/markdown",
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === "usage://readme") {
      return {
        contents: [
          { uri: "usage://readme", mimeType: "text/markdown", text: README },
        ],
      };
    }
    throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${request.params.uri}`);
  });

  // Set up tool handlers
  server.setRequestHandler(
    ListToolsRequestSchema,
    async () => {
      console.error("Handling ListToolsRequest");
      return {
        tools: [
          {
            name: "gpt5_generate",
            description: "Generate text using GPT-5 (via the Codex CLI / ChatGPT auth, using its configured default model unless overridden) from a simple input prompt",
            inputSchema: zodToJsonSchema(GPT5GenerateSchema),
          },
          {
            name: "gpt5_messages",
            description: "Generate text using GPT-5 with structured conversation messages",
            inputSchema: zodToJsonSchema(GPT5MessagesSchema),
          },
          {
            name: "gpt5_image",
            description: "Generate an image FOR FREE via the Codex CLI's built-in image tool (ChatGPT OAuth / gpt-image — no API key, no credits). Saves a PNG to out_path.",
            inputSchema: zodToJsonSchema(GPT5ImageSchema),
          },
          {
            name: "codex_dispatch",
            description: "Dispatch a Codex worker as a background job (like spawning a subagent). Non-blocking: returns a job_id IMMEDIATELY while Codex does the build/codemod/test grind unattended. The job is STEERABLE — watch it with codex_status, course-correct mid-run with codex_steer, stop with codex_interrupt, collect with codex_result. Default sandbox danger-full-access.",
            inputSchema: zodToJsonSchema(CodexDispatchSchema),
          },
          {
            name: "codex_deploy",
            description: "Dispatch a deployment-focused Codex worker, defaulting to target=mini, with guardrails for App Store/TestFlight, Cloudflare Pages/Workers, and vendor-infra queue work. Defaults to read-only/preflight; set allow_mutations=true for actual deploy/upload/vendor mutations. Never include secret values in the task.",
            inputSchema: zodToJsonSchema(CodexDeploySchema),
          },
          {
            name: "codex_status",
            description: "Check a dispatched Codex job (or list all). Returns {state: starting|running|completed|failed, threadId, turnId, events} — the events are what Codex is doing right now (assistant text + turn lifecycle). Non-blocking; call on your own schedule to decide whether to codex_steer.",
            inputSchema: zodToJsonSchema(CodexStatusSchema),
          },
          {
            name: "codex_result",
            description: "Collect the final result of a Codex job: its final assistant message and the list of files it changed (git porcelain). Call once codex_status reports completed/failed.",
            inputSchema: zodToJsonSchema(CodexResultSchema),
          },
          {
            name: "codex_steer",
            description: "Inject guidance into a RUNNING Codex job's active turn (turn/steer) — e.g. 'stop, that approach is wrong, do X instead'. Codex picks it up mid-execution. Works on ANY job_id from codex_dispatch. Use after codex_status shows it drifting.",
            inputSchema: zodToJsonSchema(CodexSteerSchema),
          },
          {
            name: "codex_interrupt",
            description: "Interrupt a running Codex job's turn (turn/interrupt) — stop the current work without killing the thread.",
            inputSchema: zodToJsonSchema(CodexInterruptSchema),
          },
          {
            name: "team_hire",
            description: "Create a durable named employee on a local or remote target with an assigned workspace, charter, role pack, approved skills, memory file, and resumable Codex thread. Set bridge_port to bind an existing Telegram-backed session.",
            inputSchema: zodToJsonSchema(TeamHireSchema),
          },
          {
            name: "team_update",
            description: "Edit a managed employee's workspace, role pack, skills, plugins, charter, model, sandbox, or Telegram bridge binding.",
            inputSchema: zodToJsonSchema(TeamUpdateSchema),
          },
          {
            name: "team_list",
            description: "List managed employees on a dispatch target, including their role, workspace, bridge binding, and current durable thread id.",
            inputSchema: zodToJsonSchema(TeamListSchema),
          },
          {
            name: "team_get",
            description: "Inspect one employee and resolve its exact approved skills, plugin requirements, and capability-library commit.",
            inputSchema: zodToJsonSchema(TeamEmployeeSchema),
          },
          {
            name: "team_fire",
            description: "Remove an employee from active duty. Archives recoverably by default; purge=true permanently removes only that employee's ~/.gpt5mcp/team state.",
            inputSchema: zodToJsonSchema(TeamFireSchema),
          },
          {
            name: "team_dispatch",
            description: "Dispatch work to a named employee. Ordinary employees resume one durable Codex thread with explicit skill input items; Telegram-bound employees queue through their bridge so the same session runs once and the result is visible both here and in Telegram.",
            inputSchema: zodToJsonSchema(TeamDispatchSchema),
          },
          {
            name: "team_status",
            description: "Check a team job from team_dispatch or team_skill_harvest, whether it is a direct Codex employee or a Telegram bridge employee.",
            inputSchema: zodToJsonSchema(TeamJobSchema),
          },
          {
            name: "team_result",
            description: "Collect the result of a team job, including employee, skill receipt metadata, thread id, changed files, and final message.",
            inputSchema: zodToJsonSchema(TeamJobSchema),
          },
          {
            name: "team_skill_harvest",
            description: "Ask an employee's existing durable session to synthesize learned behavior into a candidate SKILL.md using the approved harvest-session-knowledge skill. The candidate is never auto-approved.",
            inputSchema: zodToJsonSchema(TeamHarvestSchema),
          },
          {
            name: "team_library_sync",
            description: "Clone or fast-forward the private capability library on a local or remote dispatch target, validate it, and return the exact commit.",
            inputSchema: zodToJsonSchema(TeamLibrarySyncSchema),
          },
          {
            name: "team_plugin_sync",
            description: "Check one employee's approved role/plugin requirements on its target and optionally install missing plugins from exact versioned marketplace selectors.",
            inputSchema: zodToJsonSchema(TeamPluginSyncSchema),
          },
        ]
      };
    }
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request) => {
      console.error("Handling CallToolRequest:", JSON.stringify(request.params));
      
      try {
        switch (request.params.name) {
          case "gpt5_generate": {
            const args = GPT5GenerateSchema.parse(request.params.arguments) as GPT5GenerateArgs;
            console.error(`GPT-5 Generate: "${args.input.substring(0, 100)}..."`);
            
            const result = await callGPT5(undefined, args.input, {
              model: args.model,
              instructions: args.instructions,
              reasoning_effort: args.reasoning_effort,
              max_tokens: args.max_tokens,
              temperature: args.temperature,
              top_p: args.top_p
            });
            
            let responseText = result.content;
            if (result.usage) {
              responseText += `\n\n**Usage:** ${result.usage.prompt_tokens} prompt tokens, ${result.usage.completion_tokens} completion tokens, ${result.usage.total_tokens} total tokens`;
            }
            
            return {
              content: [{
                type: "text",
                text: responseText
              }]
            };
          }
          
          case "gpt5_messages": {
            const args = GPT5MessagesSchema.parse(request.params.arguments) as GPT5MessagesArgs;
            console.error(`GPT-5 Messages: ${args.messages.length} messages`);
            
            const result = await callGPT5WithMessages(undefined, args.messages, {
              model: args.model,
              instructions: args.instructions,
              reasoning_effort: args.reasoning_effort,
              max_tokens: args.max_tokens,
              temperature: args.temperature,
              top_p: args.top_p
            });
            
            let responseText = result.content;
            if (result.usage) {
              responseText += `\n\n**Usage:** ${result.usage.prompt_tokens} prompt tokens, ${result.usage.completion_tokens} completion tokens, ${result.usage.total_tokens} total tokens`;
            }
            
            return {
              content: [{
                type: "text",
                text: responseText
              }]
            };
          }

          case "gpt5_image": {
            const args = GPT5ImageSchema.parse(request.params.arguments) as GPT5ImageArgs;
            console.error(`GPT-5 Image: -> ${args.out_path} (${args.aspect})`);

            const result = await generateImage(args.scene, args.out_path, args.aspect);

            return {
              content: [{ type: "text", text: result.content }],
              ...(result.error ? { isError: true } : {})
            };
          }

          case "codex_dispatch": {
            const args = CodexDispatchSchema.parse(request.params.arguments) as CodexDispatchArgs;
            let m;
            try {
              m = startSession({
                prompt: args.prompt, cwd: args.cwd, model: args.model,
                sandbox: args.sandbox, effort: args.reasoning_effort, label: args.label,
                target: args.target, repo: args.repo, branch: args.branch,
                requireCodexMatch: args.require_codex_match,
              });
            } catch (e: any) {
              // Preflight (e.g. version skew / missing remote codex) — surface
              // the actionable message rather than a generic error.
              return {
                content: [{ type: "text", text: `codex_dispatch preflight failed: ${e?.message || String(e)}` }],
                isError: true,
              };
            }
            const remote = m.target && m.target !== 'local';
            console.error(`Codex dispatch (steerable): ${m.id} target=${m.target} cwd=${m.cwd}`);
            return {
              content: [{ type: "text", text: JSON.stringify({
                job_id: m.id, state: m.state, target: m.target, host: m.host,
                cwd: m.cwd, repo: m.repo, branch: m.branch, model: m.model, sandbox: args.sandbox,
                ...(m.configNote ? { configFixed: m.configNote } : {}),
                note: remote
                  ? "Dispatched to REMOTE worker. It survives this laptop closing — reconnect any time with codex_status. It will push a job branch + open a PR when done."
                  : "Dispatched (steerable). Watch with codex_status, steer mid-run with codex_steer, collect with codex_result.",
              }, null, 2) }],
            };
          }

          case "codex_deploy": {
            const args = CodexDeploySchema.parse(request.params.arguments) as CodexDeployArgs;
            const prompt = buildDeployPrompt(args);
            let m;
            try {
              m = startSession({
                prompt,
                model: args.model,
                sandbox: args.sandbox,
                effort: args.reasoning_effort,
                label: args.label || `${args.deploy_type}: ${args.repo_path || args.repo || 'deploy'}`,
                target: args.target,
                // Deploy jobs intentionally do NOT pass repo into the generic
                // remote prelude: that prelude creates a PR branch. The deploy
                // prompt handles repo_path/repo setup without forcing PR behavior.
                branch: args.branch,
                requireCodexMatch: true,
              });
            } catch (e: any) {
              return {
                content: [{ type: "text", text: `codex_deploy preflight failed: ${e?.message || String(e)}` }],
                isError: true,
              };
            }
            console.error(`Codex deploy dispatch: ${m.id} type=${args.deploy_type} target=${m.target} cwd=${m.cwd}`);
            return {
              content: [{ type: "text", text: JSON.stringify({
                job_id: m.id,
                state: m.state,
                deploy_type: args.deploy_type,
                target: m.target,
                host: m.host,
                cwd: m.cwd,
                model: m.model,
                sandbox: args.sandbox,
                allow_mutations: args.allow_mutations,
                allow_app_store_submit: args.allow_app_store_submit,
                allow_browser_dashboard: args.allow_browser_dashboard,
                ...(m.configNote ? { configFixed: m.configNote } : {}),
                note: "Deployment worker dispatched. Watch with codex_status, steer with codex_steer, collect with codex_result. Secret values must remain in target env/dashboard stores, never prompts or Markdown.",
              }, null, 2) }],
            };
          }

          case "codex_status": {
            const args = CodexStatusSchema.parse(request.params.arguments) as CodexStatusArgs;
            if (!args.job_id) {
              const all = listSessions().map((m) => ({
                job_id: m.id, state: m.state, label: m.label, target: m.target, startedAt: m.startedAt,
              }));
              return { content: [{ type: "text", text: JSON.stringify(all, null, 2) }] };
            }
            const m = getSession(args.job_id);
            if (!m) return { content: [{ type: "text", text: `Unknown job: ${args.job_id}` }], isError: true };
            return { content: [{ type: "text", text: JSON.stringify({
              job_id: m.id, state: m.state, target: m.target, host: m.host,
              repo: m.repo, branch: m.branch, threadId: m.threadId, turnId: m.turnId,
              label: m.label, startedAt: m.startedAt, endedAt: m.endedAt, error: m.error,
              events: sessionEvents(m.id, args.events),
            }, null, 2) }] };
          }

          case "codex_result": {
            const args = CodexResultSchema.parse(request.params.arguments) as CodexResultArgs;
            const m = getSession(args.job_id);
            if (!m) return { content: [{ type: "text", text: `Unknown job: ${args.job_id}` }], isError: true };
            if (m.state === 'starting' || m.state === 'running') {
              return { content: [{ type: "text", text: JSON.stringify({
                job_id: m.id, state: m.state,
                note: "Still running — poll codex_status; codex_result returns once finished.",
              }, null, 2) }] };
            }
            return {
              content: [{ type: "text", text: JSON.stringify({
                job_id: m.id, state: m.state, error: m.error,
                filesChanged: sessionChangedFiles(m.id),
                finalMessage: sessionFinalMessage(m.id),
              }, null, 2) }],
              ...(m.state === 'failed' ? { isError: true } : {}),
            };
          }

          case "codex_steer": {
            const args = CodexSteerSchema.parse(request.params.arguments) as CodexSteerArgs;
            const r = steerSession(args.job_id, args.text);
            console.error(`Codex steer ${args.job_id}: ${r.ok}`);
            return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], ...(r.ok ? {} : { isError: true }) };
          }

          case "codex_interrupt": {
            const args = CodexInterruptSchema.parse(request.params.arguments) as CodexInterruptArgs;
            const r = interruptSession(args.job_id);
            return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], ...(r.ok ? {} : { isError: true }) };
          }

          case "team_hire": {
            const args = TeamHireSchema.parse(request.params.arguments) as TeamHireArgs;
            const employee = hireEmployee({
              name: args.name,
              target: args.target,
              workspace: args.workspace,
              rolePack: args.role_pack,
              skills: args.skills,
              plugins: args.plugins,
              charter: args.charter,
              model: args.model,
              reasoningEffort: args.reasoning_effort,
              sandbox: args.sandbox,
              bridgePort: args.bridge_port,
              botUsername: args.telegram_bot,
              notifyTelegram: args.notify_telegram,
            });
            return { content: [{ type: "text", text: JSON.stringify(employee, null, 2) }] };
          }

          case "team_update": {
            const args = TeamUpdateSchema.parse(request.params.arguments) as TeamUpdateArgs;
            const employee = updateEmployee({
              name: args.name,
              target: args.target,
              workspace: args.workspace,
              rolePack: args.role_pack,
              skills: args.skills,
              plugins: args.plugins,
              charter: args.charter,
              model: args.model,
              reasoningEffort: args.reasoning_effort,
              sandbox: args.sandbox,
              bridgePort: args.bridge_port,
              botUsername: args.telegram_bot,
              notifyTelegram: args.notify_telegram,
            });
            return { content: [{ type: "text", text: JSON.stringify(employee, null, 2) }] };
          }

          case "team_list": {
            const args = TeamListSchema.parse(request.params.arguments) as TeamListArgs;
            return {
              content: [{
                type: "text",
                text: JSON.stringify(listEmployees(args.target, args.include_archived), null, 2),
              }],
            };
          }

          case "team_get": {
            const args = TeamEmployeeSchema.parse(request.params.arguments) as TeamEmployeeArgs;
            return {
              content: [{ type: "text", text: JSON.stringify(getEmployee(args.name, args.target), null, 2) }],
            };
          }

          case "team_fire": {
            const args = TeamFireSchema.parse(request.params.arguments) as TeamFireArgs;
            return {
              content: [{
                type: "text",
                text: JSON.stringify(fireEmployee(args.name, args.target, args.purge), null, 2),
              }],
            };
          }

          case "team_dispatch": {
            const args = TeamDispatchSchema.parse(request.params.arguments) as TeamDispatchToolArgs;
            const result = dispatchEmployee({
              employee: args.employee,
              target: args.target,
              prompt: args.prompt,
              model: args.model,
              sandbox: args.sandbox,
              reasoningEffort: args.reasoning_effort,
              label: args.label,
              syncLibrary: args.sync_library,
              extraSkills: args.extra_skills,
            });
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  team_job_id: result.job.id,
                  state: result.session?.state || "queued",
                  employee: result.job.employee,
                  target: result.job.target,
                  transport: result.job.kind,
                  codex_job_id: result.session?.id,
                  skills: result.job.skills,
                  plugins: result.plugins,
                  libraryCommit: result.job.libraryCommit,
                  note: result.job.kind === "bridge"
                    ? "Queued through the employee's Telegram bridge. Poll team_status; the final result is also delivered to Telegram."
                    : "Dispatched to the employee's durable Codex thread. Poll team_status and collect with team_result.",
                }, null, 2),
              }],
            };
          }

          case "team_status": {
            const args = TeamJobSchema.parse(request.params.arguments) as TeamJobArgs;
            return {
              content: [{
                type: "text",
                text: JSON.stringify(teamJobStatus(args.job_id, args.events), null, 2),
              }],
            };
          }

          case "team_result": {
            const args = TeamJobSchema.parse(request.params.arguments) as TeamJobArgs;
            const result = teamJobResult(args.job_id);
            return {
              content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
              ...(result.state === "failed" ? { isError: true } : {}),
            };
          }

          case "team_skill_harvest": {
            const args = TeamHarvestSchema.parse(request.params.arguments) as TeamHarvestArgs;
            const result = harvestEmployeeKnowledge({
              employee: args.employee,
              target: args.target,
              skillName: args.skill_name,
              topic: args.topic,
              label: args.label,
            });
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  team_job_id: result.job.id,
                  state: result.session?.state || "queued",
                  employee: result.job.employee,
                  target: result.job.target,
                  transport: result.job.kind,
                  candidateSkill: result.job.harvest?.skillName,
                  note: "The employee is producing a quarantined candidate only. Poll team_status and collect with team_result; review before promotion.",
                }, null, 2),
              }],
            };
          }

          case "team_library_sync": {
            const args = TeamLibrarySyncSchema.parse(request.params.arguments) as TeamLibrarySyncArgs;
            return {
              content: [{
                type: "text",
                text: JSON.stringify(syncCapabilityLibrary(args.target, args.ref), null, 2),
              }],
            };
          }

          case "team_plugin_sync": {
            const args = TeamPluginSyncSchema.parse(request.params.arguments) as TeamPluginSyncArgs;
            return {
              content: [{
                type: "text",
                text: JSON.stringify(
                  syncEmployeePlugins(args.employee, args.target, args.install_missing),
                  null,
                  2,
                ),
              }],
            };
          }

          default:
            throw new McpError(
              ErrorCode.MethodNotFound,
              `Unknown tool: ${request.params.name}`
            );
        }
      } catch (error) {
        console.error("ERROR during GPT-5 API call:", error);
        
        return {
          content: [{
            type: "text",
            text: `GPT-5 API error: ${error instanceof Error ? error.message : String(error)}`
          }],
          isError: true
        };
      }
    }
  );

  // Start the server
  console.error("Starting GPT-5 MCP server");
  
  try {
    const transport = new StdioServerTransport();
    console.error("StdioServerTransport created");
    
    await server.connect(transport);
    console.error("Server connected to transport");
    
    console.error("GPT-5 MCP server running on stdio");
  } catch (error) {
    console.error("ERROR starting server:", error);
    throw error;
  }
}

// Main execution
main().catch(error => {
  console.error("Server runtime error:", error);
  process.exit(1);
});
