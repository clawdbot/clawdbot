import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveHeartbeatMonitorSpecs } from "./heartbeat-monitor.js";

describe("resolveHeartbeatMonitorSpecs", () => {
  it("creates no monitor jobs for an ownerless explicit multi-agent roster", () => {
    const cfg = {
      agents: { ownership: "explicit", entries: { main: {}, ops: {} } },
    } as OpenClawConfig;

    expect(resolveHeartbeatMonitorSpecs(cfg, [], { schedulerSeed: "test-seed" })).toEqual([]);
  });
});
