// Covers heartbeat handling of queued reminder system events.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drainFormattedSystemEvents } from "../auto-reply/reply/session-system-events.js";
import { getReplySystemEventContext } from "../auto-reply/reply/system-event-session-key.js";
import type { OpenClawConfig } from "../config/config.js";
import { clearCronJobActive, markCronJobActive, resetCronActiveJobs } from "../cron/active-jobs.js";
import { readHeartbeatMonitorScratch, writeCronJobScratch } from "../cron/scratch-store.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { enqueueCommandInLane, type CommandLaneTaskMarker } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
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
import { HEARTBEAT_SKIP_CRON_IN_PROGRESS } from "./heartbeat-wake.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueSystemEvent,
  enqueueSystemEventEntry,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "./system-events.js";

beforeEach(() => {
  setupTelegramHeartbeatPluginRuntimeForTests();
  resetSystemEventsForTest();
  resetCronActiveJobs();
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
    activeHours?: boolean;
  }): Promise<{ cfg: OpenClawConfig; sessionKey: string }> => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: params.tmpDir,
          heartbeat: {
            every: "5m",
            target: params.target ?? "telegram",
            ...(params.isolatedSession === true ? { isolatedSession: true } : {}),
            ...(params.activeHours === true
              ? { activeHours: { start: "08:00", end: "24:00", timezone: "user" as const } }
              : {}),
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

  const expectCronEventPrompt = (calledCtx: HeartbeatReplyContext | null, reminderText: string) => {
    expect(calledCtx?.InternalTurnSource).toBe("cron");
    if (calledCtx === null || typeof calledCtx.Body !== "string") {
      throw new Error("Expected cron event prompt body");
    }
    expect(calledCtx.Body).toContain("scheduled reminder has been triggered");
    expect(calledCtx.Body).toContain(reminderText);
    expect(calledCtx.Body).not.toContain("HEARTBEAT_OK");
    expect(calledCtx.Body).not.toContain("heartbeat poll");
  };

  const runCronReminderCase = async (
    tmpPrefix: string,
    enqueue: (sessionKey: string) => void,
  ): Promise<{
    result: Awaited<ReturnType<typeof runHeartbeatOnce>>;
    sendTelegram: ReturnType<typeof vi.fn>;
    calledCtx: HeartbeatReplyContext | null;
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
    source?: "cron";
    intent?: "immediate";
    activeCronJobId?: string;
    owningCronJobId?: string;
    replaceOwningCronMarker?: boolean;
    owningCronLaneTaskMarker?: CommandLaneTaskMarker;
    cronLaneDepth?: number;
    cronNestedLaneDepth?: number;
    activeHours?: boolean;
    nowMs?: number;
  }): Promise<{
    result: Awaited<ReturnType<typeof runHeartbeatOnce>>;
    sendTelegram: ReturnType<typeof vi.fn>;
    calledCtx: HeartbeatReplyContext | null;
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
          activeHours: params.activeHours,
        });
        params.enqueue(sessionKey);
        const owningCronJobMarker = params.owningCronJobId
          ? markCronJobActive(params.owningCronJobId)
          : undefined;
        const replacementCronJobMarker =
          params.replaceOwningCronMarker && params.owningCronJobId
            ? markCronJobActive(params.owningCronJobId)
            : undefined;
        const unrelatedCronJobMarker =
          params.activeCronJobId && params.activeCronJobId !== params.owningCronJobId
            ? markCronJobActive(params.activeCronJobId)
            : undefined;
        let result: Awaited<ReturnType<typeof runHeartbeatOnce>>;
        try {
          result = await runHeartbeatOnce({
            cfg,
            agentId: "main",
            reason: params.reason,
            source: params.source,
            intent: params.intent,
            ...(params.source ? { sessionKey } : {}),
            ...(owningCronJobMarker ? { owningCronJobMarker } : {}),
            ...(params.owningCronLaneTaskMarker
              ? { owningCronLaneTaskMarker: params.owningCronLaneTaskMarker }
              : {}),
            deps: {
              getReplyFromConfig: getReplySpy,
              telegram: sendTelegram,
              nowMs: () => params.nowMs ?? Date.now(),
              ...(params.cronLaneDepth === undefined && params.cronNestedLaneDepth === undefined
                ? {}
                : {
                    getQueueSize: (lane?: string) =>
                      lane === CommandLane.Cron
                        ? (params.cronLaneDepth ?? 0)
                        : lane === CommandLane.CronNested
                          ? (params.cronNestedLaneDepth ?? 0)
                          : 0,
                  }),
            },
          });
        } finally {
          if (params.activeCronJobId && unrelatedCronJobMarker) {
            clearCronJobActive(params.activeCronJobId, unrelatedCronJobMarker);
          }
          if (params.owningCronJobId && owningCronJobMarker) {
            if (replacementCronJobMarker) {
              clearCronJobActive(params.owningCronJobId, replacementCronJobMarker);
            }
            clearCronJobActive(params.owningCronJobId, owningCronJobMarker);
          }
        }
        const calledCtx =
          getReplySpy.mock.calls.length === 0 ? null : getFirstReplyContext(getReplySpy);
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
    expect(calledCtx?.InternalTurnSource).toBe("heartbeat");
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

  it("runs the tagged cron payload outside heartbeat active hours", async () => {
    const reminderText = "Reminder: Send the overnight report";
    const { result, sendTelegram, calledCtx, replyCallCount } = await runHeartbeatCase({
      tmpPrefix: "openclaw-cron-quiet-hours-",
      replyText: "Overnight report sent",
      reason: "cron:overnight-report",
      source: "cron",
      intent: "immediate",
      activeHours: true,
      nowMs: Date.UTC(2025, 0, 1, 7, 0, 0),
      enqueue: (sessionKey) => {
        enqueueSystemEvent(reminderText, {
          sessionKey,
          contextKey: "cron:overnight-report",
        });
      },
    });

    expect(result.status).toBe("ran");
    expect(replyCallCount).toBe(1);
    expectCronEventPrompt(calledCtx, reminderText);
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
        enqueueSystemEvent("Cron: memory maintenance completed", {
          sessionKey,
          contextKey: "cron:memory-maintenance",
        });
      },
    });
    expect(result.status).toBe("ran");
    expect(replyCallCount).toBe(1);
    expect(calledCtx?.InternalTurnSource).toBe("cron");
    expect(calledCtx?.Body).toContain("scheduled reminder has been triggered");
    expect(calledCtx?.Body).toContain("Cron: memory maintenance completed");
    expect(calledCtx?.Body).not.toContain("Read HEARTBEAT.md");
    expect(sendTelegram).toHaveBeenCalled();
  });

  it("delivers a targeted cron event while its owning job is active", async () => {
    const { result, calledCtx, sessionKey } = await runHeartbeatCase({
      tmpPrefix: "openclaw-cron-active-job-",
      replyText: "Handled the reminder",
      reason: "cron:nightly-report",
      source: "cron",
      intent: "immediate",
      activeCronJobId: "nightly-report",
      owningCronJobId: "nightly-report",
      enqueue: (key) => {
        enqueueSystemEvent("Reminder: Send the nightly report", {
          sessionKey: key,
          contextKey: "cron:nightly-report",
        });
      },
    });

    expect(result.status).toBe("ran");
    expectCronEventPrompt(calledCtx, "Reminder: Send the nightly report");
    expect(peekSystemEvents(sessionKey)).toEqual([]);
  });

  it("still blocks an owning cron wake while the nested cron lane is busy", async () => {
    const { result, replyCallCount } = await runHeartbeatCase({
      tmpPrefix: "openclaw-cron-owner-nested-lane-",
      replyText: "must not run",
      reason: "cron:nightly-report",
      source: "cron",
      intent: "immediate",
      owningCronJobId: "nightly-report",
      cronNestedLaneDepth: 1,
      enqueue: (key) => {
        enqueueSystemEvent("Reminder: Send the nightly report", {
          sessionKey: key,
          contextKey: "cron:nightly-report",
        });
      },
    });

    expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS });
    expect(replyCallCount).toBe(0);
  });

  it("still blocks an owning cron wake while unrelated cron lane work is queued", async () => {
    const { result, replyCallCount } = await runHeartbeatCase({
      tmpPrefix: "openclaw-cron-owner-unrelated-lane-",
      replyText: "must not run",
      reason: "cron:nightly-report",
      source: "cron",
      intent: "immediate",
      owningCronJobId: "nightly-report",
      cronLaneDepth: 1,
      enqueue: (key) => {
        enqueueSystemEvent("Reminder: Send the nightly report", {
          sessionKey: key,
          contextKey: "cron:nightly-report",
        });
      },
    });

    expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS });
    expect(replyCallCount).toBe(0);
  });

  it("ignores only the exact command lane task that owns the cron wake", async () => {
    await enqueueCommandInLane(CommandLane.Cron, async (owningCronLaneTaskMarker) => {
      const ownTaskOnly = await runHeartbeatCase({
        tmpPrefix: "openclaw-cron-owner-exact-lane-",
        replyText: "Handled the reminder",
        reason: "cron:nightly-report",
        source: "cron",
        intent: "immediate",
        owningCronJobId: "nightly-report",
        owningCronLaneTaskMarker,
        cronLaneDepth: 1,
        enqueue: (key) => {
          enqueueSystemEvent("Reminder: Send the nightly report", {
            sessionKey: key,
            contextKey: "cron:nightly-report",
          });
        },
      });
      expect(ownTaskOnly.result.status).toBe("ran");

      const unrelatedTaskQueued = await runHeartbeatCase({
        tmpPrefix: "openclaw-cron-owner-second-lane-",
        replyText: "must not run",
        reason: "cron:nightly-report",
        source: "cron",
        intent: "immediate",
        owningCronJobId: "nightly-report",
        owningCronLaneTaskMarker,
        cronLaneDepth: 2,
        enqueue: (key) => {
          enqueueSystemEvent("Reminder: Send the nightly report", {
            sessionKey: key,
            contextKey: "cron:nightly-report",
          });
        },
      });
      expect(unrelatedTaskQueued.result).toEqual({
        status: "skipped",
        reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS,
      });
      expect(unrelatedTaskQueued.replyCallCount).toBe(0);
    });
  });

  it("does not let a stale command lane task marker bypass cron pressure", async () => {
    let staleMarker: CommandLaneTaskMarker | undefined;
    await enqueueCommandInLane(CommandLane.Cron, async (marker) => {
      staleMarker = marker;
    });
    if (!staleMarker) {
      throw new Error("expected command lane marker");
    }

    const { result, replyCallCount } = await runHeartbeatCase({
      tmpPrefix: "openclaw-cron-owner-stale-lane-",
      replyText: "must not run",
      reason: "cron:nightly-report",
      source: "cron",
      intent: "immediate",
      owningCronJobId: "nightly-report",
      owningCronLaneTaskMarker: staleMarker,
      cronLaneDepth: 1,
      enqueue: (key) => {
        enqueueSystemEvent("Reminder: Send the nightly report", {
          sessionKey: key,
          contextKey: "cron:nightly-report",
        });
      },
    });

    expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS });
    expect(replyCallCount).toBe(0);
  });

  it("does not let a stale owner marker bypass its replacement", async () => {
    const { result, replyCallCount } = await runHeartbeatCase({
      tmpPrefix: "openclaw-cron-replaced-owner-",
      replyText: "must not run",
      reason: "cron:nightly-report",
      source: "cron",
      intent: "immediate",
      owningCronJobId: "nightly-report",
      replaceOwningCronMarker: true,
      enqueue: (key) => {
        enqueueSystemEvent("Reminder: Send the nightly report", {
          sessionKey: key,
          contextKey: "cron:nightly-report",
        });
      },
    });

    expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS });
    expect(replyCallCount).toBe(0);
  });

  it("still blocks an owning cron wake while an unrelated job is active", async () => {
    const { result, replyCallCount } = await runHeartbeatCase({
      tmpPrefix: "openclaw-cron-unrelated-active-job-",
      replyText: "must not run",
      reason: "cron:nightly-report",
      source: "cron",
      intent: "immediate",
      activeCronJobId: "different-job",
      owningCronJobId: "nightly-report",
      enqueue: (key) => {
        enqueueSystemEvent("Reminder: Send the nightly report", {
          sessionKey: key,
          contextKey: "cron:nightly-report",
        });
      },
    });

    expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS });
    expect(replyCallCount).toBe(0);
  });

  it("still blocks a cron wake that claims no owning job while a job is active", async () => {
    const { result, replyCallCount } = await runHeartbeatCase({
      tmpPrefix: "openclaw-cron-unowned-wake-",
      replyText: "must not run",
      reason: "cron:nightly-report",
      source: "cron",
      intent: "immediate",
      activeCronJobId: "nightly-report",
      enqueue: (key) => {
        enqueueSystemEvent("Reminder: Send the nightly report", {
          sessionKey: key,
          contextKey: "cron:nightly-report",
        });
      },
    });

    expect(result).toEqual({ status: "skipped", reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS });
    expect(replyCallCount).toBe(0);
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

      enqueueSystemEvent("Cron: memory maintenance completed", {
        sessionKey,
        contextKey: "cron:memory-maintenance",
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

      const firstCtx = mockCallAt(
        getReplySpy,
        0,
        "first heartbeat reply",
      )[0] as HeartbeatReplyContext;
      const secondCtx = mockCallAt(
        getReplySpy,
        1,
        "second heartbeat reply",
      )[0] as HeartbeatReplyContext;
      expect(firstCtx.InternalTurnSource).toBe("cron");
      expect(firstCtx.Body).toContain("Cron: memory maintenance completed");
      expect(secondCtx.InternalTurnSource).toBe("heartbeat");
      expect(secondCtx.Body).toContain("Heartbeat monitor scratch:");
      expect(secondCtx.Body).not.toContain("Cron: memory maintenance completed");
    });
  });

  it("retains a cron reminder until a suppressed heartbeat can actually deliver it", async () => {
    await withTempHeartbeatSandbox(async ({ tmpDir, storePath }) => {
      const { cfg, sessionKey } = await createConfig({ tmpDir, storePath });
      const reminder = "Cron: memory maintenance completed";
      const sendTelegram = vi.fn().mockResolvedValue({
        messageId: "m1",
        chatId: "155462274",
      });
      const getReplySpy = vi
        .fn()
        .mockResolvedValueOnce({ text: "No channel reply." })
        .mockResolvedValueOnce({ text: "Relay this cron update now" });

      enqueueSystemEvent(reminder, {
        sessionKey,
        contextKey: "cron:memory-maintenance",
      });

      const runOnce = async () =>
        await runHeartbeatOnce({
          cfg,
          agentId: "main",
          reason: "interval",
          deps: {
            getReplyFromConfig: getReplySpy,
            telegram: sendTelegram,
          },
        });

      expect((await runOnce()).status).toBe("ran");
      expect(sendTelegram).not.toHaveBeenCalled();
      expect(peekSystemEvents(sessionKey)).toEqual([reminder]);

      expect((await runOnce()).status).toBe("ran");
      expect(sendTelegram).toHaveBeenCalledTimes(1);
      expect(peekSystemEvents(sessionKey)).toEqual([]);
      for (const [context] of getReplySpy.mock.calls) {
        expect(context).toMatchObject({ InternalTurnSource: "cron" });
        expect(context.Body).toContain(reminder);
      }
    });
  });

  it("uses an internal-only cron prompt when delivery target is none", async () => {
    const {
      result,
      sendTelegram,
      calledCtx,
      sessionKey: processedSessionKey,
    } = await runHeartbeatCase({
      tmpPrefix: "openclaw-cron-internal-",
      replyText: "Handled internally",
      reason: "cron:reminder-job",
      target: "none",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("Reminder: Rotate API keys", { sessionKey });
      },
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.InternalTurnSource).toBe("cron");
    expect(calledCtx?.Body).toContain("Handle this reminder internally");
    expect(sendTelegram).not.toHaveBeenCalled();
    expect(peekSystemEvents(processedSessionKey)).toEqual([]);
  });

  it("uses an internal-only exec prompt when delivery target is none", async () => {
    const {
      result,
      sendTelegram,
      calledCtx,
      sessionKey: processedSessionKey,
    } = await runHeartbeatCase({
      tmpPrefix: "openclaw-exec-internal-",
      replyText: "Handled internally",
      reason: "exec-event",
      target: "none",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("exec finished: deploy succeeded", { sessionKey });
      },
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.InternalTurnSource).toBe("exec");
    expect(calledCtx?.Body).toContain("Handle the result internally");
    expect(sendTelegram).not.toHaveBeenCalled();
    expect(peekSystemEvents(processedSessionKey)).toEqual([]);
  });

  it("includes untrusted exec completion details in user-relay prompts", async () => {
    const { result, sendTelegram, calledCtx } = await runHeartbeatCase({
      tmpPrefix: "openclaw-exec-untrusted-relay-",
      replyText: "Deploy succeeded",
      reason: "exec-event",
      enqueue: (sessionKey) => {
        enqueueSystemEvent("exec finished: deploy succeeded", { sessionKey });
      },
    });

    expect(result.status).toBe("ran");
    expect(calledCtx?.InternalTurnSource).toBe("exec");
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
    expect(calledCtx?.InternalTurnSource).toBe("exec");
    expect(calledCtx?.Body).toContain("deploy succeeded");
    expect(calledCtx?.Body).not.toContain("Node connected");
    expect(peekSystemEvents(sessionKey)).toEqual(["Node connected"]);
  });

  it("ignores an acknowledged exec-event wake without consuming unrelated events", async () => {
    const { result, sendTelegram, calledCtx, replyCallCount, sessionKey } = await runHeartbeatCase({
      tmpPrefix: "openclaw-exec-acknowledged-",
      replyText: "Unexpected heartbeat",
      reason: "exec-event",
      enqueue: (key) => {
        const completion = enqueueSystemEventEntry(
          "Exec completed (abc12345, code 0) :: deploy succeeded",
          { sessionKey: key },
        );
        if (!completion) {
          throw new Error("expected exec completion event");
        }
        expect(consumeSelectedSystemEventEntries(key, [completion])).toHaveLength(1);
        enqueueSystemEvent("Node connected", { sessionKey: key });
      },
    });

    expect(result).toEqual({ status: "skipped", reason: "no-pending-event" });
    expect(replyCallCount).toBe(0);
    expect(calledCtx).toBeNull();
    expect(sendTelegram).not.toHaveBeenCalled();
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
    expect(calledCtx?.InternalTurnSource).toBe("exec");
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
    expect(calledCtx?.InternalTurnSource).toBe("heartbeat");
    expect(calledCtx?.SessionKey).toContain(":heartbeat");
    expect(sendTelegram).not.toHaveBeenCalled();
  });

  it.each([
    { name: "shared tagged noise", queue: "shared", noise: true, tagged: true, outcome: "ack" },
    {
      name: "canonical tagged noise",
      queue: "canonical",
      noise: true,
      tagged: true,
      outcome: "ack",
    },
    { name: "legacy tagged noise", queue: "legacy", noise: true, tagged: true, outcome: "ack" },
    {
      name: "shared untagged suppressed",
      queue: "shared",
      noise: false,
      tagged: false,
      outcome: "suppressed",
    },
    {
      name: "canonical untagged suppressed",
      queue: "canonical",
      noise: false,
      tagged: false,
      outcome: "suppressed",
    },
    {
      name: "legacy untagged suppressed",
      queue: "legacy",
      noise: false,
      tagged: false,
      outcome: "suppressed",
    },
    {
      name: "legacy untagged delivery failure",
      queue: "legacy",
      noise: false,
      tagged: false,
      outcome: "failed",
    },
    {
      name: "legacy tagged suppressed",
      queue: "legacy",
      noise: false,
      tagged: true,
      outcome: "suppressed",
    },
    { name: "legacy untagged busy", queue: "legacy", noise: false, tagged: false, outcome: "busy" },
    {
      name: "shared tagged noise busy",
      queue: "shared",
      noise: true,
      tagged: true,
      outcome: "busy",
    },
  ])(
    "keeps cron event consumption with its owner for $name",
    async ({ queue, noise, tagged, outcome }) => {
      await withTempHeartbeatSandbox(async ({ tmpDir, storePath, replySpy }) => {
        const { cfg, sessionKey: baseKey } = await createConfig({
          tmpDir,
          storePath,
          isolatedSession: queue !== "shared",
        });
        const canonicalKey = `${baseKey}:heartbeat`;
        const queueKey =
          queue === "shared"
            ? baseKey
            : queue === "canonical"
              ? canonicalKey
              : `${canonicalKey}:heartbeat`;
        if (queueKey !== baseKey) {
          await seedSessionStore(storePath, queueKey, {
            sessionId: "previous-cron-run",
            heartbeatIsolatedBaseSessionKey: baseKey,
          });
        }
        const cronStore = resolveCronJobsStorePathFromConfig(cfg);
        const monitor = readHeartbeatMonitorScratch(cronStore, "main");
        if (!monitor) {
          throw new Error("Expected the sandbox heartbeat monitor");
        }
        writeCronJobScratch({ storePath: cronStore, jobId: monitor.jobId, content: "" });
        const eventText = noise ? "HEARTBEAT_OK" : "Reminder: review the scheduled owner report";
        enqueueSystemEvent(eventText, {
          sessionKey: queueKey,
          ...(tagged ? { contextKey: "cron:owner-report" } : {}),
        });
        const sendTelegram = vi
          .fn()
          .mockResolvedValue({ messageId: "owner-report", chatId: "-100155462274" });
        if (outcome === "failed") {
          sendTelegram.mockRejectedValue(new Error("synthetic delivery failure"));
        }
        let formatted: string | undefined;
        replySpy.mockImplementation(async (ctx, options) => {
          const eventContext = getReplySystemEventContext(options);
          const eventKey = eventContext?.sessionKey ?? ctx.SessionKey;
          if (!eventKey) {
            throw new Error("Expected the selected event queue");
          }
          // Exercise the real admission formatter; provider execution is the injected leaf.
          formatted = await drainFormattedSystemEvents({
            cfg,
            agentId: "main",
            sessionKey: eventKey,
            isMainSession: false,
            isNewSession: false,
            events: eventContext?.events ?? [],
          });
          return {
            text:
              outcome === "suppressed"
                ? "No channel reply."
                : noise
                  ? "HEARTBEAT_OK"
                  : "Deliver the scheduled report",
          };
        });
        const runOnce = () =>
          runHeartbeatOnce({
            cfg,
            agentId: "main",
            sessionKey: queueKey,
            source: noise ? "interval" : "cron",
            reason: noise ? "interval" : "cron:owner-report",
            deps: {
              getReplyFromConfig: replySpy,
              telegram: sendTelegram,
              getQueueSize: () => (outcome === "busy" ? 1 : 0),
            },
          });
        const result = await runOnce();
        if (outcome === "busy") {
          expect(result).toMatchObject({ status: "skipped", reason: "requests-in-flight" });
          expect(replySpy).not.toHaveBeenCalled();
          expect(sendTelegram).not.toHaveBeenCalled();
          expect(peekSystemEvents(queueKey)).toEqual([eventText]);
          return;
        }
        expect(result.status).toBe(outcome === "failed" ? "failed" : "ran");
        expect(replySpy).toHaveBeenCalledTimes(1);
        expect(peekSystemEvents(queueKey)).toEqual(noise ? [] : [eventText]);
        expect(formatted ?? "").not.toContain(eventText);
        if (noise) {
          expect(await runOnce()).toMatchObject({
            status: "skipped",
            reason: "empty-heartbeat-file",
          });
          expect(replySpy).toHaveBeenCalledTimes(1);
          expect(sendTelegram).not.toHaveBeenCalled();
        } else {
          expectCronEventPrompt(getFirstReplyContext(replySpy), eventText);
          if (outcome === "failed") {
            expect(sendTelegram).toHaveBeenCalledTimes(1);
          } else {
            expect(sendTelegram).not.toHaveBeenCalled();
          }
        }
      });
    },
  );
});
