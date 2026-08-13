// Loaded after hello so capability renewal does not inflate the startup chunk.
import { resolveSafeTimeoutDelayMs } from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

const RENEWAL_LEAD_MS = 15_000;
const MIN_RENEWAL_DELAY_MS = 1_000;
// Used only when a refresh response omits expiry; an early one-minute refresh
// is safe because it asks the server to rotate rather than extending authority.
const MISSING_EXPIRY_RENEWAL_DELAY_MS = 60_000;
const RETRY_START_MS = 1_000;
// Stay well below the server capability lifetime while limiting unsupported
// gateways to one cheap refresh request per five minutes per tab.
const RETRY_MAX_MS = 5 * 60_000;

type CanvasSurfaceRefresh = {
  surface: "canvas";
  canvasUrl: string;
  expiresAtMs?: number;
};

type CanvasSurfaceLease = {
  start: (helloUrl: string | undefined) => void;
  stop: () => void;
};

export function createCanvasSurfaceLease<
  TimerHandle = ReturnType<typeof globalThis.setTimeout>,
>(params: {
  request: (method: string, params: unknown) => Promise<unknown>;
  onChange: (url: string | null) => void;
  onConnectionChange?: () => void;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
}): CanvasSurfaceLease {
  const now = params.now ?? Date.now;
  const setTimer =
    params.setTimer ??
    ((callback: () => void, delayMs: number) =>
      globalThis.setTimeout(callback, delayMs) as TimerHandle);
  const clearTimer =
    params.clearTimer ??
    ((timer: TimerHandle) =>
      globalThis.clearTimeout(timer as ReturnType<typeof globalThis.setTimeout>));
  let currentUrl: string | null = null;
  let timer: TimerHandle | null = null;
  let inFlight: { generation: number; promise: Promise<void> } | null = null;
  let consecutiveFailures = 0;
  let generation = 0;
  let started = false;
  const ownsGeneration = (expected: number) => started && generation === expected;

  const clearScheduledRenewal = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };

  const schedule = (delayMs: number, expectedGeneration: number) => {
    if (!ownsGeneration(expectedGeneration)) {
      return;
    }
    clearScheduledRenewal();
    timer = setTimer(
      () => {
        if (!ownsGeneration(expectedGeneration)) {
          return;
        }
        timer = null;
        renew(expectedGeneration);
      },
      resolveSafeTimeoutDelayMs(delayMs, { minMs: MIN_RENEWAL_DELAY_MS }),
    );
  };

  const handleFailure = (expectedGeneration: number) => {
    if (!ownsGeneration(expectedGeneration)) {
      return;
    }
    consecutiveFailures += 1;
    const retryDelayMs = Math.min(RETRY_START_MS * 2 ** (consecutiveFailures - 1), RETRY_MAX_MS);
    schedule(retryDelayMs, expectedGeneration);
  };

  const renew = (expectedGeneration: number) => {
    if (
      inFlight?.generation === expectedGeneration ||
      !ownsGeneration(expectedGeneration) ||
      !currentUrl
    ) {
      return;
    }
    const observedUrl = currentUrl;
    const request = Promise.resolve()
      .then(() => params.request("plugin.surface.refresh", { surface: "canvas", observedUrl }))
      .then((response) => {
        if (!ownsGeneration(expectedGeneration) || currentUrl !== observedUrl) {
          return;
        }
        const refreshed = parseCanvasSurfaceRefresh(response);
        if (!refreshed) {
          handleFailure(expectedGeneration);
          return;
        }
        consecutiveFailures = 0;
        currentUrl = refreshed.canvasUrl;
        params.onChange(currentUrl);
        const delayMs =
          refreshed.expiresAtMs === undefined
            ? MISSING_EXPIRY_RENEWAL_DELAY_MS
            : Math.max(MIN_RENEWAL_DELAY_MS, refreshed.expiresAtMs - now() - RENEWAL_LEAD_MS);
        schedule(delayMs, expectedGeneration);
      })
      .catch(() => handleFailure(expectedGeneration))
      .finally(() => {
        if (inFlight?.promise === request) {
          inFlight = null;
        }
      });
    inFlight = { generation: expectedGeneration, promise: request };
  };

  return {
    start(helloUrl) {
      generation += 1;
      started = true;
      consecutiveFailures = 0;
      clearScheduledRenewal();
      params.onConnectionChange?.();
      const trimmedUrl = helloUrl?.trim();
      currentUrl = trimmedUrl ? trimmedUrl : null;
      params.onChange(currentUrl);
      if (currentUrl) {
        renew(generation);
      }
    },
    stop() {
      if (!started && currentUrl === null && timer === null) {
        return;
      }
      generation += 1;
      started = false;
      consecutiveFailures = 0;
      clearScheduledRenewal();
      params.onConnectionChange?.();
      currentUrl = null;
      params.onChange(null);
    },
  };
}

function parseCanvasSurfaceRefresh(value: unknown): CanvasSurfaceRefresh | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const response = value as {
    surface?: unknown;
    pluginSurfaceUrls?: unknown;
    expiresAtMs?: unknown;
  };
  if (response.surface !== "canvas") {
    return undefined;
  }
  const urls = response.pluginSurfaceUrls;
  if (!isRecord(urls)) {
    return undefined;
  }
  const canvasUrl = urls.canvas;
  if (typeof canvasUrl !== "string" || !canvasUrl.trim()) {
    return undefined;
  }
  const expiresAtMs = response.expiresAtMs;
  if (
    expiresAtMs !== undefined &&
    (typeof expiresAtMs !== "number" || !Number.isSafeInteger(expiresAtMs) || expiresAtMs <= 0)
  ) {
    return undefined;
  }
  return {
    surface: "canvas",
    canvasUrl: canvasUrl.trim(),
    ...(expiresAtMs === undefined ? {} : { expiresAtMs }),
  };
}
