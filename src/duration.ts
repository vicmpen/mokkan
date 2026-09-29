const DURATION_RE = /^(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;

/** Parses "30s", "10m", "2h", "1d", "1h30m" (units in d/h/m/s order) into seconds. */
export function parseDuration(input: string): number {
  const s = input.trim();
  const m = DURATION_RE.exec(s);
  if (!s || !m || m.slice(1).every((part) => part === undefined)) {
    throw new Error(`Invalid duration "${input}" (examples: 30s, 10m, 2h, 1d, 1h30m)`);
  }
  const [d, h, min, sec] = m.slice(1).map((part) => (part === undefined ? 0 : Number(part)));
  return d * 86400 + h * 3600 + min * 60 + sec;
}
