import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify } from '../src/classify.js';
import { alive } from '../src/kill.js';
import { listProcesses } from '../src/ps.js';

const CLI = fileURLToPath(new URL('../bin/cli.js', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-mcp-server.js', import.meta.url));
const unix = process.platform !== 'win32';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Start the fake server from a short-lived parent so it gets re-parented,
// exactly like a server whose agent crashed.
async function spawnOrphan(tag) {
  const launcher = `const c=require('child_process').spawn(process.execPath,[${JSON.stringify(FAKE)},${JSON.stringify(tag)}],{detached:true,stdio:'ignore'});console.log(c.pid);c.unref();`;
  const r = spawnSync(process.execPath, ['-e', launcher], { encoding: 'utf8' });
  const pid = Number(r.stdout.trim());
  for (let i = 0; i < 50 && !listProcesses().some((p) => p.pid === pid); i++) await sleep(50);
  return pid;
}

test('detects and kills a real orphaned server', { skip: !unix }, async () => {
  const tag = `orphan-${process.pid}-${Date.now()}`;
  const pid = await spawnOrphan(tag);
  try {
    assert.ok(alive(pid), 'orphan should be running');
    const group = classify(listProcesses(), {}).servers.find((g) => g.pids.includes(pid));
    assert.ok(group, 'orphan should be detected');
    // Usually re-parented to PID 1; some CI sandboxes use a different subreaper.
    assert.ok(['orphaned', 'unmanaged'].includes(group.status), group.status);

    const listed = spawnSync(process.execPath, [CLI, 'list', '--json', '--only', tag], { encoding: 'utf8' });
    assert.equal(listed.status, 0, listed.stderr);
    assert.deepEqual(JSON.parse(listed.stdout).servers.map((g) => g.rootPid), [pid]);

    const dry = spawnSync(process.execPath, [CLI, 'kill', '--dry-run', '--min-age', '0', '--include-unmanaged', '--only', tag], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.match(dry.stdout, /--dry-run: nothing killed/);
    assert.ok(alive(pid));

    const noTty = spawnSync(process.execPath, [CLI, 'kill', '--min-age', '0', '--include-unmanaged', '--only', tag], { encoding: 'utf8' });
    assert.equal(noTty.status, 1);
    assert.match(noTty.stderr, /pass --yes/);
    assert.ok(alive(pid));

    const young = spawnSync(process.execPath, [CLI, 'kill', '--yes', '--min-age', '1h', '--include-unmanaged', '--only', tag], { encoding: 'utf8' });
    assert.match(young.stdout, /nothing to kill/);

    const r = spawnSync(process.execPath, [CLI, 'kill', '--yes', '--min-age', '0', '--include-unmanaged', '--only', tag], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /killed/);
    for (let i = 0; i < 20 && alive(pid); i++) await sleep(100);
    assert.equal(alive(pid), false, 'orphan should be gone');
  } finally {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {}
  }
});

test('attached servers are left alone', { skip: !unix }, async () => {
  const tag = `attached-${process.pid}-${Date.now()}`;
  // A fake agent host whose executable is named "codex" and keeps its server as a child.
  const dir = mkdtempSync(join(tmpdir(), 'reaper-'));
  const hostScript = join(dir, 'codex');
  writeFileSync(hostScript, `require('child_process').spawn(process.execPath, [${JSON.stringify(FAKE)}, process.argv[2]], { stdio: 'ignore' }); setInterval(() => {}, 1000);`);
  const host = spawn(process.execPath, [hostScript, tag], { stdio: 'ignore' });
  try {
    let group;
    for (let i = 0; i < 40 && !group; i++) {
      await sleep(50);
      group = classify(listProcesses(), {}).servers.find((g) => g.command.includes(tag) && g.command.includes('fake-mcp-server'));
    }
    assert.ok(group, 'server should be detected');
    assert.equal(group.status, 'attached');
    assert.equal(group.host, 'Codex');
    assert.equal(group.hostPid, host.pid);
    const r = spawnSync(process.execPath, [CLI, 'kill', '--yes', '--min-age', '0', '--only', `fake-mcp-server.js ${tag}`], { encoding: 'utf8' });
    assert.match(r.stdout, /nothing to kill/);
    assert.ok(alive(group.rootPid));
  } finally {
    host.kill('SIGKILL');
    spawnSync('pkill', ['-f', tag]);
  }
});
