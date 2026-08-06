// Environment limit helpers for E2E subprocess scenarios.
export function readPositiveIntEnv(name, fallback, env = process.env) {
  const raw = env[name] ?? fallback;
  const text = raw == null ? "unset" : String(raw).trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`invalid ${name}: ${text}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid ${name}: ${text}`);
  }
  return value;
}

export function readTcpPortEnv(name, fallback, env = process.env) {
  const value = readPositiveIntEnv(name, fallback, env);
  if (value > 65_535) {
    const raw = env[name] ?? fallback;
    const text = raw == null ? "unset" : String(raw).trim();
    throw new Error(`invalid ${name}: ${text}`);
  }
  return value;
}
