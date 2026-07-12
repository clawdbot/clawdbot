/**
 * CDP and Chrome launch timeout constants.
 *
 * Centralizes timing so local loopback probes stay fast while remote/browser
 * node probes retain enough handshake slack for real networks.
 */
import {
  addTimerTimeoutGraceMs,
  clampTimerTimeoutMs,
  resolveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";
import { DEFAULT_BROWSER_LOCAL_LAUNCH_TIMEOUT_MS } from "./constants.js";

export const CDP_HTTP_REQUEST_TIMEOUT_MS = 1500;
export const CDP_WS_HANDSHAKE_TIMEOUT_MS = 5000;
export const CDP_JSON_NEW_TIMEOUT_MS = 1500;

export const CHROME_REACHABILITY_TIMEOUT_MS = 500;
export const CHROME_WS_READY_TIMEOUT_MS = 800;
export const CHROME_BOOTSTRAP_PREFS_TIMEOUT_MS = 10_000;
export const CHROME_BOOTSTRAP_PREFS_POLL_MS = 100;
export const CHROME_BOOTSTRAP_EXIT_TIMEOUT_MS = 5000;
export const CHROME_BOOTSTRAP_EXIT_POLL_MS = 50;
export const CHROME_LAUNCH_READY_WINDOW_MS = DEFAULT_BROWSER_LOCAL_LAUNCH_TIMEOUT_MS;
export const CHROME_LAUNCH_READY_POLL_MS = 200;
export const CHROME_STOP_TIMEOUT_MS = 2500;
export const CHROME_STOP_PROBE_TIMEOUT_MS = 200;
export const CHROME_STDERR_HINT_MAX_CHARS = 2000;

const PROFILE_HTTP_REACHABILITY_TIMEOUT_MS = 300;
const PROFILE_WS_REACHABILITY_MIN_TIMEOUT_MS = 200;
const PROFILE_WS_REACHABILITY_MAX_TIMEOUT_MS = 2000;
export const PROFILE_ATTACH_RETRY_TIMEOUT_MS = 1200;
export const CHROME_MCP_ATTACH_READY_WINDOW_MS = 8000;
export const CHROME_MCP_ATTACH_READY_POLL_MS = 200;

/** Return true when a profile can use the short loopback CDP probe class. */
export function usesFastLoopbackCdpProbeClass(params: {
  profileIsLoopback: boolean;
  attachOnly?: boolean;
}): boolean {
  return params.profileIsLoopback && params.attachOnly !== true;
}

function normalizeTimeoutMs(value: number | undefined): number | undefined {
  return clampTimerTimeoutMs(value);
}

function maxTimerTimeoutMs(...values: number[]): number {
  return values.reduce((max, value) => Math.max(max, resolveTimerTimeoutMs(value, 1)), 1);
}

/** Resolve HTTP and WebSocket reachability timeouts for a CDP profile. */
export function resolveCdpReachabilityTimeouts(params: {
  profileIsLoopback: boolean;
  attachOnly?: boolean;
  timeoutMs?: number;
  remoteHttpTimeoutMs: number;
  remoteHandshakeTimeoutMs: number;
}): { httpTimeoutMs: number; wsTimeoutMs: number } {
  const normalized = normalizeTimeoutMs(params.timeoutMs);
  const remoteHttpTimeoutMs = resolveTimerTimeoutMs(
    params.remoteHttpTimeoutMs,
    CDP_HTTP_REQUEST_TIMEOUT_MS,
  );
  const remoteHandshakeTimeoutMs = resolveTimerTimeoutMs(
    params.remoteHandshakeTimeoutMs,
    CDP_WS_HANDSHAKE_TIMEOUT_MS,
  );
  if (
    usesFastLoopbackCdpProbeClass({
      profileIsLoopback: params.profileIsLoopback,
      attachOnly: params.attachOnly,
    })
  ) {
    // Local launch probes run frequently during readiness checks; keep them
    // short so missing Chrome ports fail quickly without delaying startup.
    const httpTimeoutMs = normalized ?? PROFILE_HTTP_REACHABILITY_TIMEOUT_MS;
    const wsTimeoutMs = Math.max(
      PROFILE_WS_REACHABILITY_MIN_TIMEOUT_MS,
      Math.min(PROFILE_WS_REACHABILITY_MAX_TIMEOUT_MS, httpTimeoutMs * 2),
    );
    return { httpTimeoutMs, wsTimeoutMs };
  }

  if (normalized !== undefined) {
    // Remote probes get the caller's timeout plus WebSocket grace, because
    // HTTP reachability and WS handshake are separate network operations.
    const requestedWsTimeoutMs = addTimerTimeoutGraceMs(normalized, normalized) ?? normalized;
    return {
      httpTimeoutMs: maxTimerTimeoutMs(normalized, remoteHttpTimeoutMs),
      wsTimeoutMs: maxTimerTimeoutMs(requestedWsTimeoutMs, remoteHandshakeTimeoutMs),
    };
  }
  return {
    httpTimeoutMs: remoteHttpTimeoutMs,
    wsTimeoutMs: remoteHandshakeTimeoutMs,
  };
}
