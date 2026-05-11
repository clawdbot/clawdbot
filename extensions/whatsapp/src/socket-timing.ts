import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export type WhatsAppSocketTimingOptions = {
  keepAliveIntervalMs?: number;
  connectTimeoutMs?: number;
  defaultQueryTimeoutMs?: number;
};

export const DEFAULT_WHATSAPP_SOCKET_TIMING: Required<WhatsAppSocketTimingOptions> = {
  keepAliveIntervalMs: 25_000,
  connectTimeoutMs: 60_000,
  defaultQueryTimeoutMs: 60_000,
};

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

export function resolveWhatsAppSocketTiming(
  cfg: OpenClawConfig,
  overrides?: WhatsAppSocketTimingOptions,
): Required<WhatsAppSocketTimingOptions> {
  const configured = cfg.web?.whatsapp;
  return {
    keepAliveIntervalMs:
      positiveInteger(overrides?.keepAliveIntervalMs) ??
      positiveInteger(configured?.keepAliveIntervalMs) ??
      DEFAULT_WHATSAPP_SOCKET_TIMING.keepAliveIntervalMs,
    connectTimeoutMs:
      positiveInteger(overrides?.connectTimeoutMs) ??
      positiveInteger(configured?.connectTimeoutMs) ??
      DEFAULT_WHATSAPP_SOCKET_TIMING.connectTimeoutMs,
    defaultQueryTimeoutMs:
      positiveInteger(overrides?.defaultQueryTimeoutMs) ??
      positiveInteger(configured?.defaultQueryTimeoutMs) ??
      DEFAULT_WHATSAPP_SOCKET_TIMING.defaultQueryTimeoutMs,
  };
}
