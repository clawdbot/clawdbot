// Exercise the scheduler's active marker against the real heartbeat busy guard.
// Stubbing runHeartbeatOnce hides this cross-owner interaction.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createHeartbeatToolResponsePayload } from "../auto-reply/heartbeat-tool-response.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentMainSessionKey } from "../config/sessions.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { runHeartbeatOnce } from "../infra/heartbeat-runner.js";
import {
  seedMainSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
} from "../infra/heartbeat-runner.test-utils.js";
import { setHeartbeatsEnabled } from "../infra/heartbeat-wake.js";
import {
  enqueueSystemEventWithReceipt,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { getQueueSize } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { resetCronActiveJobs, waitForActiveCronJobs } from "./active-jobs.js";
import { CronService, type CronEvent } from "./service.js";
import type { CronServiceDeps } from "./service/state.js";
import { loadCronJobsStoreSync } from "./store.js";

setupTelegramHeartbeatPluginRuntimeForTests();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  setHeartbeatsEnabled(true);
  resetSystemEventsForTest();
  resetCronActiveJobs();
  closeOpenClawAgentDatabasesForTest();
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
  options: {
    heartbeatEvery?: string;
    deleteAfterRun?: boolean;
    heartbeatPaused?: boolean;
    disableBeforeRun?: boolean;
    scheduleKind?: "at" | "every";
    isolatedHeartbeat?: boolean;
    mainSessionKey?: string;
    seedMainSession?: boolean;
    heartbeatResponse?: ReturnType<typeof createHeartbeatToolResponsePayload>;
  } = {},
) {
  const sandbox = makeSandbox();
  const getReplySpy = vi
    .fn()
    .mockResolvedValue(options.heartbeatResponse ?? { text: "Handled the reminder" });
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
          ...(options.isolatedHeartbeat ? { isolatedSession: true } : {}),
        },
      },
    },
    channels: { telegram: { allowFrom: ["*"] } },
    session: {
      store: sandbox.sessionStorePath,
      ...(options.mainSessionKey ? { mainKey: options.mainSessionKey } : {}),
    },
  };
  const expectedMainSessionKey = resolveAgentMainSessionKey({ cfg, agentId: "main" });
  if (options.seedMainSession !== false) {
    await seedMainSessionStore(sandbox.sessionStorePath, cfg, {
      lastChannel: "telegram",
      lastProvider: "telegram",
      lastTo: "-100155462274",
    });
  }

  const runHeartbeatOnceReal: NonNullable<CronServiceDeps["runHeartbeatOnce"]> = (opts) =>
    runHeartbeatOnce({
      ...opts,
      cfg,
      deps: { getReplyFromConfig: getReplySpy, telegram: sendTelegram },
    });

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
    runHeartbeatOnce: runHeartbeatOnceReal,
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
    if (options.heartbeatPaused) {
      setHeartbeatsEnabled(false);
    }
    const job = await cron.add({
      enabled: true,
      name: "nightly report",
      schedule:
        options.scheduleKind === "every"
          ? { kind: "every", everyMs: 60 * 60_000 }
          : {
              kind: "at",
              at: new Date(Date.now() + (mode === "scheduled" ? 250 : 60 * 60_000)).toISOString(),
            },
      sessionTarget: "main",
      wakeMode,
      payload: { kind: "systemEvent", text: "Reminder: Send the nightly report" },
      ...(options.deleteAfterRun === undefined ? {} : { deleteAfterRun: options.deleteAfterRun }),
    });
    const scheduledNextRunAtMs = job.state.nextRunAtMs;
    if (options.disableBeforeRun) {
      const disabled = await cron.update(job.id, { enabled: false });
      expect(disabled.enabled).toBe(false);
      expect(disabled.state.nextRunAtMs).toBeUndefined();
    }

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
    if (options.heartbeatPaused) {
      expect(terminal).toMatchObject({ status: "skipped", error: "disabled" });
      expect(getReplySpy).not.toHaveBeenCalled();
      expect(sendTelegram).not.toHaveBeenCalled();
      expect(requestHeartbeat).not.toHaveBeenCalled();
      expect(peekSystemEventEntries(expectedMainSessionKey)).toHaveLength(0);

      const expectedNextRunAtMs = options.disableBeforeRun
        ? undefined
        : mode === "scheduled"
          ? terminal.runAtMs! + terminal.durationMs! + 30_000
          : scheduledNextRunAtMs;
      const persisted = loadCronJobsStoreSync(sandbox.cronStorePath).jobs.find(
        (entry) => entry.id === job.id,
      );
      for (const completed of [cron.getJob(job.id), persisted, terminal.job]) {
        expect(completed).toMatchObject({
          enabled: !options.disableBeforeRun,
          state: { lastRunStatus: "skipped", lastError: "disabled", consecutiveSkipped: 1 },
        });
        expect(completed?.state.nextRunAtMs).toBe(expectedNextRunAtMs);
      }
      expect(terminal.nextRunAtMs).toBe(expectedNextRunAtMs);
      return { expectedMainSessionKey, sandbox, terminal };
    }
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
    }
    expect(getReplySpy).toHaveBeenCalledTimes(1);

    const [ctx] = getReplySpy.mock.calls[0] ?? [];
    const replyCtx = ctx as Pick<
      MsgContext,
      "InternalTurnSource" | "Provider" | "SessionKey" | "Body"
    >;
    expect(replyCtx.InternalTurnSource).toBe("cron");
    expect(replyCtx.Provider).toBeUndefined();
    expect(replyCtx.SessionKey).toBe(
      options.isolatedHeartbeat ? `${expectedMainSessionKey}:heartbeat` : expectedMainSessionKey,
    );
    expect(replyCtx.Body).toContain("Reminder: Send the nightly report");
    expect(peekSystemEventEntries(expectedMainSessionKey)).toHaveLength(0);
    if (options.deleteAfterRun) {
      expect(cron.getJob(job.id)).toBeUndefined();
    }
    return { expectedMainSessionKey, sandbox, terminal };
  } finally {
    cron.stop();
    const drained = await waitForActiveCronJobs(5_000);
    expect(drained).toEqual({ drained: true, active: 0 });
    await vi.waitFor(() => expect(getQueueSize(CommandLane.Cron)).toBe(0), { timeout: 5_000 });
  }
}

