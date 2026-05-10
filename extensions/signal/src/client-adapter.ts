/**
 * Signal client adapter - unified interface for both native signal-cli and bbernhard container.
 *
 * This adapter provides a single API that routes to the appropriate implementation
 * based on the configured API mode. Exports mirror client.ts names so consumers
 * only need to change their import path.
 */

import {
  containerCheck,
  containerRpcRequest,
  streamContainerEvents,
  containerFetchAttachment,
} from "./client-container.js";
import type { SignalRpcOptions } from "./client.js";
import {
  signalCheck as nativeCheck,
  signalRpcRequest as nativeRpcRequest,
  streamSignalEvents as nativeStreamEvents,
} from "./client.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const MODE_CACHE_TTL_MS = 30_000;

export type SignalSseEvent = {
  event?: string;
  data?: string;
};

export type SignalApiMode = "native" | "container" | "auto";

// Re-export the options type so consumers can import it from the adapter.
export type { SignalRpcOptions } from "./client.js";

// Cache auto-detected modes per baseUrl to avoid repeated network probes.
const detectedModeCache = new Map<
  string,
  { mode: "native" | "container"; expiresAt: number; receiveAccount?: string }
>();

function resolveConfiguredApiMode(configured?: SignalApiMode): SignalApiMode {
  if (configured === "native" || configured === "container") {
    return configured;
  }
  return "auto";
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveAutoProbeTimeoutMs(timeoutMs: number | undefined): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_TIMEOUT_MS;
}

async function resolveAutoApiMode(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  options: { account?: string; requireContainerReceive?: boolean } = {},
): Promise<"native" | "container"> {
  const cached = detectedModeCache.get(baseUrl);
  if (cached && cached.expiresAt > Date.now()) {
    if (
      cached.mode !== "container" ||
      !options.requireContainerReceive ||
      cached.receiveAccount === options.account
    ) {
      return cached.mode;
    }
  }
  const detected = await detectSignalApiMode(baseUrl, timeoutMs, options);
  detectedModeCache.set(baseUrl, {
    mode: detected,
    expiresAt: Date.now() + MODE_CACHE_TTL_MS,
    ...(detected === "container" && options.requireContainerReceive && options.account
      ? { receiveAccount: options.account }
      : {}),
  });
  return detected;
}

async function resolveApiModeForOperation(params: {
  baseUrl: string;
  accountId?: string;
  account?: string;
  requireContainerReceive?: boolean;
  timeoutMs?: number;
  apiMode?: SignalApiMode;
}): Promise<"native" | "container"> {
  const configured = resolveConfiguredApiMode(params.apiMode);

  if (configured === "native" || configured === "container") {
    return configured;
  }

  return resolveAutoApiMode(params.baseUrl, params.timeoutMs ?? DEFAULT_TIMEOUT_MS, {
    account: params.account,
    requireContainerReceive: params.requireContainerReceive,
  });
}

/**
 * Detect which Signal API mode is available by probing endpoints.
 * First endpoint to respond OK wins.
 */
export async function detectSignalApiMode(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  options: { account?: string; requireContainerReceive?: boolean } = {},
): Promise<"native" | "container"> {
  const nativePromise = nativeCheck(baseUrl, timeoutMs).then((r) =>
    r.ok ? ("native" as const) : Promise.reject(new Error("native not ok")),
  );
  const containerAccount = options.requireContainerReceive ? options.account?.trim() : undefined;
  const containerPromise = containerAccount
    ? containerCheck(baseUrl, timeoutMs, containerAccount).then((r) =>
        r.ok ? ("container" as const) : Promise.reject(new Error("container not ok")),
      )
    : options.requireContainerReceive
      ? Promise.reject(new Error("container receive account required"))
      : containerCheck(baseUrl, timeoutMs).then((r) =>
          r.ok ? ("container" as const) : Promise.reject(new Error("container not ok")),
        );

  try {
    return await Promise.any([nativePromise, containerPromise]);
  } catch {
    throw new Error(`Signal API not reachable at ${baseUrl}`);
  }
}

/**
 * Drop-in replacement for native signalRpcRequest.
 * Routes to native JSON-RPC or container REST based on config.
 */
