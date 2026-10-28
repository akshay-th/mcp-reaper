import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEtime, parsePs, parseWindows } from '../src/ps.js';
import { parseToml } from '../src/toml.js';
import { serversFromConfig, signatureOf, configLocations } from '../src/configs.js';
import { parseDuration } from '../src/duration.js';
import { launchdPlist, systemdUnits } from '../src/schedule.js';
import { join } from 'node:path';

test('parseEtime handles every ps format', () => {
  assert.equal(parseEtime('00:05'), 5);
  assert.equal(parseEtime('12:34'), 754);
  assert.equal(parseEtime('01:00:00'), 3600);
  assert.equal(parseEtime('04-10:00:01'), 4 * 86400 + 36001);
  assert.equal(parseEtime('garbage'), 0);
});

test('parsePs keeps spaces in commands', () => {
  const out = parsePs(
    '    1     0  18448 04-10:00:01 /sbin/launchd\n 3338  2445  45936 4-00:00:00 npm exec @playwright/mcp@latest  \n  777 1 10 00:01 /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/x --type=renderer\n',
  );
  assert.equal(out.length, 3);
  assert.deepEqual(out[1], { pid: 3338, ppid: 2445, rssKb: 45936, ageSec: 345600, command: 'npm exec @playwright/mcp@latest' });
  assert.match(out[2].command, /Claude Helper \(Renderer\)/);
});

test('parseWindows reads CIM json (single object or array)', () => {
  const now = 1_800_000_000_000;
  const one = parseWindows(
    JSON.stringify({ ProcessId: 10, ParentProcessId: 4, WorkingSetSize: 2048 * 1024, CreationDate: `/Date(${now - 60000})/`, CommandLine: 'node x', Name: 'node.exe' }),
    now,
  );
  assert.deepEqual(one, [{ pid: 10, ppid: 4, rssKb: 2048, ageSec: 60, createdMs: now - 60000, command: 'node x' }]);
  const many = parseWindows(JSON.stringify([{ ProcessId: 0, ParentProcessId: 0, CommandLine: null, Name: 'Idle' }]), now);
  assert.equal(many[0].command, 'Idle');
});

test('parseToml reads Codex MCP tables', () => {
  const t = parseToml(`
model = "gpt-5" # comment
[mcp_servers.github]
command = "npx"
args = ["-y", "@modelcontextprotocol/server-github"]
env = { GITHUB_TOKEN = "x#y", "OTHER" = 'lit' }

[mcp_servers."docs.search"]
command = 'uvx'
args = [
  "mcp-docs",   # trailing comment
  "--port", "3000",
]
enabled = true
startup_timeout_sec = 20
`);
  assert.equal(t.model, 'gpt-5');
  assert.deepEqual(t.mcp_servers.github, { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'x#y', OTHER: 'lit' } });
  assert.deepEqual(t.mcp_servers['docs.search'], { command: 'uvx', args: ['mcp-docs', '--port', '3000'], enabled: true, startup_timeout_sec: 20 });
});

test('serversFromConfig understands each client format', () => {
  assert.deepEqual(
    serversFromConfig('claude-code', {
      mcpServers: { a: { command: 'npx', args: ['a-mcp'] }, remote: { type: 'http', url: 'https://x' } },
      projects: { '/repo': { mcpServers: { b: { command: 'node', args: ['b.js'] } } } },
    }).map((s) => `${s.name}@${s.scope}`),
    ['a@user', 'b@/repo'],
  );
  assert.equal(serversFromConfig('servers', { servers: { v: { command: 'uvx', args: ['v'] } } })[0].name, 'v');
  assert.equal(serversFromConfig('codex', { mcp_servers: { c: { command: 'c-bin' } } })[0].command, 'c-bin');
  assert.deepEqual(serversFromConfig('mcpServers', null), []);
});

test('signatureOf picks the distinctive argument', () => {
  assert.equal(signatureOf({ command: 'npx', args: ['-y', '@playwright/mcp@latest'] }), '@playwright/mcp@latest');
  assert.equal(signatureOf({ command: 'uv', args: ['run', '--directory', '/srv/x', 'server.py'] }), '/srv/x');
  assert.equal(signatureOf({ command: '/usr/local/bin/notes-server', args: [] }), '/usr/local/bin/notes-server');
  assert.equal(signatureOf({ command: 'node', args: [] }), null);
  assert.equal(signatureOf({ command: 'docker', args: ['run', '-i', '--rm', 'mcp/github'] }), 'mcp/github');
});

test('configLocations honours CLAUDE_CONFIG_DIR and CODEX_HOME', () => {
  const locs = configLocations('/home/me', 'linux', { CLAUDE_CONFIG_DIR: '/cfg/claude', CODEX_HOME: '/cfg/codex' });
  assert.equal(locs.find((l) => l.client === 'Claude Code').path, join('/cfg/claude', '.claude.json'));
  assert.equal(locs.find((l) => l.client === 'Codex').path, join('/cfg/codex', 'config.toml'));
  assert.equal(locs.find((l) => l.client === 'VS Code').path, join('/home/me', '.config', 'Code', 'User', 'mcp.json'));
});

test('parseDuration', () => {
  assert.equal(parseDuration('30s'), 30);
  assert.equal(parseDuration('10m'), 600);
  assert.equal(parseDuration('1.5h'), 5400);
  assert.equal(parseDuration('45'), 45);
  assert.equal(parseDuration(undefined, 7), 7);
  assert.throws(() => parseDuration('soon'));
});

test('schedule files are well-formed', () => {
  const plist = launchdPlist({ program: ['/usr/bin/node', '/a b/cli.js', 'kill', '--match', 'x&y'], intervalSec: 900, logPath: '/tmp/l.log' });
  assert.match(plist, /<string>\/a b\/cli\.js<\/string>/);
  assert.match(plist, /x&amp;y/);
  assert.match(plist, /<integer>900<\/integer>/);
  const { service, timer } = systemdUnits({ program: ['/usr/bin/node', '/a b/cli.js', 'kill'], intervalSec: 600 });
  assert.match(service, /ExecStart=\/usr\/bin\/node '\/a b\/cli\.js' kill/);
  assert.match(timer, /OnUnitActiveSec=600s/);
});
