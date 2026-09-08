// Discord tests cover gateway websocket transport options.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { webSocketCtorCalls, mockOwner } = vi.hoisted(() => {
  const calls: Array<{ url: string; options: unknown }> = [];
  const owner: { constructor: unknown } = { constructor: undefined };
  return { webSocketCtorCalls: calls, mockOwner: owner };
});

vi.mock("./ws-runtime.js", async () => {
  const { EventEmitter } = await import("node:events");
  class MockWebSocket extends EventEmitter {
    readyState = 1;
    send = vi.fn();
    close = vi.fn();

    constructor(url: string, options?: unknown) {
      super();
      webSocketCtorCalls.push({ url, options });
    }
  }
  mockOwner.constructor = MockWebSocket;
  return { WebSocket: MockWebSocket };
});

import { WebSocket } from "./ws-runtime.js";

describe("GatewayPlugin websocket options", () => {
  let GatewayPlugin: typeof import("./gateway.js").GatewayPlugin;

  beforeEach(async () => {
    webSocketCtorCalls.length = 0;
    ({ GatewayPlugin } = await import("./gateway.js"));
  });

  it("bounds inbound gateway websocket payloads and the opening handshake", () => {
    expect(WebSocket).toBe(mockOwner.constructor);
    const gateway = new GatewayPlugin({
      autoInteractions: false,
      url: "wss://gateway.example.test",
    });

    gateway.connect(false);

    expect(webSocketCtorCalls).toHaveLength(1);
    expect(webSocketCtorCalls[0]).toEqual({
      url: "wss://gateway.example.test/?v=10&encoding=json",
      options: { maxPayload: 16 * 1024 * 1024, handshakeTimeout: 30_000 },
    });
  });
});
