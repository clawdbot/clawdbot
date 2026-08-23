// Codex tests cover sandbox exec server.json rpc plugin behavior.
import { describe, expect, it, vi } from "vitest";
import type { WebSocket } from "ws";
import { sendResult } from "./sandbox-exec-server/json-rpc.js";

function createSocket() {
  return {
    send: vi.fn(),
  } as unknown as WebSocket & { send: ReturnType<typeof vi.fn> };
}

function sentJson(socket: ReturnType<typeof createSocket>) {
  return JSON.parse(String(socket.send.mock.calls[0]?.[0])) as unknown;
}

describe("sandbox exec-server JSON-RPC helpers", () => {
  it("preserves explicit null results", () => {
    const socket = createSocket();

    sendResult(socket, 1, null);

    expect(sentJson(socket)).toEqual({ jsonrpc: "2.0", id: 1, result: null });
  });

  it("keeps undefined results as empty objects for methods without bodies", () => {
    const socket = createSocket();

    sendResult(socket, 2, undefined);

    expect(sentJson(socket)).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
  });
});
