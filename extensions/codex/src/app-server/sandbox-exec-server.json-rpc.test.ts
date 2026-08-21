// Codex tests cover sandbox exec server.json rpc plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { sendResult } from "./sandbox-exec-server/json-rpc.js";

describe("sandbox exec-server JSON-RPC helpers", () => {
  it("preserves explicit null results", () => {
    const send = vi.fn();

    sendResult(send, 1, null);

    expect(send).toHaveBeenCalledWith({ jsonrpc: "2.0", id: 1, result: null });
  });

  it("keeps undefined results as empty objects for methods without bodies", () => {
    const send = vi.fn();

    sendResult(send, 2, undefined);

    expect(send).toHaveBeenCalledWith({ jsonrpc: "2.0", id: 2, result: {} });
  });
});
