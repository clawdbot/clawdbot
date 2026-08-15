// Gateway Client tests cover readiness behavior.
import { describe, expect, it, vi } from "vitest";
import { startGatewayClientWithReadinessWait } from "./readiness.js";

describe("startGatewayClientWithReadinessWait", () => {
  it("uses the injected client env when resolving the readiness timeout", async () => {
    const waitForReady = vi.fn(async () => ({
      ready: true,
      aborted: false,
      elapsedMs: 0,
      checks: 1,
      maxDriftMs: 0,
    }));
    const client = { start: vi.fn() };

    await startGatewayClientWithReadinessWait(waitForReady, client, {
      clientOptions: {
        env: { OPENCLAW_CONNECT_CHALLENGE_TIMEOUT_MS: "6000" },
      },
    });

    expect(waitForReady).toHaveBeenCalledWith({
      maxWaitMs: 6_000,
      signal: undefined,
    });
    expect(client.start).toHaveBeenCalledTimes(1);
  });
});
