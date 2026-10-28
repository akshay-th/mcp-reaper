import { execFileSync } from 'node:child_process';

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * SIGTERM every pid in the group (children first), wait up to graceMs,
 * then SIGKILL whatever is left. Returns { killed: [], survived: [], errors: [] }.
 */
export async function killGroup(pids, { graceMs = 3000, platform = process.platform } = {}) {
  const order = [...pids].reverse();
  const errors = [];
  if (platform === 'win32') {
    for (const pid of order) {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } catch (e) {
        if (alive(pid)) errors.push({ pid, message: e.message });
      }
    }
  } else {
    for (const pid of order) {
      try {
        process.kill(pid, 'SIGTERM');
      } catch (e) {
        if (e.code !== 'ESRCH') errors.push({ pid, message: e.message });
      }
    }
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && order.some(alive)) await sleep(100);
    for (const pid of order.filter(alive)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch (e) {
        if (e.code !== 'ESRCH') errors.push({ pid, message: e.message });
      }
    }
    const end = Date.now() + 1000;
    while (Date.now() < end && order.some(alive)) await sleep(50);
  }
  const survived = order.filter(alive);
  return { killed: order.filter((p) => !survived.includes(p)), survived, errors };
}
