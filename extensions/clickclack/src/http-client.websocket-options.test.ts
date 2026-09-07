// ClickClack tests cover websocket constructor options.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { webSocketCtorCalls, MockWebSocket } = vi.hoisted(() => {
  const calls: Array<{ url: string; options: unknown }> = [];
  function StubWebSocket(url: string | URL, options?: unknown) {
    calls.push({ url: String(url), options });
  }
  return { webSocketCtorCalls: calls, MockWebSocket: StubWebSocket };
});

vi.mock("./ws-runtime.js", () => ({ WebSocket: MockWebSocket }));

import { createClickClackClient } from "./http-client.js";
import { WebSocket } from "./ws-runtime.js";

describe("createClickClackClient websocket options", () => {
  beforeEach(() => {
    webSocketCtorCalls.length = 0;
  });

  it("passes a 30-second opening handshake deadline to ws", () => {
    expect(WebSocket).toBe(MockWebSocket);
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "fake",
    });

    client.websocket("workspace-1", "cursor-1");

    expect(webSocketCtorCalls).toEqual([
      {
        url: "wss://clickclack.example/api/realtime/ws?workspace_id=workspace-1&after_cursor=cursor-1",
        options: {
          headers: { Authorization: "Bearer fake" },
          handshakeTimeout: 30_000,
          maxPayload: 16 * 1024 * 1024,
        },
      },
    ]);
  });
});
