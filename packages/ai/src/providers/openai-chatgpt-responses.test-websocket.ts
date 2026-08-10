import {
  configureAiTransportHost,
  getAiTransportHost,
  type AiModelWebSocket,
  type AiModelWebSocketConnectOptions,
  type AiModelWebSocketResource,
} from "../host.js";
import type { Model } from "../types.js";

type TestWebSocketEventType = "open" | "message" | "error" | "close";
type TestWebSocketListener = (event: unknown) => void;
type TestWebSocketNodeListener = {
  (type: "upgrade", listener: (response: { headers?: unknown }) => void): void;
  (
    type: "unexpected-response",
    listener: (_request: unknown, response: { resume(): void; statusCode?: number }) => void,
  ): void;
};
type TestWebSocket = {
  readonly readyState?: number;
  readonly bufferedAmount?: number;
  addEventListener(type: TestWebSocketEventType, listener: TestWebSocketListener): void;
  removeEventListener(type: TestWebSocketEventType, listener: TestWebSocketListener): void;
  on?: TestWebSocketNodeListener;
  off?: TestWebSocketNodeListener;
  send(data: string, callback?: (error?: Error) => void): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
};
type TestWebSocketConstructor = new (
  url: string,
  options?: { headers?: Record<string, string> },
) => TestWebSocket;

const ambientWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;

class TestWebSocketHandshakeError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number) {
    super(`Unexpected server response: ${statusCode}`);
    this.name = "TestWebSocketHandshakeError";
    this.statusCode = statusCode;
  }
}

function testWebSocketError(event: unknown): Error {
  if (event instanceof Error) {
    return event;
  }
  if (event && typeof event === "object") {
    const nested = "error" in event ? (event as { error?: unknown }).error : undefined;
    if (nested instanceof Error) {
      return nested;
    }
    const message = "message" in event ? (event as { message?: unknown }).message : undefined;
    if (typeof message === "string") {
      return new Error(message);
    }
  }
  return new Error("WebSocket error");
}

export async function connectTestModelWebSocket(
  _model: Model,
  options: AiModelWebSocketConnectOptions,
): Promise<AiModelWebSocketResource | undefined> {
  const runtimeWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
  if (runtimeWebSocket === ambientWebSocket || typeof runtimeWebSocket !== "function") {
    return undefined;
  }
  const socket = new (runtimeWebSocket as TestWebSocketConstructor)(options.url, {
    headers: options.headers,
  });
  // Keep real ws teardown errors observable to the provider without becoming
  // unhandled after the provider removes its request-scoped listener.
  (
    socket as TestWebSocket & {
      on?(type: "error", listener: (error: Error) => void): void;
    }
  ).on?.("error", () => {});
  let handshakeHeaders: Record<string, string | readonly string[] | undefined> = {};
  const onUpgrade = (response: { headers?: unknown }) => {
    if (response.headers && typeof response.headers === "object") {
      handshakeHeaders = {
        ...(response.headers as Record<string, string | readonly string[] | undefined>),
      };
    }
  };
  socket.on?.("upgrade", onUpgrade);

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("error", onError);
      socket.removeEventListener("close", onClose);
      socket.off?.("unexpected-response", onUnexpectedResponse);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const onOpen = () => finish();
    const onError = (event: unknown) => finish(testWebSocketError(event));
    const onClose = () => finish(new Error("WebSocket closed before open"));
    const onUnexpectedResponse = (
      _request: unknown,
      response: { resume(): void; statusCode?: number },
    ) => {
      response.resume();
      finish(new TestWebSocketHandshakeError(response.statusCode ?? 500));
    };
    const onAbort = () => finish(new DOMException("Request was aborted", "AbortError"));

    socket.addEventListener("open", onOpen);
    socket.addEventListener("error", onError);
    socket.addEventListener("close", onClose);
    socket.on?.("unexpected-response", onUnexpectedResponse);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }
  });
  socket.off?.("upgrade", onUpgrade);

  let disposed = false;
  const modelSocket: AiModelWebSocket = {
    get readyState() {
      return socket.readyState;
    },
    get bufferedAmount() {
      return socket.bufferedAmount;
    },
    addEventListener: (type, listener) => socket.addEventListener(type, listener),
    removeEventListener: (type, listener) => socket.removeEventListener(type, listener),
    send: (data, callback) => {
      if (socket.send.length >= 2) {
        socket.send(data, callback);
        return;
      }
      socket.send(data);
      callback();
    },
    close: (code, reason) => socket.close(code, reason),
    ...(socket.terminate ? { terminate: () => socket.terminate?.() } : {}),
  };
  return {
    socket: modelSocket,
    handshakeHeaders,
    dispose: () => {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        socket.close(1000, "test_dispose");
      } catch {}
    },
  };
}

export function installTestModelWebSocketHost(): void {
  configureAiTransportHost({
    ...getAiTransportHost(),
    connectModelWebSocket: connectTestModelWebSocket,
  });
}
