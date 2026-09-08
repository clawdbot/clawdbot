import { expect, it, onTestFinished } from "vitest";
import {
  closeOpenClawAgentDatabaseByPath,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  applySessionEntryLifecycleMutation,
  loadSessionEntry,
  patchSessionEntryCore,
} from "./session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import { useTempSessionsFixture } from "./test-helpers.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const fixture = useTempSessionsFixture("openclaw-sqlite-cap-archive-");

async function replaceWithoutMaintenance(
  scope: { sessionKey: string; storePath: string },
  entry: SessionEntry,
): Promise<void> {
  await patchSessionEntryCore(scope, () => entry, {
    fallbackEntry: entry,
    replaceEntry: true,
    skipMaintenance: true,
  });
}

it("persists reasons and caps the least-recently-touched active row after dashboard archival", async () => {
  const storePath = fixture.storePath();
  const now = Date.now();
  const agedKey = "agent:main:ordinary:aged";
  await replaceWithoutMaintenance(
    { sessionKey: agedKey, storePath },
    {
      sessionId: "ordinary-aged",
      updatedAt: now - 40 * DAY_MS,
    },
  );
  const dashboardKey = "agent:main:dashboard:stale";
  const recentlyTouchedKey = "agent:main:ordinary:recently-touched";
  const leastRecentlyTouchedKey = "agent:main:ordinary:least-recently-touched";
  const triggerKey = "agent:main:ordinary:trigger";

  await replaceWithoutMaintenance(
    { sessionKey: dashboardKey, storePath },
    { sessionId: "dashboard-stale", updatedAt: now - 40 * DAY_MS },
  );
  await replaceWithoutMaintenance(
    { sessionKey: recentlyTouchedKey, storePath },
    {
      sessionId: "recently-touched",
      updatedAt: now - 20 * DAY_MS,
      lastInteractionAt: now - DAY_MS,
    },
  );
  await replaceWithoutMaintenance(
    { sessionKey: leastRecentlyTouchedKey, storePath },
    {
      sessionId: "least-recently-touched",
      updatedAt: now - 10 * DAY_MS,
      lastActivityAt: now - 30 * DAY_MS,
    },
  );
  await replaceWithoutMaintenance(
    { sessionKey: triggerKey, storePath },
    { sessionId: "trigger", updatedAt: now },
  );

  const result = await applySessionEntryLifecycleMutation({
    storePath,
    maintenanceOverride: {
      archiveDashboardAfterMs: 7 * DAY_MS,
      maxEntries: 2,
      mode: "enforce",
      pruneAfterMs: 30 * DAY_MS,
    },
  });

  const database = openOpenClawAgentDatabase({
    agentId: "main",
    path: resolveSqliteTargetFromSessionStorePath(storePath).path,
  });
  // Fixture cleanup must close this owner before another test changes ambient state.
  onTestFinished(() => {
    try {
      expect(database.db.isOpen).toBe(false);
    } finally {
      closeOpenClawAgentDatabaseByPath(database.path);
    }
  });
  expect(result).toMatchObject({ archived: 3, capArchived: 1, capped: 1, pruned: 0 });
  expect(loadSessionEntry({ sessionKey: agedKey, storePath })).toMatchObject({
    sessionId: "ordinary-aged",
    updatedAt: now - 40 * DAY_MS,
    archivedAt: expect.any(Number),
    archiveReason: "age-retention",
  });
  expect(loadSessionEntry({ sessionKey: agedKey, storePath })?.archivedBy).toBeUndefined();
  expect(loadSessionEntry({ sessionKey: dashboardKey, storePath })).toMatchObject({
    archivedAt: expect.any(Number),
    archiveReason: "stale-dashboard",
  });
  expect(loadSessionEntry({ sessionKey: leastRecentlyTouchedKey, storePath })).toMatchObject({
    archivedAt: expect.any(Number),
    archiveReason: "active-session-cap",
  });
  expect(
    loadSessionEntry({ sessionKey: recentlyTouchedKey, storePath })?.archivedAt,
  ).toBeUndefined();
  expect(loadSessionEntry({ sessionKey: triggerKey, storePath })?.archivedAt).toBeUndefined();
});
