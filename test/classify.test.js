import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, mcpTokenOf, hostOf } from '../src/classify.js';

const P = (pid, ppid, command, extra = {}) => ({ pid, ppid, command, rssKb: 10240, ageSec: 3600, ...extra });

const base = [
  P(1, 0, '/sbin/launchd'),
  P(500, 1, '/Applications/Terminal.app/Contents/MacOS/Terminal'),
  P(501, 500, 'login -pf me'),
  P(502, 501, '-zsh'),
];

const byRoot = (servers) => Object.fromEntries(servers.map((s) => [s.rootPid, s]));

test('server under a live agent (through npx/node wrappers) is attached', () => {
  const { servers } = classify(
    [
      ...base,
      P(600, 502, '/Users/me/.local/bin/claude --model opus'),
      P(601, 600, 'npm exec @playwright/mcp@latest'),
      P(602, 601, 'node /Users/me/.npm/_npx/98/node_modules/.bin/playwright-mcp'),
      P(603, 602, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --remote-debugging-pipe'),
    ],
    { selfPid: 9999 },
  );
  assert.equal(servers.length, 1);
  const [g] = servers;
  assert.equal(g.status, 'attached');
  assert.equal(g.host, 'Claude Code');
  assert.equal(g.rootPid, 601);
  assert.deepEqual(g.pids.sort(), [601, 602, 603]);
  assert.equal(g.rssKb, 3 * 10240);
});

test('server re-parented to launchd/init is orphaned, including its wrapper chain', () => {
  const { servers } = classify(
    [
      ...base,
      P(700, 1, '/opt/homebrew/bin/uv tool uvx mcp-for-blender'),
      P(701, 700, '/Users/me/.cache/uv/archive-v0/x/bin/python /Users/me/.cache/uv/archive-v0/x/bin/mcp-for-blender'),
    ],
    { selfPid: 9999 },
  );
  const g = byRoot(servers)[700];
  assert.equal(g.status, 'orphaned');
  assert.deepEqual(g.pids, [700, 701]);
});

test('sh -c wrappers whose parent died are orphaned too', () => {
  const { servers } = classify(
    [...base, P(710, 1, 'sh -c npx -y @modelcontextprotocol/server-filesystem /tmp'), P(711, 710, 'node /x/node_modules/.bin/mcp-server-filesystem /tmp')],
    { selfPid: 9999 },
  );
  assert.equal(byRoot(servers)[710].status, 'orphaned');
});

test('a server started by hand in a terminal is unmanaged, not orphaned', () => {
  const { servers } = classify([...base, P(800, 502, 'npx -y mcp-remote https://example.com/mcp')], { selfPid: 9999 });
  const g = byRoot(servers)[800];
  assert.equal(g.status, 'unmanaged');
  assert.equal(g.host, 'zsh');
});

test('systemd --user subreaper counts as init on Linux', () => {
  const { servers } = classify(
    [P(1, 0, '/sbin/init splash'), P(900, 1, '/lib/systemd/systemd --user'), P(901, 900, 'node /home/me/mcp-servers/notes/index.js')],
    { selfPid: 9999, platform: 'linux' },
  );
  assert.equal(servers[0].status, 'orphaned');
});

test('agent processes are hosts, never servers, even with mcp__ flags', () => {
  const claude = P(600, 502, '/Users/me/claude --allowedTools=mcp__computer-use,mcp__ccd_session__spawn_task --setting-sources=user');
  assert.equal(hostOf(claude), 'Claude Code');
  const { servers } = classify([...base, claude], { selfPid: 9999 });
  assert.equal(servers.length, 0);
});

test('"claude mcp serve" is detected as a server', () => {
  const { servers } = classify([...base, P(600, 1, '/usr/local/bin/claude mcp serve')], { selfPid: 9999 });
  assert.equal(servers.length, 1);
  assert.equal(servers[0].status, 'orphaned');
});

test('configured servers are recognised by their signature', () => {
  const procs = [...base, P(620, 1, 'node /Users/me/work/notes-server/dist/index.js --stdio')];
  assert.equal(classify(procs, { selfPid: 9999 }).servers.length, 0);
  const { servers } = classify(procs, {
    selfPid: 9999,
    signatures: [{ name: 'notes', client: 'Cursor', signature: '/Users/me/work/notes-server/dist/index.js' }],
  });
  assert.equal(servers[0].label, 'notes');
  assert.equal(servers[0].source, 'Cursor');
});

test('--match and --ignore', () => {
  const procs = [...base, P(630, 1, 'python serve_tools.py'), P(631, 1, 'npx -y @upstash/context7-mcp')];
  const { servers } = classify(procs, { selfPid: 9999, match: [/serve_tools\.py/], ignore: [/context7/] });
  assert.deepEqual(servers.map((s) => s.rootPid), [630]);
});

test('never touches its own process chain', () => {
  const { servers } = classify([...base, P(640, 1, 'node /usr/lib/node_modules/mcp-reaper/bin/cli.js kill')], { selfPid: 640 });
  assert.equal(servers.length, 0);
});

test('windows: missing parent or reused parent pid means orphaned', () => {
  const now = Date.now();
  const procs = [
    P(4, 0, 'System', { createdMs: now - 1e7 }),
    P(1200, 1100, 'C:\\Program Files\\nodejs\\node.exe C:\\Users\\me\\AppData\\npm\\node_modules\\@modelcontextprotocol\\server-memory\\dist\\index.js', { createdMs: now - 5e6 }),
    // pid 3000's parent pid 2000 is now an unrelated, younger process
    P(2000, 4, 'C:\\Windows\\explorer.exe', { createdMs: now - 1e3 }),
    P(3000, 2000, 'cmd.exe /c npx -y @playwright/mcp', { createdMs: now - 5e6 }),
  ];
  const { servers } = classify(procs, { selfPid: 9999, platform: 'win32' });
  const g = byRoot(servers);
  assert.equal(g[1200].status, 'orphaned');
  assert.equal(g[3000].status, 'orphaned');
});

test('mcpTokenOf recognises common server naming styles', () => {
  for (const [cmd, want] of [
    ['npm exec @playwright/mcp@latest', '@playwright/mcp@latest'],
    ['uvx mcp-server-fetch', 'mcp-server-fetch'],
    ['/opt/homebrew/bin/uv tool uvx blender-mcp', 'blender-mcp'],
    ['node /x/@modelcontextprotocol/server-github/dist/index.js', '/x/@modelcontextprotocol/server-github/dist/index.js'],
    ['fastmcp run server.py', 'fastmcp'],
    ['docker run -i --rm mcp/github', 'mcp/github'],
    ['python -m my_mcp_server', 'my_mcp_server'],
  ]) {
    assert.equal(mcpTokenOf(cmd), want, cmd);
  }
  for (const cmd of ['node server.js', '/usr/bin/vim mcpfoo.txt', 'git commit -m mcp']) {
    assert.equal(mcpTokenOf(cmd), null, cmd);
  }
});
