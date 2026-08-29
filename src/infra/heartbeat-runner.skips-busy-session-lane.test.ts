// Covers heartbeat skipping while session lanes or cron jobs are busy.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveEmbeddedRun,
  preemptAndDrainEmbeddedHeartbeatRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import {
  createEmbeddedRunHandle,
  testing as embeddedRunTesting,
} from "../agents/embedded-agent-runner/runs.test-support.js";
import { recordReplyOperationAgentTurn } from "../auto-reply/reply/reply-operation-agent-turn-state.js";
import { resolveReplyOperationRunState } from "../auto-reply/reply/reply-operation-run-state.js";
import { createReplyOperation } from "../auto-reply/reply/reply-run-registry.js";
import { testing as replyRunRegistryTesting } from "../auto-reply/reply/reply-run-registry.test-support.js";
import type { OpenClawConfig } from "../config/config.js";
import { markCronJobActive, resetCronActiveJobs } from "../cron/active-jobs.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { CommandLane } from "../process/lanes.js";
import { createOutboundTestPlugin, createTestRegistry } from "../test-utils/channel-plugins.js";
import { getAgentEventLifecycleGeneration } from "./agent-events.js";
import { getLastHeartbeatEvent, resetHeartbeatEventsForTest } from "./heartbeat-events.js";
import { type HeartbeatDeps, runHeartbeatOnce } from "./heartbeat-runner.js";
import { seedMainSessionStore, withTempHeartbeatSandbox } from "./heartbeat-runner.test-utils.js";
import {
  HEARTBEAT_SKIP_CRON_IN_PROGRESS,
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
} from "./heartbeat-wake.js";
import { resetSystemEventsForTest, enqueueSystemEvent } from "./system-events.js";

vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

let previousRegistry: ReturnType<typeof getActivePluginRegistry> | null = null;

const noopOutbound = {
  deliveryMode: "direct" as const,
  sendText: async () => ({ channel: "telegram" as const, messageId: "1", chatId: "1" }),
  sendMedia: async () => ({ channel: "telegram" as const, messageId: "1", chatId: "1" }),
};

beforeAll(() => {
  previousRegistry = getActivePluginRegistry();
  const telegramPlugin = createOutboundTestPlugin({ id: "telegram", outbound: noopOutbound });
  const registry = createTestRegistry([
    { pluginId: "telegram", plugin: telegramPlugin, source: "test" },
  ]);
  setActivePluginRegistry(registry);
});

afterAll(() => {
  if (previousRegistry) {
    setActivePluginRegistry(previousRegistry);
  }
});

beforeEach(() => {
  resetHeartbeatEventsForTest();
  embeddedRunTesting.resetActiveEmbeddedRuns();
  resetSystemEventsForTest();
  resetCronActiveJobs();
  replyRunRegistryTesting.resetReplyRunRegistry();
});

afterEach(() => resetHeartbeatEventsForTest());

function createHeartbeatTelegramConfig(storePath: string): OpenClawConfig {
  return {
    session: { store: storePath },
    agents: {
      defaults: {
        heartbeat: { every: "30m", target: "last" },
        model: { primary: "test/model" },
      },
    },
    channels: {
      telegram: {
        enabled: true,
        token: "fake",
        allowFrom: ["123"],
      },
    },
  } as unknown as OpenClawConfig;
}

async function seedHeartbeatTelegramSession(
  storePath: string,
  cfg: OpenClawConfig,
  entry: Partial<Parameters<typeof seedMainSessionStore>[2]> = {},
) {
  return seedMainSessionStore(storePath, cfg, {
    lastChannel: "telegram",
    lastProvider: "telegram",
    lastTo: "123",
    ...entry,
  });
}

type HeartbeatRunOverrides = Omit<Parameters<typeof runHeartbeatOnce>[0], "cfg" | "deps">;

function runHeartbeat(
  cfg: OpenClawConfig,
  replySpy: HeartbeatDeps["getReplyFromConfig"],
  overrides: HeartbeatRunOverrides = {},
  deps: Partial<HeartbeatDeps> = {},
) {
  return runHeartbeatOnce({
    cfg,
    ...overrides,
    deps: {
      getQueueSize: vi.fn((_lane?: string) => 0),
      nowMs: () => Date.now(),
      getReplyFromConfig: replySpy,
      ...deps,
    } as HeartbeatDeps,
  });
}

