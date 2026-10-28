import { execFileSync } from 'node:child_process';

/** "[[dd-]hh:]mm:ss" (ps etime) -> seconds */
export function parseEtime(s) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(String(s).trim());
  if (!m) return 0;
  const [, d = 0, h = 0, min, sec] = m;
  return Number(d) * 86400 + Number(h) * 3600 + Number(min) * 60 + Number(sec);
}

/** Output of `ps -axo pid=,ppid=,rss=,etime=,command=` */
export function parsePs(text) {
  const procs = [];
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (!m) continue;
    procs.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      rssKb: Number(m[3]),
      ageSec: parseEtime(m[4]),
      command: m[5].trim(),
    });
  }
  return procs;
}

/** Output of Get-CimInstance Win32_Process | ConvertTo-Json */
export function parseWindows(json, now = Date.now()) {
  const data = JSON.parse(json || '[]');
  const rows = Array.isArray(data) ? data : [data];
  return rows
    .filter((r) => r && r.ProcessId != null)
    .map((r) => {
      const created = parseCimDate(r.CreationDate);
      return {
        pid: Number(r.ProcessId),
        ppid: Number(r.ParentProcessId),
        rssKb: Math.round(Number(r.WorkingSetSize || 0) / 1024),
        ageSec: created ? Math.max(0, Math.round((now - created) / 1000)) : 0,
        createdMs: created || undefined,
        command: String(r.CommandLine || r.Name || '').trim(),
      };
    });
}

function parseCimDate(v) {
  if (!v) return 0;
  // ConvertTo-Json renders DateTime as "/Date(1730000000000)/"
  const ms = /\/Date\((\d+)\)\//.exec(String(v));
  if (ms) return Number(ms[1]);
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

export function listProcesses(platform = process.platform) {
  if (platform === 'win32') {
    const ps =
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CreationDate,CommandLine,Name | ConvertTo-Json -Compress';
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return parseWindows(out);
  }
  const out = execFileSync('ps', ['-A', '-ww', '-o', 'pid=,ppid=,rss=,etime=,command='], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return parsePs(out);
}
