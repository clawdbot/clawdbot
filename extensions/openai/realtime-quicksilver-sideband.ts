import type { ClientOptions, RawData } from "ws";
import {
  openAIQuicksilverAuthHeaders,
  type OpenAIQuicksilverAuth,
  type OpenAIQuicksilverRequestIds,
} from "./realtime-quicksilver-wire.js";

const SIDEBAND_CONNECT_TIMEOUT_MS = 15_000;
const SIDEBAND_CONNECT_ATTEMPTS = 5;
const SIDEBAND_RETRY_BASE_MS = 200;
const EARLY_FRAME_MAX = 32;
const EARLY_FRAME_MAX_BYTES = 1024 * 1024;
const SIDEBAND_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

export type OpenAIQuicksilverSocket = {
  readonly readyState: number;
  send(payload: string): void;
  close(code?: number, reason?: string): void;
  on(
    event: "message",
    listener: (data: RawData, isBinary: boolean) => void,
  ): OpenAIQuicksilverSocket;
  on(event: "error", listener: (error: Error) => void): OpenAIQuicksilverSocket;
  on(event: "close", listener: (code: number, reason: Buffer) => void): OpenAIQuicksilverSocket;
  once(event: "open", listener: () => void): OpenAIQuicksilverSocket;
  once(event: "error", listener: (error: Error) => void): OpenAIQuicksilverSocket;
  once(event: "close", listener: (code: number, reason: Buffer) => void): OpenAIQuicksilverSocket;
  off(event: "open", listener: () => void): OpenAIQuicksilverSocket;
  off(
    event: "message",
    listener: (data: RawData, isBinary: boolean) => void,
  ): OpenAIQuicksilverSocket;
  off(event: "error", listener: (error: Error) => void): OpenAIQuicksilverSocket;
  off(event: "close", listener: (code: number, reason: Buffer) => void): OpenAIQuicksilverSocket;
};

export type OpenAIQuicksilverSocketFactory = (
  url: string,
  options: ClientOptions,
) => OpenAIQuicksilverSocket;

type OpenAIQuicksilverBufferedFrame = { data: RawData; isBinary: boolean };
type OpenAIQuicksilverTerminalEvent =
  | { kind: "error"; error: Error }
  | { kind: "close"; code: number; reason: string };

type OpenAIQuicksilverConnectedSideband = {
  socket: OpenAIQuicksilverSocket;
  bufferedFrames: OpenAIQuicksilverBufferedFrame[];
  detachBuffer: () => OpenAIQuicksilverTerminalEvent | undefined;
};

function rawDataByteLength(data: RawData): number {
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return data.byteLength;
}

function waitForSocketOpen(params: {
  socket: OpenAIQuicksilverSocket;
  signal: AbortSignal;
}): Promise<{ detachTerminalListeners: () => OpenAIQuicksilverTerminalEvent | undefined }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let opened = false;
    let terminalEvent: OpenAIQuicksilverTerminalEvent | undefined;
    const detachTerminalListeners = () => {
      params.socket.off("error", onError);
      params.socket.off("close", onClose);
      return terminalEvent;
    };
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      params.signal.removeEventListener("abort", onAbort);
      params.socket.off("open", onOpen);
      if (error) {
        detachTerminalListeners();
        reject(error);
      } else {
        resolve({ detachTerminalListeners });
      }
    };
    const onOpen = () => {
      opened = true;
      finish();
    };
    const onError = (error: Error) => {
      if (opened) {
        terminalEvent ??= { kind: "error", error };
        return;
      }
      finish(error);
    };
    const onClose = (code: number, reason: Buffer) => {
      if (opened) {
        terminalEvent ??= {
          kind: "close",
          code: code ?? 1006,
          reason: reason?.toString("utf8") ?? "",
        };
        return;
      }
      finish(new Error("GPT-Live sideband closed during startup"));
    };
    const onAbort = () =>
      finish(
        params.signal.reason instanceof Error
          ? params.signal.reason
          : new Error("GPT-Live session stopped during startup"),
      );
    const timeout = setTimeout(
      () => finish(new Error("GPT-Live sideband connection timed out")),
      SIDEBAND_CONNECT_TIMEOUT_MS,
    );
    timeout.unref?.();
    params.socket.once("open", onOpen);
    params.socket.on("error", onError);
    params.socket.on("close", onClose);
    params.signal.addEventListener("abort", onAbort, { once: true });
    if (params.signal.aborted) {
      onAbort();
    }
  });
}

function waitForRetryDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    // Typed as Error so the rejection reason is provably an Error at the call site;
    // onAbort normalizes a non-Error AbortSignal reason before it reaches here.
    const finish = (error?: Error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onAbort = () => {
      const reason = signal.reason;
      finish(
        reason instanceof Error
          ? reason
          : new Error(reason === undefined ? "GPT-Live session stopped" : String(reason), {
              cause: reason,
            }),
      );
    };
    const timer = setTimeout(() => finish(), ms);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}

export async function connectOpenAIQuicksilverSideband(params: {
  auth: OpenAIQuicksilverAuth;
  createSocket: OpenAIQuicksilverSocketFactory;
  requestIds: OpenAIQuicksilverRequestIds;
  signal: AbortSignal;
  url: string;
}): Promise<OpenAIQuicksilverConnectedSideband> {
  let lastError: unknown = new Error("GPT-Live sideband connection failed");
  for (let attempt = 0; attempt < SIDEBAND_CONNECT_ATTEMPTS; attempt += 1) {
    if (params.signal.aborted) {
      throw params.signal.reason;
    }
    const socket = params.createSocket(params.url, {
      headers: openAIQuicksilverAuthHeaders(params.auth, params.requestIds),
      maxPayload: SIDEBAND_MAX_PAYLOAD_BYTES,
    });
    const bufferedFrames: OpenAIQuicksilverBufferedFrame[] = [];
    let bufferedBytes = 0;
    const bufferFrame = (data: RawData, isBinary: boolean) => {
      const frameBytes = rawDataByteLength(data);
      if (
        bufferedFrames.length >= EARLY_FRAME_MAX ||
        bufferedBytes + frameBytes > EARLY_FRAME_MAX_BYTES
      ) {
        socket.off("message", bufferFrame);
        socket.close(1009, "sideband startup buffer exceeded");
        return;
      }
      bufferedBytes += frameBytes;
      bufferedFrames.push({ data, isBinary });
    };
    socket.on("message", bufferFrame);
    try {
      const openHandoff = await waitForSocketOpen({ socket, signal: params.signal });
      if (params.signal.aborted) {
        socket.off("message", bufferFrame);
        openHandoff.detachTerminalListeners();
        socket.on("error", () => {});
        socket.close(1000, "sideband startup stopped");
        throw params.signal.reason;
      }
      return {
        socket,
        bufferedFrames,
        detachBuffer: () => {
          socket.off("message", bufferFrame);
          return openHandoff.detachTerminalListeners();
        },
      };
    } catch (error) {
      lastError = error;
      socket.off("message", bufferFrame);
      // waitForSocketOpen already detached its error listener, and closing a still
      // CONNECTING ws emits `error` asynchronously. Without a listener that is an
      // unhandled EventEmitter error, which is fatal to the Gateway process, so keep
      // this swallow attached for the discarded socket's lifetime.
      socket.on("error", () => {});
      try {
        socket.close(1000, "retrying sideband");
      } catch {
        // Failed startup sockets are already unusable.
      }
      if (params.signal.aborted) {
        throw params.signal.reason;
      }
      if (attempt + 1 < SIDEBAND_CONNECT_ATTEMPTS) {
        await waitForRetryDelay(SIDEBAND_RETRY_BASE_MS * 2 ** attempt, params.signal);
      }
    }
  }
  throw lastError;
}
