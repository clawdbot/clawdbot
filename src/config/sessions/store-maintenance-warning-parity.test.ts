import { expect, it, vi } from "vitest";
import { applyFileBackedSessionStoreMaintenance } from "./store-maintenance-operations.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function createMaintenanceArtifacts() {
  return {
    archiveRemovedSessionTranscripts: async () => new Set<string>(),
    removeRemovedSessionTrajectoryArtifacts: async () => {},
    cleanupArchivedSessionTranscripts: async () => {},
  };
}

it("uses enforcement preservation when predicting active-session eviction", async () => {
  const now = Date.now();
  const createStore = () => ({
    archived: { sessionId: "archived", updatedAt: now - 2, archivedAt: now },
    active: { sessionId: "active", updatedAt: now - 1 },
    recent: { sessionId: "recent", updatedAt: now },
  });
  const maintenanceConfig = {
    mode: "warn" as const,
    pruneAfterMs: 30 * DAY_MS,
    maxEntries: 2,
    modelRunPruneAfterMs: DAY_MS,
    resetArchiveRetentionMs: null,
    maxDiskBytes: null,
    highWaterBytes: null,
  };
  const shared = {
    storePath: "/tmp/openclaw-sessions/warn-enforce-parity.json",
    activeSessionKey: "active",
    log: { warn: () => {}, info: () => {} },
    artifacts: createMaintenanceArtifacts(),
  };
  const onWarn = vi.fn();

  await applyFileBackedSessionStoreMaintenance({
    ...shared,
    store: createStore(),
    maintenanceConfig,
    onWarn,
  });

  const enforcedStore = createStore();
  await applyFileBackedSessionStoreMaintenance({
    ...shared,
    store: enforcedStore,
    maintenanceConfig: { ...maintenanceConfig, mode: "enforce" },
  });

  expect(onWarn).not.toHaveBeenCalled();
  expect(enforcedStore).toHaveProperty("archived");
  expect(enforcedStore).toHaveProperty("active");
  expect(enforcedStore.recent).toBeUndefined();
});
