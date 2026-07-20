// One-shot main job tests cover disabling cron jobs after a single run.
import { describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_SKIP_CRON_IN_PROGRESS,
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  type HeartbeatRunResult,
} from "../infra/heartbeat-wake.js";
import {
  consumeSelectedSystemEventEntries,
  drainSystemEventEntries,
  enqueueSystemEventEntry,
  peekSystemEventEntries,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import type { CronEvent } from "./service.js";
import { CronService } from "./service.js";
import {
  createCronStoreHarness,
  createDeferred,
  createNoopLogger,
  installCronTestHooks,
} from "./service.test-harness.js";
import type { CronServiceDeps } from "./service/state.js";

const noopLogger = createNoopLogger();
installCronTestHooks({ logger: noopLogger });
const { makeStorePath } = createCronStoreHarness({
  prefix: "openclaw-cron-runs-one-shot-",
});

function expectCronRunSessionKey(value: unknown, jobId: string) {
  expect(value).toMatch(new RegExp(`^agent:main:cron:${jobId}:run:\\d+$`));
}

function createCronEventHarness() {
  const events: CronEvent[] = [];
  const waiters: Array<{
    predicate: (evt: CronEvent) => boolean;
    deferred: ReturnType<typeof createDeferred<CronEvent>>;
  }> = [];

  const onEvent = (evt: CronEvent) => {
    events.push(evt);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      const waiter = waiters[i];
      if (waiter && waiter.predicate(evt)) {
        waiters.splice(i, 1);
        waiter.deferred.resolve(evt);
      }
    }
  };

  const waitFor = (predicate: (evt: CronEvent) => boolean) => {
    for (const evt of events) {
      if (predicate(evt)) {
        return Promise.resolve(evt);
      }
    }
    const deferred = createDeferred<CronEvent>();
    waiters.push({ predicate, deferred });
    return deferred.promise;
  };

  return { onEvent, waitFor, events };
}

type CronHarnessOptions = {
  runIsolatedAgentJob?: CronServiceDeps["runIsolatedAgentJob"];
  runHeartbeatOnce?: NonNullable<CronServiceDeps["runHeartbeatOnce"]>;
  nowMs?: () => number;
  cronConfig?: CronServiceDeps["cronConfig"];
  useRemovableSystemEventQueue?: boolean;
  wakeNowHeartbeatBusyMaxWaitMs?: number;
  wakeNowHeartbeatBusyRetryDelayMs?: number;
  withEvents?: boolean;
};

async function createCronHarness(options: CronHarnessOptions = {}) {
  const store = await makeStorePath();
  const enqueueSystemEvent = options.useRemovableSystemEventQueue
    ? vi.fn((text: string, opts?: Parameters<CronServiceDeps["enqueueSystemEvent"]>[1]) => {
        if (!opts?.sessionKey) {
          throw new Error("test removable queue requires a sessionKey");
        }
        const event = enqueueSystemEventEntry(text, {
          sessionKey: opts.sessionKey,
          contextKey: opts.contextKey,
          deliveryContext: opts.deliveryContext,
        });
        return event
          ? {
              accepted: true,
              remove: () =>
                consumeSelectedSystemEventEntries(opts.sessionKey as string, [event]).length > 0,
            }
          : { accepted: false };
      })
    : vi.fn();
  const requestHeartbeat = vi.fn();
  const events = options.withEvents === false ? undefined : createCronEventHarness();

  const cron = new CronService({
    storePath: store.storePath,
    cronEnabled: true,
    log: noopLogger,
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
    ...(options.cronConfig ? { cronConfig: options.cronConfig } : {}),
    ...(options.wakeNowHeartbeatBusyMaxWaitMs !== undefined
      ? { wakeNowHeartbeatBusyMaxWaitMs: options.wakeNowHeartbeatBusyMaxWaitMs }
      : {}),
    ...(options.wakeNowHeartbeatBusyRetryDelayMs !== undefined
      ? { wakeNowHeartbeatBusyRetryDelayMs: options.wakeNowHeartbeatBusyRetryDelayMs }
      : {}),
    enqueueSystemEvent,
    requestHeartbeat,
    ...(options.runHeartbeatOnce ? { runHeartbeatOnce: options.runHeartbeatOnce } : {}),
    runIsolatedAgentJob:
      options.runIsolatedAgentJob ??
      (vi.fn(async (_params: { job: unknown; message: string }) => ({
        status: "ok",
      })) as unknown as CronServiceDeps["runIsolatedAgentJob"]),
    ...(events ? { onEvent: events.onEvent } : {}),
  });
  await cron.start();
  return { store, cron, enqueueSystemEvent, requestHeartbeat, events };
}

