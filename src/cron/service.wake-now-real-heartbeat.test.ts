// Exercise the scheduler's active marker against the real heartbeat busy guard.
// Stubbing runHeartbeatOnce hides this cross-owner interaction.
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentMainSessionKey } from "../config/sessions.js";
import { runHeartbeatOnce, startHeartbeatRunner } from "../infra/heartbeat-runner.js";
import { installHeartbeatRunnerTestRuntime } from "../infra/heartbeat-runner.test-harness.js";
import { seedMainSessionStore } from "../infra/heartbeat-runner.test-utils.js";
import {
  getHeartbeatWakeAbortSignal,
  requestHeartbeat as queueHeartbeat,
  requestHeartbeatAndWait,
} from "../infra/heartbeat-wake.js";
import {
  enqueueSystemEventWithReceipt,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { getQueueSize } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { resetCronActiveJobs, waitForActiveCronJobs } from "./active-jobs.js";
import { CronService, type CronEvent } from "./service.js";
import type { CronServiceDeps } from "./service/state.js";

installHeartbeatRunnerTestRuntime();
beforeAll(async () => {
  // Load the real dispatch graph before this real-time scheduler fixture starts its watchdog.
  await import("../auto-reply/dispatch.js");
});
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  resetSystemEventsForTest();
  resetCronActiveJobs();
  vi.restoreAllMocks();
});

const noopLogger = { debug() {}, info() {}, warn() {}, error() {} };

function makeSandbox() {
  const dir = tempDirs.make("openclaw-cron-real-heartbeat-");
  return {
    dir,
    cronStorePath: path.join(dir, "cron", "jobs.json"),
    sessionStorePath: path.join(dir, "sessions.json"),
  };
}

type WakeNowRunMode = "direct" | "queued" | "scheduled";

