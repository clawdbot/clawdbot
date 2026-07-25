// Discord tests cover gateway websocket transport options.
import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { webSocketCtorCalls } = vi.hoisted(() => ({
  webSocketCtorCalls: [] as Array<{ url: string; options: unknown }>,
}));

vi.mock("ws", () => ({
  WebSocket: class MockWebSocket extends EventEmitter {
    readyState = 1;
    send = vi.fn();
    close = vi.fn();

    constructor(url: string, options?: unknown) {
      super();
      webSocketCtorCalls.push({ url, options });
    }
  },
}));

describe("GatewayPlugin websocket options", () => {
  let GatewayPlugin: typeof import("./gateway.js").GatewayPlugin;

  beforeEach(async () => {
    webSocketCtorCalls.length = 0;
    ({ GatewayPlugin } = await import("./gateway.js"));
  });

  it("bounds inbound gateway websocket payloads", () => {
    const gateway = new GatewayPlugin({
      autoInteractions: false,
      url: "wss://gateway.example.test",
    });

    gateway.connect(false);

    expect(webSocketCtorCalls).toHaveLength(1);
    expect(webSocketCtorCalls[0]).toEqual({
      url: "wss://gateway.example.test/?v=10&encoding=json",
      options: { maxPayload: 16 * 1024 * 1024 },
    });
  });
});
