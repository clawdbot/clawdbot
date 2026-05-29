function readPositiveIntEnv(name, fallback, env) {
  const text = String(env[name] ?? fallback).trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`invalid ${name}: ${text}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid ${name}: ${text}`);
  }
  return value;
}

export function readGatewayNetworkClientConnectTimeoutMs(env = process.env) {
  if (env.OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS != null) {
    return readPositiveIntEnv("OPENCLAW_GATEWAY_NETWORK_CLIENT_CONNECT_TIMEOUT_MS", 80000, env);
  }
  return readPositiveIntEnv("OPENCLAW_GATEWAY_NETWORK_CONNECT_READY_TIMEOUT_MS", 80000, env);
}
