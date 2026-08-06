// Signal transport detection is a setup and compatibility-only network probe.
import type { SignalTransportConfig } from "./account-types.js";
import { normalizeSignalTransportUrl } from "./transport-url.js";

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export type SignalTransportProbeResult = {
  ok: boolean;
  status?: number | null;
  error?: string | null;
};

export type SignalNativeTransportProbe = (
  url: string,
  timeoutMs?: number,
) => Promise<SignalTransportProbeResult>;

export type SignalContainerTransportProbe = (
  url: string,
  timeoutMs?: number,
  account?: string,
) => Promise<SignalTransportProbeResult>;

export async function detectSignalTransport(params: {
  url: string;
  account?: string;
  timeoutMs?: number;
  probeNative?: SignalNativeTransportProbe;
  probeContainer?: SignalContainerTransportProbe;
}): Promise<SignalTransportConfig> {
  const url = normalizeSignalTransportUrl(params.url);
  const timeoutMs = params.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const probes =
    params.probeNative && params.probeContainer
      ? undefined
      : await import("./transport-probes.runtime.js");
  const probeNative = params.probeNative ?? probes?.nativeCheck;
  const probeContainer = params.probeContainer ?? probes?.containerCheck;
  if (!probeNative || !probeContainer) {
    throw new Error("Signal transport probes are unavailable");
  }
  const [native, container] = await Promise.all([
    probeNative(url, timeoutMs).catch(() => ({ ok: false })),
    probeContainer(url, timeoutMs, params.account).catch(() => ({ ok: false })),
  ]);
  if (native.ok) {
    return { kind: "external-native", url };
  }
  if (container.ok) {
    return { kind: "container", url };
  }
  throw new Error(`Signal transport not reachable at ${url}`);
}
