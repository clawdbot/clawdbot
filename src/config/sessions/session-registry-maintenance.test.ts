// Session registry maintenance tests cover the task-owned cron-run pruning seam.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import { createFixtureSuite } from "../../test-utils/fixture-suite.js";
import { loadSessionEntry, replaceSessionEntry } from "./session-accessor.js";
import { runSessionRegistryMaintenanceForStore } from "./session-registry-maintenance.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const fixtureSuite = createFixtureSuite("openclaw-session-registry-maintenance-");

beforeAll(async () => {
  await fixtureSuite.setup();
});

afterAll(async () => {
  await fixtureSuite.cleanup();
});

function sessionEntry(sessionId: string, updatedAt: number): SessionEntry {
  return { sessionId, updatedAt };
}

async function createStore(entries: Record<string, SessionEntry>): Promise<string> {
  const dir = await fixtureSuite.createCaseDir("store");
  const storePath = path.join(dir, "sessions.json");
  await fs.mkdir(dir, { recursive: true });
  for (const [sessionKey, entry] of Object.entries(entries)) {
    await replaceSessionEntry({ sessionKey, storePath }, entry);
  }
  return storePath;
}

function resolveRequiredSqlitePath(storePath: string): string {
  const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath).path;
  if (!sqlitePath) {
    throw new Error(`Expected a SQLite target for ${storePath}`);
  }
  return sqlitePath;
}

describe("runSessionRegistryMaintenanceForStore", () => {
  it("summarizes a missing store without creating it", async () => {
    const dir = await fixtureSuite.createCaseDir("missing-store");
    const storePath = path.join(dir, "sessions.json");
    const sqlitePath = resolveRequiredSqlitePath(storePath);

    const result = await runSessionRegistryMaintenanceForStore({
      apply: true,
      retentionMs: 7 * DAY_MS,
      runningCronJobIds: new Set(),
      storePath,
    });

    expect(result).toEqual({
      beforeCount: 0,
      afterCount: 0,
      preservedRunning: 0,
      pruned: 0,
    });
    await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(sqlitePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("previews a missing store without creating SQLite state", async () => {
    const dir = await fixtureSuite.createCaseDir("missing-store-preview");
    const storePath = path.join(dir, "sessions.json");
    const sqlitePath = resolveRequiredSqlitePath(storePath);

    const result = await runSessionRegistryMaintenanceForStore({
      apply: false,
      retentionMs: 7 * DAY_MS,
      runningCronJobIds: new Set(),
      storePath,
    });

    expect(result).toEqual({
      beforeCount: 0,
      afterCount: 0,
      preservedRunning: 0,
      pruned: 0,
    });
    await expect(fs.stat(sqlitePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("previews stale cron-run pruning without mutating the store", async () => {
    const now = Date.now();
    const storePath = await createStore({
      "agent:main:cron:done-job:run:old-run": sessionEntry("old-run", now - 8 * DAY_MS),
      "agent:main:cron:done-job:run:recent-run": sessionEntry("recent-run", now),
    });

    const result = await runSessionRegistryMaintenanceForStore({
      apply: false,
      retentionMs: 7 * DAY_MS,
      runningCronJobIds: new Set(),
      storePath,
    });

    expect(result).toEqual({
      beforeCount: 2,
      afterCount: 1,
      preservedRunning: 0,
      pruned: 1,
    });
    expect(
      loadSessionEntry({ sessionKey: "agent:main:cron:done-job:run:old-run", storePath }),
    ).toEqual(sessionEntry("old-run", now - 8 * DAY_MS));
  });

  it("applies one store-sized pruning transaction and preserves running cron rows", async () => {
    const now = Date.now();
    const storePath = await createStore({
      "agent:main:cron:done-job:run:old-run": sessionEntry("done-run", now - 8 * DAY_MS),
      "agent:main:cron:running-job:run:old-run": sessionEntry("running-run", now - 8 * DAY_MS),
      "agent:main:cron:done-job:run:recent-run": sessionEntry("recent-run", now),
    });

    const result = await runSessionRegistryMaintenanceForStore({
      apply: true,
      retentionMs: 7 * DAY_MS,
      runningCronJobIds: new Set(["running-job"]),
      storePath,
    });

    expect(result).toEqual({
      beforeCount: 3,
      afterCount: 2,
      preservedRunning: 1,
      pruned: 1,
    });
    expect(
      loadSessionEntry({ sessionKey: "agent:main:cron:done-job:run:old-run", storePath }),
    ).toBeUndefined();
    expect(
      loadSessionEntry({ sessionKey: "agent:main:cron:running-job:run:old-run", storePath }),
    ).toEqual(sessionEntry("running-run", now - 8 * DAY_MS));
    expect(
      loadSessionEntry({ sessionKey: "agent:main:cron:done-job:run:recent-run", storePath }),
    ).toEqual(sessionEntry("recent-run", now));
  });

  it("skips generic session maintenance while applying task registry pruning", async () => {
    const now = Date.now();
    const oldOrdinaryKey = "agent:main:subagent:old-worker";
    const storePath = await createStore({
      "agent:main:cron:done-job:run:old-run": sessionEntry("done-run", now - 8 * DAY_MS),
      [oldOrdinaryKey]: sessionEntry("old-worker", now - 40 * DAY_MS),
    });

    const result = await runSessionRegistryMaintenanceForStore({
      apply: true,
      retentionMs: 7 * DAY_MS,
      runningCronJobIds: new Set(),
      storePath,
    });

    expect(result.pruned).toBe(1);
    expect(
      loadSessionEntry({ sessionKey: "agent:main:cron:done-job:run:old-run", storePath }),
    ).toBeUndefined();
    expect(loadSessionEntry({ sessionKey: oldOrdinaryKey, storePath })).toEqual(
      sessionEntry("old-worker", now - 40 * DAY_MS),
    );
  });

  it("preserves active cron rows until their admission releases", async () => {
    const now = Date.now();
    const sessionKey = "agent:main:cron:done-job:run:active-run";
    const sessionId = "active-run";
    const storePath = await createStore({
      [sessionKey]: sessionEntry(sessionId, now - 8 * DAY_MS),
    });
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [sessionId],
      assertAllowed: () => {},
    });

    try {
      const activeResult = await runSessionRegistryMaintenanceForStore({
        apply: true,
        retentionMs: 7 * DAY_MS,
        runningCronJobIds: new Set(),
        storePath,
      });
      expect(activeResult.pruned).toBe(0);
      expect(loadSessionEntry({ sessionKey, storePath })).toBeDefined();
    } finally {
      admission.release();
    }

    const releasedResult = await runSessionRegistryMaintenanceForStore({
      apply: true,
      retentionMs: 7 * DAY_MS,
      runningCronJobIds: new Set(),
      storePath,
    });
    expect(releasedResult.pruned).toBe(1);
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
  });
});
