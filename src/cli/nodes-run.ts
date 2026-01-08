export function parseEnvPairs(
  pairs: unknown,
): Record<string, string> | undefined {
  if (!Array.isArray(pairs) || pairs.length === 0) return undefined;
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    if (typeof pair !== "string") continue;
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const key = pair.slice(0, idx).trim();
    if (!key) continue;
    env[key] = pair.slice(idx + 1);
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

export function parseTimeoutMs(raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  let value = Number.NaN;
  if (typeof raw === "number") {
    value = raw;
  } else if (typeof raw === "bigint") {
    value = Number(raw);
  } else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    value = Number.parseInt(trimmed, 10);
  }
  return Number.isFinite(value) ? value : undefined;
}
