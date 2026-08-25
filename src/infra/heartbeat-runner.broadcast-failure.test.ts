import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { setLoggerOverride } from "../logging/logger.js";
import { startHeartbeatRunner } from "./heartbeat-runner.js";
import { requestHeartbeat } from "./heartbeat-wake.js";

describe("heartbeat broadcast terminal outcomes", () => {
  afterEach(() => {
    setLoggerOverride(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    { name: "its only agent fails", agentIds: ["main"] },
    { name: "one agent succeeds and another fails", agentIds: ["ops", "main"] },
  ])("reports a failed broadcast when $name", async ({ agentIds }) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    setLoggerOverride({ level: "silent", consoleLevel: "debug", consoleStyle: "json" });
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const runOnce = vi.fn(async ({ agentId }: { agentId?: string }) =>
      agentId === "main"
        ? ({ status: "failed", reason: "agent-tool-failure" } as const)
        : ({ status: "ran", durationMs: 1 } as const),
    );
    const runner = startHeartbeatRunner({
      cfg: {
        agents: {
          defaults: { heartbeat: { every: "30m" } },
          list: agentIds.map((id) => ({ id })),
        },
      } as OpenClawConfig,
      runOnce,
      stableSchedulerSeed: "heartbeat-broadcast-failure-test-seed",
    });

    try {
      requestHeartbeat({ source: "manual", intent: "manual", reason: "manual", coalesceMs: 0 });
      await vi.advanceTimersByTimeAsync(1);

      expect(runOnce).toHaveBeenCalledTimes(agentIds.length);
      const completion = output.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes("heartbeat/wake") && message.includes("completed:"));
      expect(completion).toContain("status=failed reason=agent-tool-failure");
    } finally {
      runner.stop();
    }
  });
});
