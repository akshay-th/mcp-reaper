// Decide which processes are MCP servers and whether the agent that started
// them is still alive.

// Agent hosts that spawn stdio MCP servers. Matched against the full command line.
export const HOSTS = [
  { name: 'Claude Code', re: /(^|[\\/])claude(\.exe)?(\s|$)|@anthropic-ai[\\/]claude-code|native-binary[\\/]claude/i },
  { name: 'Claude Desktop', re: /Claude\.app[\\/]Contents[\\/]MacOS[\\/]Claude(\s|$)|[\\/]AnthropicClaude[\\/]|(^|[\\/])Claude\.exe/ },
  { name: 'Codex', re: /(^|[\\/])codex(\.exe)?(\s|$)|@openai[\\/]codex|(^|[\\/])codex-(aarch64|x86_64)/i },
  { name: 'Cursor', re: /Cursor\.app[\\/]|(^|[\\/])cursor(\.exe)?(\s|$)|Cursor Helper/i },
  { name: 'VS Code', re: /Visual Studio Code[^\\/]*\.app[\\/]|Code Helper|(^|[\\/])(code|code-insiders|Code)(\.exe)?(\s|$)|[\\/]share[\\/]code[\\/]code/ },
  { name: 'Windsurf', re: /Windsurf/i },
  { name: 'Gemini CLI', re: /(^|[\\/])gemini(\.exe)?(\s|$)|@google[\\/]gemini-cli/i },
  { name: 'Copilot CLI', re: /@github[\\/]copilot|(^|[\\/])copilot(\.exe)?(\s|$)/i },
  { name: 'OpenCode', re: /(^|[\\/])opencode(\.exe)?(\s|$)/i },
  { name: 'Goose', re: /(^|[\\/])goose(d)?(\.exe)?(\s|$)|Goose\.app/i },
  { name: 'Zed', re: /Zed\.app[\\/]|(^|[\\/])zed(\.exe)?(\s|$)|zed-editor/i },
  { name: 'Amp', re: /(^|[\\/])amp(\.exe)?(\s|$)|@sourcegraph[\\/]amp/i },
  { name: 'Kiro', re: /Kiro\.app[\\/]|(^|[\\/])kiro(\.exe)?(\s|$)/i },
  { name: 'Qwen Code', re: /(^|[\\/])qwen(\.exe)?(\s|$)|@qwen-code/i },
  { name: 'Crush', re: /(^|[\\/])crush(\.exe)?(\s|$)/i },
  { name: 'Antigravity', re: /Antigravity/i },
  { name: 'LM Studio', re: /LM Studio/i },
];

// Processes that only launch other processes. We look through them when
// walking up the tree.
const WRAPPER = /^(node|nodejs|npm|npx|pnpm|pnpx|yarn|bun|bunx|deno|uv|uvx|python[\d.]*|pipx|sh|bash|zsh|dash|fish|cmd|cmd\.exe|powershell|pwsh|env|tsx|ts-node|docker|podman|java|ruby|php|go|timeout|nohup|conhost\.exe)$/i;

const MCP_TOKEN = /(^|[\\/@_.-])(mcp|fastmcp|modelcontextprotocol)([\\/@_.:-]|$)/i;
// Only the reaper's own entry point, not anything that lives under a folder of that name.
const SELF = /mcp-reaper[\\/]bin[\\/]cli\.js|(^|[\\/\s])mcp-reaper(\.cmd)?(\s|$)/i;

export function tokens(command) {
  return command.split(/\s+/).filter(Boolean);
}

