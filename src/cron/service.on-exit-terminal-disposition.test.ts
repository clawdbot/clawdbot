// Terminal one-shot disposition for watcher-completed on-exit jobs (#131490).
import { expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";

const noopLogger = createNoopLogger();
installCronTestHooks({ logger: noopLogger });
const { makeStorePath } = createCronStoreHarness({
  prefix: "openclaw-cron-onexit-terminal-",
});

const HARNESS_BASE_MS = Date.parse("2025-12-13T00:00:00.000Z");

async function createErroringOneShotHarness(params: {
  name: string;
  schedule?: { kind: "on-exit"; command: string } | { kind: "at"; at: string };
  bestEffort?: boolean;
  error?: string;
  executionStarted?: boolean;
}) {
  const store = await makeStorePath();
  const enqueueSystemEvent = vi.fn();
  const clock = { now: HARNESS_BASE_MS };
  const cron = new CronService({
    storePath: store.storePath,
    cronEnabled: true,
    log: noopLogger,
    nowMs: () => clock.now,
    enqueueSystemEvent,
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({
      status: "error" as const,
      error: params.error ?? "wrong model id",
      ...(params.executionStarted ? { executionStarted: true } : {}),
    })) as unknown as CronServiceDeps["runIsolatedAgentJob"],
  });
  await cron.start();
  const job = await cron.add({
    enabled: true,
    name: params.name,
    schedule: params.schedule ?? { kind: "on-exit", command: "sleep 1" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "report" },
    delivery: { mode: "announce", bestEffort: params.bestEffort },
  });
  return {
    cron,
    job,
    clock,
    getJob: async () =>
      (await cron.list({ includeDisabled: true })).find((entry) => entry.id === job.id),
    notifications: () => enqueueSystemEvent.mock.calls.map((call) => String(call[0])),
    finish: async () => {
      cron.stop();
      await store.cleanup();
    },
  };
}

it("records the terminal disposition when a watcher-completed on-exit payload fails (#131490)", async () => {
  const h = await createErroringOneShotHarness({ name: "watcher-fired on-exit" });
  // The exit watcher persists the one-shot disabled before force-running the
  // payload (persistCompletion), then fires it via cron.run(..., "force")
  // with explicit watcher-completion provenance.
  await h.cron.update(h.job.id, { enabled: false });
  await h.cron.run(h.job.id, "force", { onExitWatcherCompletion: true });

  const updated = await h.getJob();
  expect(updated?.enabled).toBe(false);
  expect(updated?.state.autoDisabled).toMatchObject({
    reason: "consecutive-failures",
    consecutiveErrors: 1,
  });
  // The announce route resolves an alert, so the first (terminal) failure
  // bypasses the default after: 2 threshold instead of parking silently.
  expect(h.notifications().some((text) => text.includes("failed 1 times"))).toBe(true);
  await h.finish();
});

it("falls back to the auto-disable notice for a best-effort watcher-completed on-exit failure (#131590)", async () => {
  const h = await createErroringOneShotHarness({
    name: "best-effort watcher-fired on-exit",
    bestEffort: true,
  });
  await h.cron.update(h.job.id, { enabled: false });
  await h.cron.run(h.job.id, "force", { onExitWatcherCompletion: true });

  const updated = await h.getJob();
  expect(updated?.state.autoDisabled).toMatchObject({ reason: "consecutive-failures" });
  expect(h.notifications().some((text) => text.includes("auto-disabled"))).toBe(true);
  await h.finish();
});

it("keeps a manually paused on-exit job out of the terminal disposition on operator force-runs", async () => {
  const h = await createErroringOneShotHarness({ name: "paused on-exit manual force" });
  // Operator pause + `automations run` without watcher provenance: the
  // failure must not convert the pause into a scheduler auto-disable.
  await h.cron.update(h.job.id, { enabled: false });
  await h.cron.run(h.job.id, "force");

  const updated = await h.getJob();
  expect(updated?.enabled).toBe(false);
  expect(updated?.state.autoDisabled).toBeUndefined();
  expect(h.notifications().some((text) => text.includes("auto-disabled"))).toBe(false);
  await h.finish();
});

it("keeps a manual force-run of a still-armed on-exit watcher out of the terminal disposition", async () => {
  const h = await createErroringOneShotHarness({ name: "armed on-exit manual force" });
  await h.cron.run(h.job.id, "force");

  // The watcher is still armed (job enabled): disabling here would tear down
  // the live watch, so the run keeps the plain preserve path.
  const updated = await h.getJob();
  expect(updated?.enabled).toBe(true);
  expect(updated?.state.autoDisabled).toBeUndefined();
  await h.finish();
});

it("records the auto-disable fact and notifies when a timed one-shot is parked after a permanent error (#131490)", async () => {
  const h = await createErroringOneShotHarness({
    name: "silently parked one-shot",
    schedule: { kind: "at", at: new Date(HARNESS_BASE_MS + 1_000).toISOString() },
    error: 'Session "agent:main:cron:job-1" changed while starting work. Retry.',
    executionStarted: true,
  });
  h.clock.now = HARNESS_BASE_MS + 2_000;
  await h.cron.run(h.job.id, "due");

  const updated = await h.getJob();
  expect(updated?.enabled).toBe(false);
  expect(updated?.state.autoDisabled).toMatchObject({
    reason: "consecutive-failures",
    consecutiveErrors: 1,
  });
  // The announce route resolves a failure alert, so the terminal disable is
  // reported through the (threshold-bypassed) alert path.
  expect(h.notifications().some((text) => text.includes("failed 1 times"))).toBe(true);
  await h.finish();
});

it("falls back to the auto-disable notice when best-effort suppresses the terminal alert (#131590)", async () => {
  const h = await createErroringOneShotHarness({
    name: "best-effort parked one-shot",
    schedule: { kind: "at", at: new Date(HARNESS_BASE_MS + 1_000).toISOString() },
    // Best-effort suppresses the inherited failure alert; the terminal
    // disable must still surface through the generic auto-disable notice.
    bestEffort: true,
  });
  h.clock.now = HARNESS_BASE_MS + 2_000;
  await h.cron.run(h.job.id, "due");

  const updated = await h.getJob();
  expect(updated?.enabled).toBe(false);
  expect(updated?.state.autoDisabled).toMatchObject({ reason: "consecutive-failures" });
  expect(h.notifications().some((text) => text.includes("auto-disabled"))).toBe(true);
  await h.finish();
});