async function runMainCronCase(
  mode: WakeNowRunMode,
  wakeMode: "now" | "next-heartbeat" = "now",
  options: { heartbeatEvery?: string; deleteAfterRun?: boolean; mixedExec?: boolean } = {},
) {
  const sandbox = makeSandbox();
  const wakeSignals: Array<AbortSignal | undefined> = [];
  const getReplySpy = vi.fn().mockImplementation(async (ctx: MsgContext) => {
    wakeSignals.push(getHeartbeatWakeAbortSignal());
    if (options.mixedExec && ctx.InternalTurnSource === "cron") {
      enqueueSystemEventWithReceipt("Reminder: Late arrival", {
        sessionKey: expectedMainSessionKey,
        contextKey: "cron:late-arrival",
      });
    }
    return {
      text: ctx.InternalTurnSource === "exec" ? "Command completed" : "Handled the reminder",
    };
  });
  const sendTelegram = vi.fn().mockResolvedValue({ messageId: "m1", chatId: "155462274" });
  const requestHeartbeat = vi.fn();
  let resolveFinished: ((event: CronEvent) => void) | undefined;
  const finished = new Promise<CronEvent>((resolve) => {
    resolveFinished = resolve;
  });

  const cfg: OpenClawConfig = {
    agents: {
      defaults: {
        workspace: sandbox.dir,
        heartbeat: {
          every: options.heartbeatEvery ?? "5m",
          target: "telegram",
          ...(options.mixedExec ? { to: "999999" } : {}),
        },
      },
    },
    channels: { telegram: { allowFrom: ["*"] } },
    session: { store: sandbox.sessionStorePath },
  };
  const expectedMainSessionKey = resolveAgentMainSessionKey({ cfg, agentId: "main" });
  await seedMainSessionStore(sandbox.sessionStorePath, cfg, {
    lastChannel: "telegram",
    lastProvider: "telegram",
    lastTo: "-100155462274",
  });

  const runHeartbeatOnceReal: typeof runHeartbeatOnce = (opts) =>
    runHeartbeatOnce({
      ...opts,
      cfg,
      deps: { getReplyFromConfig: getReplySpy, telegram: sendTelegram },
    });

  const heartbeatRunner = startHeartbeatRunner({ cfg, runOnce: runHeartbeatOnceReal });
  const cron = new CronService({
    storePath: sandbox.cronStorePath,
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent: (text, opts) => {
      const agentId = opts?.agentId ?? "main";
      const sessionKey = opts?.sessionKey ?? resolveAgentMainSessionKey({ cfg, agentId });
      const remove = enqueueSystemEventWithReceipt(text, {
        sessionKey,
        contextKey: opts?.contextKey,
        deliveryContext: opts?.deliveryContext,
      });
      return remove ? { accepted: true, remove } : { accepted: false };
    },
    requestHeartbeat,
    requestHeartbeatAndWait: (opts, lifecycle) => {
      const sessionKey = opts.sessionKey ?? expectedMainSessionKey;
      if (options.mixedExec) {
        enqueueSystemEventWithReceipt("Exec completed (report, code 0) :: ready", { sessionKey });
        queueHeartbeat({
          source: "exec-event",
          intent: "event",
          reason: "exec-event",
          agentId: "main",
          sessionKey,
          coalesceMs: 0,
        });
      }
      return requestHeartbeatAndWait({ ...opts, sessionKey, coalesceMs: 0 }, lifecycle);
    },
    runIsolatedAgentJob: vi.fn(async () => ({
      status: "ok",
    })) as unknown as CronServiceDeps["runIsolatedAgentJob"],
    onEvent: (event) => {
      if (event.action === "finished") {
        resolveFinished?.(event);
      }
    },
  });
  await cron.start();

  try {
    const job = await cron.add({
      enabled: true,
      name: "nightly report",
      schedule: {
        kind: "at",
        at: new Date(Date.now() + (mode === "scheduled" ? 250 : 60 * 60_000)).toISOString(),
      },
      sessionTarget: "main",
      wakeMode,
      payload: { kind: "systemEvent", text: "Reminder: Send the nightly report" },
      ...(options.deleteAfterRun === undefined ? {} : { deleteAfterRun: options.deleteAfterRun }),
    });

    if (mode === "direct") {
      await cron.run(job.id, "force");
    } else if (mode === "queued") {
      await expect(cron.enqueueRun(job.id, "force")).resolves.toMatchObject({
        ok: true,
        enqueued: true,
      });
    }

    let finishTimeout: ReturnType<typeof setTimeout> | undefined;
    const terminal = await Promise.race([
      finished,
      new Promise<never>((_, reject) => {
        finishTimeout = setTimeout(
          () => reject(new Error(`${mode} cron run did not finish`)),
          10_000,
        );
      }),
    ]).finally(() => clearTimeout(finishTimeout));
    expect(terminal.status).toBe("ok");
    if (wakeMode === "next-heartbeat") {
      expect(getReplySpy).not.toHaveBeenCalled();
      expect(requestHeartbeat).toHaveBeenCalledTimes(1);
      await expect(
        runHeartbeatOnce({
          cfg,
          source: "interval",
          intent: "scheduled",
          reason: "interval",
          agentId: "main",
          scheduledEveryMs: 5 * 60_000,
          deps: { getReplyFromConfig: getReplySpy, telegram: sendTelegram },
        }),
      ).resolves.toMatchObject({ status: "ran" });
    } else {
      expect(requestHeartbeat).not.toHaveBeenCalled();
      expect(wakeSignals[0]).toBeInstanceOf(AbortSignal);
    }
    if (options.mixedExec) {
      await vi.waitFor(() => expect(getReplySpy).toHaveBeenCalledTimes(2));
      expect(getReplySpy.mock.calls[0]?.[0].InternalTurnSource).toBe("exec");
      expect(getReplySpy.mock.calls[0]?.[0].Body).not.toContain(
        "Reminder: Send the nightly report",
      );
      expect(getReplySpy.mock.calls[1]?.[0]).toMatchObject({
        InternalTurnSource: "cron",
        SessionKey: expectedMainSessionKey,
      });
      expect(getReplySpy.mock.calls[1]?.[0].Body).toContain("Reminder: Send the nightly report");
      expect(getReplySpy.mock.calls[1]?.[0].Body).not.toContain("Exec completed");
      await vi.waitFor(() => expect(sendTelegram).toHaveBeenCalledTimes(2));
      expect(sendTelegram.mock.calls.map(([to]) => to)).toEqual(["-100155462274", "-100155462274"]);
      expect(peekSystemEventEntries(expectedMainSessionKey).map((event) => event.text)).toEqual([
        "Reminder: Late arrival",
      ]);
      expect(cron.getJob(job.id)).toBeUndefined();
      return;
    }
    expect(getReplySpy).toHaveBeenCalledTimes(1);

    const [ctx] = getReplySpy.mock.calls[0] ?? [];
    const replyCtx = ctx as Pick<
      MsgContext,
      "InternalTurnSource" | "Provider" | "SessionKey" | "Body"
    >;
    expect(replyCtx.InternalTurnSource).toBe("cron");
    expect(replyCtx.Provider).toBeUndefined();
    expect(replyCtx.SessionKey).toBe(expectedMainSessionKey);
    expect(replyCtx.Body).toContain("Reminder: Send the nightly report");
    expect(peekSystemEventEntries(expectedMainSessionKey)).toHaveLength(0);
    if (options.deleteAfterRun) {
      expect(cron.getJob(job.id)).toBeUndefined();
    }
  } finally {
    cron.stop();
    heartbeatRunner.stop();
    const drained = await waitForActiveCronJobs(5_000);
    expect(drained).toEqual({ drained: true, active: 0 });
    await vi.waitFor(() => expect(getQueueSize(CommandLane.Cron)).toBe(0), { timeout: 5_000 });
  }
}

describe("main cron with the real heartbeat runner", () => {
  it("drains coalesced cron and exec work without recurrence while retaining late arrivals", async () => {
    await runMainCronCase("scheduled", "now", {
      heartbeatEvery: "0m",
      deleteAfterRun: true,
      mixedExec: true,
    });
  });
  it("delivers during a direct manual run", async () => {
    await runMainCronCase("direct");
  });

  it("delivers before a command-lane queued run finishes", async () => {
    await runMainCronCase("queued");
  });

  it("delivers during a natural scheduled run", async () => {
    await runMainCronCase("scheduled");
  });

  it("delivers a next-heartbeat event through a later scheduled main-session heartbeat", async () => {
    await runMainCronCase("direct", "next-heartbeat");
  });

  it("delivers and removes an immediate one-shot when heartbeat cadence is disabled", async () => {
    await runMainCronCase("scheduled", "now", { heartbeatEvery: "0m", deleteAfterRun: true });
  });
});
