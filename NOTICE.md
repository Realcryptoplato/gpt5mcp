# Attribution

This repository is a **private fork** of the upstream project:

- **Upstream:** https://github.com/AllAboutAI-YT/gpt5mcp
- **Original author:** AllAboutAI-YT

All original code and the `gpt5_generate` / `gpt5_messages` / image-generation
groundwork originate with the upstream author. This fork exists only for private
internal infrastructure and is not a redistribution or a claim of original
authorship.

## What this fork adds (on top of upstream)

The `servers/gpt5-server` MCP server has been extended with:

- Driving the **Codex CLI** (ChatGPT OAuth) instead of the OpenAI REST API.
- `gpt5_image` — free image generation via Codex's built-in image tool.
- An async, **steerable Codex worker** engine (`codex_dispatch` / `codex_status`
  / `codex_steer` / `codex_interrupt` / `codex_result`), runnable locally or on a
  remote host over SSH, with config self-heal, version preflight, and a
  git-clone/PR bootstrap.
- `scripts/install-dispatch-host.sh` to install the server on another host.

These additions are by the fork maintainer; upstream is not responsible for them.

## License

Upstream does not ship a LICENSE file. This fork makes **no ownership claim** over
the upstream code and is kept private. If the upstream author requests changes to
this fork's visibility or attribution, those requests will be honored.
