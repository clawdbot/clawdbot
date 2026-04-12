import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  seedMainSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { enqueueSystemEvent, resetSystemEventsForTest } from "./system-events.js";

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
  resetSystemEventsForTest();
});

afterEach(() => {
  resetSystemEventsForTest();
  vi.restoreAllMocks();
});

describe("Ghost reminder bug (issue #13317)", () => {
  const createHeartbeatDeps = (replyText: string) => {
    const sendTelegram = vi.fn().mockResolvedValue({
      messageId: "m1",
      chatId: "155462274",
    });
    const getReplySpy = vi.fn().mockResolvedValue({ text: replyText });
    return { sendTelegram, getReplySpy };
  };

  const createConfig = async (params: {
    tmpDir: string;
    storePath: string;
    target?: "telegram" | "none";
  }): Promise<{ cfg: OpenClawConfig; sessionKey: string }> => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: params.tmpDir,
          heartbeat: {
            every: "5m",
            target: params.target ?? "telegram",
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

  const expectCronEventPrompt = (
    calledCtx: {
      Provider?: string;
      Body?: string;
    } | null,
    reminderText: string,
  ) => {
    expect(calledCtx).not.toBeNull();
    expect(calledCtx?.Provider).toBe("cron-event");
    expect(calledCtx?.Body).toContain("scheduled reminder has been triggered");
    expect(calledCtx?.Body).toContain(reminderText);
    expect(calledCtx?.Body).not.toContain("HEARTBEAT_OK");
    expect(calledCtx?.Body).not.toContain("heartbeat poll");
  };

  const runCronReminderCase = async (
    tmpPrefix: string,
    enqueue: (sessionKey: string) => void,
  ): Promise<{
    result: Awaited<ReturnType<typeof runHeartbeatOnce>>;
    sendTelegram: ReturnType<typeof vi.fn>;
    calledCtx: { Provider?: string; Body?: string; ForceSenderIsOwnerFalse?: boolean } | null;
  }> => {
    return runHeartbeatCase({
      tmpPrefix,
      replyText: "Relay this reminder now",
      reason: "cron:reminder-job",
      enqueue,
    });
  };

  const runHeartbeatCase = async (params: {
    tmpPrefix: string;
    replyText: string;
    reason: string;
    enqueue: (sessionKey: string) => void;
    target?: "telegram" | "none";
  }): Promise<{
    result: Awaited<ReturnType<typeof runHeartbeatOnce>>;
    sendTelegram: ReturnType<typeof vi.fn>;
    calledCtx: { Provider?: string; Body?: string; ForceSenderIsOwnerFalse?: boolean } | null;
    replyCallCount: number;
  }> => {
    return withTempHeartbeatSandbox(
      async ({ tmpDir, storePath }) => {
        const { sendTelegram, getReplySpy } = createHeartbeatDeps(params.replyText);
        const { cfg, sessionKey } = await createConfig({
          tmpDir,
          storePath,
          target: params.target,
        });
        params.enqueue(sessionKey);
        const result = await runHeartbeatOnce({
          cfg,
          agentId: "main",
          reason: params.reason,
          deps: {
            getReplyFromConfig: getReplySpy,
            telegram: sendTelegram,
          },
        });
        const calledCtx = (getReplySpy.mock.calls[0]?.[0] ?? null) as {
          Provider?: string;
          Body?: string;
        } | null;
        return {
          result,
          sendTelegram,
          calledCtx,
          replyCallCount: getReplySpy.mock.calls.length,
        };
      },
      { prefix: params.tmpPrefix },
    );
  };

  it("does not use CRON_EVENT_PROMPT when only a HEARTBEAT_OK event is present", async () => {
    const { result, sendTelegram, calledCtx, replyCallCount } = await runHeartbeatCase({
      tmpPrefix: "openclaw-ghost-",
      replyText: "Heartbeat check-in",
      reason: "cron:test-job",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("HEARTBEAT_OK", { sessionKey });
      },
    });
    expect(result.status).toBe("ran");
    expect(replyCallCount).toBe(1);
    expect(calledCtx?.Provider).toBe("heartbeat");
    expect(calledCtx?.Body).not.toContain("scheduled reminder has been triggered");
    expect(calledCtx?.Body).not.toContain("relay this reminder");
    expect(sendTelegram).toHaveBeenCalled();
  });

  it("uses CRON_EVENT_PROMPT when an actionable cron event exists", async () => {
    const { result, sendTelegram, calledCtx } = await runCronReminderCase(
      "openclaw-cron-",
      (sessionKey) => {
        enqueueSystemEvent("Reminder: Check Base Scout results", { sessionKey });
      },
    );
    expect(result.status).toBe("ran");
    expectCronEventPrompt(calledCtx, "Reminder: Check Base Scout results");
    expect(sendTelegram).toHaveBeenCalled();
  });

  it("uses CRON_EVENT_PROMPT when cron events are mixed with heartbeat noise", async () => {
    const { result, sendTelegram, calledCtx } = await runCronReminderCase(
      "openclaw-cron-mixed-",
      (sessionKey) => {
        enqueueSystemEvent("HEARTBEAT_OK", { sessionKey });
        enqueueSystemEvent("Reminder: Check Base Scout results", { sessionKey });
      },
    );
    expect(result.status).toBe("ran");
    expectCronEventPrompt(calledCtx, "Reminder: Check Base Scout results");
    expect(sendTelegram).toHaveBeenCalled();
  });

  it("uses CRON_EVENT_PROMPT for tagged cron events on interval wake", async () => {
    const { result, sendTelegram, calledCtx, replyCallCount } = await runHeartbeatCase({
      tmpPrefix: "openclaw-cron-interval-",
      replyText: "Relay this cron update now",
      reason: "interval",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("Cron: QMD maintenance completed", {
          sessionKey,
          contextKey: "cron:qmd-maintenance",
        });
      },
    });
    expect(result.status).toBe("ran");
    expect(replyCallCount).toBe(1);
    expect(calledCtx?.Provider).toBe("cron-event");
    expect(calledCtx?.Body).toContain("scheduled reminder has been triggered");
    expect(calledCtx?.Body).toContain("Cron: QMD maintenance completed");
    expect(calledCtx?.Body).not.toContain("Read HEARTBEAT.md");
    expect(sendTelegram).toHaveBeenCalled();
  });

  it("drains inspected cron events after a successful run so later heartbeats do not replay them", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "155462274",
      });
      const getReplySpy = vi
        .fn()
        .mockResolvedValueOnce({ text: "Relay this cron update now" })
        .mockResolvedValueOnce({ text: "HEARTBEAT_OK" });
      const { cfg, sessionKey } = await createConfig({ tmpDir, storePath });

      enqueueSystemEvent("Cron: QMD maintenance completed", {
        sessionKey,
        contextKey: "cron:qmd-maintenance",
      });

      const first = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "interval",
        deps: {
          getReplyFromConfig: getReplySpy,
          telegram: sendTelegram,
        },
      });
      const second = await runHeartbeatOnce({
        cfg,
        agentId: "main",
        reason: "interval",
        deps: {
          getReplyFromConfig: getReplySpy,
          telegram: sendTelegram,
        },
      });

      expect(first.status).toBe("ran");
      expect(second.status).toBe("ran");
      expect(getReplySpy).toHaveBeenCalledTimes(2);

      const firstCtx = getReplySpy.mock.calls[0]?.[0] as { Provider?: string; Body?: string };
      const secondCtx = getReplySpy.mock.calls[1]?.[0] as { Provider?: string; Body?: string };
      expect(firstCtx.Provider).toBe("cron-event");
      expect(firstCtx.Body).toContain("Cron: QMD maintenance completed");
      expect(secondCtx.Provider).toBe("heartbeat");
      expect(secondCtx.Body).toContain("Read HEARTBEAT.md");
      expect(secondCtx.Body).not.toContain("Cron: QMD maintenance completed");
    });
  });

  it("uses an internal-only cron prompt when delivery target is none", async () => {
    const { result, sendTelegram, calledCtx } = await runHeartbeatCase({
      tmpPrefix: "openclaw-cron-internal-",
      replyText: "Handled internally",
      reason: "cron:reminder-job",
      target: "none",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("Reminder: Rotate API keys", { sessionKey });
      },
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.Provider).toBe("cron-event");
    expect(calledCtx?.Body).toContain("Handle this reminder internally");
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("uses an internal-only exec prompt when delivery target is none", async () => {
    const { result, sendTelegram, calledCtx } = await runHeartbeatCase({
      tmpPrefix: "openclaw-exec-internal-",
      replyText: "Handled internally",
      reason: "exec-event",
      target: "none",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("exec finished: deploy succeeded", { sessionKey });
      },
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.Provider).toBe("exec-event");
    expect(calledCtx?.ForceSenderIsOwnerFalse).toBe(true);
    expect(calledCtx?.Body).toContain("Handle the result internally");
    expect(sendTelegram).not.toHaveBeenCalled();
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
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
          },
        }),
      );

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
        reason: "wake",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: sendTelegram,
        },
      });

      expect(result.status).toBe("ran");
      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(sendTelegram).toHaveBeenCalledWith(
        "-100155462274",
        "Restart complete",
        expect.objectContaining({ messageThreadId: 42 }),
      );
    });
  });

  it("does not reuse stale turn-source routing for isolated wake runs", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
      const cfg: OpenClawConfig = {
        agents: {
          defaults: {
            workspace: tmpDir,
            heartbeat: {
              every: "5m",
              target: "last",
              isolatedSession: true,
            },
          },
        },
        channels: { telegram: { allowFrom: ["*"] } },
        session: { store: storePath },
      };
      const sessionKey = resolveMainSessionKey(cfg);
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
            lastChannel: "telegram",
            lastTo: "-100155462274",
          },
        }),
      );

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
        reason: "wake",
        deps: {
          getReplyFromConfig: replySpy,
          telegram: sendTelegram,
        },
      });

      expect(result.status).toBe("ran");
      expect(replySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          SessionKey: `${sessionKey}:heartbeat`,
        }),
        expect.anything(),
        expect.anything(),
      );
      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(sendTelegram.mock.calls[0]?.[0]).toBe("-100155462274");
      const options = sendTelegram.mock.calls[0]?.[2] as { messageThreadId?: number } | undefined;
      expect(options?.messageThreadId).toBeUndefined();
    });
  });

  it("keeps exec-event delivery pinned to the original Telegram topic when session route drifts", async () => {
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
      await fs.writeFile(
        storePath,
        JSON.stringify({
          [sessionKey]: {
            sessionId: "sid",
            updatedAt: Date.now(),
            lastChannel: "telegram",
            lastTo: "telegram:-1003774691294:topic:2175",
            lastThreadId: 2175,
          },
        }),
      );

      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "-1003774691294",
      });
      const getReplySpy = vi.fn().mockResolvedValue({
        text: "The review-worker spawn finished successfully.",
      });
      enqueueSystemEvent("Exec completed (review-run, code 0)", {
        sessionKey,
        trusted: false,
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
      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(sendTelegram).toHaveBeenCalledWith(
        "telegram:-1003774691294:topic:47",
        "The review-worker spawn finished successfully.",
        expect.objectContaining({ messageThreadId: 47 }),
      );
    });
  });
});
