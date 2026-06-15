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


// Type definitions
type GPT5GenerateArgs = z.infer<typeof GPT5GenerateSchema>;
type GPT5ImageArgs = z.infer<typeof GPT5ImageSchema>;
type GPT5MessagesArgs = z.infer<typeof GPT5MessagesSchema>;

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