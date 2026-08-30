import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { loadExactSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  runExclusiveSqliteSessionWrite,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import {
  closeOpenClawAgentDatabasesForTest,
  listOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import { clearCronJobActive, markCronJobActive } from "./active-jobs.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-remove-session-cleanup-",
});

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
});

describe("CronService.remove session cleanup", () => {
  it("does not materialize a session database when the deleted job never ran", async () => {
    const { storePath } = await makeStorePath();
    const sessionStorePath = path.join(path.dirname(storePath), "sessions.json");
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      defaultAgentId: "main",
      resolveSessionStorePath: () => sessionStorePath,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const job = await cron.add({
      id: "never-ran",
      name: "never ran",
      enabled: false,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "work" },
    });
    const sessionKey = `agent:main:cron:${job.id}`;
    const databasePath = resolveSqliteScope({
      agentId: "main",
      sessionKey,
      storePath: sessionStorePath,
    }).path!;

    expect(fs.existsSync(databasePath)).toBe(false);

    await expect(cron.remove(job.id)).resolves.toEqual({ ok: true, removed: true });

    expect(fs.existsSync(databasePath)).toBe(false);
    expect(
      listOpenClawAgentDatabasesForTest().some((database) => database.path === databasePath),
    ).toBe(false);
  });

  it("removes only the deleted isolated job's base session", async () => {
    const { storePath } = await makeStorePath();
    const sessionStorePath = path.join(path.dirname(storePath), "sessions.json");
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      defaultAgentId: "main",
      resolveSessionStorePath: () => sessionStorePath,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const job = await cron.add({
      id: "deleted-job",
      name: "deleted job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "work" },
    });
    const baseSessionKey = `agent:main:cron:${job.id}`;
    const runSessionKey = `${baseSessionKey}:run:retained-run`;
    const otherSessionKey = "agent:main:cron:other-job";
    await replaceSessionEntry(
      { agentId: "main", storePath: sessionStorePath, sessionKey: baseSessionKey },
      { sessionId: "base-session", updatedAt: Date.now() },
    );
    await replaceSessionEntry(
      { agentId: "main", storePath: sessionStorePath, sessionKey: runSessionKey },
      { sessionId: "run-session", updatedAt: Date.now() },
    );
    await replaceSessionEntry(
      { agentId: "main", storePath: sessionStorePath, sessionKey: otherSessionKey },
      { sessionId: "other-session", updatedAt: Date.now() },
    );

    await expect(cron.remove(job.id)).resolves.toEqual({ ok: true, removed: true });

    expect(loadExactSessionEntry({ storePath: sessionStorePath, sessionKey: baseSessionKey })).toBe(
      undefined,
    );
    expect(
      loadExactSessionEntry({ storePath: sessionStorePath, sessionKey: runSessionKey }),
    ).toMatchObject({ entry: { sessionId: "run-session" } });
    expect(
      loadExactSessionEntry({ storePath: sessionStorePath, sessionKey: otherSessionKey }),
    ).toMatchObject({ entry: { sessionId: "other-session" } });
  });

  it("releases the cron lock before waiting for the session lifecycle writer", async () => {
    const { storePath } = await makeStorePath();
    const sessionStorePath = path.join(path.dirname(storePath), "sessions.json");
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      defaultAgentId: "main",
      resolveSessionStorePath: () => sessionStorePath,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const job = await cron.add({
      id: "contended-session-writer",
      name: "contended session writer",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "work" },
    });
    const sessionKey = `agent:main:cron:${job.id}`;
    await replaceSessionEntry(
      { agentId: "main", storePath: sessionStorePath, sessionKey },
      { sessionId: "contended-session", updatedAt: Date.now() },
    );

    const writerEntered = createDeferred();
    const releaseWriter = createDeferred();
    const resolvedSessionScope = resolveSqliteScope({
      agentId: "main",
      sessionKey,
      storePath: sessionStorePath,
    });
    const heldWriter = runExclusiveSqliteSessionWrite(resolvedSessionScope, async () => {
      writerEntered.resolve();
      await releaseWriter.promise;
    });
    await writerEntered.promise;

    const removal = cron.remove(job.id);
    let unrelatedAdded = false;
    const unrelatedAdd = cron
      .add({
        id: "unrelated-during-session-cleanup",
        name: "unrelated during session cleanup",
        enabled: true,
        schedule: { kind: "every", everyMs: 120_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "unrelated" },
      })
      .then(() => {
        unrelatedAdded = true;
      });

    try {
      await vi.advanceTimersByTimeAsync(50);
      expect(unrelatedAdded).toBe(true);
    } finally {
      releaseWriter.resolve();
      await heldWriter;
      await Promise.all([removal, unrelatedAdd]);
    }

    expect(loadExactSessionEntry({ storePath: sessionStorePath, sessionKey })).toBeUndefined();
  });

  it("removes a base session recreated by an already-admitted run", async () => {
    const { storePath } = await makeStorePath();
    const sessionStorePath = path.join(path.dirname(storePath), "sessions.json");
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      defaultAgentId: "main",
      resolveSessionStorePath: () => sessionStorePath,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const job = await cron.add({
      id: "active-deleted-job",
      name: "active deleted job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "work" },
    });
    const sessionKey = `agent:main:cron:${job.id}`;
    const marker = markCronJobActive(job.id);

    await replaceSessionEntry(
      { agentId: "main", storePath: sessionStorePath, sessionKey },
      { sessionId: "active-session", updatedAt: Date.now() },
    );

    await cron.remove(job.id);
    expect(loadExactSessionEntry({ storePath: sessionStorePath, sessionKey })).toMatchObject({
      entry: { sessionId: "active-session" },
    });
    await replaceSessionEntry(
      { agentId: "main", storePath: sessionStorePath, sessionKey },
      { sessionId: "late-session", updatedAt: Date.now() },
    );
    clearCronJobActive(job.id, marker);

    await vi.waitFor(() => {
      expect(loadExactSessionEntry({ storePath: sessionStorePath, sessionKey })).toBeUndefined();
    });
  });

  it("preserves the session of a replacement job with the same id", async () => {
    const { storePath } = await makeStorePath();
    const sessionStorePath = path.join(path.dirname(storePath), "sessions.json");
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      defaultAgentId: "main",
      resolveSessionStorePath: () => sessionStorePath,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const original = await cron.add({
      id: "reused-job-id",
      name: "original job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "original" },
    });
    const sessionKey = `agent:main:cron:${original.id}`;
    const originalMarker = markCronJobActive(original.id);

    await replaceSessionEntry(
      { agentId: "main", storePath: sessionStorePath, sessionKey },
      { sessionId: "original-session", updatedAt: Date.now() },
    );

    await cron.remove(original.id);
    let replacementAdded = false;
    const replacementPromise = cron
      .add({
        id: original.id,
        name: "replacement job",
        enabled: true,
        schedule: { kind: "every", everyMs: 120_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "replacement" },
      })
      .then((job) => {
        replacementAdded = true;
        return job;
      });
    await vi.advanceTimersByTimeAsync(50);
    expect(replacementAdded).toBe(false);

    clearCronJobActive(original.id, originalMarker);
    await replacementPromise;
    expect(loadExactSessionEntry({ storePath: sessionStorePath, sessionKey })).toBeUndefined();
    await replaceSessionEntry(
      { agentId: "main", storePath: sessionStorePath, sessionKey },
      { sessionId: "replacement-session", updatedAt: Date.now() },
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(loadExactSessionEntry({ storePath: sessionStorePath, sessionKey })).toMatchObject({
      entry: { sessionId: "replacement-session" },
    });
  });

  it("fences same-id replacement across services sharing one store", async () => {
    const { storePath } = await makeStorePath();
    const sessionStorePath = path.join(path.dirname(storePath), "sessions.json");
    const createCron = () =>
      new CronService({
        storePath,
        cronEnabled: true,
        defaultAgentId: "main",
        resolveSessionStorePath: () => sessionStorePath,
        log: logger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
    const removingCron = createCron();
    const replacementCron = createCron();
    const original = await removingCron.add({
      id: "cross-service-reused-id",
      name: "original job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "original" },
    });
    const sessionKey = `agent:main:cron:${original.id}`;
    const originalMarker = markCronJobActive(original.id);
    await replaceSessionEntry(
      { agentId: "main", storePath: sessionStorePath, sessionKey },
      { sessionId: "original-session", updatedAt: Date.now() },
    );

    await removingCron.remove(original.id);
    let replacementAdded = false;
    const replacementPromise = replacementCron
      .add({
        id: original.id,
        name: "replacement job",
        enabled: true,
        schedule: { kind: "every", everyMs: 120_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "replacement" },
      })
      .then((job) => {
        replacementAdded = true;
        return job;
      });
    await vi.advanceTimersByTimeAsync(50);
    expect(replacementAdded).toBe(false);

    clearCronJobActive(original.id, originalMarker);
    await replacementPromise;
    await replaceSessionEntry(
      { agentId: "main", storePath: sessionStorePath, sessionKey },
      { sessionId: "replacement-session", updatedAt: Date.now() },
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(loadExactSessionEntry({ storePath: sessionStorePath, sessionKey })).toMatchObject({
      entry: { sessionId: "replacement-session" },
    });
  });

  it("does not delete a shared main session", async () => {
    const { storePath } = await makeStorePath();
    const sessionStorePath = path.join(path.dirname(storePath), "sessions.json");
    const cron = new CronService({
      storePath,
      cronEnabled: true,
      defaultAgentId: "main",
      resolveSessionStorePath: () => sessionStorePath,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const job = await cron.add({
      id: "main-session-job",
      name: "main session job",
      enabled: true,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "work" },
    });
    const sessionKey = "agent:main:main";
    await replaceSessionEntry(
      { agentId: "main", storePath: sessionStorePath, sessionKey },
      { sessionId: "main-session", updatedAt: Date.now() },
    );

    await cron.remove(job.id);

    expect(loadExactSessionEntry({ storePath: sessionStorePath, sessionKey })).toMatchObject({
      entry: { sessionId: "main-session" },
    });
  });
});
