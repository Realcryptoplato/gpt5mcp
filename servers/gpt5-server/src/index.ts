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
  dispatchCodex, getStatus, listJobs, tailLog, finalMessage, changedFiles,
} from './codexJobs.js';
import {
  startSession, steerSession, interruptSession, getSession, listSessions, sessionEvents,
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

// --- Async Codex worker (dispatch-and-await like a subagent) ---
const CodexDispatchSchema = z.object({
  prompt: z.string().describe("The full spec/task for the Codex worker. Be tight and self-contained — Codex does the build/codemod/test grind unattended."),
  cwd: z.string().optional().describe("Working directory for the job (defaults to the server's CWD). Use the repo you want Codex to operate on."),
  model: z.string().optional().default("gpt-5.5").describe("Codex model (via the CLI)"),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional().default('danger-full-access').describe("Execution sandbox. danger-full-access = files + commands + network, unattended (default for the delegated-worker setup)."),
  reasoning_effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional().describe("Codex reasoning effort"),
  label: z.string().optional().describe("Short human label for the job (shown in status)")
});

const CodexStatusSchema = z.object({
  job_id: z.string().optional().describe("Job id to check. Omit to list ALL jobs (most recent first)."),
  tail: z.boolean().optional().default(true).describe("Include a tail of the job's output log")
});

const CodexResultSchema = z.object({
  job_id: z.string().describe("Job id to collect the final result from")
});

// --- Steerable Codex session (app-server: dispatch -> watch -> steer mid-run) ---
const CodexSessionStartSchema = z.object({
  prompt: z.string().describe("The task/spec to start the Codex session with."),
  cwd: z.string().optional().describe("Working directory (defaults to server CWD)."),
  model: z.string().optional().default("gpt-5.5").describe("Codex model"),
  effort: z.enum(['low', 'medium', 'high', 'xhigh']).optional().describe("Reasoning effort"),
  label: z.string().optional().describe("Short human label")
});

const CodexSessionWatchSchema = z.object({
  session_id: z.string().optional().describe("Session id to inspect. Omit to list ALL sessions."),
  events: z.number().optional().default(40).describe("How many recent events to return (assistant text + turn lifecycle)")
});

const CodexSteerSchema = z.object({
  session_id: z.string().describe("Session id to steer"),
  text: z.string().describe("Guidance to inject into the running turn (e.g. 'stop, you're going wrong — do X instead').")
});

const CodexInterruptSchema = z.object({
  session_id: z.string().describe("Session id to interrupt (sends turn/interrupt)")
});


// Type definitions
type GPT5GenerateArgs = z.infer<typeof GPT5GenerateSchema>;
type GPT5ImageArgs = z.infer<typeof GPT5ImageSchema>;
type GPT5MessagesArgs = z.infer<typeof GPT5MessagesSchema>;
type CodexDispatchArgs = z.infer<typeof CodexDispatchSchema>;
type CodexStatusArgs = z.infer<typeof CodexStatusSchema>;
type CodexResultArgs = z.infer<typeof CodexResultSchema>;
type CodexSessionStartArgs = z.infer<typeof CodexSessionStartSchema>;
type CodexSessionWatchArgs = z.infer<typeof CodexSessionWatchSchema>;
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

## Notes
- **Async Codex worker (subagent-style):** codex_dispatch { prompt, cwd?, sandbox?=danger-full-access, label? }
  returns a job_id IMMEDIATELY (non-blocking); codex_status { job_id?, tail? } reports
  { state, exitCode, durationMs, filesChanged, tail }; codex_result { job_id } returns the
  finalMessage once done. Jobs persist under ~/.gpt5mcp/codex-jobs/ and survive a restart.
  This path uses one-shot \`codex exec\` (no steering).
- **Steerable Codex session (app-server):** codex_session_start { prompt, cwd?, model?, effort?, label? }
  returns { session_id, thread_id } IMMEDIATELY (non-blocking, like a subagent); the session
  runs a long-lived app-server thread you can course-correct.
    - codex_session_watch { session_id?, events? } -> { state, threadId, turnId, events[] }
      (assistant text + turn lifecycle) — what Codex is doing right now. Omit id to list all.
    - codex_steer { session_id, text } -> injects guidance into the RUNNING turn (turn/steer),
      e.g. "stop, that's wrong — do X". Codex picks it up mid-execution.
    - codex_interrupt { session_id } -> turn/interrupt (stop the turn, keep the thread).
  Sessions persist under ~/.gpt5mcp/codex-sessions/. Pattern: dispatch -> watch on your own
  schedule -> steer if it's drifting -> let it finish.
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
            description: "Dispatch a Codex worker as a background job (like spawning a subagent) — runs `codex exec` detached and returns a job_id IMMEDIATELY (non-blocking). Codex does the heavy build/codemod/test grind unattended. Poll with codex_status, collect with codex_result.",
            inputSchema: zodToJsonSchema(CodexDispatchSchema),
          },
          {
            name: "codex_status",
            description: "Check a dispatched Codex job (or list all). Returns structured status {state: running|completed|failed, exitCode, durationMs, filesChanged, tail of log}. Non-blocking — call repeatedly until state != running.",
            inputSchema: zodToJsonSchema(CodexStatusSchema),
          },
          {
            name: "codex_result",
            description: "Collect the final result of a completed Codex job: its final message, exit code, and the list of files it changed (git porcelain). Call once codex_status reports completed/failed.",
            inputSchema: zodToJsonSchema(CodexResultSchema),
          },
          {
            name: "codex_session_start",
            description: "Start a STEERABLE Codex session (app-server thread/turn) — non-blocking, returns {session_id, thread_id} IMMEDIATELY. Unlike codex_dispatch, you can inject guidance mid-run with codex_steer. Use for long tasks you want to monitor and course-correct.",
            inputSchema: zodToJsonSchema(CodexSessionStartSchema),
          },
          {
            name: "codex_session_watch",
            description: "Check on a steerable session (or list all): returns {state, threadId, turnId} + recent events (assistant text deltas, turn lifecycle) — i.e. what Codex is currently doing. Non-blocking; call whenever you want to decide if a steer is needed.",
            inputSchema: zodToJsonSchema(CodexSessionWatchSchema),
          },
          {
            name: "codex_steer",
            description: "Inject guidance into a RUNNING Codex session's active turn (turn/steer) — e.g. 'stop, that approach is wrong, do X instead'. The steering message is picked up by Codex mid-execution. Use after codex_session_watch shows it going the wrong way.",
            inputSchema: zodToJsonSchema(CodexSteerSchema),
          },
          {
            name: "codex_interrupt",
            description: "Interrupt a running Codex session's turn (turn/interrupt) — stop the current work without killing the thread.",
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
            const job = dispatchCodex({
              prompt: args.prompt,
              cwd: args.cwd,
              model: args.model,
              sandbox: args.sandbox,
              reasoning_effort: args.reasoning_effort,
              label: args.label,
            });
            console.error(`Codex dispatch: ${job.id} (${args.sandbox}) cwd=${job.cwd}`);
            return {
              content: [{
                type: "text",
                text: JSON.stringify({
                  job_id: job.id,
                  state: job.state,
                  cwd: job.cwd,
                  model: job.model,
                  sandbox: job.sandbox,
                  pid: job.pid,
                  note: "Dispatched. Poll codex_status with this job_id; collect with codex_result when state != running.",
                }, null, 2),
              }],
            };
          }

          case "codex_status": {
            const args = CodexStatusSchema.parse(request.params.arguments) as CodexStatusArgs;
            if (!args.job_id) {
              const all = listJobs().map((s) => ({
                job_id: s.id, state: s.state, label: s.label,
                startedAt: s.startedAt, durationMs: s.durationMs, exitCode: s.exitCode,
              }));
              return { content: [{ type: "text", text: JSON.stringify(all, null, 2) }] };
            }
            const s = getStatus(args.job_id);
            if (!s) {
              return { content: [{ type: "text", text: `Unknown job: ${args.job_id}` }], isError: true };
            }
            const payload: any = {
              job_id: s.id, state: s.state, label: s.label,
              exitCode: s.exitCode, durationMs: s.durationMs,
              startedAt: s.startedAt, endedAt: s.endedAt, cwd: s.cwd,
            };
            if (s.state !== 'running') payload.filesChanged = changedFiles(s.id);
            if (args.tail) payload.tail = tailLog(s.id);
            return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
          }

          case "codex_result": {
            const args = CodexResultSchema.parse(request.params.arguments) as CodexResultArgs;
            const s = getStatus(args.job_id);
            if (!s) {
              return { content: [{ type: "text", text: `Unknown job: ${args.job_id}` }], isError: true };
            }
            if (s.state === 'running') {
              return {
                content: [{ type: "text", text: JSON.stringify({
                  job_id: s.id, state: 'running',
                  note: "Still running — call codex_status to poll; codex_result only returns once finished.",
                }, null, 2) }],
              };
            }
            return {
              content: [{ type: "text", text: JSON.stringify({
                job_id: s.id, state: s.state, exitCode: s.exitCode,
                durationMs: s.durationMs, filesChanged: changedFiles(s.id),
                finalMessage: finalMessage(s.id),
              }, null, 2) }],
              ...(s.state === 'failed' ? { isError: true } : {}),
            };
          }

          case "codex_session_start": {
            const args = CodexSessionStartSchema.parse(request.params.arguments) as CodexSessionStartArgs;
            const m = startSession({
              prompt: args.prompt, cwd: args.cwd, model: args.model,
              effort: args.effort, label: args.label,
            });
            console.error(`Codex session start: ${m.id} cwd=${m.cwd}`);
            return {
              content: [{ type: "text", text: JSON.stringify({
                session_id: m.id, state: m.state, cwd: m.cwd, model: m.model,
                note: "Steerable session starting. Poll codex_session_watch; inject guidance with codex_steer; stop with codex_interrupt.",
              }, null, 2) }],
            };
          }

          case "codex_session_watch": {
            const args = CodexSessionWatchSchema.parse(request.params.arguments) as CodexSessionWatchArgs;
            if (!args.session_id) {
              const all = listSessions().map((m) => ({
                session_id: m.id, state: m.state, label: m.label, startedAt: m.startedAt,
              }));
              return { content: [{ type: "text", text: JSON.stringify(all, null, 2) }] };
            }
            const m = getSession(args.session_id);
            if (!m) return { content: [{ type: "text", text: `Unknown session: ${args.session_id}` }], isError: true };
            return { content: [{ type: "text", text: JSON.stringify({
              session_id: m.id, state: m.state, threadId: m.threadId, turnId: m.turnId,
              label: m.label, startedAt: m.startedAt, endedAt: m.endedAt, error: m.error,
              events: sessionEvents(m.id, args.events),
            }, null, 2) }] };
          }

          case "codex_steer": {
            const args = CodexSteerSchema.parse(request.params.arguments) as CodexSteerArgs;
            const r = steerSession(args.session_id, args.text);
            console.error(`Codex steer ${args.session_id}: ${r.ok}`);
            return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], ...(r.ok ? {} : { isError: true }) };
          }

          case "codex_interrupt": {
            const args = CodexInterruptSchema.parse(request.params.arguments) as CodexInterruptArgs;
            const r = interruptSession(args.session_id);
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