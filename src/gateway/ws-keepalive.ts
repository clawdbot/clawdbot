// Resolves gateway WebSocket keepalive/liveness settings from gateway.ws config.
import type { GatewayWsConfig } from "../config/types.gateway.js";

export const DEFAULT_WS_PING_INTERVAL_MS = 30_000;
export const DEFAULT_WS_MAX_MISSED_PONGS = 5;

export type WsKeepaliveSettings = {
  pingIntervalMs: number;
  maxMissedPongs: number;
};

/** Normalizes a positive integer config value, falling back to the default. */
function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    return fallback;
  }
  return Math.floor(value);
}

/** Resolves effective WebSocket keepalive settings with validated defaults. */
export function resolveWsKeepaliveSettings(config?: GatewayWsConfig): WsKeepaliveSettings {
  const keepalive = config?.keepalive;
  return {
    pingIntervalMs: normalizePositiveInt(keepalive?.pingIntervalMs, DEFAULT_WS_PING_INTERVAL_MS),
    maxMissedPongs: normalizePositiveInt(keepalive?.maxMissedPongs, DEFAULT_WS_MAX_MISSED_PONGS),
  };
}
