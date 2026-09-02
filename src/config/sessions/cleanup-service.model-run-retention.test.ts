import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const maintenanceState = vi.hoisted(() => ({ modelRunPruneAfterMs: 24 * 60 * 60 * 1000 }));

vi.mock("./store-maintenance-runtime.js", () => ({
  resolveMaintenanceConfig: () => ({
    mode: "enforce",
    pruneAfterMs: 30 * DAY_MS,
    archiveDashboardAfterMs: null,
    modelRunPruneAfterMs: maintenanceState.modelRunPruneAfterMs,
    maxEntries: 2,
    preserveRecentMs: null,
    resetArchiveRetentionMs: null,
    maxDiskBytes: null,
    highWaterBytes: null,
  }),
}));

import { runSessionsCleanup } from "./cleanup-service.js";
import { replaceSessionEntrySync } from "./session-accessor.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("sessions cleanup model-run preview", () => {
  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
  });

  it.each([
    { modelRunPruneAfterMs: DAY_MS, modelRunPruned: 1, capped: 0 },
    { modelRunPruneAfterMs: 0, modelRunPruned: 0, capped: 1 },
    { modelRunPruneAfterMs: -DAY_MS, modelRunPruned: 0, capped: 1 },
  ])(
    "previews model-run retention $modelRunPruneAfterMs before capping",
    async ({ modelRunPruneAfterMs, modelRunPruned, capped }) => {
      maintenanceState.modelRunPruneAfterMs = modelRunPruneAfterMs;
      const storePath = path.join(
        tempDirs.make("openclaw-cleanup-model-run-"),
        "agents",
        "main",
        "sessions",
        "sessions.json",
      );
      const modelRunSessionKey =
        "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174000";
      const oldSessionKey = "agent:main:old";
      const now = Date.now();
      replaceSessionEntrySync(
        { sessionKey: modelRunSessionKey, storePath },
        { sessionId: "session-model-run", updatedAt: now - 2 * DAY_MS },
      );
      replaceSessionEntrySync(
        { sessionKey: oldSessionKey, storePath },
        { sessionId: "session-old", updatedAt: now - 3 * DAY_MS },
      );
      replaceSessionEntrySync(
        { sessionKey: "agent:main:active", storePath },
        { sessionId: "session-active", updatedAt: now },
      );

      const result = await runSessionsCleanup({
        cfg: {},
        opts: { dryRun: true, enforce: true },
        targets: [{ agentId: "main", storePath }],
      });

      const preview = result.previewResults[0];
      expect(preview?.summary).toMatchObject({ modelRunPruned, capped, afterCount: 2 });
      expect(preview?.modelRunPrunedKeys.has(modelRunSessionKey)).toBe(modelRunPruned === 1);
      expect(preview?.cappedKeys.has(oldSessionKey)).toBe(capped === 1);
    },
  );
});