async function createMainOneShotHarness() {
  const harness = await createCronHarness();
  if (!harness.events) {
    throw new Error("missing event harness");
  }
  return { ...harness, events: harness.events };
}

async function createIsolatedAnnounceHarness(
  runIsolatedAgentJob: CronServiceDeps["runIsolatedAgentJob"],
) {
  const harness = await createCronHarness({
    runIsolatedAgentJob,
  });
  if (!harness.events) {
    throw new Error("missing event harness");
  }
  return { ...harness, events: harness.events };
}

async function createWakeModeNowMainHarness(options: {
  nowMs?: () => number;
  runHeartbeatOnce: NonNullable<CronServiceDeps["runHeartbeatOnce"]>;
  wakeNowHeartbeatBusyMaxWaitMs?: number;
  wakeNowHeartbeatBusyRetryDelayMs?: number;
}) {
  return createCronHarness({
    runHeartbeatOnce: options.runHeartbeatOnce,
    nowMs: options.nowMs,
    wakeNowHeartbeatBusyMaxWaitMs: options.wakeNowHeartbeatBusyMaxWaitMs,
    wakeNowHeartbeatBusyRetryDelayMs: options.wakeNowHeartbeatBusyRetryDelayMs,
    withEvents: false,
  });
}

async function addDefaultIsolatedAnnounceJob(cron: CronService, name: string) {
  const runAt = new Date("2025-12-13T00:00:01.000Z");
  const job = await cron.add({
    enabled: true,
    name,
    schedule: { kind: "at", at: runAt.toISOString() },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "do it" },
    delivery: { mode: "announce" },
  });
  return { job, runAt };
}

async function runIsolatedAnnounceJobAndWait(params: {
  cron: CronService;
  events: ReturnType<typeof createCronEventHarness>;
  name: string;
  status: "ok" | "error";
}) {
  const { job, runAt } = await addDefaultIsolatedAnnounceJob(params.cron, params.name);
  vi.setSystemTime(runAt);
  await vi.runOnlyPendingTimersAsync();
  await params.events.waitFor(
    (evt) => evt.jobId === job.id && evt.action === "finished" && evt.status === params.status,
  );
  return job;
}

async function runIsolatedAnnounceScenario(params: {
  cron: CronService;
  events: ReturnType<typeof createCronEventHarness>;
  name: string;
  status?: "ok" | "error";
}) {
  await runIsolatedAnnounceJobAndWait({
    cron: params.cron,
    events: params.events,
    name: params.name,
    status: params.status ?? "ok",
  });
}

async function addWakeModeNowMainSystemEventJob(
  cron: CronService,
  options?: { name?: string; agentId?: string; sessionKey?: string },
) {
  return cron.add({
    name: options?.name ?? "wakeMode now",
    ...(options?.agentId ? { agentId: options.agentId } : {}),
    ...(options?.sessionKey ? { sessionKey: options.sessionKey } : {}),
    enabled: true,
    schedule: { kind: "at", at: new Date(1).toISOString() },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "hello" },
  });
}

async function addMainOneShotHelloJob(
  cron: CronService,
  params: { atMs: number; name: string; deleteAfterRun?: boolean },
) {
  return cron.add({
    name: params.name,
    enabled: true,
    ...(params.deleteAfterRun === undefined ? {} : { deleteAfterRun: params.deleteAfterRun }),
    schedule: { kind: "at", at: new Date(params.atMs).toISOString() },
    sessionTarget: "main",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "hello" },
  });
}

function expectMainSystemEventPosted(
  enqueueSystemEvent: ReturnType<typeof vi.fn>,
  params: { text: string; jobId: string },
) {
  const matchingCall = enqueueSystemEvent.mock.calls.find(([text]) => text === params.text);
  if (!matchingCall) {
    throw new Error(`missing system event ${params.text}`);
  }
  const options = matchingCall[1] as Record<string, unknown>;
  expect(options).toMatchObject({
    agentId: undefined,
    contextKey: `cron:${params.jobId}`,
  });
  expectCronRunSessionKey(options.sessionKey, params.jobId);
}

