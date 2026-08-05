import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadExactSessionEntry, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { clearCronJobActive, markCronJobActive } from "./active-jobs.js";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-remove-session-cleanup-",
});

afterEach(async () => {
  await closeOpenClawAgentDatabasesForTest();
});

describe("CronService.remove session cleanup", () => {
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

    await cron.remove(job.id);
    await replaceSessionEntry(
      { agentId: "main", storePath: sessionStorePath, sessionKey },
      { sessionId: "late-session", updatedAt: Date.now() },
    );
    clearCronJobActive(job.id, marker);

    await vi.waitFor(() => {
      expect(loadExactSessionEntry({ storePath: sessionStorePath, sessionKey })).toBeUndefined();
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
