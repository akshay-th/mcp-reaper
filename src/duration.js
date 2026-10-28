/** "30s" | "10m" | "1h" | "2d" | "500ms" | "45" (seconds) -> seconds */
export function parseDuration(s, fallback) {
  if (s == null || s === '') return fallback;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(String(s).trim());
  if (!m) throw new Error(`bad duration "${s}" (try 30s, 10m, 1h)`);
  const mult = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400 }[m[2] || 's'];
  return Number(m[1]) * mult;
}
