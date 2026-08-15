// Shared fixtures for the heartbeat runner scheduler test files.
import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { startHeartbeatRunner } from "./heartbeat-runner.js";
import { requestHeartbeatRaw as requestHeartbeat } from "./heartbeat-wake.js";

type RunOnce = Parameters<typeof startHeartbeatRunner>[0]["runOnce"];
type MockRunOnce = RunOnce & { mock: { calls: unknown[][] } };

export const TEST_SCHEDULER_SEED = "heartbeat-runner-test-seed";

export function useFakeHeartbeatTime() {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(0));
}

export function heartbeatConfig(
  list?: NonNullable<NonNullable<OpenClawConfig["agents"]>["list"]>,
): OpenClawConfig {
  return {
    agents: {
      defaults: { heartbeat: { every: "30m" } },
      ...(list ? { list } : {}),
    },
  } as OpenClawConfig;
}

export function getRunCall(runSpy: MockRunOnce, callIndex: number) {
  const call = runSpy.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected heartbeat run call ${callIndex}`);
  }
  const options = call[0];
  if (!options || typeof options !== "object") {
    throw new Error(`expected heartbeat run options ${callIndex}`);
  }
  return options as Record<string, unknown>;
}

export function expectRunCallFields(
  runSpy: MockRunOnce,
  callIndex: number,
  expected: Record<string, unknown>,
) {
  const options = getRunCall(runSpy, callIndex);
  for (const [key, value] of Object.entries(expected)) {
    expect(options[key]).toEqual(value);
  }
  return options;
}

export function wake(
  reason: string,
  opts: Partial<Parameters<typeof requestHeartbeat>[0]> = {},
): Parameters<typeof requestHeartbeat>[0] {
  const source =
    opts.source ??
    (reason === "interval"
      ? "interval"
      : reason === "manual"
        ? "manual"
        : reason === "retry"
          ? "retry"
          : reason === "exec-event"
            ? "exec-event"
            : reason === "background-task"
              ? "background-task"
              : reason === "background-task-blocked"
                ? "background-task-blocked"
                : reason.startsWith("cron:")
                  ? "cron"
                  : reason.startsWith("hook:")
                    ? "hook"
                    : "other");
  const intent =
    opts.intent ??
    (reason === "interval"
      ? "scheduled"
      : reason === "manual"
        ? "manual"
        : reason === "wake" || reason === "background-task" || reason === "background-task-blocked"
          ? "immediate"
          : "event");
  return { source, intent, reason, ...opts };
}

export async function expectWakeDispatch(params: {
  cfg: OpenClawConfig;
  runSpy: MockRunOnce;
  wake: Parameters<typeof requestHeartbeat>[0];
  expectedCall: Record<string, unknown>;
}) {
  const runner = startHeartbeatRunner({
    cfg: params.cfg,
    runOnce: params.runSpy,
    stableSchedulerSeed: TEST_SCHEDULER_SEED,
  });

  requestHeartbeat(params.wake);
  await vi.advanceTimersByTimeAsync(1);

  expect(params.runSpy).toHaveBeenCalledTimes(1);
  expectRunCallFields(params.runSpy, 0, params.expectedCall);

  return runner;
}
