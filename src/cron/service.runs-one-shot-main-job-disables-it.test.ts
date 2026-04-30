import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  HEARTBEAT_SKIP_CRON_IN_PROGRESS,
  HEARTBEAT_SKIP_REQUESTS_IN_FLIGHT,
  type HeartbeatRunResult,
} from "../infra/heartbeat-wake.js";
import type { CronEvent, CronServiceDeps } from "./service.js";
import { CronService } from "./service.js";
import { createDeferred, createNoopLogger, installCronTestHooks } from "./service.test-harness.js";

const noopLogger = createNoopLogger();
installCronTestHooks({ logger: noopLogger });

type FakeFsEntry =
  | { kind: "file"; content: string; mtimeMs: number }
  | { kind: "dir"; mtimeMs: number };

const fsState = vi.hoisted(() => ({
  entries: new Map<string, FakeFsEntry>(),
  nowMs: 0,
  fixtureCount: 0,
}));

const abs = (p: string) => path.resolve(p);
const fixturesRoot = abs(path.join("__openclaw_vitest__", "cron", "runs-one-shot"));
const isFixturePath = (p: string) => {
  const resolved = abs(p);
  const rootPrefix = `${fixturesRoot}${path.sep}`;
  return resolved === fixturesRoot || resolved.startsWith(rootPrefix);
};

function bumpMtimeMs() {
  fsState.nowMs += 1;
  return fsState.nowMs;
}

function ensureDir(dirPath: string) {
  let current = abs(dirPath);
  while (true) {
    if (!fsState.entries.has(current)) {
      fsState.entries.set(current, { kind: "dir", mtimeMs: bumpMtimeMs() });
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
}

function setFile(filePath: string, content: string) {
  const resolved = abs(filePath);
  ensureDir(path.dirname(resolved));
  fsState.entries.set(resolved, { kind: "file", content, mtimeMs: bumpMtimeMs() });
}

async function makeStorePath() {
  const dir = path.join(fixturesRoot, `case-${fsState.fixtureCount++}`);
  ensureDir(dir);
  const storePath = path.join(dir, "cron", "jobs.json");
  ensureDir(path.dirname(storePath));
  return { storePath, cleanup: async () => {} };
}

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  const pathMod = await import("node:path");
  const absInMock = (p: string) => pathMod.resolve(p);
  const isFixtureInMock = (p: string) => {
    const resolved = absInMock(p);
    const rootPrefix = `${absInMock(fixturesRoot)}${pathMod.sep}`;
    return resolved === absInMock(fixturesRoot) || resolved.startsWith(rootPrefix);
  };

  const mkErr = (code: string, message: string) => Object.assign(new Error(message), { code });

  const promises = {
    ...actual.promises,
    mkdir: async (p: string) => {
      if (!isFixtureInMock(p)) {
        return await actual.promises.mkdir(p, { recursive: true });
      }
      ensureDir(p);
      return undefined;
    },
    readFile: async (p: string) => {
      if (!isFixtureInMock(p)) {
        return await actual.promises.readFile(p, "utf-8");
      }
      const entry = fsState.entries.get(absInMock(p));
      if (!entry || entry.kind !== "file") {
        throw mkErr("ENOENT", `ENOENT: no such file or directory, open '${p}'`);
      }
      return entry.content;
    },
    writeFile: async (p: string, data: string | Uint8Array) => {
      if (!isFixtureInMock(p)) {
        return await actual.promises.writeFile(p, data, "utf-8");
      }
      const content = typeof data === "string" ? data : Buffer.from(data).toString("utf-8");
      setFile(p, content);
    },
    rename: async (from: string, to: string) => {
      if (!isFixtureInMock(from) || !isFixtureInMock(to)) {
        return await actual.promises.rename(from, to);
      }
      const fromAbs = absInMock(from);
      const toAbs = absInMock(to);
      const entry = fsState.entries.get(fromAbs);
      if (!entry || entry.kind !== "file") {
        throw mkErr("ENOENT", `ENOENT: no such file or directory, rename '${from}' -> '${to}'`);
      }
      ensureDir(pathMod.dirname(toAbs));
      fsState.entries.delete(fromAbs);
      fsState.entries.set(toAbs, { ...entry, mtimeMs: bumpMtimeMs() });
    },
    copyFile: async (from: string, to: string) => {
      if (!isFixtureInMock(from) || !isFixtureInMock(to)) {
        return await actual.promises.copyFile(from, to);
      }
      const entry = fsState.entries.get(absInMock(from));
      if (!entry || entry.kind !== "file") {
        throw mkErr("ENOENT", `ENOENT: no such file or directory, copyfile '${from}' -> '${to}'`);
      }
      setFile(to, entry.content);
    },
    stat: async (p: string) => {
      if (!isFixtureInMock(p)) {
        return await actual.promises.stat(p);
      }
      const entry = fsState.entries.get(absInMock(p));
      if (!entry) {
        throw mkErr("ENOENT", `ENOENT: no such file or directory, stat '${p}'`);
      }
      return {
        mtimeMs: entry.mtimeMs,
        isDirectory: () => entry.kind === "dir",
        isFile: () => entry.kind === "file",
      };
    },
    access: async (p: string) => {
      if (!isFixtureInMock(p)) {
        return await actual.promises.access(p);
      }
      const entry = fsState.entries.get(absInMock(p));
      if (!entry) {
        throw mkErr("ENOENT", `ENOENT: no such file or directory, access '${p}'`);
      }
    },
    unlink: async (p: string) => {
      if (!isFixtureInMock(p)) {
        return await actual.promises.unlink(p);
      }
      fsState.entries.delete(absInMock(p));
    },
  } as unknown as typeof actual.promises;

  const wrapped = { ...actual, promises };
  return { ...wrapped, default: wrapped };
});

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const wrapped = {
    ...actual,
    mkdir: async (p: string, _opts?: unknown) => {
      if (!isFixturePath(p)) {
        return await actual.mkdir(p, { recursive: true });
      }
      ensureDir(p);
      return undefined;
    },
    writeFile: async (p: string, data: string, _enc?: unknown) => {
      if (!isFixturePath(p)) {
        return await actual.writeFile(p, data, "utf-8");
      }
      setFile(p, data);
    },
  };
  return { ...wrapped, default: wrapped };
});

