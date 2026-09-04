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
import {
  createGatewayActiveWorkSnapshot,
  waitForGatewayActiveWork,
} from "./gateway-active-work.js";

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
    const second = tryBeginGatewayRootWorkAdmission("cron:timer-tick");
    const third = tryBeginGatewayRootWorkAdmission("ws:sessions.subscribe");

    try {
      const result = await waitForGatewayActiveWork(0);

      expect(result.snapshot.blockers).toContainEqual({
        kind: "root-request",
        count: 3,
        message: "3 active gateway request(s): cron:timer-tick, ws:sessions.subscribe (2)",
      });
    } finally {
      first?.release();
      second?.release();
      third?.release();
    }
  });

  it("does not mix default holders into an overridden root count", () => {
    const admission = tryBeginGatewayRootWorkAdmission("ws:agent");
    try {
      const snapshot = createGatewayActiveWorkSnapshot({ getRootRequests: () => 1 });

      expect(snapshot.blockers).toContainEqual({
        kind: "root-request",
        count: 1,
        message: "1 active gateway request(s)",
      });
    } finally {
      admission?.release();
    }
  });
});
