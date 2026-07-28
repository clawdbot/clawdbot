/**
 * Tests gateway plugin lifecycle loading, startup, and shutdown behavior.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { clearFallbackGatewayContext, createGatewaySubagentRuntime } from "./server-plugins.js";
import { installGatewayTestHooks, startServer } from "./test-helpers.server.js";

installGatewayTestHooks({ scope: "suite" });

afterEach(() => {
  clearFallbackGatewayContext();
});

describe("gateway plugin fallback context lifecycle", () => {
  let started: Awaited<ReturnType<typeof startServer>> | undefined;

  beforeAll(async () => {
    const warm = await startServer();
    await warm.server.close({ reason: "warm fallback context lifecycle" });
    started = await startServer();
  });

  afterAll(async () => {
    await started?.server.close({ reason: "fallback context lifecycle cleanup" });
  });

  it("clears the fallback gateway context after server close", async () => {
    const runtime = createGatewaySubagentRuntime();
    if (!started) {
      throw new Error("expected gateway server to start");
    }

    try {
      await expect(
        runtime.getSessionMessages({ sessionKey: "agent:main:main", limit: 1 }),
      ).resolves.toEqual({ messages: [] });
    } finally {
      await started.server.close({ reason: "fallback context lifecycle test done" });
      started = undefined;
    }

    await expect(
      runtime.getSessionMessages({ sessionKey: "agent:main:main", limit: 1 }),
    ).rejects.toThrow("No scope set and no fallback context available");
  });
});
