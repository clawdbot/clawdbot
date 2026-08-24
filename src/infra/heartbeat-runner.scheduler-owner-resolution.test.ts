import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { heartbeatLog } from "./heartbeat-runner-config.js";
import { startHeartbeatRunner } from "./heartbeat-runner.js";
import { requestHeartbeat } from "./heartbeat-wake.js";

const TEST_SCHEDULER_SEED = "heartbeat-owner-resolution-test-seed";

describe("startHeartbeatRunner ambient owner resolution", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts explicit multi-agent heartbeats under the configured system owner", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const runOnce = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
    const cfg = {
      agents: {
        ownership: "explicit",
        entries: { ops: {}, main: {} },
        defaults: { systemAgent: { agentId: "ops" } },
      },
    } as OpenClawConfig;

    const runner = startHeartbeatRunner({
      cfg,
      runOnce,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });
    requestHeartbeat({ source: "manual", intent: "manual", reason: "manual", coalesceMs: 0 });
    await vi.advanceTimersByTimeAsync(1);

    expect(runOnce).toHaveBeenCalledOnce();
    expect(runOnce.mock.calls[0]?.[0]).toMatchObject({ agentId: "ops" });
    runner.stop();
  });

  it("starts disabled and warns once when an explicit multi-agent roster has no owner", () => {
    const info = vi.spyOn(heartbeatLog, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(heartbeatLog, "warn").mockImplementation(() => undefined);
    const cfg = {
      agents: { ownership: "explicit", entries: { ops: {}, main: {} } },
    } as OpenClawConfig;

    const runner = startHeartbeatRunner({
      cfg,
      stableSchedulerSeed: TEST_SCHEDULER_SEED,
    });
    runner.updateConfig(cfg);

    expect(info).toHaveBeenCalledWith("heartbeat: disabled", { enabled: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("agents.defaults.heartbeat.agentId");
    expect(warn.mock.calls[0]?.[0]).toContain("agents.defaults.systemAgent.agentId");
    runner.stop();
  });
});
