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
  model: z.string().optional().default("gpt-5.5").describe("GPT-5 model variant to use (via Codex CLI)"),
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
  model: z.string().optional().default("gpt-5.5").describe("GPT-5 model variant to use (via Codex CLI)"),
  instructions: z.string().optional().describe("System instructions for the model"),
  reasoning_effort: z.enum(['low', 'medium', 'high']).optional().describe("Reasoning effort level"),
  max_tokens: z.number().optional().describe("Maximum tokens to generate"),
  temperature: z.number().min(0).max(2).optional().describe("Temperature for randomness (0-2)"),
  top_p: z.number().min(0).max(1).optional().describe("Top-p sampling parameter")
});


const GPT5ImageSchema = z.object({
  scene: z.string().describe("Detailed scene description for the image to generate"),
  out_path: z.string().describe("Absolute path where the PNG should be saved (e.g. /Users/greg/out/shot.png)"),
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
  cwd: z.string().optional().describe("LOCAL only: working directory (defaults to server CWD). For remote, the workdir is derived from repo."),
  model: z.string().optional().default("gpt-5.5").describe("Codex model"),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional().default('danger-full-access').describe("Execution sandbox. danger-full-access = files + commands + network, unattended (default)."),
  reasoning_effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional().describe("Codex reasoning effort"),
  label: z.string().optional().describe("Short human label for the job")
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


// Type definitions
type GPT5GenerateArgs = z.infer<typeof GPT5GenerateSchema>;
type GPT5ImageArgs = z.infer<typeof GPT5ImageSchema>;
type GPT5MessagesArgs = z.infer<typeof GPT5MessagesSchema>;
type CodexDispatchArgs = z.infer<typeof CodexDispatchSchema>;
type CodexStatusArgs = z.infer<typeof CodexStatusSchema>;
type CodexResultArgs = z.infer<typeof CodexResultSchema>;
type CodexSteerArgs = z.infer<typeof CodexSteerSchema>;
type CodexInterruptArgs = z.infer<typeof CodexInterruptSchema>;

// Usage doc exposed as an MCP resource so connecting clients can fetch a
// human-readable README through the protocol (in addition to tools/list, which
// already exposes every tool's param schema).
const README = `# gpt5-server (MCP)

Drives the **Codex CLI** (ChatGPT OAuth) — no OPENAI_API_KEY, no credits.
Run \`codex login\` once if not authenticated. Defaults to model **gpt-5.5**.

## Tools
- **gpt5_generate** { input, model?=gpt-5.5, instructions?, reasoning_effort?, max_tokens?, temperature?, top_p? }
  → text. Single-prompt generation via \`codex exec\`.
- **gpt5_messages** { messages:[{role,content}], model?=gpt-5.5, instructions?, reasoning_effort?, ... }
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
- **codex_status** { job_id?, events? } -> { state: starting|running|completed|failed, threadId,
  turnId, events[] }. The events are what Codex is doing now (assistant text + turn lifecycle).
  Omit job_id to list all jobs.
- **codex_steer** { job_id, text } -> injects guidance into the RUNNING turn (turn/steer),
  e.g. "stop, that's wrong — do X". Codex picks it up mid-execution. Works on ANY dispatched job.
- **codex_interrupt** { job_id } -> turn/interrupt (stop the turn, keep the thread).
- **codex_result** { job_id } -> { state, filesChanged, finalMessage } once finished.
Jobs persist under ~/.gpt5mcp/codex-sessions/ and survive a restart.
Pattern: dispatch -> watch on your own schedule -> steer if it's drifting -> collect.

## Notes
- Image gen is agentic (the model writes the file); allow up to ~4 min.
- API-only model snapshots are irrelevant here — the CLI session picks the backing model.
- Full machine-readable param schemas: call \`tools/list\`.
`;

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
            description: "Generate text using GPT-5 (gpt-5.5 via the Codex CLI / ChatGPT auth) from a simple input prompt",
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
            const m = startSession({
              prompt: args.prompt, cwd: args.cwd, model: args.model,
              sandbox: args.sandbox, effort: args.reasoning_effort, label: args.label,
              target: args.target, repo: args.repo, branch: args.branch,
            });
            const remote = m.target && m.target !== 'local';
            console.error(`Codex dispatch (steerable): ${m.id} target=${m.target} cwd=${m.cwd}`);
            return {
              content: [{ type: "text", text: JSON.stringify({
                job_id: m.id, state: m.state, target: m.target, host: m.host,
                cwd: m.cwd, repo: m.repo, branch: m.branch, model: m.model, sandbox: args.sandbox,
                note: remote
                  ? "Dispatched to REMOTE worker. It survives this laptop closing — reconnect any time with codex_status. It will push a job branch + open a PR when done."
                  : "Dispatched (steerable). Watch with codex_status, steer mid-run with codex_steer, collect with codex_result.",
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