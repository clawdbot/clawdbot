import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import {
  seedMainSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
  withTempHeartbeatSandbox,
} from "./heartbeat-runner.test-utils.js";
import { enqueueSystemEvent, peekSystemEvents, resetSystemEventsForTest } from "./system-events.js";

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
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: "sid",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          ...overrides,
        },
      }),
    );
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
    isolatedSession?: boolean;
  }): Promise<{
    result: Awaited<ReturnType<typeof runHeartbeatOnce>>;
    sendTelegram: ReturnType<typeof vi.fn>;
    calledCtx: {
      Provider?: string;
      Body?: string;
      SessionKey?: string;
      ForceSenderIsOwnerFalse?: boolean;
    } | null;
    sessionKey: string;
    replyCallCount: number;
  }> => {
    return withTempHeartbeatSandbox(
      async ({ tmpDir, storePath }) => {
        const { sendTelegram, getReplySpy } = createHeartbeatDeps(params.replyText);
        const { cfg, sessionKey } = await createConfig({
          tmpDir,
          storePath,
          target: params.target,
          isolatedSession: params.isolatedSession,
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
          SessionKey?: string;
          ForceSenderIsOwnerFalse?: boolean;
        } | null;
        return {
          result,
          sendTelegram,
          calledCtx,
          sessionKey,
          replyCallCount: getReplySpy.mock.calls.length,
        };
      },
      { prefix: params.tmpPrefix },
    );
  };

  const expectUntrustedEventOwnership = async (params: {
    tmpPrefix: string;
    reason: "hook:wake" | "interval";
    isolatedSession?: boolean;
    forceSenderIsOwnerFalse: boolean;
  }): Promise<void> => {
    const { result, sendTelegram, calledCtx } = await runHeartbeatCase({
      tmpPrefix: params.tmpPrefix,
      replyText: "Handled internally",
      reason: params.reason,
      target: "none",
      isolatedSession: params.isolatedSession,
      enqueue: (sessionKey) => {
        enqueueSystemEvent("GitHub issue opened: untrusted webhook content", {
          sessionKey,
          trusted: false,
        });
      },
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.Provider).toBe("heartbeat");
    if (params.isolatedSession === true) {
      expect(calledCtx?.SessionKey).toContain(":heartbeat");
    }
    expect(calledCtx?.ForceSenderIsOwnerFalse).toBe(params.forceSenderIsOwnerFalse);
    expect(sendTelegram).not.toHaveBeenCalled();
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
        enqueueSystemEvent("exec finished: deploy succeeded", { sessionKey, trusted: false });
      },
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.Provider).toBe("exec-event");
    expect(calledCtx?.ForceSenderIsOwnerFalse).toBe(true);
    expect(calledCtx?.Body).toContain("Handle the result internally");
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("includes untrusted exec completion details in user-relay prompts", async () => {
    const { result, sendTelegram, calledCtx } = await runHeartbeatCase({
      tmpPrefix: "openclaw-exec-untrusted-relay-",
      replyText: "Deploy succeeded",
      reason: "exec-event",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("exec finished: deploy succeeded", { sessionKey, trusted: false });
      },
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.Provider).toBe("exec-event");
    expect(calledCtx?.ForceSenderIsOwnerFalse).toBe(true);
    expect(calledCtx?.Body).toContain("exec finished: deploy succeeded");
    expect(sendTelegram).toHaveBeenCalled();
  });

  it("consumes exec completion entries without dropping later generic events", async () => {
    const { result, calledCtx, sessionKey } = await runHeartbeatCase({
      tmpPrefix: "openclaw-exec-preserve-generic-",
      replyText: "Deploy succeeded",
      reason: "exec-event",
      enqueue: (key) => {
        enqueueSystemEvent("Exec finished (gateway id=abc12345, code 0)\ndeploy succeeded", {
          sessionKey: key,
        });
        enqueueSystemEvent("Node connected", { sessionKey: key });
      },
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.Provider).toBe("exec-event");
    expect(calledCtx?.Body).toContain("deploy succeeded");
    expect(calledCtx?.Body).not.toContain("Node connected");
    expect(peekSystemEvents(sessionKey)).toEqual(["Node connected"]);
  });

  it("classifies hook:wake exec completions as exec-event prompts", async () => {
    const { result, sendTelegram, calledCtx } = await runHeartbeatCase({
      tmpPrefix: "openclaw-hook-exec-",
      replyText: "Handled internally",
      reason: "hook:wake",
      target: "none",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("exec finished: webhook-triggered backup completed", { sessionKey });
      },
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.Provider).toBe("exec-event");
    expect(calledCtx?.ForceSenderIsOwnerFalse).toBe(true);
    expect(calledCtx?.Body).toContain("Handle the result internally");
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("does not classify base-session hook:wake exec completions as exec-event prompts when isolated sessions are enabled", async () => {
    const { result, sendTelegram, calledCtx } = await runHeartbeatCase({
      tmpPrefix: "openclaw-hook-exec-isolated-",
      replyText: "Handled internally",
      reason: "hook:wake",
      target: "none",
      isolatedSession: true,
      enqueue: (sessionKey) => {
        enqueueSystemEvent("exec finished: webhook-triggered backup completed", { sessionKey });
      },
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.Provider).toBe("heartbeat");
    expect(calledCtx?.SessionKey).toContain(":heartbeat");
    expect(calledCtx?.ForceSenderIsOwnerFalse).toBe(false);
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it("forces owner downgrade for untrusted hook:wake system events", async () => {
    await expectUntrustedEventOwnership({
      tmpPrefix: "openclaw-hook-untrusted-",
      reason: "hook:wake",
      forceSenderIsOwnerFalse: true,
    });
  });

  it("forces owner downgrade for untrusted interval events", async () => {
    await expectUntrustedEventOwnership({
      tmpPrefix: "openclaw-interval-untrusted-",
      reason: "interval",
      forceSenderIsOwnerFalse: true,
    });
  });

  it("does not force owner downgrade for untrusted hook:wake events with isolated sessions", async () => {
    await expectUntrustedEventOwnership({
      tmpPrefix: "openclaw-hook-untrusted-isolated-",
      reason: "hook:wake",
      isolatedSession: true,
      forceSenderIsOwnerFalse: false,
    });
  });

  it("does not force owner downgrade for isolated interval runs with only base-session untrusted events", async () => {
    await expectUntrustedEventOwnership({
      tmpPrefix: "openclaw-interval-untrusted-isolated-",
      reason: "interval",
      isolatedSession: true,
      forceSenderIsOwnerFalse: false,
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
      enqueueSystemEvent("Exec completed (review-run, code 0) :: review-worker spawn finished", {
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

      const sendTelegram = vi.fn();
      const getReplySpy = vi.fn().mockResolvedValue({
        text: "HEARTBEAT_OK",
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
      expect(getReplySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          Body: expect.stringContaining("no command output was found"),
        }),
        expect.anything(),
        expect.anything(),
      );
      expect(sendTelegram).not.toHaveBeenCalled();
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
      expect(replySpy).toHaveBeenCalledWith(
        expect.objectContaining({
          SessionKey: `${sessionKey}:heartbeat`,
          MessageThreadId: 42,
        }),
        expect.anything(),
        expect.anything(),
      );
      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(sendTelegram).toHaveBeenCalledWith(
        "-100155462274",
        "Topic heartbeat",
        expect.objectContaining({ messageThreadId: 42 }),
      );
    });
  });
});
