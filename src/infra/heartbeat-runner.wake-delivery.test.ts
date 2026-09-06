// Covers wake-run delivery routing and isolated wake event ownership.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  getFirstReplyContext,
  mockCallAt,
  seedMainSessionStore,
  seedSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempHeartbeatSandbox,
  type HeartbeatReplyContext,
} from "./heartbeat-runner.test-utils.js";
import { selectAgentSystemEvents, withSystemEventOwner } from "./system-event-ownership.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueSystemEvent,
  peekSystemEventEntries,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "./system-events.js";

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
  resetSystemEventsForTest();
});

afterEach(() => {
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

describe("heartbeat wake delivery ownership", () => {
  const createConfig = async (params: {
    tmpDir: string;
    storePath: string;
    target?: "telegram" | "none";
    isolatedSession?: boolean;
  }): Promise<{ cfg: OpenClawConfig; sessionKey: string }> => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: params.tmpDir,
          heartbeat: {
            every: "5m",
            target: params.target ?? "telegram",
            ...(params.isolatedSession === true ? { isolatedSession: true } : {}),
          },
        },
      },
      channels: { telegram: { allowFrom: ["*"] } },
      session: { store: params.storePath },
    };
    const sessionKey = await seedMainSessionStore(params.storePath, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: "-100155462274",
    });
    return { cfg, sessionKey };
  };

  const createLastTargetConfig = (params: {
    tmpDir: string;
    storePath: string;
    isolatedSession?: boolean;
  }): OpenClawConfig => ({
    agents: {
      defaults: {
        workspace: params.tmpDir,
        heartbeat: {
          every: "5m",
          target: "last",
          ...(params.isolatedSession === true ? { isolatedSession: true } : {}),
        },
      },
    },
    channels: { telegram: { allowFrom: ["*"] } },
    session: { store: params.storePath },
  });

  const writeTelegramSessionStore = async (
    storePath: string,
    sessionKey: string,
    overrides: Record<string, unknown>,
  ): Promise<void> => {
    await seedSessionStore(storePath, sessionKey, {
      sessionId: "sid",
      updatedAt: Date.now(),
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: "-100155462274",
      ...overrides,
    });
  };

  const expectTelegramSend = (
    sendTelegram: ReturnType<typeof vi.fn>,
    params: {
      to: string;
      text: string;
      messageThreadId?: number;
    },
  ) => {
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    const [to, text, options] = mockCallAt(sendTelegram, 0, "Telegram send");
    expect(to).toBe(params.to);
    expect(text).toBe(params.text);
    expect((options as { messageThreadId?: number } | undefined)?.messageThreadId).toBe(
      params.messageThreadId,
    );
  };

  it("consumes surfaced generic wake context while deferring base-session exec completions", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const execCompletion = "exec finished: webhook-triggered backup completed";
      const { cfg, sessionKey } = await createConfig({
        tmpDir,
        storePath,
        target: "none",
        isolatedSession: true,
      });
      const getReplySpy = vi.fn().mockResolvedValue({ text: "Handled internally" });
      const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "155462274" });
      enqueueSystemEvent("Gateway restart ok", { sessionKey });
      enqueueSystemEvent(execCompletion, { sessionKey });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        source: "hook",
        intent: "immediate",
        reason: "hook:wake",
        deps: {
          getReplyFromConfig: getReplySpy,
          telegram: sendTelegram,
        },
      });

      const calledCtx: HeartbeatReplyContext | null =
        getReplySpy.mock.calls.length === 0 ? null : getFirstReplyContext(getReplySpy);
      expect(result.status).toBe("ran");
      expect(calledCtx?.InternalTurnSource).toBe("heartbeat");
      expect(calledCtx?.Body).toContain("Gateway restart ok");
      expect(calledCtx?.Body).not.toContain(execCompletion);
      expect(peekSystemEvents(sessionKey)).toEqual([execCompletion]);
    });
  });

  it("routes wake-triggered heartbeat replies using queued system-event delivery context", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
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
      const sessionKey = resolveMainSessionKey(cfg);
      await writeTelegramSessionStore(storePath, sessionKey, {});

      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "-100155462274",
      });
      replySpy.mockResolvedValue({ text: "Restart complete" });
      enqueueSystemEvent("Gateway restart ok", {
        sessionKey,
        deliveryContext: {
          channel: "telegram",
          to: "-100155462274",
          threadId: 42,
        },
      });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        source: "hook",
        intent: "immediate",
        reason: "wake",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: sendTelegram,
        },
      });

      expect(result.status).toBe("ran");
      expect(getFirstReplyContext(replySpy).Body).toContain("Gateway restart ok");
      expectTelegramSend(sendTelegram, {
        to: "-100155462274",
        text: "Restart complete",
        messageThreadId: 42,
      });
      expect(peekSystemEvents(sessionKey)).toEqual([]);
    });
  });

  it("does not reuse stale turn-source routing for isolated wake runs", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createLastTargetConfig({ tmpDir, storePath, isolatedSession: true });
      const sessionKey = resolveMainSessionKey(cfg);
      await writeTelegramSessionStore(storePath, sessionKey, { lastTo: "-100155462274" });

      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "-100155462274",
      });
      replySpy.mockResolvedValue({ text: "Restart complete" });
      enqueueSystemEvent("Gateway restart ok", {
        sessionKey,
        deliveryContext: {
          channel: "telegram",
          to: "-100999999999",
          threadId: 42,
        },
      });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        source: "hook",
        intent: "immediate",
        reason: "wake",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: sendTelegram,
        },
      });

      expect(result.status).toBe("ran");
      expect(getFirstReplyContext(replySpy).Body).toContain("Gateway restart ok");
      expect(getFirstReplyContext(replySpy).SessionKey).toBe(`${sessionKey}:heartbeat`);
      expectTelegramSend(sendTelegram, {
        to: "-100155462274",
        text: "Restart complete",
      });
    });
  });

  it("keeps output-bearing exec-event delivery pinned to the original Telegram topic when session route drifts", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
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
      const sessionKey = "agent:main:telegram:group:-1003774691294:topic:47";
      await writeTelegramSessionStore(storePath, sessionKey, {
        lastTo: "telegram:-1003774691294:topic:2175",
        lastThreadId: 2175,
      });

      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "-1003774691294",
      });
      const getReplySpy = vi.fn().mockResolvedValue({
        text: "The review-worker spawn finished successfully.",
      });
      enqueueSystemEvent("Exec completed (review-run, code 0) :: review-worker spawn finished", {
        sessionKey,
        deliveryContext: {
          channel: "telegram",
          to: "telegram:-1003774691294:topic:47",
          threadId: 47,
        },
      });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        reason: "exec-event",
        deps: {
          getReplyFromConfig: getReplySpy,
          telegram: sendTelegram,
        },
      });

      expect(result.status).toBe("ran");
      expectTelegramSend(sendTelegram, {
        to: "telegram:-1003774691294:topic:47",
        text: "The review-worker spawn finished successfully.",
        messageThreadId: 47,
      });
    });
  });

  it("suppresses metadata-only successful exec completions", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
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
      const sessionKey = "agent:main:telegram:group:-1003774691294:topic:47";
      await writeTelegramSessionStore(storePath, sessionKey, {
        lastTo: "telegram:-1003774691294:topic:2175",
        lastThreadId: 2175,
      });

      const sendTelegram = vi.fn();
      const getReplySpy = vi.fn().mockResolvedValue({
        text: "HEARTBEAT_OK",
      });
      enqueueSystemEvent("Exec completed (review-run, code 0)", {
        sessionKey,
        deliveryContext: {
          channel: "telegram",
          to: "telegram:-1003774691294:topic:47",
          threadId: 47,
        },
      });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        sessionKey,
        reason: "exec-event",
        deps: {
          getReplyFromConfig: getReplySpy,
          telegram: sendTelegram,
        },
      });

      expect(result.status).toBe("ran");
      expect(getFirstReplyContext(getReplySpy).Body).toContain("no command output was found");
      expect(sendTelegram).not.toHaveBeenCalled();
    });
  });

  it("re-queues the truncation-hidden tail of a partially shown wake event", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const { cfg, sessionKey } = await createConfig({ tmpDir, storePath });
      const oversized = `Gateway restart report ${"x".repeat(12_000)}`;
      enqueueSystemEvent(oversized, { sessionKey });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        source: "hook",
        intent: "immediate",
        reason: "hook:wake",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: vi.fn().mockResolvedValue({ messageId: "m1", chatId: "155462274" }),
        },
      });

      expect(result.status).toBe("ran");
      expect(getFirstReplyContext(replySpy).Body).toContain("[truncated]");
      const queued = peekSystemEvents(sessionKey);
      expect(queued.length).toBe(1);
      expect(queued[0]).toMatch(/^x+$/);
      expect(queued[0]!.length).toBeGreaterThan(1_000);
    });
  });

  it("keeps the re-queued remainder owned by the source agent", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const { cfg, sessionKey } = await createConfig({ tmpDir, storePath });
      const oversized = `Gateway restart report ${"x".repeat(12_000)}`;
      enqueueSystemEvent(oversized, withSystemEventOwner({ sessionKey }, "main"));

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        source: "hook",
        intent: "immediate",
        reason: "hook:wake",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: vi.fn().mockResolvedValue({ messageId: "m1", chatId: "155462274" }),
        },
      });

      expect(result.status).toBe("ran");
      const continuation = peekSystemEventEntries(sessionKey);
      expect(continuation.length).toBe(1);
      expect(
        selectAgentSystemEvents(continuation, "main").map((entry) => entry.text),
        "the source agent still sees its continuation",
      ).toHaveLength(1);
      expect(
        selectAgentSystemEvents(continuation, "beta"),
        "another agent sharing the queue can never claim the continuation",
      ).toHaveLength(0);
    });
  });

  it("does not evict unrelated queued events when inserting a continuation at capacity", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const { cfg, sessionKey } = await createConfig({ tmpDir, storePath });
      for (let index = 0; index < 19; index += 1) {
        enqueueSystemEvent(`heartbeat poll ${index}`, { sessionKey });
      }
      enqueueSystemEvent(`Exec completed (report, code 0) :: ${"o".repeat(12_000)}`, {
        sessionKey,
      });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        source: "exec-event",
        reason: "exec-event",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: vi.fn().mockResolvedValue({ messageId: "m1", chatId: "155462274" }),
        },
      });

      expect(result.status).toBe("ran");
      const queued = peekSystemEvents(sessionKey);
      expect(queued.length).toBe(20);
      expect(queued.filter((entry) => entry.startsWith("heartbeat poll")).length).toBe(19);
      expect(queued.at(-1)).toMatch(/^o+$/);
    });
  });

  it("does not re-queue a remainder when the original was replaced mid-turn", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const { cfg, sessionKey } = await createConfig({ tmpDir, storePath });
      const oversized = `Gateway restart report ${"x".repeat(12_000)}`;
      enqueueSystemEvent(oversized, { sessionKey });
      replySpy.mockImplementation(async () => {
        // The event is replaced while the model turn is running; finalization
        // must not resurrect its captured remainder as a stale continuation.
        consumeSelectedSystemEventEntries(sessionKey, peekSystemEventEntries(sessionKey));
        return { text: "HEARTBEAT_OK" };
      });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        source: "hook",
        intent: "immediate",
        reason: "hook:wake",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: vi.fn().mockResolvedValue({ messageId: "m1", chatId: "155462274" }),
        },
      });

      expect(result.status).toBe("ran");
      expect(peekSystemEvents(sessionKey)).toEqual([]);
    });
  });

  it("keeps queued reminders unconsumed when a task wake runs the task prompt", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createLastTargetConfig({ tmpDir, storePath });
      const sessionKey = resolveMainSessionKey(cfg);
      await writeTelegramSessionStore(storePath, sessionKey, {});
      const reminder = "Reminder: review the scheduled report";
      const generic = "Gateway restart ok";
      enqueueSystemEvent(reminder, { sessionKey, contextKey: "cron:owner-report" });
      enqueueSystemEvent(generic, { sessionKey });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        source: "interval",
        intent: "task",
        reason: "heartbeat-task:job-rotate-logs",
        tasks: [
          { jobId: "job-rotate-logs", name: "rotate-logs", prompt: "Rotate the workspace logs" },
        ],
        deps: {
          getReplyFromConfig: replySpy,
          telegram: vi.fn().mockResolvedValue({ messageId: "m1", chatId: "-100155462274" }),
        },
      });

      expect(result.status).toBe("ran");
      const body = getFirstReplyContext(replySpy).Body ?? "";
      expect(body).toContain("rotate-logs");
      expect(body).not.toContain(reminder);
      expect(body).not.toContain(generic);
      expect(peekSystemEvents(sessionKey)).toEqual([reminder, generic]);
    });
  });

  it("keeps Telegram topic routing for isolated scheduled heartbeats", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg = createLastTargetConfig({ tmpDir, storePath, isolatedSession: true });
      const sessionKey = resolveMainSessionKey(cfg);
      await writeTelegramSessionStore(storePath, sessionKey, {
        lastTo: "-100155462274",
        deliveryContext: {
          channel: "telegram",
          to: "-100155462274",
          threadId: 42,
        },
        chatType: "group",
      });

      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "-100155462274",
      });
      replySpy.mockResolvedValue({ text: "Topic heartbeat" });

      const result = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "timer",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: sendTelegram,
        },
      });

      expect(result.status).toBe("ran");
      const replyCtx = getFirstReplyContext(replySpy);
      expect(replyCtx.SessionKey).toBe(`${sessionKey}:heartbeat`);
      expect(replyCtx.MessageThreadId).toBe(42);
      expectTelegramSend(sendTelegram, {
        to: "-100155462274",
        text: "Topic heartbeat",
        messageThreadId: 42,
      });
    });
  });
});
