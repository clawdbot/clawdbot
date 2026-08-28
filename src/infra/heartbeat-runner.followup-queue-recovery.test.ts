// Covers followup-queue restore wakes outside the routine heartbeat agent map.
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetConfigRuntimeState, type OpenClawConfig } from "../config/config.js";
import { startHeartbeatRunner } from "./heartbeat-runner.js";
import { requestHeartbeat } from "./heartbeat-wake.js";

describe("heartbeat followup-queue recovery wakes", () => {
  type RunOnce = Parameters<typeof startHeartbeatRunner>[0]["runOnce"];
  type MockRunOnce = RunOnce & { mock: { calls: unknown[][] } };

  afterEach(() => {
    resetConfigRuntimeState();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("runs followup-queue recovery wakes for a valid session outside the routine heartbeat map", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const runSpy = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 }) as MockRunOnce;
    const runner = startHeartbeatRunner({
      cfg: {
        agents: {
          defaults: { heartbeat: { every: "30m" } },
          list: [{ id: "ops", heartbeat: { every: "30m" } }, { id: "main" }],
        },
      } as OpenClawConfig,
      runOnce: runSpy,
    });

    requestHeartbeat({
      source: "followup-queue-restore",
      intent: "immediate",
      reason: "restored-followup-queue",
      sessionKey: "agent:main:main",
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(runSpy).toHaveBeenCalledTimes(1);
    const options = runSpy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(options).toMatchObject({
      agentId: "main",
      reason: "restored-followup-queue",
      source: "followup-queue-restore",
      sessionKey: "agent:main:main",
    });

    const opsCalls = runSpy.mock.calls.filter(
      (call) => (call[0] as { agentId?: string } | undefined)?.agentId === "ops",
    );
    expect(opsCalls).toStrictEqual([]);

    runner.stop();
  });
});