function base(tok) {
  return tok.replace(/^["']|["']$/g, '').split(/[\\/]/).pop();
}

// "-zsh" (login shell) -> "zsh"
const label = (tok) => base(tok).replace(/^-/, '');

export function hostOf(proc) {
  for (const h of HOSTS) if (h.re.test(proc.command)) return h.name;
  return null;
}

/** Name-based detection: "@playwright/mcp", "mcp-server-fetch", "blender-mcp", "fastmcp run". */
export function mcpTokenOf(command) {
  const toks = tokens(command).filter((t) => !t.startsWith('-'));
  for (const t of toks.slice(0, 6)) {
    const clean = t.replace(/^["']|["']$/g, '');
    if (clean.toLowerCase() !== 'mcp' && MCP_TOKEN.test(clean)) return clean;
  }
  // `claude mcp serve`, `some-cli mcp start`
  const i = toks.findIndex((t) => t.toLowerCase() === 'mcp');
  if (i > 0 && i < 4 && /^(serve|start|server|run|stdio)$/i.test(toks[i + 1] || '')) return toks.slice(0, i + 2).map(base).join(' ');
  return null;
}

/** "/u/.npm/_npx/9f/node_modules/@playwright/mcp/cli.js" -> "@playwright/mcp" */
export function prettyLabel(tok) {
  const s = tok.replace(/\\/g, '/').replace(/@latest$/, '');
  const nm = s.lastIndexOf('node_modules/');
  if (nm >= 0) {
    const [a, b] = s.slice(nm + 'node_modules/'.length).split('/');
    if (a === '.bin' && b) return b;
    if (a?.startsWith('@') && b) return `${a}/${b}`;
    if (a) return a;
  }
  const scoped = s.match(/(?:^|\/)(@[^/@]+\/[^/@]+)\//);
  return scoped ? scoped[1] : s;
}

export function isWrapper(proc) {
  const first = tokens(proc.command)[0] || '';
  return WRAPPER.test(base(first));
}

export function isInitLike(proc, platform = process.platform) {
  if (!proc) return true;
  if (proc.pid === 1) return true;
  if (platform === 'win32') return false;
  // Linux user subreapers adopt orphans instead of PID 1
  return /(^|\/)systemd\s+--user\b/.test(proc.command) || /(^|\/)(launchd|init)$/.test(tokens(proc.command)[0] || '');
}

/**
 * @param procs     list from listProcesses()
 * @param options   { signatures: [{name, client, signature}], match: RegExp[], ignore: RegExp[], selfPid, platform }
 * @returns { servers: Group[] } one group per server process tree:
 *   { rootPid, pids, label, source, status: 'orphaned'|'attached'|'unmanaged', host, hostPid, rssKb, ageSec, command }
 */
export function classify(procs, options = {}) {
  const { signatures = [], match = [], ignore = [], selfPid = process.pid, platform = process.platform } = options;
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const children = new Map();
  for (const p of procs) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p);
  }

  const parentOf = (p) => {
    const parent = byPid.get(p.ppid);
    if (!parent || parent.pid === p.pid) return undefined;
    // Windows never re-parents, and PIDs get reused: a "parent" younger than the
    // child is an unrelated process.
    if (p.createdMs && parent.createdMs && parent.createdMs > p.createdMs) return undefined;
    return parent;
  };

  // Our own process chain is off-limits.
  const protectedPids = new Set();
  for (let p = byPid.get(selfPid); p; p = parentOf(p)) protectedPids.add(p.pid);

  function detect(p) {
    if (protectedPids.has(p.pid) || SELF.test(p.command)) return null;
    if (ignore.some((re) => re.test(p.command))) return null;
    for (const s of signatures) {
      if (s.signature && p.command.includes(s.signature)) return { label: s.name, source: s.client };
    }
    for (const re of match) if (re.test(p.command)) return { label: (re.exec(p.command) || [])[0], source: '--match' };
    const tok = mcpTokenOf(p.command);
    if (tok && !hostOf(p)) return { label: prettyLabel(tok), source: 'name' };
    if (tok && /\bmcp\s+(serve|start|server)\b/i.test(p.command)) return { label: tok, source: 'name' };
    return null;
  }

  const hits = new Map();
  for (const p of procs) {
    const d = detect(p);
    if (d) hits.set(p.pid, d);
  }

  // Root of a server tree = highest ancestor that is still a server or a wrapper
  // (npx -> node -> server). Its parent decides the status.
  function rootOf(p) {
    let root = p;
    for (let cur = parentOf(p); cur; cur = parentOf(cur)) {
      if (hostOf(cur) && !hits.has(cur.pid)) break;
      if (isInitLike(cur, platform)) break;
      if (hits.has(cur.pid) || isWrapper(cur)) root = cur;
      else break;
    }
    return root;
  }

  function statusOf(root) {
    // Walk past wrappers (sh -c, npm exec) to the first meaningful ancestor.
    for (let cur = parentOf(root); ; cur = parentOf(cur)) {
      if (!cur || isInitLike(cur, platform)) return { status: 'orphaned' };
      const host = hostOf(cur);
      if (host && !hits.has(cur.pid)) return { status: 'attached', host, hostPid: cur.pid };
      if (!isWrapper(cur) && !hits.has(cur.pid)) return { status: 'unmanaged', host: label(tokens(cur.command)[0] || ''), hostPid: cur.pid };
    }
  }

  function subtree(pid, acc = []) {
    acc.push(pid);
    for (const c of children.get(pid) || []) if (!protectedPids.has(c.pid) && !acc.includes(c.pid)) subtree(c.pid, acc);
    return acc;
  }

  const groups = new Map();
  for (const pid of hits.keys()) {
    const p = byPid.get(pid);
    const root = rootOf(p);
    if (groups.has(root.pid)) continue;
    const pids = subtree(root.pid);
    const info = hits.get(pid);
    const st = statusOf(root);
    groups.set(root.pid, {
      rootPid: root.pid,
      pids,
      label: info.label,
      source: info.source,
      ...st,
      rssKb: pids.reduce((n, x) => n + (byPid.get(x)?.rssKb || 0), 0),
      ageSec: root.ageSec,
      command: root.command,
    });
  }
  return { servers: [...groups.values()].sort((a, b) => b.rssKb - a.rssKb) };
}