describe("main cron with the real heartbeat runner", () => {
  it.each([
    { mode: "direct", scheduleKind: "at" },
    { mode: "queued", scheduleKind: "at" },
    { mode: "direct", scheduleKind: "every" },
    { mode: "queued", scheduleKind: "every" },
  ] as const)(
    "keeps an operator-disabled $scheduleKind job disabled after a $mode force run while heartbeats are globally paused",
    async ({ mode, scheduleKind }) => {
      await runMainCronCase(mode, "now", {
        heartbeatPaused: true,
        disableBeforeRun: true,
        scheduleKind,
        deleteAfterRun: false,
      });
    },
  );

  it.each(["direct", "queued", "scheduled"] as const)(
    "preserves an enabled one-shot's schedule policy after a %s run while heartbeats are globally paused",
    async (mode) => {
      await runMainCronCase(mode, "now", { heartbeatPaused: true, deleteAfterRun: false });
    },
  );

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

  it("keeps a transient isolated heartbeat successful without creating an orphan outcome", async () => {
    const result = await runMainCronCase("direct", "now", {
      isolatedHeartbeat: true,
      mainSessionKey: "cron:job:run:transient",
      seedMainSession: false,
      heartbeatResponse: createHeartbeatToolResponsePayload({
        outcome: "progress",
        notify: false,
        summary: "Transient heartbeat completed",
      }),
    });
    if (!result) {
      throw new Error("expected completed cron run");
    }
    const sessionKey = result.expectedMainSessionKey;
    const db = openOpenClawAgentDatabase(
      toDatabaseOptions(
        resolveSqliteScope({
          agentId: "main",
          sessionKey,
          storePath: result?.sandbox.sessionStorePath,
        }),
      ),
    ).db;

    expect(result.terminal.status).toBe("ok");
    expect(
      db.prepare("SELECT session_key FROM session_nodes WHERE session_key = ?").get(sessionKey),
    ).toBeUndefined();
    expect(
      db
        .prepare("SELECT session_key FROM session_nodes WHERE session_key = ?")
        .get(`${sessionKey}:heartbeat`),
    ).toEqual({ session_key: `${sessionKey}:heartbeat` });
    expect(db.prepare("SELECT COUNT(*) AS count FROM heartbeat_outcomes").get()).toEqual({
      count: 0,
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
