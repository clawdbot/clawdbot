// Exercise the scheduler's active marker against the real heartbeat busy guard.
// Stubbing runHeartbeatOnce hides this cross-owner interaction.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { runHeartbeatOnce } from "../infra/heartbeat-runner.js";
import {
  seedMainSessionStore,
  setupTelegramHeartbeatPluginRuntimeForTests,
} from "../infra/heartbeat-runner.test-utils.js";
import {
  consumeSelectedSystemEventEntries,
  enqueueSystemEventEntry,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { getQueueSize } from "../process/command-queue.js";
import { CommandLane } from "../process/lanes.js";
import { resetCronActiveJobs, waitForActiveCronJobs } from "./active-jobs.js";
import { CronService, type CronEvent } from "./service.js";
import type { CronServiceDeps } from "./service/state.js";

setupTelegramHeartbeatPluginRuntimeForTests();
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

async function runWakeNowCase(mode: WakeNowRunMode) {
  const sandbox = makeSandbox();
  const getReplySpy = vi.fn().mockResolvedValue({ text: "Handled the reminder" });
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
        heartbeat: { every: "5m", target: "telegram" },
      },
    },
    channels: { telegram: { allowFrom: ["*"] } },
    session: { store: sandbox.sessionStorePath },
  };
  await seedMainSessionStore(sandbox.sessionStorePath, cfg, {
    lastChannel: "telegram",
    lastProvider: "telegram",
    lastTo: "-100155462274",
  });

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
      const event = enqueueSystemEventEntry(text, {
        sessionKey: opts?.sessionKey as string,
        contextKey: opts?.contextKey,
        deliveryContext: opts?.deliveryContext,
      });
      return event
        ? {
            accepted: true,
            remove: () =>
              consumeSelectedSystemEventEntries(opts?.sessionKey as string, [event]).length > 0,
          }
        : { accepted: false };
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
    const job = await cron.add({
      enabled: true,
      name: "nightly report",
      schedule: {
        kind: "at",
        at: new Date(Date.now() + (mode === "scheduled" ? 250 : 60 * 60_000)).toISOString(),
      },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "Reminder: Send the nightly report" },
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
    expect(getReplySpy).toHaveBeenCalledTimes(1);
    expect(requestHeartbeat).not.toHaveBeenCalled();

    const [ctx] = getReplySpy.mock.calls[0] ?? [];
    const replyCtx = ctx as { Provider?: string; SessionKey?: string; Body?: string };
    expect(replyCtx.Provider).toBe("cron-event");
    expect(replyCtx.SessionKey).toContain(`:cron:${job.id}:run:`);
    expect(replyCtx.Body).toContain("Reminder: Send the nightly report");
  } finally {
    cron.stop();
    const drained = await waitForActiveCronJobs(5_000);
    expect(drained).toEqual({ drained: true, active: 0 });
    await vi.waitFor(() => expect(getQueueSize(CommandLane.Cron)).toBe(0), { timeout: 5_000 });
  }
}

describe("wakeMode:now main cron with the real heartbeat runner", () => {
  it("delivers during a direct manual run", async () => {
    await runWakeNowCase("direct");
  });

  it("delivers before a command-lane queued run finishes", async () => {
    await runWakeNowCase("queued");
  });

  it("delivers during a natural scheduled run", async () => {
    await runWakeNowCase("scheduled");
  });
});
