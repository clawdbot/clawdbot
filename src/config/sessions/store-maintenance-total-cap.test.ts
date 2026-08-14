import { describe, expect, it, vi } from "vitest";
import { applyFileBackedSessionStoreMaintenance } from "./store-maintenance-operations.js";
import { capEntryCount, getActiveSessionMaintenanceWarning } from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function makeEntry(updatedAt: number): SessionEntry {
  return { sessionId: `session-${updatedAt}`, updatedAt };
}

function makeStore(entries: Array<[string, SessionEntry]>): Record<string, SessionEntry> {
  return Object.fromEntries(entries);
}

function createMaintenanceArtifacts() {
  return {
    archiveRemovedSessionTranscripts: async () => new Set<string>(),
    removeRemovedSessionTrajectoryArtifacts: async () => {},
    cleanupArchivedSessionTranscripts: async () => {},
  };
}

describe("session maintenance total entry cap", () => {
  it("counts archived sessions toward the cap without evicting them", () => {
    const now = Date.now();
    const archivedEntries = Array.from({ length: 499 }, (_, index): [string, SessionEntry] => [
      `archived-${index}`,
      { ...makeEntry(index), archivedAt: now },
    ]);
    const store = makeStore([
      ...archivedEntries,
      ["dashboard-1", makeEntry(now - 2)],
      ["dashboard-2", makeEntry(now - 1)],
      ["dashboard-3", makeEntry(now)],
    ]);

    expect(capEntryCount(store, 500)).toBe(2);
    expect(Object.keys(store)).toHaveLength(500);
    expect(store["dashboard-1"]).toBeUndefined();
    expect(store["dashboard-2"]).toBeUndefined();
    expect(store).toHaveProperty("dashboard-3");
    expect(store).toHaveProperty("archived-0");
    expect(store).toHaveProperty("archived-498");
  });

  it("uses the remaining total capacity for ordinary sessions", () => {
    const pinnedEntries = Array.from({ length: 200 }, (_, index): [string, SessionEntry] => [
      `pinned-${index}`,
      { ...makeEntry(index), pinnedAt: index + 1 },
    ]);
    const ordinaryEntries = Array.from({ length: 400 }, (_, index): [string, SessionEntry] => [
      `ordinary-${index}`,
      makeEntry(index),
    ]);
    const store = makeStore([...pinnedEntries, ...ordinaryEntries]);

    expect(capEntryCount(store, 500)).toBe(100);
    expect(Object.keys(store)).toHaveLength(500);
    expect(store["ordinary-99"]).toBeUndefined();
    expect(store).toHaveProperty("ordinary-100");
    expect(store).toHaveProperty("ordinary-399");
    expect(store).toHaveProperty("pinned-0");
    expect(store).toHaveProperty("pinned-199");
  });

  it("uses total rows when warning that an active session would be capped", () => {
    const now = Date.now();
    const archivedEntries = Array.from({ length: 499 }, (_, index): [string, SessionEntry] => [
      `archived-${index}`,
      { ...makeEntry(index), archivedAt: now },
    ]);
    const store = makeStore([
      ...archivedEntries,
      ["recent", makeEntry(now)],
      ["active", makeEntry(now - 1)],
    ]);

    expect(
      getActiveSessionMaintenanceWarning({
        store,
        activeSessionKey: "active",
        pruneAfterMs: DAY_MS,
        maxEntries: 500,
        nowMs: now,
      }),
    ).toMatchObject({ wouldCap: true, wouldPrune: false });
  });

  it("uses enforcement preservation when predicting active-session eviction", async () => {
    const now = Date.now();
    const storePath = "/tmp/openclaw-sessions/warn-enforce-parity.json";
    const makePressureStore = () =>
      makeStore([
        ["archived", { ...makeEntry(now - 2), archivedAt: now }],
        ["active", makeEntry(now - 1)],
        ["recent", makeEntry(now)],
      ]);
    const maintenanceConfig = {
      mode: "warn" as const,
      pruneAfterMs: 30 * DAY_MS,
      maxEntries: 2,
      modelRunPruneAfterMs: DAY_MS,
      resetArchiveRetentionMs: null,
      maxDiskBytes: null,
      highWaterBytes: null,
    };
    const onWarn = vi.fn();

    await applyFileBackedSessionStoreMaintenance({
      storePath,
      store: makePressureStore(),
      activeSessionKey: "active",
      maintenanceConfig,
      onWarn,
      log: { warn: () => {}, info: () => {} },
      artifacts: createMaintenanceArtifacts(),
    });

    const enforcedStore = makePressureStore();
    await applyFileBackedSessionStoreMaintenance({
      storePath,
      store: enforcedStore,
      activeSessionKey: "active",
      maintenanceConfig: { ...maintenanceConfig, mode: "enforce" },
      log: { warn: () => {}, info: () => {} },
      artifacts: createMaintenanceArtifacts(),
    });

    expect(onWarn).not.toHaveBeenCalled();
    expect(enforcedStore).toHaveProperty("archived");
    expect(enforcedStore).toHaveProperty("active");
    expect(enforcedStore.recent).toBeUndefined();
  });
});
