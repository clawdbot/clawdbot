import { afterEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_TOKEN } from "../auto-reply/tokens.js";
import { readCommitmentsForTest, seedCommitmentsForTest } from "../commitments/store.test-utils.js";
import type { CommitmentRecord } from "../commitments/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import {
  runHeartbeatOnce,
  setHeartbeatsEnabled,
  startHeartbeatRunner,
} from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import { seedSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";
import { requestHeartbeat } from "./heartbeat-wake.js";
import { resetSystemEventsForTest } from "./system-events.js";

vi.mock("../commitments/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commitments/config.js")>()),
  resolveCommitmentsConfig: () => ({
    enabled: true,
    maxPerDay: 3,
    extraction: {
      debounceMs: 15_000,
      batchMaxItems: 8,
      queueMaxItems: 64,
      confidenceThreshold: 0.72,
      careConfidenceThreshold: 0.86,
      timeoutSeconds: 45,
    },
  }),
}));

installHeartbeatRunnerTestRuntime();

describe("heartbeat monitor and task commitment delivery", () => {
  const nowMs = Date.parse("2026-04-29T17:00:00.000Z");
  const envSnapshot = captureEnv(["OPENCLAW_STATE_DIR"]);

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    setHeartbeatsEnabled(true);
    vi.useRealTimers();
    vi.unstubAllEnvs();
    envSnapshot.restore();
    resetHeartbeatEventsForTest();
    resetSystemEventsForTest();
  });

  it("delivers commitments when a cron monitor coalesces with a scheduled task", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);

    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
      const sessionKey = "agent:main:telegram:user-155462274";
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "last", session: sessionKey },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      await seedSessionStore(storePath, sessionKey, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "155462274",
      });
      const commitment: CommitmentRecord = {
        id: "cm_interview",
        agentId: "main",
        sessionKey,
        channel: "telegram",
        accountId: "primary",
        to: "155462274",
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
      seedCommitmentsForTest([commitment]);
      const task = {
        jobId: "job-deployment-status",
        name: "deployment-status",
        prompt: "Check deployment status with the normal tools",
      };
      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "155462274",
      });
      replySpy
        .mockResolvedValueOnce({ text: HEARTBEAT_TOKEN })
        .mockResolvedValueOnce({ text: "How did the interview go?" });
      const runOnce = vi.fn<typeof runHeartbeatOnce>(async (options) =>
        runHeartbeatOnce({
          ...options,
          deps: {
            ...options.deps,
            getReplyFromConfig: replySpy,
            telegram: sendTelegram,
            getQueueSize: () => 0,
            nowMs: () => nowMs,
          },
        }),
      );
      const runner = startHeartbeatRunner({
        cfg,
        runOnce,
        stableSchedulerSeed: "coalesced-cron-monitor-and-task",
      });

      requestHeartbeat({
        source: "interval",
        intent: "scheduled",
        reason: "interval",
        agentId: "main",
        scheduledEveryMs: 5 * 60_000,
        coalesceMs: 100,
      });
      requestHeartbeat({
        source: "interval",
        intent: "task",
        reason: "heartbeat-task:job-deployment-status",
        agentId: "main",
        tasks: [task],
        coalesceMs: 100,
      });

      try {
        await vi.advanceTimersByTimeAsync(100);
        await vi.waitFor(() => expect(runOnce).toHaveBeenCalledTimes(2));
        expect(runOnce.mock.calls[0]?.[0]).toMatchObject({
          agentId: "main",
          runScope: "global",
          tasks: [task],
        });
        expect(runOnce.mock.calls[1]?.[0]).toMatchObject({
          agentId: "main",
          runScope: "commitment-only",
          sessionKey,
        });
        expect(sendTelegram).toHaveBeenCalledTimes(1);
        expect(readCommitmentsForTest()[0]).toMatchObject({
          id: "cm_interview",
          status: "sent",
          attempts: 1,
        });
      } finally {
        runner.stop();
      }
    });
  });
});
