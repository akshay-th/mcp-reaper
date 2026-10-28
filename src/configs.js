import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseToml } from './toml.js';

// Where each client keeps its MCP servers. Used to recognise servers whose
// process name says nothing about MCP (e.g. `node /path/to/dist/index.js`).
export function configLocations(home = homedir(), platform = process.platform, env = process.env) {
  const appData = env.APPDATA || join(home, 'AppData', 'Roaming');
  const macSupport = join(home, 'Library', 'Application Support');
  const xdg = env.XDG_CONFIG_HOME || join(home, '.config');
  const appDir = (name) =>
    platform === 'darwin' ? join(macSupport, name) : platform === 'win32' ? join(appData, name) : join(xdg, name);
  const claudeHome = env.CLAUDE_CONFIG_DIR || home;
  return [
    { client: 'Claude Code', path: join(claudeHome, '.claude.json'), format: 'claude-code' },
    { client: 'Claude Desktop', path: join(appDir('Claude'), 'claude_desktop_config.json'), format: 'mcpServers' },
    { client: 'Cursor', path: join(home, '.cursor', 'mcp.json'), format: 'mcpServers' },
    { client: 'Windsurf', path: join(home, '.codeium', 'windsurf', 'mcp_config.json'), format: 'mcpServers' },
    { client: 'Gemini CLI', path: join(home, '.gemini', 'settings.json'), format: 'mcpServers' },
    { client: 'VS Code', path: join(appDir('Code'), 'User', 'mcp.json'), format: 'servers' },
    { client: 'Codex', path: join(env.CODEX_HOME || join(home, '.codex'), 'config.toml'), format: 'codex' },
  ];
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

export function serversFromConfig(format, data) {
  if (!data || typeof data !== 'object') return [];
  const out = [];
  const take = (obj, scope) => {
    if (!obj || typeof obj !== 'object') return;
    for (const [name, s] of Object.entries(obj)) {
      if (s && typeof s === 'object' && typeof s.command === 'string') {
        out.push({ name, command: s.command, args: Array.isArray(s.args) ? s.args.map(String) : [], scope });
      }
    }
  };
  if (format === 'claude-code') {
    take(data.mcpServers, 'user');
    for (const [dir, p] of Object.entries(data.projects || {})) take(p && p.mcpServers, dir);
  } else if (format === 'servers') take(data.servers);
  else if (format === 'codex') take(data.mcp_servers);
  else take(data.mcpServers);
  return out;
}

export function loadConfiguredServers(opts = {}) {
  const out = [];
  for (const loc of configLocations(opts.home, opts.platform, opts.env)) {
    if (!existsSync(loc.path)) continue;
    let data;
    if (loc.format === 'codex') {
      try {
        data = parseToml(readFileSync(loc.path, 'utf8'));
      } catch {
        continue;
      }
    } else data = readJson(loc.path);
    for (const s of serversFromConfig(loc.format, data)) out.push({ ...s, client: loc.client });
  }
  return out;
}

const GENERIC = new Set([
  'node', 'nodejs', 'python', 'python3', 'npx', 'npm', 'uv', 'uvx', 'bun', 'bunx', 'deno', 'pnpm', 'yarn',
  'docker', 'podman', 'sh', 'bash', 'cmd', 'cmd.exe', 'powershell', 'pwsh', 'java', 'go', 'ruby', 'php',
  'run', 'exec', 'tool', 'dlx', 'x', '-y', '--yes', 'start', 'serve', 'mcp',
]);

/**
 * The most distinctive string we expect to see in the server's command line:
 * the first non-flag argument that isn't a generic launcher word, or the command
 * itself if it's a dedicated binary.
 */
export function signatureOf(server) {
  for (const a of server.args) {
    if (a.startsWith('-')) continue;
    if (GENERIC.has(a.toLowerCase())) continue;
    if (a.length < 4) continue;
    return a;
  }
  const base = server.command.split(/[\\/]/).pop().toLowerCase();
  if (!GENERIC.has(base) && base.length >= 4) return server.command;
  return null;
}
