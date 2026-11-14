# U2RE VSEXT

**Features (components):**

- [**MathML**](https://en.wikipedia.org/wiki/MathML) vs. [**KaTeX**](https://katex.org/docs/supported) operations.
- HTML vs. Markdown operations.
- Project management panel (quick actions).
- Symbolic link tools and utilities.
- Custom actions support (up to 3 in context menu).
- Agent panel: the AI agent of `@u2ai/server` or of the monolith `ai`, with the live
  actions, the ghost-text completion and the tools of the workspace.
- The tools of the editor as the tools of other AI systems, over the Model Context
  Protocol.
- Our U2RE projects better and simpler managment.
  - Press `X` to win!
  - Press `F` to pay respects!
- Configuratable themes (OLED, dark and light).

It's all known features, which I can currently to meet.

---

## The agent panel

The panel of the agent lives in the side bar (`Universal AI`). It starts a run on the bus
of the agent server, shows the life of the run — the text, the reasoning, the tools — and
lets the user answer the questions of the server and approve the tools it wants to run.

| Command | What it does |
|---|---|
| `Universal AI: Start agent` | Connects to the agent server and starts the bus. |
| `Universal AI: Stop agent` | Stops the current run. |
| `Universal AI: Reconnect agent` | Reconnects to the server. |
| `Universal AI: Tools of the agent server` | Shows the tools of the server and calls one of them. |
| `Universal AI: Copy the MCP configuration of the editor` | Puts the MCP configuration of the editor into the clipboard. |

The extension talks to two servers and knows both of them:

| Server | Home | Protocol |
|---|---|---|
| `ai-serve serve` (the package `@u2ai/server`) | `~/.ai-serve` (`AI_SERVE_HOME`) | `ai-serve` `0.4` |
| `ai serve` (the monolith) | `~/.ai-agent` (`AI_AGENT_HOME`) | `ai-serve` `0.2` |

The address of the server comes from the file `serve.json` of the home directory. The
first home with a live record wins: `AI_SERVE_HOME` and `~/.ai-serve` come first,
`AI_AGENT_HOME` and `~/.ai-agent` after. The record names the parts of the server — the
bus, the HTTP part, the route of the completion and the endpoint of MCP:

```json
{
  "pid": 12345,
  "url": "ws://127.0.0.1:8765",
  "token": "<64 hex characters>",
  "httpURL": "http://127.0.0.1:8765",
  "complete": "http://127.0.0.1:8765/v1/complete",
  "structure": "http://127.0.0.1:8765/v1/structure",
  "completeWs": "ws://127.0.0.1:8765/v1/complete",
  "mcp": "http://127.0.0.1:8765/mcp",
  "protocol": "0.4"
}
```

A server of the version `0.2` does not know the frame `tools.register`: the extension
takes the refusal of the server and goes on working — the tools of the editor are simply
not published to that server.

---

## The settings

| Setting | Default | What it does |
|---|---|---|
| `vext.agent.server` | `auto` | The server to start: `auto` tries `ai-serve` and then `ai`, `ai-serve` starts only the package, `ai` only the monolith. |
| `vext.agent.command` | empty | The program to start. Empty takes the program of `vext.agent.server`. |
| `vext.agent.port` | `0` | The port of the bus. `0` takes the port of `serve.json`. |
| `vext.agent.token` | empty | The token of a server that already runs. Empty takes the token of `serve.json`. |
| `vext.agent.launch` | `false` | Start the agent server when no live `serve.json` is found. |
| `vext.agent.approve` | `ask` | The level of the approval sent with every run: `ask`, `read`, `write`, `all`. |
| `vext.agent.openaiBaseUrl` | empty | `OPENAI_BASE_URL` for a server this extension starts. |
| `vext.agent.openaiApiKey` | empty | `OPENAI_API_KEY` for a server this extension starts. |
| `vext.agent.completion.enabled` | `true` | The ghost text of the completion. |
| `vext.agent.completion.debounceMs` | `350` | The wait after the last edit before the request of the completion. |
| `vext.agent.completion.model` | `minimax/minimax-m3.1-flash` | The model of the completion. The first three of the list are the models of `@u2ai/server`. |

The default model of the server is `minimax/minimax-m3.1-flash`; the server falls back to
`moonshotai/kimi-k3` and `openai/gpt-5.1` when the model of the run is not free.

The ghost text comes over the WebSocket of the bus. When the bus does not answer the
request, the extension takes the HTTP route `/v1/complete` of the same server.

---

## The tools of the editor

Only the editor has the access to the API of the editor, so only the editor can run the
tools of the workspace: the files, the search, the terminal. The extension publishes them
to the bus of the server with the frame `tools.register`, and the server calls them back
with the frame `tool.call`.

The names of the tools carry the name of the client, so two clients may have a tool with
the same name: the tool `read_file` of the client `vscode` is `vscode__read_file`. The
catalog of the editor is the same list as the tools it really runs — the test of the
repository compares them.

| Tool | What it does |
|---|---|
| `list_files` | The files and the directories of a path of the workspace. |
| `read_file` | A text file of the workspace, with the numbered lines. |
| `search_files` | The files that hold a string or a regular expression. |
| `write_file` | Write a file of the workspace. |
| `replace_text` | Replace a fragment of a file. |
| `delete_file` | Delete a file of the workspace. |
| `run_command` | One command of the workspace. |
| `run_script` | A script file of the workspace. |

There are two ways for another AI system to take them.

### The MCP server of the package

The MCP server of `@u2ai/server` shows the tools of the clients of the bus in the same
list as its own tools. The client of MCP asks the server for the list and calls a tool of
the editor by the name with the prefix: `vscode__read_file`.

### The stdio server of the editor

The extension ships a program of its own: `dist/agent-mcp.mjs`. It speaks the Model
Context Protocol over the standard input and the standard output — JSON-RPC 2.0 without an
SDK — and it serves the tools of the editor. The path of the program goes into the
configuration of a client of MCP:

```json
{
  "mcpServers": {
    "vscode": {
      "command": "C:\\Program Files\\Microsoft VS Code\\Code.exe",
      "args": ["C:\\Users\\you\\.vscode\\extensions\\u2re-dev.u2re-toolset\\dist\\agent-mcp.mjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

The binary of the host of the extension is Electron, not Node.js, so the environment of
the program says `ELECTRON_RUN_AS_NODE: "1"` — with it the same binary runs the script as
Node.js. A real `node` in the path needs no flag.

The command `Universal AI: Copy the MCP configuration of the editor` writes exactly this
configuration, with the real path of the program and the homes of the server, into the
clipboard.

The program finds the server through the record `serve.json` of the homes of the server:
`AI_SERVE_HOME`/`~/.ai-serve` first, `AI_AGENT_HOME`/`~/.ai-agent` after. It asks the MCP
server of the agent for the tools of the editor and calls them through it. The names lose
the prefix of the client on the way out and get it back on the way in: the client of MCP
sees `read_file` and not `vscode__read_file`.

The program writes nothing to the standard output except the answers of the protocol: a
note about a failure goes to the standard error, so the channel of the protocol stays
clean.

---

## The development

```bash
npm install
npm run compile        # the bundles: dist/extension.mjs and dist/agent-mcp.mjs
npm test               # the tests of vscode-test
npm run check-types    # tsc --noEmit
npm run lint
```

The bundle of the agent server is a program of its own: it must not take the API of the
editor, because the program lives outside of the editor.
