#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { classify } from '../src/classify.js';
import { parseDuration } from '../src/duration.js';
import { loadConfiguredServers, signatureOf } from '../src/configs.js';
import { killGroup } from '../src/kill.js';
import { listProcesses } from '../src/ps.js';
import { install, uninstall } from '../src/schedule.js';

const HELP = `mcp-reaper — find and kill MCP server processes left behind by AI agents

Usage
  mcp-reaper [list]          show MCP servers and whether their agent is still alive
  mcp-reaper kill            kill orphaned servers (asks first unless --yes)
  mcp-reaper watch           keep killing orphans every --interval
  mcp-reaper install         run "kill --yes" on a schedule (launchd / systemd --user / Task Scheduler)
  mcp-reaper uninstall       remove the schedule

Options
  -a, --all                  list: also show servers whose agent is alive
      --json                 machine-readable output
  -y, --yes                  kill without asking
  -n, --dry-run              kill: only show what would be killed
      --min-age <dur>        skip orphans younger than this (default 60s; e.g. 30s, 10m, 1h)
      --interval <dur>       watch/install: how often to run (default 5m / 15m)
      --match <regex>        also treat matching commands as MCP servers (repeatable)
      --ignore <regex>       never touch matching commands (repeatable)
      --only <regex>         kill/list only servers whose command matches
      --include-unmanaged    also kill servers whose parent is a shell or terminal, not an agent
  -q, --quiet                only print when something was killed
  -h, --help

Config: ~/.config/mcp-reaper/config.json  { "match": [...], "ignore": [...], "minAge": "2m" }
`;

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (c) => (s) => (color ? `\x1b[${c}m${s}\x1b[0m` : String(s));
const red = paint(31);
const green = paint(32);
const yellow = paint(33);
const dim = paint(2);
const bold = paint(1);