function expectQueuedCronHeartbeat(
  requestHeartbeat: ReturnType<typeof vi.fn>,
  params: { jobId: string },
) {
  const request = requestHeartbeat.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
  expect(request).toMatchObject({
    source: "cron",
    intent: "immediate",
    reason: `cron:${params.jobId}`,
    agentId: undefined,
    heartbeat: { target: "last" },
  });
  expectCronRunSessionKey(request?.sessionKey, params.jobId);
}

function getPostedSystemEventSessionKeys(enqueueSystemEvent: ReturnType<typeof vi.fn>) {
  return enqueueSystemEvent.mock.calls
    .map(([, options]) => (options as { sessionKey?: string } | undefined)?.sessionKey)
    .filter((sessionKey): sessionKey is string => Boolean(sessionKey));
}

function expectNoQueuedEvents(sessionKeys: readonly string[]) {
  for (const sessionKey of sessionKeys) {
    expect(peekSystemEventEntries(sessionKey)).toHaveLength(0);
  }
}

async function stopCronAndCleanup(cron: CronService, store: { cleanup: () => Promise<void> }) {
  await cron.status();
  cron.stop();
  await store.cleanup();
  resetSystemEventsForTest();
}

function createStartedCronService(
  storePath: string,
  runIsolatedAgentJob?: CronServiceDeps["runIsolatedAgentJob"],
) {
  return new CronService({
    storePath,
    cronEnabled: true,
    log: noopLogger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: runIsolatedAgentJob ?? vi.fn(async () => ({ status: "ok" as const })),
  });
}

async function createMainOneShotJobHarness(params: { name: string; deleteAfterRun?: boolean }) {
  const harness = await createMainOneShotHarness();
  const atMs = Date.parse("2025-12-13T00:00:02.000Z");
  const job = await addMainOneShotHelloJob(harness.cron, {
    atMs,
    name: params.name,
    deleteAfterRun: params.deleteAfterRun,
  });
  return { ...harness, atMs, job };
}

async function expectNoMainSummaryForIsolatedRun(params: {
  runIsolatedAgentJob: CronServiceDeps["runIsolatedAgentJob"];
  name: string;
}) {
  const { store, cron, enqueueSystemEvent, requestHeartbeat, events } =
    await createIsolatedAnnounceHarness(params.runIsolatedAgentJob);
  await runIsolatedAnnounceScenario({
    cron,
    events,
    name: params.name,
  });
  expect(enqueueSystemEvent).not.toHaveBeenCalled();
  expect(requestHeartbeat).not.toHaveBeenCalled();
  await stopCronAndCleanup(cron, store);
}

