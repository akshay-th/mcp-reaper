# mcp-reaper

**Find and kill MCP server processes that outlived the AI agent that started them.**

Every stdio MCP server runs as a child process of your agent. When the agent crashes, a terminal closes, a `claude -p` run finishes, a subagent ends, or you reconnect servers with `/mcp`, those children are often left behind. They pile up: dozens of `npm exec @playwright/mcp`, `uvx mcp-server-*` and `node .../index.js` processes, each holding 40–200 MB plus any browsers they launched.

This is one of the most-reported MCP problems across agents:

- Claude Code: [#1935](https://github.com/anthropics/claude-code/issues/1935), #22612, #24649, #26658, #33947, #35567, #40667, #42881, #58918, #79740, #93087 … including reports of 248 orphaned servers using 111 GB and a kernel panic.
- Codex: #30408 (9+ GB RSS), #40579 (Windows)
- Cursor forum: "MCP server process leak", "orphaned children on restart"
- Gemini: "all MCP server processes are orphaned after conversation ends"

The usual workaround is a manual `pkill -f some-server`. `mcp-reaper` does the same job safely: it only kills servers whose agent is actually gone.

```
$ mcp-reaper
orphaned  playwright  pid 41233 +6  612 MB  up 2d  agent gone
          npm exec @playwright/mcp@latest
orphaned  mcp-server-github  pid 40110 +1  88 MB  up 3d  agent gone
          npx -y @modelcontextprotocol/server-github
unmanaged mcp-remote  pid 51200  41 MB  up 2h  zsh (pid 51190)
          npx -y mcp-remote https://example.com/mcp

2 orphaned server tree(s) using 700 MB. Run mcp-reaper kill to clean up.

$ mcp-reaper kill
...
Kill 2 server tree(s)? [y/N] y
2026-10-28T17:02:11.004Z killed playwright (pid 41233 +6, 612 MB)
2026-10-28T17:02:11.190Z killed mcp-server-github (pid 40110 +1, 88 MB)
```

## Install

```bash
npm install -g github:akshay-th/mcp-reaper
# or try it without installing
npx -y github:akshay-th/mcp-reaper
```

It has no dependencies and needs Node 18.3+. It runs on macOS, Linux and Windows.

## Commands

| Command | What it does |
|---|---|
| `mcp-reaper` / `list` | Show orphaned and unmanaged servers. `--all` also shows servers attached to live agents, and flags duplicates (the same server running under several agents). |
| `mcp-reaper kill` | Kill orphaned server trees. Asks first. `--yes` skips the question, `--dry-run` only shows what would be killed. |
| `mcp-reaper watch` | Reap every `--interval` (default 5m) in the foreground. |
| `mcp-reaper install` | Reap on a schedule: a launchd agent on macOS, a systemd `--user` timer on Linux, Task Scheduler on Windows. Defaults: every 15m, orphans older than 10m. |
| `mcp-reaper uninstall` | Remove the schedule. |

Options: `--json`, `--min-age 2m`, `--match <regex>`, `--ignore <regex>`, `--only <regex>`, `--include-unmanaged`, `--quiet`.

You can make options permanent in `~/.config/mcp-reaper/config.json`:

```json
{ "ignore": ["my-long-running-http-mcp"], "match": ["serve_tools\\.py"], "minAge": "5m" }
```

## How it decides

1. **Find MCP servers.** It looks at the process table for:
   - command lines that look like MCP servers (`@playwright/mcp`, `mcp-server-fetch`, `blender-mcp`, `@modelcontextprotocol/server-*`, `fastmcp`, `docker run … mcp/github`, `claude mcp serve`);
   - **every server configured in your clients**: Claude Code (`~/.claude.json`, including per-project servers), Claude Desktop, Cursor, Windsurf, VS Code, Gemini CLI and Codex (`config.toml`). Custom servers like `node ~/work/notes/dist/index.js` are recognised this way.
2. **Group each server with its wrappers and children.** For example, `npm exec` → `node playwright-mcp` → Chrome is one tree, and is killed as one.
3. **Walk up the parent chain**, past wrappers like `npx`, `uv`, `sh -c` and `node`:
   - It reaches a running agent (Claude Code, Claude Desktop, Codex, Cursor, VS Code, Windsurf, Gemini CLI, Copilot CLI, OpenCode, Goose, Zed, Amp, Kiro, Qwen Code, Crush …) → **attached**. Never touched.
   - It reaches PID 1, `launchd` or a `systemd --user` subreaper, or the parent no longer exists (Windows) → **orphaned**.
   - It reaches anything else, such as a shell, tmux or Terminal → **unmanaged**. You probably started it by hand, so it is only killed with `--include-unmanaged`.

Safety rails:

- It never touches its own process chain.
- Orphans younger than `--min-age` (default 60s) are skipped.
- It re-scans right before killing and skips any PID whose command changed, so a reused PID is never hit.
- It sends SIGTERM to the whole tree, then SIGKILL after 3s. On Windows it uses `taskkill /T /F`.
- On Windows, PIDs get reused, so a "parent" that is younger than its child is treated as gone.
- Without `--yes`, it won't kill anything if it can't ask you.

## Examples

```bash
mcp-reaper --all --json | jq '.servers[] | {label, status, host, mb: (.rssKb/1024|floor)}'
mcp-reaper kill --only playwright --yes        # just the browser servers
mcp-reaper install --interval 10m --min-age 30m
```

## Limitations

- An agent that is alive but has stopped using a server, for example after `/mcp` reconnects, still counts as its parent, so that server isn't reaped. Restarting the agent fixes it.
- A server you deliberately run as a launchd or systemd service has PID 1 as its parent. Add it to `ignore`.

## License

MIT
