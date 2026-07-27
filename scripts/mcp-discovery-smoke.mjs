#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const executable = path.join(root, "servers", "gpt5-server", "build", "index.js");
const child = spawn(process.execPath, [executable], {
  cwd: root,
  stdio: ["pipe", "pipe", "inherit"],
});

let buffer = "";
let nextId = 1;
const pending = new Map();
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  }
});

function request(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve) => pending.set(id, resolve));
}

try {
  const initialized = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "gpt5mcp-discovery-smoke", version: "1.0.0" },
  });
  assert.equal(initialized.error, undefined);
  assert.match(initialized.result.instructions, /team_manifest/);
  assert.equal(initialized.result.capabilities.prompts !== undefined, true);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

  const [tools, resources, prompts] = await Promise.all([
    request("tools/list", {}),
    request("resources/list", {}),
    request("prompts/list", {}),
  ]);
  assert(tools.result.tools.some((tool) => tool.name === "team_manifest"));
  assert(tools.result.tools.some((tool) =>
    tool.name === "team_hire" && tool.inputSchema.properties.repo));
  assert(resources.result.resources.some((resource) =>
    resource.uri === "usage://team-onboarding"));
  assert(prompts.result.prompts.some((prompt) => prompt.name === "team-hire-employee"));

  const [guide, hirePrompt] = await Promise.all([
    request("resources/read", { uri: "usage://team-onboarding" }),
    request("prompts/get", {
      name: "team-hire-employee",
      arguments: {
        name: "Olivia",
        target: "mini",
        workspace: "/Users/ellaai/dev/acme-api",
        repo: "owner/acme-api",
        role_pack: "backend-engineer",
      },
    }),
  ]);
  assert.match(guide.result.contents[0].text, /team_hire/);
  assert.match(hirePrompt.result.messages[0].content.text, /Olivia/);

  console.log(JSON.stringify({
    server: initialized.result.serverInfo,
    instructions: initialized.result.instructions,
    discovered: {
      teamManifestTool: true,
      repositoryCloneInput: true,
      onboardingResource: true,
      hireEmployeePrompt: true,
    },
  }, null, 2));
} finally {
  child.stdin.end();
  child.kill();
}