export async function signalRpcRequest<T = unknown>(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: SignalRpcOptions & { accountId?: string; apiMode?: SignalApiMode },
): Promise<T> {
  const mode = await resolveApiModeForOperation({
    baseUrl: opts.baseUrl,
    accountId: opts.accountId,
    account: typeof params?.account === "string" ? params.account : undefined,
    timeoutMs: opts.timeoutMs,
    apiMode: opts.apiMode,
  });
  if (mode === "native") {
    return nativeRpcRequest<T>(method, params, opts);
  }
  return containerRpcRequest<T>(method, params, opts);
}

/**
 * Drop-in replacement for native signalCheck.
 */
export async function signalCheck(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  options: { apiMode?: SignalApiMode } = {},
): Promise<{ ok: boolean; status?: number | null; error?: string | null }> {
  const configured = resolveConfiguredApiMode(options.apiMode);
  const mode =
    configured === "auto"
      ? await resolveAutoApiMode(baseUrl, timeoutMs).catch((error: unknown) => {
          return { ok: false, status: null, error: formatErrorMessage(error) } as const;
        })
      : configured;
  if (typeof mode !== "string") {
    return mode;
  }
  if (mode === "container") {
    return containerCheck(baseUrl, timeoutMs);
  }
  return nativeCheck(baseUrl, timeoutMs);
}

/**
 * Drop-in replacement for native streamSignalEvents.
 * Container mode uses WebSocket; native uses SSE.
 */
export async function streamSignalEvents(params: {
  baseUrl: string;
  account?: string;
  accountId?: string;
  abortSignal?: AbortSignal;
  timeoutMs?: number;
  onEvent: (event: SignalSseEvent) => void;
  logger?: { log?: (msg: string) => void; error?: (msg: string) => void };
  apiMode?: SignalApiMode;
}): Promise<void> {
  const mode = await resolveApiModeForOperation({
    baseUrl: params.baseUrl,
    accountId: params.accountId,
    account: params.account,
    requireContainerReceive: true,
    timeoutMs: resolveAutoProbeTimeoutMs(params.timeoutMs),
    apiMode: params.apiMode,
  });

  if (mode === "container") {
    return streamContainerEvents({
      baseUrl: params.baseUrl,
      account: params.account,
      abortSignal: params.abortSignal,
      timeoutMs: params.timeoutMs,
      onEvent: (event) => params.onEvent({ event: "receive", data: JSON.stringify(event) }),
      logger: params.logger,
    });
  }

  return nativeStreamEvents({
    baseUrl: params.baseUrl,
    account: params.account,
    abortSignal: params.abortSignal,
    timeoutMs: params.timeoutMs,
    onEvent: (event) => params.onEvent(event),
  });
}

/**
 * Fetch attachment, routing to native or container implementation.
 */
export async function fetchAttachment(params: {
  baseUrl: string;
  account?: string;
  accountId?: string;
  attachmentId: string;
  sender?: string;
  groupId?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  apiMode?: SignalApiMode;
}): Promise<Buffer | null> {
  const mode = await resolveApiModeForOperation({
    baseUrl: params.baseUrl,
    accountId: params.accountId,
    account: params.account,
    timeoutMs: params.timeoutMs,
    apiMode: params.apiMode,
  });
  if (mode === "container") {
    return containerFetchAttachment(params.attachmentId, {
      baseUrl: params.baseUrl,
      timeoutMs: params.timeoutMs,
      maxResponseBytes: params.maxResponseBytes,
    });
  }

  const rpcParams: Record<string, unknown> = {
    id: params.attachmentId,
  };
  if (params.account) {
    rpcParams.account = params.account;
  }
  if (params.groupId) {
    rpcParams.groupId = params.groupId;
  } else if (params.sender) {
    rpcParams.recipient = params.sender;
  } else {
    return null;
  }
  const result = await nativeRpcRequest<{ data?: string }>("getAttachment", rpcParams, {
    baseUrl: params.baseUrl,
    timeoutMs: params.timeoutMs,
    maxResponseBytes: params.maxResponseBytes,
  });
  if (!result?.data) {
    return null;
  }
  return Buffer.from(result.data, "base64");
}
