#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const server = path.join(root, "servers", "gpt5-server", "build", "index.js");
const tool = process.argv[2];
const rawArgs = process.argv[3] || "{}";
if (!tool) {
  console.error("Usage: node scripts/mcp-call.mjs <tool-name> '<json-arguments>'");
  process.exit(2);
}
let args;
try { args = JSON.parse(rawArgs); }
catch (error) {
  console.error(`Invalid JSON arguments: ${error.message}`);
  process.exit(2);
}

const child = spawn(process.execPath, [server], {
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
    clientInfo: { name: "gpt5mcp-smoke", version: "1.0.0" },
  });
  if (initialized.error) throw new Error(JSON.stringify(initialized.error));
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const result = await request("tools/call", { name: tool, arguments: args });
  console.log(JSON.stringify(result, null, 2));
} finally {
  child.stdin.end();
  child.kill();
}
