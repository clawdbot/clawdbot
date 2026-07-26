// Covers heartbeat commitment checks and runner scheduling behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_TOKEN } from "../auto-reply/tokens.js";
import { listDueCommitmentSessionKeys } from "../commitments/store.js";
import { readCommitmentsForTest, seedCommitmentsForTest } from "../commitments/store.test-utils.js";
import type { CommitmentRecord } from "../commitments/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { resolveHeartbeatRunScope } from "./heartbeat-run-scope.js";
import {
  runHeartbeatOnce,
  setHeartbeatsEnabled,
  startHeartbeatRunner,
} from "./heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "./heartbeat-runner.test-harness.js";
import {
  readSessionStoreForTest,
  seedHeartbeatScratchForTest,
  seedSessionStore,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { requestHeartbeat } from "./heartbeat-wake.js";
import {
  enqueueSystemEvent,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "./system-events.js";

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

type CommitmentTestStore = { version: 1; commitments: CommitmentRecord[] };

async function saveCommitmentStore(
  _storePath: undefined,
  store: CommitmentTestStore,
): Promise<void> {
  seedCommitmentsForTest(store.commitments);
}

async function loadCommitmentStore(): Promise<CommitmentTestStore> {
  return { version: 1, commitments: readCommitmentsForTest() };
}

describe("runHeartbeatOnce commitments", () => {
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

  function buildCommitment(params: {
    id: string;
    sessionKey: string;
    to: string;
    dueWindow?: CommitmentRecord["dueWindow"];
  }): CommitmentRecord {
    return {
      id: params.id,
      agentId: "main",
      sessionKey: params.sessionKey,
      channel: "telegram",
      accountId: "primary",
      to: params.to,
      kind: "event_check_in",
      sensitivity: "routine",
      source: "inferred_user_context",
      status: "pending",
      reason: "The user said they had an interview yesterday.",
      suggestedText: "How did the interview go?",
      dedupeKey: "interview:2026-04-28",
      confidence: 0.92,
      dueWindow: params.dueWindow ?? {
        earliestMs: nowMs - 60_000,
        latestMs: nowMs + 60 * 60_000,
        timezone: "America/Los_Angeles",
      },
      createdAtMs: nowMs - 24 * 60 * 60_000,
      updatedAtMs: nowMs - 24 * 60 * 60_000,
      attempts: 0,
    };
  }

  function expectCommitmentFields(
    commitment: CommitmentRecord | undefined,
    expected: Partial<CommitmentRecord>,
  ) {
    if (!commitment) {
      throw new Error("Expected heartbeat commitment");
    }
    for (const [key, value] of Object.entries(expected)) {
      expect(commitment[key as keyof CommitmentRecord]).toEqual(value);
    }
  }

  async function setupCommitmentCase(params?: {
    replyText?: string;
    target?: "last" | "none";
    dueWindow?: CommitmentRecord["dueWindow"];
    visibleReplies?: "automatic" | "message_tool";
    isolatedSession?: boolean;
    runScope?: "commitment-only";
  }) {
    return await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
      const sessionKey = "agent:main:telegram:user-155462274";
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: params?.target ?? "last",
              ...(params?.isolatedSession ? { isolatedSession: true } : {}),
            },
          },
        },
        ...(params?.visibleReplies ? { messages: { visibleReplies: params.visibleReplies } } : {}),
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      await seedSessionStore(storePath, sessionKey, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "stale-target",
      });
      const storePayload: CommitmentTestStore = {
        version: 1,
        commitments: [
          buildCommitment({
            id: "cm_interview",
            sessionKey,
            to: "155462274",
            dueWindow: params?.dueWindow,
          }),
        ],
      };
      await saveCommitmentStore(undefined, storePayload);

      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "155462274",
      });
      replySpy.mockImplementation(
        async (
          ctx: {
            Body?: string;
            OriginatingChannel?: string;
            OriginatingTo?: string;
            SessionKey?: string;
          },
          opts?: { disableTools?: boolean; skillFilter?: string[] },
        ) => {
          expect(ctx.Body).toContain("Due inferred follow-up commitments");
          expect(ctx.Body).toContain("How did the interview go?");
          expect(ctx.Body).toContain(HEARTBEAT_TOKEN);
          expect(ctx.Body).not.toContain("heartbeat_respond");
          expect(ctx.OriginatingChannel).toBe("telegram");
          expect(ctx.OriginatingTo).toBe("155462274");
          expect(ctx.SessionKey).toBe(
            params?.isolatedSession ? `${sessionKey}:heartbeat` : sessionKey,
          );
          expect(opts?.disableTools).toBe(true);
          expect(opts?.skillFilter).toStrictEqual([]);
          return { text: params?.replyText ?? "How did the interview go?" };
        },
      );

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        runScope: params?.runScope,
        deps: {
          getReplyFromConfig: replySpy,
          telegram: sendTelegram,
          getQueueSize: () => 0,
          nowMs: () => nowMs,
        },
      });

      return {
        result,
        sendTelegram,
        store: await loadCommitmentStore(),
      };
    });
  }

  it("keeps free-form reasons from changing cron-carried heartbeat task priority", async () => {
    const { result, sendTelegram, store } = await withTempHeartbeatSandbox(
      async ({ tmpDir, storePath, replySpy }) => {
        setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
        const sessionKey = "agent:main:telegram:user-155462274";
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                target: "last",
              },
            },
          },
          channels: { telegram: { allowFrom: ["*"] } },
          session: { store: storePath },
        };
        await seedSessionStore(storePath, sessionKey, {
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "stale-target",
        });
        await saveCommitmentStore(undefined, {
          version: 1,
          commitments: [buildCommitment({ id: "cm_interview", sessionKey, to: "155462274" })],
        });

        const sendTelegramResult = vi.fn().mockResolvedValue({
          messageId: "m1",
          chatId: "stale-target",
        });
        replySpy.mockImplementation(
          async (
            ctx: { Body?: string; OriginatingChannel?: string; OriginatingTo?: string },
            opts?: { disableTools?: boolean; skillFilter?: string[] },
          ) => {
            expect(ctx.Body).toContain("Run the following periodic tasks");
            expect(ctx.Body).toContain("- deployment-status: Check deployment status");
            expect(ctx.Body).not.toContain("Due inferred follow-up commitments");
            expect(ctx.OriginatingChannel).toBe("telegram");
            expect(ctx.OriginatingTo).toBe("stale-target");
            expect(opts?.disableTools).toBeUndefined();
            expect(opts?.skillFilter).toBeUndefined();
            return { text: "Deployment status checked" };
          },
        );

        const resultResult = await runHeartbeatOnce({
          cfg,
          agentId: "main",
          reason: "commitment",
          source: "interval",
          intent: "task",
          tasks: [
            {
              jobId: "job-deployment-status",
              name: "deployment-status",
              prompt: "Check deployment status with the normal tools",
            },
          ],
          sessionKey,
          deps: {
            getReplyFromConfig: replySpy,
            telegram: sendTelegramResult,
            getQueueSize: () => 0,
            nowMs: () => nowMs,
          },
        });

        return {
          result: resultResult,
          sendTelegram: sendTelegramResult,
          store: await loadCommitmentStore(),
        };
      },
    );

    expect(result.status).toBe("ran");
    expect(sendTelegram).toHaveBeenCalled();
    expectCommitmentFields(store.commitments[0], {
      id: "cm_interview",
      status: "pending",
      attempts: 0,
    });
  });

  it("does not deliver due commitments when heartbeat target is none", async () => {
    const { result, sendTelegram, store } = await withTempHeartbeatSandbox(
      async ({ tmpDir, storePath, replySpy }) => {
        setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
        const sessionKey = "agent:main:telegram:user-155462274";
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                target: "none",
              },
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
        await saveCommitmentStore(undefined, {
          version: 1,
          commitments: [buildCommitment({ id: "cm_interview", sessionKey, to: "155462274" })],
        });

        const sendTelegramValue = vi.fn().mockResolvedValue({
          messageId: "m1",
          chatId: "155462274",
        });
        replySpy.mockImplementation(
          async (
            ctx: { Body?: string; OriginatingChannel?: string; OriginatingTo?: string },
            opts?: { disableTools?: boolean; skillFilter?: string[] },
          ) => {
            expect(ctx.Body).not.toContain("Due inferred follow-up commitments");
            expect(ctx.Body).not.toContain("How did the interview go?");
            expect(ctx.OriginatingChannel).toBeUndefined();
            expect(ctx.OriginatingTo).toBeUndefined();
            expect(opts?.disableTools).toBeUndefined();
            expect(opts?.skillFilter).toBeUndefined();
            return { text: "internal heartbeat done" };
          },
        );

        const resultValue = await runHeartbeatOnce({
          cfg,
          agentId: "main",
          sessionKey,
          deps: {
            getReplyFromConfig: replySpy,
            telegram: sendTelegramValue,
            getQueueSize: () => 0,
            nowMs: () => nowMs,
          },
        });

        return {
          result: resultValue,
          sendTelegram: sendTelegramValue,
          store: await loadCommitmentStore(),
        };
      },
    );

    expect(result.status).toBe("ran");
    expect(sendTelegram).not.toHaveBeenCalled();
    expectCommitmentFields(store.commitments[0], {
      id: "cm_interview",
      status: "pending",
      attempts: 0,
    });
  });

  it("does not wake extra commitment sessions when heartbeat target is none", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);

    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
      const dueSessionKey = "agent:main:telegram:user-155462274";
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "none",
            },
          },
        },
        session: { store: storePath },
      };
      await saveCommitmentStore(undefined, {
        version: 1,
        commitments: [buildCommitment({ id: "cm_interview", sessionKey: dueSessionKey, to: "1" })],
      });
      expect(await listDueCommitmentSessionKeys({ cfg, agentId: "main", nowMs })).toStrictEqual([
        dueSessionKey,
      ]);
      const runOnce = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
      const runner = startHeartbeatRunner({
        cfg,
        runOnce,
        stableSchedulerSeed: "commitment-target-none",
      });

      requestHeartbeat({ source: "manual", intent: "manual", reason: "manual", coalesceMs: 0 });
      await vi.advanceTimersByTimeAsync(1);
      runner.stop();

      expect(runOnce).toHaveBeenCalledTimes(1);
      const runOptions = runOnce.mock.calls[0]?.[0] as
        | { agentId?: string; heartbeat?: { target?: string }; sessionKey?: string }
        | undefined;
      expect(runOptions?.agentId).toBe("main");
      expect(runOptions?.heartbeat?.target).toBe("none");
      expect(runOptions?.sessionKey).not.toBe(dueSessionKey);
    });
  });

  it("uses an explicit commitment-only run scope for scheduler fan-out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);

    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
      const dueSessionKey = "agent:main:telegram:user-155462274";
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "last",
            },
          },
        },
        session: { store: storePath },
      };
      await saveCommitmentStore(undefined, {
        version: 1,
        commitments: [buildCommitment({ id: "cm_interview", sessionKey: dueSessionKey, to: "1" })],
      });
      const runOnce = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
      const runner = startHeartbeatRunner({
        cfg,
        runOnce,
        stableSchedulerSeed: "commitment-run-scope",
      });

      requestHeartbeat({ source: "manual", intent: "manual", reason: "manual", coalesceMs: 0 });
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(runOnce).toHaveBeenCalledTimes(2));
      runner.stop();

      expect(runOnce.mock.calls[0]?.[0]).toMatchObject({
        agentId: "main",
        runScope: "global",
      });
      expect(runOnce.mock.calls[1]?.[0]).toMatchObject({
        agentId: "main",
        runScope: "commitment-only",
        sessionKey: dueSessionKey,
      });
      expect(runOnce.mock.calls[1]?.[0]).not.toHaveProperty("reason");
    });
  });

  it("delivers due commitments on a targeted cron-monitor interval tick", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(nowMs);

    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
      const dueSessionKey = "agent:main:telegram:user-155462274";
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: { every: "5m", target: "last" },
          },
        },
        session: { store: storePath },
      };
      await saveCommitmentStore(undefined, {
        version: 1,
        commitments: [buildCommitment({ id: "cm_interview", sessionKey: dueSessionKey, to: "1" })],
      });
      const runOnce = vi.fn().mockResolvedValue({ status: "ran", durationMs: 1 });
      const runner = startHeartbeatRunner({
        cfg,
        runOnce,
        stableSchedulerSeed: "commitment-monitor-tick",
      });

      // Reach the agent's due slot first: scheduled-intent wakes defer with
      // not-due until the phase boundary passes.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      // The cron heartbeat monitor pokes with an agentId; that targeted
      // interval tick must keep the commitment fan-out the broadcast timer had.
      requestHeartbeat({
        source: "interval",
        intent: "scheduled",
        reason: "interval",
        agentId: "main",
        coalesceMs: 0,
      });
      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => expect(runOnce).toHaveBeenCalledTimes(2));
      runner.stop();

      expect(runOnce.mock.calls[0]?.[0]).toMatchObject({ agentId: "main", runScope: "global" });
      expect(runOnce.mock.calls[1]?.[0]).toMatchObject({
        agentId: "main",
        runScope: "commitment-only",
        sessionKey: dueSessionKey,
      });
    });
  });

  it("delivers due commitments to the original scope when heartbeat target is last", async () => {
    const { result, sendTelegram, store } = await setupCommitmentCase();

    expect(result.status).toBe("ran");
    expect(sendTelegram).toHaveBeenCalled();
    expectCommitmentFields(store.commitments[0], {
      id: "cm_interview",
      status: "sent",
      attempts: 1,
      sentAtMs: nowMs,
    });
  });

  it("keeps commitment-only delivery on the configured isolated run session", async () => {
    const { result, sendTelegram, store } = await setupCommitmentCase({
      isolatedSession: true,
      runScope: "commitment-only",
    });

    expect(result.status).toBe("ran");
    expect(sendTelegram).toHaveBeenCalled();
    expectCommitmentFields(store.commitments[0], {
      id: "cm_interview",
      status: "sent",
      attempts: 1,
      sentAtMs: nowMs,
    });
  });

  it("does not mark suppressed commitment sends as delivered or duplicate-dismiss their retry", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
      const sessionKey = "agent:main:telegram:user-155462274";
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "last",
            },
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
      await saveCommitmentStore(undefined, {
        version: 1,
        commitments: [buildCommitment({ id: "cm_interview", sessionKey, to: "155462274" })],
      });

      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m2",
        chatId: "155462274",
      });
      replySpy
        .mockResolvedValueOnce({ text: "No channel reply." })
        .mockResolvedValueOnce({ text: "How did the interview go?" });

      const runOnce = async () =>
        await runHeartbeatOnce({
          cfg,
          agentId: "main",
          sessionKey,
          deps: {
            getReplyFromConfig: replySpy,
            telegram: sendTelegram,
            getQueueSize: () => 0,
            nowMs: () => nowMs,
          },
        });

      const first = await runOnce();

      expect(first.status).toBe("ran");
      expect(sendTelegram).not.toHaveBeenCalled();
      let store = await loadCommitmentStore();
      expectCommitmentFields(store.commitments[0], {
        id: "cm_interview",
        status: "pending",
        attempts: 1,
        lastAttemptAtMs: nowMs,
      });
      expect(store.commitments[0]?.sentAtMs).toBeUndefined();
      const sessionStoreAfterSuppressed = readSessionStoreForTest<{
        lastHeartbeatText?: string;
        lastHeartbeatSentAt?: number;
      }>(storePath);
      expect(sessionStoreAfterSuppressed[sessionKey]?.lastHeartbeatText).toBeUndefined();
      expect(sessionStoreAfterSuppressed[sessionKey]?.lastHeartbeatSentAt).toBeUndefined();
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: "skipped",
        reason: "no_visible_payload",
      });

      const second = await runOnce();

      expect(second.status).toBe("ran");
      expect(sendTelegram).toHaveBeenCalledTimes(1);
      store = await loadCommitmentStore();
      expectCommitmentFields(store.commitments[0], {
        id: "cm_interview",
        status: "sent",
        attempts: 2,
        sentAtMs: nowMs,
      });
      expect(getLastHeartbeatEvent()).toMatchObject({
        status: "sent",
      });
    });
  });

  it("tolerates Date-invalid commitment due timestamps in heartbeat prompts", async () => {
    const { result, sendTelegram, store } = await setupCommitmentCase({
      dueWindow: {
        earliestMs: nowMs - 60_000,
        latestMs: 8_700_000_000_000_000,
        timezone: "UTC",
      },
    });

    expect(result.status).toBe("ran");
    expect(sendTelegram).toHaveBeenCalled();
    expectCommitmentFields(store.commitments[0], {
      id: "cm_interview",
      status: "sent",
      attempts: 1,
      sentAtMs: nowMs,
    });
  });

  it("dismisses a due commitment when the heartbeat model declines to send a check-in", async () => {
    const { result, sendTelegram, store } = await setupCommitmentCase({
      replyText: HEARTBEAT_TOKEN,
    });

    expect(result.status).toBe("ran");
    expect(sendTelegram).not.toHaveBeenCalled();
    expectCommitmentFields(store.commitments[0], {
      id: "cm_interview",
      status: "dismissed",
      attempts: 1,
      dismissedAtMs: nowMs,
    });
  });

  it("keeps due commitment heartbeats on the text ack while tools are disabled", async () => {
    const { result, sendTelegram, store } = await setupCommitmentCase({
      visibleReplies: "message_tool",
      replyText: HEARTBEAT_TOKEN,
    });

    expect(result.status).toBe("ran");
    expect(sendTelegram).not.toHaveBeenCalled();
    expectCommitmentFields(store.commitments[0], {
      id: "cm_interview",
      status: "dismissed",
      attempts: 1,
      dismissedAtMs: nowMs,
    });
  });

  it("appends scratch directives to the commitment prompt", async () => {
    const { result, sendTelegram, store } = await withTempHeartbeatSandbox(
      async ({ tmpDir, storePath, replySpy }) => {
        setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
        const sessionKey = "agent:main:telegram:user-155462274";
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                target: "last",
              },
            },
          },
          channels: { telegram: { allowFrom: ["*"] } },
          session: { store: storePath },
        };
        await seedHeartbeatScratchForTest({
          content: "Do not contact the user unless critical.\n",
        });
        await seedSessionStore(storePath, sessionKey, {
          sessionId: "sid",
          updatedAt: nowMs,
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "155462274",
        });
        await saveCommitmentStore(undefined, {
          version: 1,
          commitments: [buildCommitment({ id: "cm_interview", sessionKey, to: "155462274" })],
        });

        const sendTelegramLocal = vi.fn().mockResolvedValue({
          messageId: "m1",
          chatId: "155462274",
        });
        replySpy.mockImplementation(
          async (ctx: { Body?: string }, _opts?: { disableTools?: boolean }) => {
            // Must contain commitment text
            expect(ctx.Body).toContain("Due inferred follow-up commitments");
            expect(ctx.Body).toContain("How did the interview go?");
            // Must also contain the monitor scratch directive.
            expect(ctx.Body).toContain("Do not contact the user unless critical.");
            return { text: "How did the interview go?" };
          },
        );

        const resultLocal = await runHeartbeatOnce({
          cfg,
          agentId: "main",
          sessionKey,
          deps: {
            getReplyFromConfig: replySpy,
            telegram: sendTelegramLocal,
            getQueueSize: () => 0,
            nowMs: () => nowMs,
          },
        });

        return {
          result: resultLocal,
          sendTelegram: sendTelegramLocal,
          store: await loadCommitmentStore(),
        };
      },
    );

    expect(result.status).toBe("ran");
    expect(sendTelegram).toHaveBeenCalled();
    expect(store.commitments[0]).toMatchObject({
      id: "cm_interview",
      status: "sent",
      attempts: 1,
      sentAtMs: nowMs,
    });
  });

  it("keeps commitment-only fan-out isolated from global work and state", async () => {
    const { pendingEvents, result, sendTelegram, sessionStore, store } =
      await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
        setTestEnvValue("OPENCLAW_STATE_DIR", tmpDir);
        const sessionKey = "agent:main:telegram:user-155462274";
        const cfg: OpenClawConfig = {
          agents: {
            defaults: {
              workspace: tmpDir,
              heartbeat: {
                every: "5m",
                target: "last",
              },
            },
          },
          channels: { telegram: { allowFrom: ["*"] } },
          session: { store: storePath },
        };
        await seedHeartbeatScratchForTest({
          content: `Run the global operations audit and surface any unrelated account drift.

tasks:
  - name: global-ops-audit
    interval: 5m
    prompt: Check every dashboard for unrelated account drift
`,
        });
        await seedSessionStore(storePath, sessionKey, {
          sessionId: "sid",
          updatedAt: nowMs,
          lastChannel: "telegram",
          lastProvider: "telegram",
          lastTo: "155462274",
          heartbeatTaskState: { "global-ops-audit": nowMs - 10 * 60_000 },
        });
        enqueueSystemEvent("Reminder: run the global audit", {
          sessionKey,
          deliveryContext: {
            channel: "telegram",
            to: "wrong-target",
            accountId: "wrong-account",
          },
        });
        await saveCommitmentStore(undefined, {
          version: 1,
          commitments: [buildCommitment({ id: "cm_interview", sessionKey, to: "155462274" })],
        });

        const sendTelegramLocal = vi.fn().mockResolvedValue({
          messageId: "m1",
          chatId: "155462274",
        });
        replySpy.mockImplementation(
          async (
            ctx: {
              Body?: string;
              OriginatingChannel?: string;
              OriginatingTo?: string;
            },
            opts?: { disableTools?: boolean; skillFilter?: string[] },
          ) => {
            expect(ctx.Body).toContain("Due inferred follow-up commitments");
            expect(ctx.Body).toContain("How did the interview go?");
            expect(ctx.Body).not.toContain("global operations audit");
            expect(ctx.Body).not.toContain("unrelated account drift");
            expect(ctx.Body).not.toContain("Run the following periodic tasks");
            expect(ctx.Body).not.toContain("Heartbeat monitor scratch:");
            expect(ctx.Body).not.toContain("HEARTBEAT.md");
            expect(ctx.OriginatingChannel).toBe("telegram");
            expect(ctx.OriginatingTo).toBe("155462274");
            expect(opts?.disableTools).toBe(true);
            expect(opts?.skillFilter).toStrictEqual([]);
            expect(resolveHeartbeatRunScope(opts)).toBe("commitment-only");
            return { text: "How did the interview go?" };
          },
        );

        const resultLocal = await runHeartbeatOnce({
          cfg,
          agentId: "main",
          runScope: "commitment-only",
          sessionKey,
          deps: {
            getReplyFromConfig: replySpy,
            telegram: sendTelegramLocal,
            getQueueSize: () => 0,
            nowMs: () => nowMs,
          },
        });

        return {
          result: resultLocal,
          sendTelegram: sendTelegramLocal,
          pendingEvents: peekSystemEventEntries(sessionKey),
          sessionStore: readSessionStoreForTest<{
            heartbeatTaskState?: Record<string, number>;
          }>(storePath),
          store: await loadCommitmentStore(),
        };
      });

    expect(result.status).toBe("ran");
    expect(sendTelegram).toHaveBeenCalled();
    expect(sendTelegram).toHaveBeenCalledWith(
      "155462274",
      "How did the interview go?",
      expect.any(Object),
    );
    expect(sessionStore).toMatchObject({
      "agent:main:telegram:user-155462274": {
        heartbeatTaskState: { "global-ops-audit": nowMs - 10 * 60_000 },
      },
    });
    expect(pendingEvents).toHaveLength(1);
    expect(pendingEvents[0]).toMatchObject({
      text: "Reminder: run the global audit",
    });
    expect(store.commitments[0]).toMatchObject({
      id: "cm_interview",
      status: "sent",
      attempts: 1,
      sentAtMs: nowMs,
    });
  });
});
