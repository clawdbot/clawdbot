// Covers TUI connect-error reporting across reconnect close cycles.
import { describe, expect, it, vi } from "vitest";

type CapturedClientCallbacks = {
  onConnectError?: (error: Error) => void;
  onClose?: (code: number, reason: string) => void;
  onHelloOk?: (hello: unknown) => void;
};

const capturedClientOptions = vi.hoisted(() => ({
  current: undefined as CapturedClientCallbacks | undefined,
}));

vi.mock("../gateway/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/client.js")>();
  class RecordingGatewayClient {
    constructor(options: CapturedClientCallbacks) {
      capturedClientOptions.current = options;
    }
    stopAndWait(): Promise<void> {
      return Promise.resolve();
    }
  }
  return { ...actual, GatewayClient: RecordingGatewayClient };
});

const { GatewayChatClient } = await import("./gateway-chat.js");

function connectChatClient() {
  const chat = new GatewayChatClient({ url: "ws://127.0.0.1:1" });
  const callbacks = capturedClientOptions.current;
  if (!callbacks) {
    throw new Error("expected GatewayChatClient to construct a gateway client");
  }
  return { chat, callbacks };
}

describe("GatewayChatClient reconnect errors", () => {
  it("reports a distinct connect error after each close cycle", () => {
    const { chat, callbacks } = connectChatClient();
    const connectErrors: string[] = [];
    const disconnects: string[] = [];
    chat.onConnectError = (error) => connectErrors.push(error.message);
    chat.onDisconnected = (reason) => disconnects.push(reason);

    callbacks.onConnectError?.(new Error("connection refused"));
    callbacks.onClose?.(1006, "connect failed");
    callbacks.onConnectError?.(new Error("pairing required"));

    expect(connectErrors).toEqual(["connection refused", "pairing required"]);
    // The close that follows a reported connect error stays suppressed so the
    // TUI shows one cause per cycle, not a redundant disconnect line.
    expect(disconnects).toEqual([]);
  });

  it("dedupes repeated connect errors within one close cycle", () => {
    const { chat, callbacks } = connectChatClient();
    const connectErrors: string[] = [];
    chat.onConnectError = (error) => connectErrors.push(error.message);

    callbacks.onConnectError?.(new Error("connection refused"));
    callbacks.onConnectError?.(new Error("connection refused"));

    expect(connectErrors).toEqual(["connection refused"]);
  });
});
