// Canonical Gateway active-work waiting must report the owners that block shutdown.
import { afterEach, describe, expect, it } from "vitest";
import type { EmbeddedAgentQueueHandle } from "../agents/embedded-agent-runner/run-state.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import {
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";
import { waitForGatewayActiveWork } from "./gateway-active-work.js";

const activeRuns = new Map<string, EmbeddedAgentQueueHandle>();

afterEach(() => {
  for (const [sessionId, handle] of activeRuns) {
    clearActiveEmbeddedRun(sessionId, handle);
  }
  activeRuns.clear();
  resetGatewayWorkAdmission();
});

describe("waitForGatewayActiveWork", () => {
  it("returns the final canonical blockers when its deadline expires", async () => {
    const sessionId = "probe-gateway-active-work-timeout";
    const handle: EmbeddedAgentQueueHandle = {
      queueMessage: async () => {},
      isStreaming: () => true,
      isCompacting: () => false,
      abort: () => {},
    };
    activeRuns.set(sessionId, handle);
    setActiveEmbeddedRun(sessionId, handle);

    const result = await waitForGatewayActiveWork(0);

    expect(result.drained).toBe(false);
    expect(result.snapshot.counts.embeddedRuns).toBe(1);
    expect(result.snapshot.blockers).toContainEqual({
      kind: "embedded-run",
      count: 1,
      message: "1 active embedded run(s)",
    });
  });

  it("names active root request holders in deterministic order", async () => {
    const first = tryBeginGatewayRootWorkAdmission("ws:sessions.subscribe");
    const second = tryBeginGatewayRootWorkAdmission("startup:acp-identity-reconcile");
    const third = tryBeginGatewayRootWorkAdmission("ws:sessions.subscribe");

    try {
      const result = await waitForGatewayActiveWork(0);

      expect(result.snapshot.blockers).toContainEqual({
        kind: "root-request",
        count: 3,
        message:
          "3 active gateway request(s): startup:acp-identity-reconcile, ws:sessions.subscribe (2)",
      });
    } finally {
      first?.release();
      second?.release();
      third?.release();
    }
  });
});
