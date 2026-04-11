export function toStringEnv(env?: NodeJS.ProcessEnv): Record<string, string> {
  if (!env) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      continue;
    }
    out[key] = value;
  }
  return out;
}
