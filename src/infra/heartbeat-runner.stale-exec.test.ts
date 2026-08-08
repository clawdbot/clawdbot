import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { seedCommitmentsForTest } from "../commitments/store.test-utils.js";
import type { CommitmentRecord } from "../commitments/types.js";
import { resetConfigRuntimeState } from "../config/config.js";
import type { OpenClawConfig } from "../config/config.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { setHeartbeatsEnabled, startHeartbeatRunner } from "./heartbeat-runner.js";
import { withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";
import {
  HEARTBEAT_SKIP_NO_PENDING_EVENT,
  requestHeartbeat,
  setHeartbeatWakeHandler as setRuntimeHeartbeatWakeHandler,
} from "./heartbeat-wake.js";

describe("stale exec heartbeat wakes", () => {
  type WakeRequest = Parameters<typeof requestHeartbeat>[0];
  type WakeHandler = Parameters<typeof setRuntimeHeartbeatWakeHandler>[0];
  const schedulerSeed = "stale-exec-heartbeat-test";
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);
  let currentHandlerDisposer: (() => void) | undefined;

  function setHeartbeatWakeHandler(handler: WakeHandler): void {
    currentHandlerDisposer?.();
    currentHandlerDisposer = setRuntimeHeartbeatWakeHandler(handler);
  }

  function heartbeatConfig(): OpenClawConfig {
    return {
      agents: {
        defaults: { heartbeat: { every: "30m" } },
      },
    } as OpenClawConfig;
  }

  function buildDueCommitment(nowMs: number): CommitmentRecord {
    return {
      id: "cm_interview",
      agentId: "main",
      sessionKey: "agent:main:telegram:user-155462274",
      channel: "telegram",
      accountId: "primary",
      to: "1",
      kind: "event_check_in",
      sensitivity: "routine",
      source: "inferred_user_context",
      status: "pending",
      reason: "The user said they had an interview yesterday.",
      suggestedText: "How did the interview go?",
      dedupeKey: "interview:2026-04-28",
      confidence: 0.92,
      dueWindow: {
        earliestMs: nowMs - 60_000,
        latestMs: nowMs + 60 * 60_000,
        timezone: "America/Los_Angeles",
      },
      createdAtMs: nowMs - 24 * 60 * 60_000,
      updatedAtMs: nowMs - 24 * 60 * 60_000,
      attempts: 0,
    };
  }

  beforeEach(() => {
    resetGatewayWorkAdmission();
  });

  afterEach(async () => {
    currentHandlerDisposer?.();
    if (vi.isFakeTimers()) {
      currentHandlerDisposer = setRuntimeHeartbeatWakeHandler(async () => ({
        status: "skipped",
        reason: "disabled",
      }));
      await vi.runAllTimersAsync();
    }
    currentHandlerDisposer?.();
    currentHandlerDisposer = undefined;
    closeOpenClawStateDatabaseForTest();
    resetConfigRuntimeState();
    resetGatewayWorkAdmission();
    resetHeartbeatEventsForTest();
    setHeartbeatsEnabled(true);
    envSnapshot.restore();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retires a stale exec event without retrying or dropping coalesced task work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000_000_000_000);
    const handler = vi.fn(async (request: WakeRequest) =>
      request.intent === "event"
        ? ({ status: "skipped", reason: HEARTBEAT_SKIP_NO_PENDING_EVENT } as const)
        : ({ status: "ran", durationMs: 1 } as const),
    );
    setHeartbeatWakeHandler(handler);

    requestHeartbeat({
      source: "exec-event",
      intent: "event",
      reason: "exec-event",
      agentId: "main",
      coalesceMs: 0,
    });
    requestHeartbeat({
      source: "interval",
      intent: "task",
      reason: "heartbeat-task:job-inbox",
      agentId: "main",
      tasks: [{ jobId: "job-inbox", name: "inbox", prompt: "Check inbox" }],
      coalesceMs: 0,
    });
    await vi.advanceTimersByTimeAsync(1);

    expect(handler.mock.calls.map(([request]) => request.intent)).toEqual(["task", "event"]);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({
      intent: "task",
      tasks: [{ jobId: "job-inbox", name: "inbox", prompt: "Check inbox" }],
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("does not record cooldown bookkeeping for an acknowledged exec wake", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
    const runSpy = vi
      .fn()
      .mockResolvedValueOnce({ status: "skipped", reason: HEARTBEAT_SKIP_NO_PENDING_EVENT })
      .mockResolvedValue({ status: "ran", durationMs: 1 });
    const runner = startHeartbeatRunner({
      cfg: heartbeatConfig(),
      runOnce: runSpy,
      stableSchedulerSeed: schedulerSeed,
    });

    const requestExecWake = () =>
      requestHeartbeat({
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        sessionKey: "agent:main:main",
        coalesceMs: 0,
      });
    requestExecWake();
    await vi.advanceTimersByTimeAsync(1);
    requestExecWake();
    await vi.advanceTimersByTimeAsync(1);

    expect(runSpy).toHaveBeenCalledTimes(2);
    runner.stop();
  });

  it("does not fan out due commitments for an acknowledged exec wake", async () => {
    vi.useFakeTimers();
    const nowMs = Date.parse("2026-04-29T17:00:00.000Z");
    vi.setSystemTime(nowMs);

    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
      seedCommitmentsForTest([buildDueCommitment(nowMs)]);
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "last" },
          },
        },
        session: { store: storePath },
      };
      const runOnce = vi
        .fn()
        .mockResolvedValue({ status: "skipped", reason: HEARTBEAT_SKIP_NO_PENDING_EVENT });
      const runner = startHeartbeatRunner({
        cfg,
        runOnce,
        stableSchedulerSeed: "acknowledged-exec-no-commitment",
      });

      requestHeartbeat({
        source: "exec-event",
        intent: "event",
        reason: "exec-event",
        coalesceMs: 0,
      });
      await vi.advanceTimersByTimeAsync(1);
      runner.stop();

      expect(runOnce).toHaveBeenCalledTimes(1);
      expect(runOnce.mock.calls[0]?.[0]).toMatchObject({
        source: "exec-event",
        runScope: "global",
      });
    });
  });
});