beforeEach(() => {
  fsState.entries.clear();
  fsState.nowMs = 0;
  ensureDir(fixturesRoot);
});

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
  wakeNowHeartbeatBusyMaxWaitMs?: number;
  wakeNowHeartbeatBusyRetryDelayMs?: number;
  withEvents?: boolean;
};

async function createCronHarness(options: CronHarnessOptions = {}) {
  ensureDir(fixturesRoot);
  const store = await makeStorePath();
  const enqueueSystemEvent = vi.fn();
  const requestHeartbeatNow = vi.fn();
  const events = options.withEvents === false ? undefined : createCronEventHarness();

  const cron = new CronService({
    storePath: store.storePath,
    cronEnabled: true,
    log: noopLogger,
    ...(options.nowMs ? { nowMs: options.nowMs } : {}),
    ...(options.wakeNowHeartbeatBusyMaxWaitMs !== undefined
      ? { wakeNowHeartbeatBusyMaxWaitMs: options.wakeNowHeartbeatBusyMaxWaitMs }
      : {}),
    ...(options.wakeNowHeartbeatBusyRetryDelayMs !== undefined
      ? { wakeNowHeartbeatBusyRetryDelayMs: options.wakeNowHeartbeatBusyRetryDelayMs }
      : {}),
    enqueueSystemEvent,
    requestHeartbeatNow,
    ...(options.runHeartbeatOnce ? { runHeartbeatOnce: options.runHeartbeatOnce } : {}),
    runIsolatedAgentJob:
      options.runIsolatedAgentJob ??
      (vi.fn(async (_params: { job: unknown; message: string }) => ({
        status: "ok",
      })) as unknown as CronServiceDeps["runIsolatedAgentJob"]),
    ...(events ? { onEvent: events.onEvent } : {}),
  });
  await cron.start();
  return { store, cron, enqueueSystemEvent, requestHeartbeatNow, events };
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

function expectMainSystemEventPosted(enqueueSystemEvent: unknown, text: string) {
  expect(enqueueSystemEvent).toHaveBeenCalledWith(
    text,
    expect.objectContaining({ agentId: undefined }),
  );
}

async function stopCronAndCleanup(cron: CronService, store: { cleanup: () => Promise<void> }) {
  cron.stop();
  await store.cleanup();
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
    requestHeartbeatNow: vi.fn(),
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
  const { store, cron, enqueueSystemEvent, requestHeartbeatNow, events } =
    await createIsolatedAnnounceHarness(params.runIsolatedAgentJob);
  await runIsolatedAnnounceScenario({
    cron,
    events,
    name: params.name,
  });
  expect(enqueueSystemEvent).not.toHaveBeenCalled();
  expect(requestHeartbeatNow).not.toHaveBeenCalled();
  await stopCronAndCleanup(cron, store);
}

describe("CronService", () => {
  it("runs a one-shot main job and disables it after success when requested", async () => {
    const { store, cron, enqueueSystemEvent, requestHeartbeatNow, events, atMs, job } =
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
    expectMainSystemEventPosted(enqueueSystemEvent, "hello");
    expect(requestHeartbeatNow).toHaveBeenCalled();

    await cron.list({ includeDisabled: true });
    await stopCronAndCleanup(cron, store);
  });

  it("runs a one-shot job and deletes it after success by default", async () => {
    const { store, cron, enqueueSystemEvent, requestHeartbeatNow, events, job } =
      await createMainOneShotJobHarness({
        name: "one-shot delete",
      });

    vi.setSystemTime(new Date("2025-12-13T00:00:02.000Z"));
    await vi.runOnlyPendingTimersAsync();
    await events.waitFor((evt) => evt.jobId === job.id && evt.action === "removed");

    const jobs = await cron.list({ includeDisabled: true });
    expect(jobs.find((j) => j.id === job.id)).toBeUndefined();
    expectMainSystemEventPosted(enqueueSystemEvent, "hello");
    expect(requestHeartbeatNow).toHaveBeenCalled();

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

    const { store, cron, enqueueSystemEvent, requestHeartbeatNow } =
      await createWakeModeNowMainHarness({
        runHeartbeatOnce,
        nowMs,
      });
    const job = await addWakeModeNowMainSystemEventJob(cron, { name: "wakeMode now waits" });

    const runPromise = cron.run(job.id, "force");
    await heartbeatStarted.promise;

    expect(runHeartbeatOnce).toHaveBeenCalledTimes(1);
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
    expectMainSystemEventPosted(enqueueSystemEvent, "hello");
    expect(job.state.runningAtMs).toBeTypeOf("number");

    if (typeof resolveHeartbeat === "function") {
      (resolveHeartbeat as (res: HeartbeatRunResult) => void)({ status: "ran", durationMs: 123 });
    }
    await runPromise;

    expect(job.state.lastStatus).toBe("ok");
    expect(job.state.lastDurationMs).toBeGreaterThan(0);

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

    const { store, cron, requestHeartbeatNow } = await createWakeModeNowMainHarness({
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
    expect(requestHeartbeatNow).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: `cron:${job.id}`,
        sessionKey,
      }),
    );
    expect(job.state.lastStatus).toBe("ok");
    expect(job.state.lastError).toBeUndefined();

    await cron.list({ includeDisabled: true });
    await stopCronAndCleanup(cron, store);
  });

  it("wakeMode now queues heartbeat when cron active marker blocks synchronous wake", async () => {
    const runHeartbeatOnce = vi.fn(async () => ({
      status: "skipped" as const,
      reason: HEARTBEAT_SKIP_CRON_IN_PROGRESS,
    }));

    const { store, cron, requestHeartbeatNow } = await createWakeModeNowMainHarness({
      runHeartbeatOnce,
    });

    const sessionKey = "agent:main:discord:channel:ops";
    const job = await addWakeModeNowMainSystemEventJob(cron, {
      name: "wakeMode now cron marker fallback",
      sessionKey,
    });

    await cron.run(job.id, "force");

    expect(runHeartbeatOnce).toHaveBeenCalledTimes(1);
    expect(requestHeartbeatNow).toHaveBeenCalledWith(
      expect.objectContaining({
        reason: `cron:${job.id}`,
        sessionKey,
      }),
    );
    expect(job.state.lastStatus).toBe("ok");
    expect(job.state.lastError).toBeUndefined();

    await cron.list({ includeDisabled: true });
    await stopCronAndCleanup(cron, store);
  });

  it("runs an isolated job without posting a fallback summary to main", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({ status: "ok" as const, summary: "done" }));
    const { store, cron, enqueueSystemEvent, requestHeartbeatNow, events } =
      await createIsolatedAnnounceHarness(runIsolatedAgentJob);
    await runIsolatedAnnounceScenario({ cron, events, name: "weekly" });
    expect(runIsolatedAgentJob).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
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
    const { store, cron, enqueueSystemEvent, requestHeartbeatNow, events } =
      await createIsolatedAnnounceHarness(runIsolatedAgentJob);
    await runIsolatedAnnounceJobAndWait({
      cron,
      events,
      name: "isolated error test",
      status: "error",
    });

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
    await stopCronAndCleanup(cron, store);
  });

  it("does not post fallback main summary for isolated delivery-target errors", async () => {
    const runIsolatedAgentJob = vi.fn(async () => ({
      status: "error" as const,
      summary: "last output",
      error: "Channel is required when multiple channels are configured: telegram, discord",
      errorKind: "delivery-target" as const,
    }));
    const { store, cron, enqueueSystemEvent, requestHeartbeatNow, events } =
      await createIsolatedAnnounceHarness(runIsolatedAgentJob);
    await runIsolatedAnnounceJobAndWait({
      cron,
      events,
      name: "isolated delivery target error test",
      status: "error",
    });

    expect(enqueueSystemEvent).not.toHaveBeenCalled();
    expect(requestHeartbeatNow).not.toHaveBeenCalled();
    await stopCronAndCleanup(cron, store);
  });

  it("rejects unsupported session/payload combinations", async () => {
    ensureDir(fixturesRoot);
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

    cron.stop();
    await store.cleanup();
  });
});
