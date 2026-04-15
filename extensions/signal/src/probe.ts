import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { signalCheck, signalRpcRequest } from "./client.js";

export type SignalProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs: number;
  version?: string | null;
};

function parseSignalVersion(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "object" && value !== null) {
    const version = (value as { version?: unknown }).version;
    if (typeof version === "string" && version.trim()) {
      return version.trim();
    }
  }
  return null;
}

export async function probeSignal(baseUrl: string, timeoutMs: number): Promise<SignalProbe> {
  const started = Date.now();
  const result: SignalProbe = {
    ok: false,
    status: null,
    error: null,
    elapsedMs: 0,
    version: null,
  };
  const check = await signalCheck(baseUrl, timeoutMs);
  if (!check.ok) {
    return {
      ...result,
      status: check.status ?? null,
      error: check.error ?? "unreachable",
      elapsedMs: Date.now() - started,
    };
  }
  try {
    const version = await signalRpcRequest("version", undefined, {
      baseUrl,
      timeoutMs,
    });
    result.version = parseSignalVersion(version);
  } catch (err) {
    result.error = formatErrorMessage(err);
  }
  return {
    ...result,
    ok: true,
    status: check.status ?? null,
    elapsedMs: Date.now() - started,
  };
}
