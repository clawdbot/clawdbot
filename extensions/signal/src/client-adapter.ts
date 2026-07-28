/**
 * Signal client adapter - unified interface for both native signal-cli and bbernhard container.
 *
 * This adapter provides a single API that routes to the concrete account transport.
 * Exports mirror client.ts names so consumers
 * only need to change their import path.
 */

import type { SignalTransportConfig } from "./account-types.js";
import { containerCheck, containerRpcRequest, streamContainerEvents } from "./client-container.js";
import type { SignalRpcOptions } from "./client.js";
import {
  signalCheck as nativeCheck,
  signalRpcRequest as nativeRpcRequest,
  streamSignalEvents as nativeStreamEvents,
} from "./client.js";

const DEFAULT_TIMEOUT_MS = 10_000;

export type SignalSseEvent = {
  event?: string;
  data?: string;
};

export type SignalTransportKind = SignalTransportConfig["kind"];

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function usesContainer(kind: SignalTransportKind | undefined): boolean {
  return kind === "container";
}

/**
 * Drop-in replacement for native signalRpcRequest.
 * Routes to native JSON-RPC or container REST based on config.
 */
export async function signalRpcRequest<T = unknown>(
  method: string,
  params: Record<string, unknown> | undefined,
  opts: SignalRpcOptions & {
    accountId?: string;
    transportKind?: SignalTransportKind;
    maxAttachmentBytes?: number;
  },
): Promise<T> {
  return usesContainer(opts.transportKind)
    ? containerRpcRequest<T>(method, params, opts)
    : nativeRpcRequest<T>(method, params, opts);
}

/**
 * Drop-in replacement for native signalCheck.
 */
export async function signalCheck(
  baseUrl: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  options: { transportKind?: SignalTransportKind } = {},
): Promise<{ ok: boolean; status?: number | null; error?: string | null }> {
  try {
    return usesContainer(options.transportKind)
      ? await containerCheck(baseUrl, timeoutMs)
      : await nativeCheck(baseUrl, timeoutMs);
  } catch (error) {
    return { ok: false, status: null, error: formatErrorMessage(error) };
  }
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
  onEvent: (event: SignalSseEvent) => unknown;
  logger?: { log?: (msg: string) => void; error?: (msg: string) => void };
  transportKind?: SignalTransportKind;
}): Promise<void> {
  if (usesContainer(params.transportKind)) {
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
