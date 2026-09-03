import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";

vi.mock("./store-maintenance-runtime.js", () => ({
  resolveMaintenanceConfig: () => ({
    mode: "enforce" as const,
    pruneAfterMs: Number.MAX_SAFE_INTEGER,
    archiveDashboardAfterMs: null,
    maxEntries: 2,
    modelRunPruneAfterMs: 24 * 60 * 60 * 1000,
    preserveRecentMs: null,
    resetArchiveRetentionMs: null,
    maxDiskBytes: null,
    highWaterBytes: null,
  }),
}));

import { resolveSessionCleanupAction, runSessionsCleanup } from "./cleanup-service.js";
import { loadSessionEntry, replaceSessionEntrySync } from "./session-accessor.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("session cleanup cap archives", () => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
  });

  it("reports cap archives separately from dashboard-age archives", () => {
    const key = "agent:main:dashboard:cap-victim";
    expect(
      resolveSessionCleanupAction({
        key,
        missingKeys: new Set(),
        modelRunPrunedKeys: new Set(),
        archivedKeys: new Set(),
        capArchivedKeys: new Set([key]),
        staleKeys: new Set(),
        cappedKeys: new Set(),
        dmScopeRetiredKeys: new Set(),
      }),
    ).toBe("archive-cap");
  });

  it("separates cap archives in cleanup summary JSON", async () => {
    const now = Date.now();
    const storePath = path.join(
      tempDirs.make("openclaw-cleanup-cap-summary-"),
      "agents",
      "main",
      "sessions",
      "sessions.json",
    );
    for (const [index, updatedAt] of [now - 2, now - 1, now].entries()) {
      const sessionKey = `agent:main:dashboard:ordinary-${index}`;
      replaceSessionEntrySync(
        { sessionKey, storePath },
        { sessionId: `ordinary-${index}`, updatedAt },
      );
    }

    const preview = await runSessionsCleanup({
      cfg: {},
      opts: { dryRun: true },
      targets: [{ agentId: "main", storePath }],
    });

    expect(preview.previewResults[0]?.summary).toMatchObject({
      archived: 0,
      capArchived: 1,
      capped: 1,
    });
    expect(preview.previewResults[0]?.capArchivedKeys).toEqual(
      new Set(["agent:main:dashboard:ordinary-0"]),
    );
  });

  it("uses unarchived pressure consistently in preview and apply", async () => {
    const now = Date.now();
    const storePath = path.join(
      tempDirs.make("openclaw-cleanup-cap-archive-"),
      "agents",
      "main",
      "sessions",
      "sessions.json",
    );
    const probeKey = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174000";
    const entries = [
      [
        "agent:main:dashboard:archived-1",
        { sessionId: "archived-1", updatedAt: now, archivedAt: now },
      ],
      [
        "agent:main:dashboard:archived-2",
        { sessionId: "archived-2", updatedAt: now, archivedAt: now },
      ],
      [probeKey, { sessionId: "probe", updatedAt: now - 2 * 24 * 60 * 60 * 1000 }],
      ["agent:main:dashboard:current", { sessionId: "current", updatedAt: now }],
    ] as const;
    for (const [sessionKey, entry] of entries) {
      replaceSessionEntrySync({ sessionKey, storePath }, entry);
    }
    const target = { agentId: "main", storePath };

    const preview = await runSessionsCleanup({
      cfg: {},
      opts: { dryRun: true },
      targets: [target],
    });
    expect(preview.previewResults[0]?.summary.modelRunPruned).toBe(0);
    expect(preview.previewResults[0]?.modelRunPrunedKeys).not.toContain(probeKey);

    const applied = await runSessionsCleanup({
      cfg: {},
      opts: { enforce: true },
      targets: [target],
    });
    expect(applied.appliedSummaries[0]?.modelRunPruned).toBe(0);
    expect(loadSessionEntry({ sessionKey: probeKey, storePath })).toMatchObject({
      sessionId: "probe",
    });
  });
});
