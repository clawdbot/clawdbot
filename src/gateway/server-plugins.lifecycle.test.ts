import { afterEach, describe, expect, it } from "vitest";
import { clearFallbackGatewayContext, createGatewaySubagentRuntime } from "./server-plugins.js";
import { installGatewayTestHooks, startServer } from "./test-helpers.server.js";

installGatewayTestHooks();

afterEach(() => {
  clearFallbackGatewayContext();
});

describe("gateway plugin fallback context lifecycle", () => {
  it("clears the fallback gateway context after server close", async () => {
    const runtime = createGatewaySubagentRuntime();
    const started = await startServer();

    try {
      await expect(
        runtime.getSessionMessages({ sessionKey: "agent:main:main", limit: 1 }),
      ).resolves.toEqual({ messages: [] });
    } finally {
      await started.server.close({ reason: "fallback context lifecycle test done" });
    }

    await expect(
      runtime.getSessionMessages({ sessionKey: "agent:main:main", limit: 1 }),
    ).rejects.toThrow("No scope set and no fallback context available");
  });
});