const fmtAge = (s) => (s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : s < 86400 ? `${Math.floor(s / 3600)}h` : `${Math.floor(s / 86400)}d`);
const fmtMem = (kb) => (kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`);

function loadUserConfig() {
  const p = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'mcp-reaper', 'config.json');
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`could not read ${p}: ${e.message}`);
  }
}

function scan(opts) {
  const signatures = loadConfiguredServers().map((s) => ({ ...s, signature: signatureOf(s) }));
  const { servers } = classify(listProcesses(), { signatures, match: opts.match, ignore: opts.ignore });
  return opts.only ? servers.filter((g) => opts.only.test(g.command) || opts.only.test(g.label)) : servers;
}

function targets(servers, opts) {
  return servers.filter(
    (g) => (g.status === 'orphaned' || (opts.includeUnmanaged && g.status === 'unmanaged')) && g.ageSec >= opts.minAge,
  );
}

function printTable(servers, { all }) {
  const shown = all ? servers : servers.filter((g) => g.status !== 'attached');
  const orphans = servers.filter((g) => g.status === 'orphaned');
  const attached = servers.filter((g) => g.status === 'attached');
  if (!shown.length) {
    console.log(`${green('✓')} no orphaned MCP servers ${dim(`(${attached.length} attached to a running agent${attached.length && !all ? '; --all to list' : ''})`)}`);
    return;
  }
  for (const g of shown) {
    const tag =
      g.status === 'orphaned' ? red('orphaned ') : g.status === 'unmanaged' ? yellow('unmanaged') : green('attached ');
    const owner = g.status === 'orphaned' ? dim('agent gone') : dim(`${g.host} (pid ${g.hostPid})`);
    console.log(
      `${tag} ${bold(g.label)}  ${dim(`pid ${g.rootPid}${g.pids.length > 1 ? ` +${g.pids.length - 1}` : ''}`)}  ${fmtMem(g.rssKb)}  up ${fmtAge(g.ageSec)}  ${owner}`,
    );
    console.log(dim(`          ${g.command.length > 110 ? `${g.command.slice(0, 107)}...` : g.command}`));
  }
  const dupes = countDupes(attached);
  if (dupes.length) console.log(dim(`\nduplicates across agents: ${dupes.map(([l, n]) => `${l} ×${n}`).join(', ')}`));
  if (orphans.length) {
    const kb = orphans.reduce((n, g) => n + g.rssKb, 0);
    console.log(`\n${bold(orphans.length)} orphaned server tree(s) using ${bold(fmtMem(kb))}. Run ${bold('mcp-reaper kill')} to clean up.`);
  }
}

function countDupes(groups) {
  const m = new Map();
  for (const g of groups) m.set(g.label, (m.get(g.label) || 0) + 1);
  return [...m].filter(([, n]) => n > 1);
}

async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(question);
  rl.close();
  return /^y(es)?$/i.test(a.trim());
}

async function reap(opts, { interactive }) {
  const victims = targets(scan(opts), opts);
  if (!victims.length) {
    if (!opts.quiet) console.log(`${green('✓')} nothing to kill`);
    return { killed: [], victims };
  }
  if (!opts.quiet || opts.dryRun) printTable(victims, { all: true });
  if (opts.dryRun) {
    console.log(dim('\n--dry-run: nothing killed'));
    return { killed: [], victims };
  }
  if (!opts.yes) {
    if (!interactive || !process.stdin.isTTY) {
      console.error('refusing to kill without a terminal to confirm; pass --yes');
      process.exitCode = 1;
      return { killed: [], victims };
    }
    if (!(await confirm(`\nKill ${victims.length} server tree(s)? [y/N] `))) return { killed: [], victims };
  }
  // Re-scan right before killing so a reused PID never gets hit.
  const fresh = new Map(targets(scan(opts), opts).map((g) => [g.rootPid, g]));
  const killed = [];
  for (const g of victims) {
    const now = fresh.get(g.rootPid);
    if (!now || now.command !== g.command) continue;
    const r = await killGroup(now.pids);
    killed.push({ ...now, ...r });
    const line = `${r.survived.length ? yellow('partly killed') : red('killed')} ${g.label} (pid ${g.rootPid}${now.pids.length > 1 ? ` +${now.pids.length - 1}` : ''}, ${fmtMem(now.rssKb)})`;
    console.log(`${new Date().toISOString()} ${line}${r.survived.length ? ` survivors: ${r.survived.join(',')}` : ''}`);
  }
  return { killed, victims };
}

async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      all: { type: 'boolean', short: 'a' },
      json: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      'dry-run': { type: 'boolean', short: 'n' },
      'min-age': { type: 'string' },
      interval: { type: 'string' },
      match: { type: 'string', multiple: true },
      ignore: { type: 'string', multiple: true },
      only: { type: 'string' },
      'include-unmanaged': { type: 'boolean' },
      quiet: { type: 'boolean', short: 'q' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const cfg = loadUserConfig();
  const opts = {
    all: values.all,
    yes: values.yes,
    dryRun: values['dry-run'],
    quiet: values.quiet,
    includeUnmanaged: values['include-unmanaged'],
    minAge: parseDuration(values['min-age'] ?? cfg.minAge, 60),
    match: [...(cfg.match || []), ...(values.match || [])].map((r) => new RegExp(r, 'i')),
    ignore: [...(cfg.ignore || []), ...(values.ignore || [])].map((r) => new RegExp(r, 'i')),
    only: values.only ? new RegExp(values.only, 'i') : null,
  };
  const cmd = positionals[0] || 'list';

  if (cmd === 'list') {
    const servers = scan(opts);
    if (values.json) console.log(JSON.stringify({ servers }, null, 2));
    else printTable(servers, opts);
    return;
  }
  if (cmd === 'kill') {
    const r = await reap(opts, { interactive: true });
    if (values.json) console.log(JSON.stringify(r, null, 2));
    return;
  }
  if (cmd === 'watch') {
    const every = parseDuration(values.interval, 300) * 1000;
    opts.yes = true;
    console.log(dim(`watching every ${every / 1000}s (min age ${opts.minAge}s). Ctrl+C to stop.`));
    for (;;) {
      await reap({ ...opts, quiet: true }, { interactive: false });
      await new Promise((r) => setTimeout(r, every));
    }
  }
  if (cmd === 'install') {
    const self = fileURLToPath(import.meta.url);
    if (/[\\/]_npx[\\/]/.test(self)) {
      throw new Error('install from a permanent location, not npx: npm install -g github:akshay-th/mcp-reaper');
    }
    const intervalSec = Math.round(parseDuration(values.interval, 900));
    const minAge = values['min-age'] || cfg.minAge || '10m';
    const program = [process.execPath, self, 'kill', '--yes', '--quiet', '--min-age', String(minAge)];
    for (const r of values.match || []) program.push('--match', r);
    for (const r of values.ignore || []) program.push('--ignore', r);
    if (values.only) program.push('--only', values.only);
    const res = install({ program, intervalSec });
    console.log(`${green('✓')} installed: runs every ${intervalSec}s, kills orphans older than ${minAge}`);
    for (const f of res.files) console.log(dim(`  ${f}`));
    if (res.log) console.log(dim(`  log: ${res.log}`));
    return;
  }
  if (cmd === 'uninstall') {
    const removed = uninstall();
    console.log(removed.length ? `${green('✓')} removed ${removed.join(', ')}` : 'nothing installed');
    return;
  }
  throw new Error(`unknown command "${cmd}" (try --help)`);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`mcp-reaper: ${e.message}`);
  process.exitCode = 2;
});