describe("CronService", () => {
  it("runs a one-shot main job and disables it after success when requested", async () => {
    const { store, cron, enqueueSystemEvent, requestHeartbeat, events, atMs, job } =
      await createMainOneShotJobHarness({
        name: "one-shot hello",
        deleteAfterRun: false,
      });

    expect(job.state.nextRunAtMs).toBe(atMs);

    vi.setSystemTime(new Date("2025-12-13T00:00:02.000Z"));
    await vi.runOnlyPendingTimersAsync();
    await events.waitFor((evt) => evt.jobId === job.id && evt.action === "finished");

    const jobs = await cron.list({ includeDisabled: true });
    const updated = jobs.find((j) => j.id === job.id);
    expect(updated?.enabled).toBe(false);
    expectMainSystemEventPosted(enqueueSystemEvent, { text: "hello", jobId: job.id });
    expect(requestHeartbeat).toHaveBeenCalled();

    await cron.list({ includeDisabled: true });
    await stopCronAndCleanup(cron, store);
  });

  it("runs a one-shot job and deletes it after success by default", async () => {
    const { store, cron, enqueueSystemEvent, requestHeartbeat, events, job } =
      await createMainOneShotJobHarness({
        name: "one-shot delete",
      });

    vi.setSystemTime(new Date("2025-12-13T00:00:02.000Z"));
    await vi.runOnlyPendingTimersAsync();
    await events.waitFor((evt) => evt.jobId === job.id && evt.action === "removed");

    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs.find((j) => j.id === job.id)).toBeUndefined();
    expectMainSystemEventPosted(enqueueSystemEvent, { text: "hello", jobId: job.id });
    expect(requestHeartbeat).toHaveBeenCalled();

    await stopCronAndCleanup(cron, store);
  });

  it("deletes a recurring job converted to at when retention is omitted", async () => {
    const { store, cron, events } = await createMainOneShotHarness();
    const job = await cron.add({
      name: "converted one-shot delete",
      enabled: true,
      deleteAfterRun: false,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "converted" },
    });
    const atMs = Date.parse("2025-12-13T00:00:02.000Z");

    const updated = await cron.update(job.id, {
      schedule: { kind: "at", at: new Date(atMs).toISOString() },
    });
    expect(updated.deleteAfterRun).toBe(true);

    vi.setSystemTime(atMs);
    await vi.runOnlyPendingTimersAsync();
    await events.waitFor((evt) => evt.jobId === job.id && evt.action === "removed");

    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs.find((candidate) => candidate.id === job.id)).toBeUndefined();
    await stopCronAndCleanup(cron, store);
  });

  it("keeps a recurring job converted to at when explicitly requested", async () => {
    const { store, cron, events } = await createMainOneShotHarness();
    const job = await cron.add({
      name: "converted one-shot keep",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "converted" },
    });
    const atMs = Date.parse("2025-12-13T00:00:02.000Z");

    const updated = await cron.update(job.id, {
      schedule: { kind: "at", at: new Date(atMs).toISOString() },
      deleteAfterRun: false,
    });
    expect(updated.deleteAfterRun).toBe(false);

    vi.setSystemTime(atMs);
    await vi.runOnlyPendingTimersAsync();
    await events.waitFor((evt) => evt.jobId === job.id && evt.action === "finished");

    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs.find((candidate) => candidate.id === job.id)?.enabled).toBe(false);
    await stopCronAndCleanup(cron, store);
  });

  it("wakeMode now waits for heartbeat completion when available", async () => {
    let now = 0;
    const nowMs = () => {
      now += 10;
      return now;
    };

    const heartbeatStarted = createDeferred<void>();
    let resolveHeartbeat: ((res: HeartbeatRunResult) => void) | null = null;
    const runHeartbeatOnce = vi.fn(async () => {
      heartbeatStarted.resolve();
      return await new Promise<HeartbeatRunResult>((resolve) => {
        resolveHeartbeat = resolve;
      });
    });

    const { store, cron, enqueueSystemEvent, requestHeartbeat } =
      await createWakeModeNowMainHarness({
        runHeartbeatOnce,
        nowMs,
      });
    const job = await addWakeModeNowMainSystemEventJob(cron, { name: "wakeMode now waits" });

    const runPromise = cron.run(job.id, "force");
    await heartbeatStarted.promise;

    expect(runHeartbeatOnce).toHaveBeenCalledTimes(1);
    expect(requestHeartbeat).not.toHaveBeenCalled();
    expectMainSystemEventPosted(enqueueSystemEvent, { text: "hello", jobId: job.id });
    const running = (await cron.list({ includeDisabled: true })).find(
      (entry) => entry.id === job.id,
    );
    expect(running?.state.runningAtMs).toBeTypeOf("number");

    if (typeof resolveHeartbeat === "function") {
      (resolveHeartbeat as (res: HeartbeatRunResult) => void)({ status: "ran", durationMs: 123 });
    }
    await runPromise;

    await stopCronAndCleanup(cron, store);
  });

  it("rejects sessionTarget main for non-default agents at creation time", async () => {
    const runHeartbeatOnce = vi.fn(async () => ({ status: "ran" as const, durationMs: 1 }));

    const { store, cron } = await createWakeModeNowMainHarness({
      runHeartbeatOnce,
      wakeNowHeartbeatBusyMaxWaitMs: 1,
      wakeNowHeartbeatBusyRetryDelayMs: 2,
    });

    await expect(
      addWakeModeNowMainSystemEventJob(cron, {
        name: "wakeMode now with agent",
        agentId: "ops",
      }),
    ).rejects.toThrow('cron: sessionTarget "main" is only valid for the default agent');

    await stopCronAndCleanup(cron, store);
  });

  it("wakeMode now falls back to queued heartbeat when main lane stays busy", async () => {
    const runHeartbeatOnce = vi.fn(async () => ({
      status: "skipped" as const,
      reason: HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
    }));
    let now = 0;
    const nowMs = () => {
      now += 10;
      return now;
    };

    const { store, cron, requestHeartbeat } = await createWakeModeNowMainHarness({
      runHeartbeatOnce,
      nowMs,
      // Perf: avoid advancing fake timers by 2+ minutes for the busy-heartbeat fallback.
      wakeNowHeartbeatBusyMaxWaitMs: 1,
      wakeNowHeartbeatBusyRetryDelayMs: 2,
    });

    const sessionKey = "agent:main:discord:channel:ops";
    const job = await addWakeModeNowMainSystemEventJob(cron, {
      name: "wakeMode now fallback",
      sessionKey,
    });

    await cron.run(job.id, "force");

    expect(runHeartbeatOnce).toHaveBeenCalled();
    expectQueuedCronHeartbeat(requestHeartbeat, { jobId: job.id });
    await stopCronAndCleanup(cron, store);
  });

  it("wakeMode now queues heartbeat when cron active marker blocks synchronous wake", async () => {
    const runHeartbeatOnce = vi.fn(async () => ({
      status: "skipped" as const,
      reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS,
    }));

    const { store, cron, requestHeartbeat } = await createWakeModeNowMainHarness({
      runHeartbeatOnce,
    });

    const sessionKey = "agent:main:discord:channel:ops";
    const job = await addWakeModeNowMainSystemEventJob(cron, {
      name: "wakeMode now cron marker fallback",
      sessionKey,
    });

    await cron.run(job.id, "force");

    expect(runHeartbeatOnce).toHaveBeenCalledTimes(1);
    expectQueuedCronHeartbeat(requestHeartbeat, { jobId: job.id });
    await stopCronAndCleanup(cron, store);
  });

  it("retries disabled one-shot main wakes without leaving failed-attempt system events", async () => {
    resetSystemEventsForTest();
    const atMs = Date.parse("2025-12-13T00:00:02.000Z");
    let now = atMs;
    const consumedTexts: string[] = [];
    const runHeartbeatOnce = vi.fn(
      async (opts?: Parameters<NonNullable<CronServiceDeps["runHeartbeatOnce"]>>[0]) => {
        if (runHeartbeatOnce.mock.calls.length < 3) {
          return { status: "skipped" as const, reason: "disabled" };
        }
        const sessionKey = opts?.sessionKey;
        if (sessionKey) {
          consumedTexts.push(...drainSystemEventEntries(sessionKey).map((event) => event.text));
        }
        return { status: "ran" as const, durationMs: 1 };
      },
    );
    const { store, cron, enqueueSystemEvent, requestHeartbeat } = await createCronHarness({
      runHeartbeatOnce,
      nowMs: () => now,
      useRemovableSystemEventQueue: true,
      withEvents: false,
    });
    const job = await addMainOneShotHelloJob(cron, {
      atMs,
      name: "one-shot disabled heartbeat retries cleanly",
    });

    await cron.run(job.id, "due");
    let jobs = await cron.list({ includeDisabled: true });
    let updated = jobs.find((j) => j.id === job.id);
    expect(updated?.enabled).toBe(true);
    expect(updated?.state.lastStatus).toBe("skipped");
    expect(updated?.state.lastError).toBe("disabled");
    expect(updated?.state.consecutiveSkipped).toBe(1);
    expect(updated?.state.nextRunAtMs).toBe(atMs + 30_000);
    expectNoQueuedEvents(getPostedSystemEventSessionKeys(enqueueSystemEvent));

    now = updated?.state.nextRunAtMs ?? now;
    await cron.run(job.id, "due");
    jobs = await cron.list({ includeDisabled: true });
    updated = jobs.find((j) => j.id === job.id);
    expect(updated?.enabled).toBe(true);
    expect(updated?.state.consecutiveSkipped).toBe(2);
    expect(updated?.state.nextRunAtMs).toBe(atMs + 90_000);
    expectNoQueuedEvents(getPostedSystemEventSessionKeys(enqueueSystemEvent));

    now = updated?.state.nextRunAtMs ?? now;
    await cron.run(job.id, "due");

    jobs = await cron.list({ includeDisabled: true });
    expect(jobs.find((j) => j.id === job.id)).toBeUndefined();
    expect(runHeartbeatOnce).toHaveBeenCalledTimes(3);
    expect(requestHeartbeat).not.toHaveBeenCalled();
    expect(consumedTexts).toEqual(["hello"]);
    expectNoQueuedEvents(getPostedSystemEventSessionKeys(enqueueSystemEvent));

    await stopCronAndCleanup(cron, store);
  });

  it("runs an isolated job without posting a fallback summary to main", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const, summary: "done" }));
    const { store, cron, enqueueSystemEvent, requestHeartbeat, events } =
      await createIsolatedAnnounceHarness(runIsolatedAgentJob);
    await runIsolatedAnnounceScenario({ cron, events, name: "weekly" });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
    await stopCronAndCleanup(cron, store);
  });

  it("does not post isolated summary to main when run already delivered output", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      delivered: true,
    }));
    await expectNoMainSummaryForIsolatedRun({
      runIsolatedAgentJob,
      name: "weekly delivered",
    });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
  });

  it("does not post isolated summary to main when announce delivery was attempted", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "ok" as const,
      summary: "done",
      delivered: false,
      deliveryAttempted: true,
    }));
    await expectNoMainSummaryForIsolatedRun({
      runIsolatedAgentJob,
      name: "weekly attempted",
    });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
  });

  it("does not post a fallback main summary when an isolated job errors", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      summary: "last output",
      error: "boom",
    }));
    const { store, cron, enqueueSystemEvent, requestHeartbeat, events } =
      await createIsolatedAnnounceHarness(runIsolatedAgentJob);
    await runIsolatedAnnounceJobAndWait({
      cron,
      events,
      name: "isolated error test",
      status: "error",
    });

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
    await stopCronAndCleanup(cron, store);
  });

  it("retries one-shot lifecycle claim conflicts instead of disabling the job (#106875)", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error:
        'CronSessionLifecycleClaimError: Session "agent:main:cron:job-1" changed while starting work. Retry.',
    }));
    const { store, cron, events } = await createIsolatedAnnounceHarness(runIsolatedAgentJob);
    const job = await runIsolatedAnnounceJobAndWait({
      cron,
      events,
      name: "one-shot lifecycle claim retry",
      status: "error",
    });

    const updated = (await cron.list({ includeDisabled: true })).find(
      (entry) => entry.id === job.id,
    );
    expect(updated?.enabled).toBe(true);
    expect(updated?.state.consecutiveErrors).toBe(1);
    expect(updated?.state.nextRunAtMs).toBeTypeOf("number");

    await stopCronAndCleanup(cron, store);
  });

  it("does not retry a lifecycle claim conflict after agent execution starts (#108428)", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      error:
        'CronSessionLifecycleClaimError: Session "agent:main:cron:job-1" changed while starting work. Retry.',
      executionStarted: true,
    }));
    const { store, cron, events } = await createIsolatedAnnounceHarness(runIsolatedAgentJob);
    const job = await runIsolatedAnnounceJobAndWait({
      cron,
      events,
      name: "post-execution lifecycle claim conflict",
      status: "error",
    });

    const updated = (await cron.list({ includeDisabled: true })).find(
      (entry) => entry.id === job.id,
    );
    expect(updated?.enabled).toBe(false);
    expect(updated?.state.consecutiveErrors).toBe(1);
    expect(updated?.state.nextRunAtMs).toBeUndefined();

    await stopCronAndCleanup(cron, store);
  });

  it("does not post fallback main summary for isolated delivery-target errors", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      summary: "last output",
      error: "Channel is required when multiple channels are configured: telegram, discord",
      errorKind: "delivery-target" as const,
    }));
    const { store, cron, enqueueSystemEvent, requestHeartbeat, events } =
      await createIsolatedAnnounceHarness(runIsolatedAgentJob);
    await runIsolatedAnnounceJobAndWait({
      cron,
      events,
      name: "isolated delivery target error test",
      status: "error",
    });

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeat).not.toHaveBeenCalled();
    await stopCronAndCleanup(cron, store);
  });

  it("rejects unsupported session/payload combinations", async () => {
    const store = await makeStorePath();

    const cron = createStartedCronService(
      store.storePath,
      vi.fn(async (_params: { job: unknown; message: string }) => ({
        status: "ok" as const,
      })) as unknown as CronServiceDeps["runIsolatedAgentJob"],
    );

    await cron.start();

    await expect(
      cron.add({
        name: "bad combo (main/agentTurn)",
        enabled: true,
        schedule: { kind: "every", everyMs: 1000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "nope" },
      }),
    ).rejects.toThrow(/main cron jobs require/);

    await expect(
      cron.add({
        name: "bad combo (isolated/systemEvent)",
        enabled: true,
        schedule: { kind: "every", everyMs: 1000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "nope" },
      }),
    ).rejects.toThrow(/isolated.*cron jobs require/);

    await stopCronAndCleanup(cron, store);
  });
});
