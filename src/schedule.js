import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const LABEL = 'dev.akshay-th.mcp-reaper';

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function launchdPlist({ program, intervalSec, logPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${program.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>StartInterval</key>
  <integer>${intervalSec}</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(logPath)}</string>
</dict>
</plist>
`;
}

const shq = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

export function systemdUnits({ program, intervalSec }) {
  return {
    service: `[Unit]
Description=Kill orphaned MCP server processes (mcp-reaper)

[Service]
Type=oneshot
ExecStart=${program.map(shq).join(' ')}
`,
    timer: `[Unit]
Description=Run mcp-reaper every ${intervalSec}s

[Timer]
OnBootSec=2min
OnUnitActiveSec=${intervalSec}s
Persistent=true

[Install]
WantedBy=timers.target
`,
  };
}

export function paths(home = homedir()) {
  return {
    plist: join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    log: join(home, 'Library', 'Logs', 'mcp-reaper.log'),
    service: join(home, '.config', 'systemd', 'user', 'mcp-reaper.service'),
    timer: join(home, '.config', 'systemd', 'user', 'mcp-reaper.timer'),
  };
}

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function install({ program, intervalSec, platform = process.platform, home }) {
  const p = paths(home);
  if (platform === 'darwin') {
    mkdirSync(dirname(p.plist), { recursive: true });
    mkdirSync(dirname(p.log), { recursive: true });
    try {
      run('launchctl', ['unload', p.plist]);
    } catch {}
    writeFileSync(p.plist, launchdPlist({ program, intervalSec, logPath: p.log }));
    run('launchctl', ['load', '-w', p.plist]);
    return { files: [p.plist], log: p.log };
  }
  if (platform === 'linux') {
    const units = systemdUnits({ program, intervalSec });
    mkdirSync(dirname(p.service), { recursive: true });
    writeFileSync(p.service, units.service);
    writeFileSync(p.timer, units.timer);
    run('systemctl', ['--user', 'daemon-reload']);
    run('systemctl', ['--user', 'enable', '--now', 'mcp-reaper.timer']);
    return { files: [p.service, p.timer], log: 'journalctl --user -u mcp-reaper' };
  }
  if (platform === 'win32') {
    const minutes = Math.max(1, Math.round(intervalSec / 60));
    const tr = program.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
    run('schtasks', ['/Create', '/F', '/SC', 'MINUTE', '/MO', String(minutes), '/TN', 'mcp-reaper', '/TR', tr]);
    return { files: ['Task Scheduler: mcp-reaper'], log: null };
  }
  throw new Error(`install is not supported on ${platform}`);
}

export function uninstall({ platform = process.platform, home } = {}) {
  const p = paths(home);
  const removed = [];
  if (platform === 'darwin') {
    if (existsSync(p.plist)) {
      try {
        run('launchctl', ['unload', '-w', p.plist]);
      } catch {}
      rmSync(p.plist);
      removed.push(p.plist);
    }
  } else if (platform === 'linux') {
    try {
      run('systemctl', ['--user', 'disable', '--now', 'mcp-reaper.timer']);
    } catch {}
    for (const f of [p.timer, p.service]) {
      if (existsSync(f)) {
        rmSync(f);
        removed.push(f);
      }
    }
    try {
      run('systemctl', ['--user', 'daemon-reload']);
    } catch {}
  } else if (platform === 'win32') {
    try {
      run('schtasks', ['/Delete', '/F', '/TN', 'mcp-reaper']);
      removed.push('Task Scheduler: mcp-reaper');
    } catch {}
  }
  return removed;
}
