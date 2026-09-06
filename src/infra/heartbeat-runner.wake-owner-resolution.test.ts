import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";

describe("heartbeat wake owner resolution", () => {
  it("admits a scheduled tick for the configured system heartbeat owner", async () => {
    await withOpenClawTestState({ label: "heartbeat-system-owner" }, async () => {
      const cfg = {
        agents: {
          ownership: "explicit",
          entries: { ops: {}, main: {} },
          defaults: { systemAgent: { agentId: "ops" } },
        },
      } as OpenClawConfig;

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "ops",
        source: "interval",
        intent: "scheduled",
        reason: "interval",
        deps: { getQueueSize: () => 0, nowMs: () => 0 },
      });

      expect(result).not.toEqual({ status: "skipped", reason: "disabled" });
    });
  });
});