describe("heartbeat runner skips when target session lane is busy", () => {
  it.each([
    { label: "scheduled", intent: "scheduled" as const },
    { label: "automatic immediate", intent: "immediate" as const },
  ])(
    "defers $label heartbeat while main-session restart recovery owns the session",
    async ({ intent }) => {
      await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
        const cfg = createHeartbeatTelegramConfig(storePath);
        cfg.session = { store: storePath };
        await seedHeartbeatTelegramSession(storePath, cfg, {
          status: "running",
          abortedLastRun: true,
          mainRestartRecovery: {
            cycleId: "restart-cycle",
            revision: 1,
            chargedAttempts: 0,
          },
        });

        const result = await runHeartbeat(cfg, replySpy, { intent });

        expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT });
        expect(getLastHeartbeatEvent()).toMatchObject({
          ...result,
          durationMs: expect.any(Number),
        });
        expect(replySpy).not.toHaveBeenCalled();
      });
    },
  );

  it("defers automatic heartbeat while an admitted recovery owns the current lifecycle", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig(storePath);
      cfg.session = { store: storePath };
      await seedHeartbeatTelegramSession(storePath, cfg, {
        status: "running",
        abortedLastRun: false,
        mainRestartRecovery: {
          cycleId: "restart-cycle",
          revision: 2,
          chargedAttempts: 1,
          foregroundClaims: {
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
            tokens: ["recovery-owner"],
          },
        },
      });

      const result = await runHeartbeat(cfg, replySpy, { intent: "immediate" });

      expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT });
      expect(getLastHeartbeatEvent()).toMatchObject({ ...result, durationMs: expect.any(Number) });
      expect(replySpy).not.toHaveBeenCalled();
    });
  });

  it.each([
    { label: "scheduled", intent: "scheduled" as const },
    { label: "automatic immediate", intent: "immediate" as const },
  ])(
    "defers $label heartbeat until the current restart recovery delivery settles",
    async ({ intent }) => {
      await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
        const cfg = createHeartbeatTelegramConfig(storePath);
        cfg.session = { store: storePath };
        await seedHeartbeatTelegramSession(storePath, cfg, {
          status: "running",
          abortedLastRun: false,
          restartRecoveryDeliveryRunId: "restart-recovery-run",
          restartRecoveryRuns: [
            {
              runId: "restart-recovery-run",
              lifecycleGeneration: getAgentEventLifecycleGeneration(),
            },
          ],
        });

        const result = await runHeartbeat(cfg, replySpy, { intent });

        expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT });
        expect(getLastHeartbeatEvent()).toMatchObject({
          ...result,
          durationMs: expect.any(Number),
        });
        expect(replySpy).not.toHaveBeenCalled();
      });
    },
  );

  it("does not block an explicit manual heartbeat on restart recovery delivery", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig(storePath);
      cfg.session = { store: storePath };
      await seedHeartbeatTelegramSession(storePath, cfg, {
        status: "running",
        abortedLastRun: false,
        restartRecoveryDeliveryRunId: "restart-recovery-run",
        restartRecoveryRuns: [
          {
            runId: "restart-recovery-run",
            lifecycleGeneration: getAgentEventLifecycleGeneration(),
          },
        ],
      });
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeat(cfg, replySpy, { intent: "manual" });

      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledOnce();
    });
  });

  it.each([
    {
      label: "a previous gateway lifecycle",
      recoveryRun: {
        runId: "restart-recovery-run",
        lifecycleGeneration: "previous-gateway-lifecycle",
      },
    },
    {
      label: "another restart recovery run",
      recoveryRun: {
        runId: "another-restart-recovery-run",
        lifecycleGeneration: "current-gateway-lifecycle",
      },
    },
  ])("does not defer a heartbeat for $label", async ({ recoveryRun }) => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig(storePath);
      cfg.session = { store: storePath };
      await seedHeartbeatTelegramSession(storePath, cfg, {
        status: "running",
        abortedLastRun: false,
        restartRecoveryDeliveryRunId: "restart-recovery-run",
        restartRecoveryRuns: [
          {
            ...recoveryRun,
            lifecycleGeneration:
              recoveryRun.lifecycleGeneration === "current-gateway-lifecycle"
                ? getAgentEventLifecycleGeneration()
                : recoveryRun.lifecycleGeneration,
          },
        ],
      });
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeat(cfg, replySpy, { intent: "scheduled" });

      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledOnce();
    });
  });

  it("returns cron-in-progress when cron has an active job", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig(storePath);
      await seedHeartbeatTelegramSession(storePath, cfg);
      markCronJobActive("local-model-report");

      const result = await runHeartbeat(cfg, replySpy);

      expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS });
      expect(replySpy).not.toHaveBeenCalled();
    });
  });

  it("returns cron-in-progress when cron lanes have queued work", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig(storePath);
      await seedHeartbeatTelegramSession(storePath, cfg);

      const result = await runHeartbeat(
        cfg,
        replySpy,
        {},
        {
          getQueueSize: vi.fn((lane?: string) => (lane === CommandLane.Cron ? 1 : 0)),
        },
      );

      expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS });
      expect(replySpy).not.toHaveBeenCalled();
    });
  });

  it("does not skip for global subagent-lane work alone", async () => {
    // The global Subagent lane has no agent identity in its name — a stalled
    // subagent on any one agent must not silently disable every other
    // agent's heartbeat.
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig(storePath);
      cfg.agents!.defaults!.heartbeat = { every: "30m", target: "last" };
      await seedHeartbeatTelegramSession(storePath, cfg);

      const result = await runHeartbeat(
        cfg,
        replySpy,
        {},
        {
          getQueueSize: vi.fn((lane?: string) => (lane === CommandLane.Subagent ? 1 : 0)),
        },
      );

      expect(result.status).not.toBe("skipped");
    });
  });

  it.each(["main", "session"])(
    "records requests-in-flight when the %s lane has queued work",
    async (busyLane) => {
      await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
        const cfg = createHeartbeatTelegramConfig(storePath);
        const sessionKey = await seedHeartbeatTelegramSession(storePath, cfg);

        enqueueSystemEvent("Exec completed (test-id, code 0) :: test output", {
          sessionKey,
        });

        const getQueueSize = vi.fn((lane?: string) =>
          Number(busyLane === "main" ? lane === CommandLane.Main : lane?.startsWith("session:")),
        );

        const result = await runHeartbeat(cfg, replySpy, {}, { getQueueSize });

        expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT });
        expect(getLastHeartbeatEvent()).toMatchObject({
          ...result,
          durationMs: expect.any(Number),
        });
        expect(replySpy).not.toHaveBeenCalled();
      });
    },
  );

  it("returns requests-in-flight when the target session has an active reply run", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig(storePath);
      const sessionKey = await seedHeartbeatTelegramSession(storePath, cfg);
      const isReplyRunActive = vi.fn((key: string) => key === sessionKey);

      const result = await runHeartbeat(cfg, replySpy, {}, { isReplyRunActive });

      expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT });
      expect(isReplyRunActive).toHaveBeenCalledWith(sessionKey);
      expect(replySpy).not.toHaveBeenCalled();
    });
  });

  it("returns requests-in-flight when another session for the same agent has an active reply run", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig(storePath);
      await seedHeartbeatTelegramSession(storePath, cfg);
      const listActiveReplyRunSessionKeys = vi.fn(() => [
        "agent:main:telegram:group:-1003966283270:topic:547",
      ]);

      const result = await runHeartbeat(cfg, replySpy, {}, { listActiveReplyRunSessionKeys });

      expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT });
      expect(listActiveReplyRunSessionKeys).toHaveBeenCalledOnce();
      expect(replySpy).not.toHaveBeenCalled();
    });
  });

  it("ignores unscoped active reply runs when checking same-agent heartbeat work", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig(storePath);
      await seedHeartbeatTelegramSession(storePath, cfg);
      const listActiveReplyRunSessionKeys = vi.fn(() => ["legacy-session-key"]);
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeat(cfg, replySpy, {}, { listActiveReplyRunSessionKeys });

      expect(result.status).toBe("ran");
      expect(listActiveReplyRunSessionKeys).toHaveBeenCalledOnce();
      expect(replySpy).toHaveBeenCalledOnce();
    });
  });

  it("does not defer immediate heartbeat wakes for another active session", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig(storePath);
      await seedHeartbeatTelegramSession(storePath, cfg);
      const listActiveReplyRunSessionKeys = vi.fn(() => [
        "agent:main:telegram:group:-1003966283270:topic:547",
      ]);
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeat(
        cfg,
        replySpy,
        { intent: "immediate" },
        { listActiveReplyRunSessionKeys },
      );

      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledOnce();
    });
  });

  it("returns requests-in-flight when a reply run is still active after queues drain", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig(storePath);
      const sessionKey = await seedHeartbeatTelegramSession(storePath, cfg);
      const operation = createReplyOperation({
        sessionKey,
        sessionId: "active-reply-session",
        resetTriggered: false,
      });
      operation.setPhase("running");

      try {
        const result = await runHeartbeat(cfg, replySpy);

        expect(result.status).toBe("skipped");
        if (result.status === "skipped") {
          expect(result.reason).toBe(HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT);
        }
        expect(replySpy).not.toHaveBeenCalled();
      } finally {
        operation.complete();
      }
    });
  });

  it("suppresses delivery when a visible turn supersedes a finalizing heartbeat", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig(storePath);
      const sessionKey = await seedHeartbeatTelegramSession(storePath, cfg);
      const sessionId = "finalizing-heartbeat-session";
      let preempt: ReturnType<typeof vi.fn<() => boolean>> | undefined;
      replySpy.mockImplementationOnce(async (_ctx, options) => {
        const operation = createReplyOperation({
          sessionKey,
          sessionId,
          turnKind: "heartbeat",
          resetTriggered: false,
        });
        preempt = vi.fn(() => operation.supersede());
        const handle = {
          ...createEmbeddedRunHandle({ isAbortable: false }),
          preemptByVisibleTurn: preempt,
        };
        const runState = resolveReplyOperationRunState(options);
        if (!runState) {
          throw new Error("Expected heartbeat reply operation run state");
        }
        recordReplyOperationAgentTurn(runState, "ok", operation);
        operation.freezeAbort();
        setActiveEmbeddedRun(sessionId, handle, sessionKey);
        const drained = preemptAndDrainEmbeddedHeartbeatRun(sessionId, 1_000);
        clearActiveEmbeddedRun(sessionId, handle, sessionKey);
        await expect(drained).resolves.toBe("drained");
        operation.complete();
        return { text: "Background work finished." };
      });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "123" });

      const result = await runHeartbeat(cfg, replySpy, {}, { telegram: sendTelegram });

      expect(result).toEqual({ status: "skipped", reason: "preempted" });
      expect(preempt).toHaveBeenCalledOnce();
      expect(sendTelegram).not.toHaveBeenCalled();
    });
  });

  it("does not infer admission rejection from a replacement run after an empty heartbeat", async () => {
    await withTempHeartbeatSandbox(async ({ storePath }) => {
      const cfg = createHeartbeatTelegramConfig(storePath);
      const sessionKey = await seedHeartbeatTelegramSession(storePath, cfg);
      let operation: ReturnType<typeof createReplyOperation> | undefined;
      const replySpy = vi.fn(async (_ctx, replyOptions) => {
        const runState = resolveReplyOperationRunState(replyOptions);
        if (!runState) {
          throw new Error("expected heartbeat reply operation state");
        }
        runState.admission = { status: "owned" };
        operation = createReplyOperation({
          sessionKey,
          sessionId: "racing-visible-session",
          resetTriggered: false,
        });
        operation.setPhase("running");
        return undefined;
      });

      try {
        const result = await runHeartbeat(cfg, replySpy);

        expect(result.status).toBe("ran");
        expect(replySpy).toHaveBeenCalledOnce();
      } finally {
        operation?.complete();
      }
    });
  });

  it("returns requests-in-flight when an isolated heartbeat reply run is still active", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig(storePath);
      cfg.agents!.defaults!.heartbeat = {
        every: "30m",
        target: "last",
        isolatedSession: true,
      };
      const baseSessionKey = await seedHeartbeatTelegramSession(storePath, cfg);
      const isolatedSessionKey = `${baseSessionKey}:heartbeat`;
      const operation = createReplyOperation({
        sessionKey: isolatedSessionKey,
        sessionId: "active-isolated-reply-session",
        resetTriggered: false,
      });
      operation.setPhase("running");

      try {
        const result = await runHeartbeat(cfg, replySpy);

        expect(result.status).toBe("skipped");
        if (result.status === "skipped") {
          expect(result.reason).toBe(HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT);
        }
        expect(replySpy).not.toHaveBeenCalled();
      } finally {
        operation.complete();
      }
    });
  });

  it("records a busy skip while a recent final delivery is pending", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig(storePath);
      await seedHeartbeatTelegramSession(storePath, cfg, {
        updatedAt: Date.now(),
        pendingFinalDelivery: {
          kind: "replayable",
          text: "The requested report is ready.",
          createdAt: Date.now(),
        },
      });

      const result = await runHeartbeat(cfg, replySpy);

      expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT });
      expect(getLastHeartbeatEvent()).toMatchObject({ ...result, durationMs: expect.any(Number) });
      expect(replySpy).not.toHaveBeenCalled();
    });
  });

  it("does not defer on a recent heartbeat ack pending final delivery", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig(storePath);
      cfg.session = { store: storePath };
      await seedHeartbeatTelegramSession(storePath, cfg, {
        lastProvider: "heartbeat",
        lastTo: "heartbeat",
        updatedAt: Date.now(),
        pendingFinalDelivery: {
          kind: "replayable",
          text: "HEARTBEAT_OK",
          createdAt: Date.now(),
        },
      });
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeat(cfg, replySpy);

      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledTimes(1);
    });
  });

  it("does not defer a recent pending acknowledgement under the fixed ack budget", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig(storePath);
      cfg.session = { store: storePath };
      cfg.agents!.defaults!.heartbeat = { every: "30m", target: "last" };
      await seedHeartbeatTelegramSession(storePath, cfg, {
        lastProvider: "heartbeat",
        lastTo: "heartbeat",
        updatedAt: Date.now(),
        pendingFinalDelivery: {
          kind: "replayable",
          text: "HEARTBEAT_OK short",
          createdAt: Date.now(),
        },
      });
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });

      const result = await runHeartbeat(cfg, replySpy);

      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledTimes(1);
    });
  });

  it("does not replay stale pending final delivery through a later heartbeat", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig(storePath);
      cfg.session = { store: storePath };
      cfg.agents!.defaults!.heartbeat = {
        every: "30m",
        target: "telegram",
      };
      await seedHeartbeatTelegramSession(storePath, cfg, {
        lastTo: "default-heartbeat-target",
        updatedAt: Date.now() - 60_000,
        pendingFinalDelivery: {
          kind: "replayable",
          text: "private prior user answer",
          createdAt: Date.now() - 60_000,
        },
      });
      replySpy.mockResolvedValue({ text: "HEARTBEAT_OK" });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "default" });

      const result = await runHeartbeat(cfg, replySpy, {}, { telegram: sendTelegram });

      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledOnce();
      expect(replySpy.mock.calls[0]?.[1]).toMatchObject({
        isHeartbeat: true,
      });
      expect(sendTelegram).not.toHaveBeenCalled();
    });
  });

  it("proceeds normally when session lane is idle", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = createHeartbeatTelegramConfig(storePath);
      await seedHeartbeatTelegramSession(storePath, cfg);

      // Both lanes idle
      const getQueueSize = vi.fn((_lane?: string) => 0);

      replySpy.mockResolvedValue({
        text: "HEARTBEAT_OK",
      });

      const result = await runHeartbeat(cfg, replySpy, {}, { getQueueSize });

      expect(replySpy).toHaveBeenCalled();
      expect(result.status).toBe("ran");
    });
  });
});
