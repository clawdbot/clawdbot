import { expect, it, vi } from "vitest";
import { applyFileBackedSessionStoreMaintenance } from "./store-maintenance-operations.js";
import {
  normalizeResolvedMaintenanceConfigInput,
  resolveMaintenanceConfigFromInput,
} from "./store-maintenance.js";

const DAY_MS = 24 * 60 * 60 * 1000;

it("inherits deleted archive retention for older resolved callers but preserves explicit disablement", () => {
  const base = {
    mode: "enforce" as const,
    pruneAfterMs: DAY_MS,
    maxEntries: 100,
    resetArchiveRetentionMs: 7 * DAY_MS,
    maxDiskBytes: null,
    highWaterBytes: null,
  };

  expect(normalizeResolvedMaintenanceConfigInput(base).deletedArchiveRetentionMs).toBe(7 * DAY_MS);
  expect(
    normalizeResolvedMaintenanceConfigInput({ ...base, deletedArchiveRetentionMs: null })
      .deletedArchiveRetentionMs,
  ).toBeNull();
});

it("passes independent deleted and reset archive retention rules", async () => {
  const now = Date.now();
  const cleanupArchivedSessionTranscripts = vi.fn(async () => {});

  await applyFileBackedSessionStoreMaintenance({
    storePath: "/tmp/openclaw-sessions/sessions.json",
    store: {
      stale: { sessionId: "stale-session", updatedAt: now - 30 * DAY_MS },
      fresh: { sessionId: "fresh-session", updatedAt: now },
    },
    maintenanceConfig: {
      mode: "enforce",
      pruneAfterMs: 7 * DAY_MS,
      maxEntries: 500,
      modelRunPruneAfterMs: DAY_MS,
      resetArchiveRetentionMs: 14 * DAY_MS,
      deletedArchiveRetentionMs: 3 * DAY_MS,
      maxDiskBytes: null,
      highWaterBytes: null,
    },
    log: { warn: () => {}, info: () => {} },
    artifacts: {
      archiveRemovedSessionTranscripts: async () => new Set(),
      removeRemovedSessionTrajectoryArtifacts: async () => {},
      cleanupArchivedSessionTranscripts,
    },
  });

  expect(cleanupArchivedSessionTranscripts).toHaveBeenCalledWith({
    directories: ["/tmp/openclaw-sessions"],
    rules: [
      { reason: "deleted", olderThanMs: 3 * DAY_MS },
      { reason: "reset", olderThanMs: 14 * DAY_MS },
    ],
  });
});

it("allows deleted archive retention to diverge from reset history", () => {
  const maintenance = resolveMaintenanceConfigFromInput({
    resetArchiveRetention: false,
    deletedArchiveRetention: "30d",
  });

  expect(maintenance.resetArchiveRetentionMs).toBeNull();
  expect(maintenance.deletedArchiveRetentionMs).toBe(30 * DAY_MS);
});
