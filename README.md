# GPT-5 MCP Server

> **⚠️ Fork.** This is a GitHub fork of
> **[AllAboutAI-YT/gpt5mcp](https://github.com/AllAboutAI-YT/gpt5mcp)** — the
> original project and author. This fork adds an async/steerable Codex dispatch
> engine for internal infra use; it is **not** original work and makes no
> ownership claim over the upstream code. See [NOTICE.md](NOTICE.md). The README
> below is from upstream.

---

## Team employees and capability library

This fork can manage named, long-lived Codex employees on the laptop, a remote
target such as `mini`, or an existing Telegram-backed Codex session.

- `team_manifest` is the required starting point for a fresh agent. It returns
  the selected target's live employees, role packs, approved skills/plugins,
  defaults, capability-library commit, and recommended workflow.
- `team_hire`, `team_update`, `team_list`, `team_get`, and `team_fire` manage
  employee manifests, assigned workspaces, role packs, skills, and durable
  thread ids. If an absolute workspace does not exist, `team_hire` can clone a
  supplied `owner/repo` and optional branch into it first. Firing archives by
  default; permanent deletion requires `purge=true`.
- `team_dispatch`, `team_status`, and `team_result` resume the employee's Codex
  thread and attach approved skills as native app-server skill inputs.
- `team_library_sync` installs or updates the private, versioned capability
  library on a target.
- `team_plugin_sync` verifies an employee's approved plugin requirements and
  can explicitly install missing marketplace plugins.
- `team_skill_harvest` asks an existing employee—including a Telegram-backed
  employee—to synthesize its learned workflow into a quarantined candidate
  skill for review. It never auto-promotes generated knowledge.

If a target has an optional `~/.gpt5mcp/team/pools.json` describing which
credit pool backs each employee, `team_manifest` returns a `pools` health
summary (`green`/`yellow`/`red`/`unknown` counts) and a `directory` mapping
each employee to its runtime, model, credit pool, and fallback employees;
`team_list` annotates each employee the same way. `team_dispatch` refuses to
dispatch to an employee whose pool is `red` (naming the pool, its note, and
the fallback) unless `force=true` is passed; a `yellow` pool dispatches
normally but the response includes a `poolWarning`. The file is entirely
optional — everything above behaves exactly as before when it is absent or
malformed.

Employees are target-scoped and have an explicit absolute workspace. Role packs
resolve only skills listed in the library's approved registry; revoked and
quarantined skills fail closed.

The MCP initialization response carries the short operating instructions
automatically. Clients that expose resources can read
`usage://team-onboarding`, and clients that expose MCP prompts can use
`team-hire-employee`. Together with `team_manifest`, this means a new or resumed
agent can discover the workflow without relying on conversation history.

Telegram employees use a loopback-only, token-authenticated bridge ingress.
The bridge queues the task into the bot's existing durable Codex thread and can
send the final response both to the MCP caller's job ledger and to Telegram.
The token remains on the target host and is never returned by an MCP tool.

`team_update` sets an employee's default `model` and `reasoning_effort`.
`team_dispatch` can override either for one assignment. Direct and
Telegram-backed MCP jobs both honor the effective employee/job configuration;
ordinary Telegram messages continue to use the bridge process defaults.

```text
team_manifest target=mini
team_list target=mini
team_hire name=Olivia target=mini workspace=/Users/ellaai/dev/acme-api repo=owner/acme-api branch=main role_pack=backend-engineer
team_get name=Olivia target=mini
team_plugin_sync employee=Olivia target=mini install_missing=true
team_dispatch employee=Olivia target=mini prompt="Review the current API architecture"
team_status job_id=...
team_result job_id=...
```

After rebuilding, fully restart MCP clients such as Codex Desktop or Claude
Desktop/Code so they reconnect and refresh the initialization instructions,
tools, resources, and prompts.

---

A Model Context Protocol (MCP) server that provides seamless integration with OpenAI's GPT-5 API through Claude Code. This server enables you to leverage GPT-5's advanced capabilities directly within your Claude Code workflows.

## 🚀 Features

- **Direct GPT-5 Integration**: Call GPT-5 API with simple prompts or structured conversations
- **Two Powerful Tools**:
  - `gpt5_generate`: Simple text generation with prompts
  - `gpt5_messages`: Structured conversation handling with message arrays
- **Built for Claude Code**: Optimized for seamless integration with Anthropic's Claude Code IDE
- **TypeScript Support**: Fully typed for better development experience
- **Error Handling**: Robust error handling with detailed feedback
- **Usage Tracking**: Built-in token usage reporting

## 📋 Prerequisites

- Node.js (v18 or higher)
- OpenAI API key with GPT-5 access
- Claude Code IDE

## 🛠 Installation

### 1. Clone the Repository

```bash
git clone https://github.com/AllAboutAI-YT/gpt5mcp.git
cd gpt5mcp
```

### 2. Install Dependencies

```bash
cd servers/gpt5-server
npm install
```

### 3. Build the Server

```bash
npm run build
```

### 4. Configure Environment Variables

Create a `.env` file in the `servers` directory:

```bash
# servers/.env
OPENAI_API_KEY=your-openai-api-key-here
```

## 🔧 Claude Code Integration

### Add the Server to Claude Code

```bash
claude mcp add gpt5-server -e OPENAI_API_KEY=your-openai-api-key-here -- node /path/to/gpt5mcp/servers/gpt5-server/build/index.js
```

### Verify Installation

Test the server with a simple query:

```
Ask GPT-5: "Hello, how are you today?"
```

## 📚 Available Tools

### `gpt5_generate`

Generate text using a simple input prompt.

**Parameters:**
- `input` (required): The text prompt for GPT-5
- `model` (optional): GPT-5 model variant (default: "gpt-5")
- `instructions` (optional): System instructions for the model
- `reasoning_effort` (optional): Reasoning level ("low", "medium", "high")
- `max_tokens` (optional): Maximum tokens to generate
- `temperature` (optional): Randomness level (0-2)
- `top_p` (optional): Top-p sampling parameter (0-1)

### `gpt5_messages`

Generate text using structured conversation messages.

**Parameters:**
- `messages` (required): Array of conversation messages with role and content
- `model` (optional): GPT-5 model variant (default: "gpt-5")
- `instructions` (optional): System instructions for the model
- `reasoning_effort` (optional): Reasoning level ("low", "medium", "high")
- `max_tokens` (optional): Maximum tokens to generate
- `temperature` (optional): Randomness level (0-2)
- `top_p` (optional): Top-p sampling parameter (0-1)

**Message Format:**
```json
{
  "messages": [
    {"role": "user", "content": "What is the capital of France?"},
    {"role": "assistant", "content": "The capital of France is Paris."},
    {"role": "user", "content": "What about Germany?"}
  ]
}
```

## 🎯 Usage Examples

### Simple Text Generation

```typescript
// Using the gpt5_generate tool
{
  "input": "Explain quantum computing in simple terms",
  "reasoning_effort": "high",
  "max_tokens": 500
}
```

### Conversation Handling

```typescript
// Using the gpt5_messages tool
{
  "messages": [
    {"role": "user", "content": "I'm learning Python. Can you help?"},
    {"role": "assistant", "content": "I'd be happy to help you learn Python! What specific topic would you like to start with?"},
    {"role": "user", "content": "Let's start with variables and data types."}
  ],
  "instructions": "Be a helpful Python tutor",
  "reasoning_effort": "medium"
}
```

## 📁 Project Structure

```
gpt5mcp/
├── servers/
│   └── gpt5-server/
│       ├── src/
│       │   ├── index.ts          # Main server implementation
│       │   └── utils.ts          # GPT-5 API utilities
│       ├── build/                # Compiled TypeScript output
│       ├── package.json          # Dependencies and scripts
│       └── tsconfig.json         # TypeScript configuration
├── CLAUDE.md                     # Claude Code configuration
├── GPT5-MCP-Server-Guide.html    # Interactive setup guide
├── .gitignore                    # Git ignore patterns
└── README.md                     # This file
```

## 🛡️ Security

- API keys are loaded from environment variables (never hardcoded)
- The `.env` file is automatically excluded from version control
- All API communications use secure HTTPS
- Error messages don't expose sensitive information

## 🔄 Development

### Scripts

- `npm run build`: Compile TypeScript and set permissions
- `npm run start`: Start the compiled server
- `npm run dev`: Build and start in development mode

### Making Changes

1. Edit TypeScript files in `src/`
2. Run `npm run build` to compile
3. Restart Claude Code MCP server if needed

## 🐛 Troubleshooting

### Common Issues

**Server not found in Claude Code:**
```bash
# Remove and re-add the server
claude mcp remove gpt5-server
claude mcp add gpt5-server -e OPENAI_API_KEY=your-key -- node /path/to/build/index.js
```

**API Key Issues:**
- Ensure your OpenAI API key has GPT-5 access
- Verify the key is correctly set in the `.env` file
- Check that the environment variable is properly loaded

**Build Errors:**
```bash
# Clean rebuild
rm -rf build/
npm run build
```

## 📖 Interactive Guide

Open `GPT5-MCP-Server-Guide.html` in your browser for an interactive, step-by-step setup guide with copy-paste commands.

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature-name`
3. Make your changes and test thoroughly
4. Commit your changes: `git commit -m 'Add feature-name'`
5. Push to the branch: `git push origin feature-name`
6. Submit a pull request

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Built with [Model Context Protocol (MCP)](https://github.com/modelcontextprotocol/servers) by Anthropic
- Powered by OpenAI's GPT-5 API
- Created for the Claude Code community

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/AllAboutAI-YT/gpt5mcp/issues)
- **Discussions**: [GitHub Discussions](https://github.com/AllAboutAI-YT/gpt5mcp/discussions)
- **Documentation**: [MCP Documentation](https://docs.anthropic.com/en/docs/build-with-claude/computer-use)

---

⭐ **Star this repo if you found it helpful!**
