// Signal plugin module implements probe behavior.
import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { runChannelProbe } from "openclaw/plugin-sdk/text-utility-runtime";
import { type SignalTransportKind, signalCheck, signalRpcRequest } from "./client-adapter.js";
import { detectSignalTransport } from "./transport-detection.js";

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

export async function probeSignal(
  baseUrl: string,
  timeoutMs: number,
  options: {
    transportKind?: SignalTransportKind;
    /** @deprecated Pass transportKind after resolving the account transport. */
    apiMode?: "auto" | "native" | "container";
  } = {},
): Promise<SignalProbe> {
  return await runChannelProbe(undefined, async () => {
    const result: Omit<SignalProbe, "elapsedMs"> = {
      ok: false,
      status: null,
      error: null,
      version: null,
    };
    let transportKind: SignalTransportKind;
    try {
      transportKind = await resolveProbeTransportKind(baseUrl, timeoutMs, options);
    } catch (error) {
      return { ...result, error: formatErrorMessage(error) };
    }
    const check = await signalCheck(baseUrl, timeoutMs, { transportKind });
    if (!check.ok) {
      return {
        ...result,
        status: check.status ?? null,
        error: check.error ?? "unreachable",
      };
    }
    try {
      const version = await signalRpcRequest("version", undefined, {
        baseUrl,
        timeoutMs,
        transportKind,
      });
      result.version = parseSignalVersion(version);
    } catch (error) {
      result.error = formatErrorMessage(error);
    }
    return { ...result, ok: true, status: check.status ?? null };
  });
}

async function resolveProbeTransportKind(
  baseUrl: string,
  timeoutMs: number,
  options: {
    transportKind?: SignalTransportKind;
    apiMode?: "auto" | "native" | "container";
  },
): Promise<SignalTransportKind> {
  if (options.transportKind) {
    return options.transportKind;
  }
  if (options.apiMode === "container") {
    return "container";
  }
  if (options.apiMode === "auto") {
    return (await detectSignalTransport({ url: baseUrl, timeoutMs })).kind;
  }
  return "external-native";
}
