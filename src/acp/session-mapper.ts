import type { GatewayClient } from "../gateway/client.js";

import type { AcpServerOptions } from "./types.js";
import { readBool, readString } from "./meta.js";

export type AcpSessionMeta = {
  sessionKey?: string;
  sessionLabel?: string;
  resetSession?: boolean;
  requireExisting?: boolean;
  prefixCwd?: boolean;
};

export function parseSessionMeta(meta: unknown): AcpSessionMeta {
  if (!meta || typeof meta !== "object") return {};
  const record = meta as Record<string, unknown>;
  return {
    sessionKey: readString(record, ["sessionKey", "session", "key"]),
    sessionLabel: readString(record, ["sessionLabel", "label"]),
    resetSession: readBool(record, ["resetSession", "reset"]),
    requireExisting: readBool(record, ["requireExistingSession", "requireExisting"]),
    prefixCwd: readBool(record, ["prefixCwd"]),
  };
}

export async function resolveSessionKey(params: {
  meta: AcpSessionMeta;
  fallbackKey: string;
  gateway: GatewayClient;
  opts: AcpServerOptions;
}): Promise<string> {
  const requestedLabel = params.meta.sessionLabel ?? params.opts.defaultSessionLabel;
  const requestedKey = params.meta.sessionKey ?? params.opts.defaultSessionKey;
  const requireExisting =
    params.meta.requireExisting ?? params.opts.requireExistingSession ?? false;

  if (params.meta.sessionLabel) {
    const resolved = await params.gateway.request<{ ok: true; key: string }>(
      "sessions.resolve",
      { label: params.meta.sessionLabel },
    );
    if (!resolved?.key) {
      throw new Error(`Unable to resolve session label: ${params.meta.sessionLabel}`);
    }
    return resolved.key;
  }

  if (params.meta.sessionKey) {
    if (!requireExisting) return params.meta.sessionKey;
    const resolved = await params.gateway.request<{ ok: true; key: string }>(
      "sessions.resolve",
      { key: params.meta.sessionKey },
    );
    if (!resolved?.key) {
      throw new Error(`Session key not found: ${params.meta.sessionKey}`);
    }
    return resolved.key;
  }

  if (requestedLabel) {
    const resolved = await params.gateway.request<{ ok: true; key: string }>(
      "sessions.resolve",
      { label: requestedLabel },
    );
    if (!resolved?.key) {
      throw new Error(`Unable to resolve session label: ${requestedLabel}`);
    }
    return resolved.key;
  }

  if (requestedKey) {
    if (!requireExisting) return requestedKey;
    const resolved = await params.gateway.request<{ ok: true; key: string }>(
      "sessions.resolve",
      { key: requestedKey },
    );
    if (!resolved?.key) {
      throw new Error(`Session key not found: ${requestedKey}`);
    }
    return resolved.key;
  }

  return params.fallbackKey;
}

export async function resetSessionIfNeeded(params: {
  meta: AcpSessionMeta;
  sessionKey: string;
  gateway: GatewayClient;
  opts: AcpServerOptions;
}): Promise<void> {
  const resetSession = params.meta.resetSession ?? params.opts.resetSession ?? false;
  if (!resetSession) return;
  await params.gateway.request("sessions.reset", { key: params.sessionKey });
}
