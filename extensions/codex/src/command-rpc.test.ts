import { describe, expect, it } from "vitest";
import { CodexAppServerRpcError } from "./app-server/client.js";
import { safeValue } from "./command-rpc.js";

describe("Codex command RPC helpers", () => {
  it("formats unsupported control methods from JSON-RPC error codes", async () => {
    await expect(
      safeValue(async () => {
        throw new CodexAppServerRpcError({ code: -32601, message: "Method not found" }, "x/y");
      }),
    ).resolves.toEqual({
      ok: false,
      error: "unsupported by this Codex app-server",
    });
  });
});
