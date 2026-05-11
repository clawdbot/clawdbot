import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

type BridgeAuth = {
  token?: string;
  password?: string;
};

// In-process registry for loopback-only bridge servers that require auth, but
// are addressed via dynamic ephemeral ports (e.g. sandbox browser bridge).
const authByPort = new Map<number, BridgeAuth>();

export function setBridgeAuthForPort(port: number, auth: BridgeAuth): void {
  if (!Number.isFinite(port) || port <= 0) {
    return;
  }
  const token = normalizeOptionalString(auth.token) ?? "";
  const password = normalizeOptionalString(auth.password) ?? "";
  authByPort.set(port, {
    token: token || undefined,
    password: password || undefined,
  });
}

export function getBridgeAuthForPort(port: number): BridgeAuth | undefined {
  if (!Number.isFinite(port) || port <= 0) {
    return undefined;
  }
  return authByPort.get(port);
}

export function deleteBridgeAuthForPort(port: number): void {
  if (!Number.isFinite(port) || port <= 0) {
    return;
  }
  authByPort.delete(port);
}
