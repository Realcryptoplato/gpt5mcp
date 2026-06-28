#!/usr/bin/env bash
# install-dispatch-host.sh — install the gpt5-server MCP (codex dispatch) on a
# host so a Claude Code running THERE can dispatch Codex jobs locally.
#
# Idempotent. Safe to re-run to update (git pull + rebuild).
#
# Usage (on the target host, or piped over ssh):
#   bash install-dispatch-host.sh [--repo-url URL] [--dir DIR] [--no-register]
#
#   --repo-url   git URL of the gpt5mcp fork (default: the Realcryptoplato fork)
#   --dir        where to clone   (default: ~/repos/gpt5mcp)
#   --no-register  build only; don't touch the Claude config
#
# Requires on the host: node (>=18), git, and codex (logged in) for jobs to run.
# Registers the server in ~/.claude.json under mcpServers.gpt5-server.
set -euo pipefail

REPO_URL="https://github.com/Realcryptoplato/gpt5mcp.git"
DIR="$HOME/repos/gpt5mcp"
REGISTER=1
while [ $# -gt 0 ]; do
  case "$1" in
    --repo-url) REPO_URL="$2"; shift 2 ;;
    --dir)      DIR="$2"; shift 2 ;;
    --no-register) REGISTER=0; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n[install-dispatch-host] %s\n' "$*"; }

# --- prerequisites -----------------------------------------------------------
command -v node >/dev/null || { echo "ERROR: node not found on PATH"; exit 1; }
command -v git  >/dev/null || { echo "ERROR: git not found on PATH"; exit 1; }
if ! command -v codex >/dev/null; then
  echo "WARN: codex not found on PATH — install it (npm i -g @openai/codex) and 'codex login' before dispatching."
fi
say "node $(node --version), git ok$(command -v codex >/dev/null && echo ", codex $(codex --version 2>&1|head -1)")"

# --- clone or update ---------------------------------------------------------
if [ -d "$DIR/.git" ]; then
  say "updating $DIR"
  git -C "$DIR" fetch --quiet origin && git -C "$DIR" pull --ff-only --quiet || say "pull skipped (local changes?)"
else
  say "cloning $REPO_URL -> $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --quiet "$REPO_URL" "$DIR"
fi

# --- build the server --------------------------------------------------------
SRV="$DIR/servers/gpt5-server"
say "building $SRV"
( cd "$SRV" && npm install --silent && npm run build >/dev/null )
BUILT="$SRV/build/index.js"
[ -f "$BUILT" ] || { echo "ERROR: build did not produce $BUILT"; exit 1; }
say "built: $BUILT"

# --- smoke test (tools/list) -------------------------------------------------
say "smoke test (tools/list)"
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"install","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node "$BUILT" 2>/dev/null | node -e '
    let buf="";process.stdin.on("data",d=>buf+=d).on("end",()=>{
      for(const l of buf.split("\n")){try{const o=JSON.parse(l);if(o.id===2){
        console.log("  tools:",o.result.tools.map(t=>t.name).join(", "));}}catch{}}});'

# --- register in the host Claude config -------------------------------------
if [ "$REGISTER" = 1 ]; then
  CFG="$HOME/.claude.json"
  say "registering gpt5-server in $CFG"
  BUILT="$BUILT" node -e '
    const fs=require("fs"),p=process.env.HOME+"/.claude.json";
    let d={};try{d=JSON.parse(fs.readFileSync(p,"utf8"))}catch{}
    d.mcpServers=d.mcpServers||{};
    d.mcpServers["gpt5-server"]={command:"node",args:[process.env.BUILT]};
    fs.writeFileSync(p,JSON.stringify(d,null,2));
    console.log("  registered: gpt5-server -> "+process.env.BUILT);
  '
  say "DONE. Restart Claude Code on this host to load the gpt5-server tools (codex_dispatch, etc.)."
else
  say "DONE (build only; not registered). Built server: $BUILT"
fi
