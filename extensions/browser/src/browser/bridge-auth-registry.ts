/**
 * Ephemeral auth registry for loopback browser bridge servers.
 *
 * Dynamic sandbox/host ports need auth lookup without persisting tokens in
 * config files, so callers store credentials only for the current process.
 */
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";

type BridgeAuth = {
  token?: string;
  password?: string;
};

const authByPort = new Map<number, BridgeAuth>();

/** Store auth material for a loopback bridge port in the current process. */
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

/** Read auth material for a loopback bridge port. */
export function getBridgeAuthForPort(port: number): BridgeAuth | undefined {
  if (!Number.isFinite(port) || port <= 0) {
    return undefined;
  }
  return authByPort.get(port);
}

/** Drop auth material when a bridge server closes or changes port. */
export function deleteBridgeAuthForPort(port: number): void {
  if (!Number.isFinite(port) || port <= 0) {
    return;
  }
  authByPort.delete(port);
}
