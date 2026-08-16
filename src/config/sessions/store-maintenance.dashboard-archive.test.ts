import { describe, expect, it } from "vitest";
import { applyFileBackedSessionStoreMaintenance } from "./store-maintenance-operations.js";
import {
  archiveStaleDashboardEntries,
  resolveMaintenanceConfigFromInput,
} from "./store-maintenance.js";
import type { SessionEntry } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function entry(updatedAt: number, extra: Partial<SessionEntry> = {}): SessionEntry {
  return { sessionId: `session-${updatedAt}`, updatedAt, ...extra };
}

function artifacts() {
  return {
    archiveRemovedSessionTranscripts: async () => new Set<string>(),
    removeRemovedSessionTrajectoryArtifacts: async () => {},
    cleanupArchivedSessionTranscripts: async () => {},
  };
}

describe("archiveStaleDashboardEntries", () => {
  it("uses the latest activity signal", () => {
    const now = 40 * DAY_MS;
    const staleKey = "agent:main:dashboard:stale";
    const activeKey = "agent:main:dashboard:active";
    const store = {
      [staleKey]: entry(now - 10 * DAY_MS, {
        lastActivityAt: now - 9 * DAY_MS,
        lastInteractionAt: now - 8 * DAY_MS,
        sessionStartedAt: now - 20 * DAY_MS,
      }),
      [activeKey]: entry(now - 10 * DAY_MS, { lastInteractionAt: now - DAY_MS }),
    };

    expect(archiveStaleDashboardEntries(store, 7 * DAY_MS, { nowMs: now })).toBe(1);
    expect(store[staleKey]?.archivedAt).toBe(now);
    expect(store[activeKey]?.archivedAt).toBeUndefined();
  });

  it("leaves pinned, archived, and non-dashboard sessions untouched", () => {
    const now = 40 * DAY_MS;
    const archivedAt = now - DAY_MS;
    const store: Record<string, SessionEntry> = {
      "agent:main:dashboard:pinned": entry(1, { pinnedAt: 2 }),
      "agent:main:dashboard:archived": entry(1, { archivedAt }),
      "agent:main:main": entry(1),
      "agent:main:slack:channel:C1": entry(1),
      "agent:main:subagent:child": entry(1),
      "dashboard:unscoped": entry(1),
    };

    expect(archiveStaleDashboardEntries(store, 7 * DAY_MS, { nowMs: now })).toBe(0);
    expect(store["agent:main:dashboard:pinned"]?.archivedAt).toBeUndefined();
    expect(store["agent:main:dashboard:archived"]?.archivedAt).toBe(archivedAt);
    for (const key of [
      "agent:main:main",
      "agent:main:slack:channel:C1",
      "agent:main:subagent:child",
      "dashboard:unscoped",
    ]) {
      expect(store[key]?.archivedAt).toBeUndefined();
    }
  });

  it("supports the default and both disable values", () => {
    expect(resolveMaintenanceConfigFromInput().archiveDashboardAfterMs).toBe(7 * DAY_MS);
    for (const archiveDashboardAfter of [false, 0] as const) {
      expect(
        resolveMaintenanceConfigFromInput({ archiveDashboardAfter }).archiveDashboardAfterMs,
      ).toBeNull();
    }
  });
});

describe("dashboard archive maintenance ordering", () => {
  it("archives before general pruning", async () => {
    const dashboardKey = "agent:main:dashboard:stale-visible-session";
    const store = { [dashboardKey]: entry(Date.now() - 31 * DAY_MS) };

    await applyFileBackedSessionStoreMaintenance({
      storePath: "/tmp/openclaw-sessions/sessions.json",
      store,
      maintenanceConfig: resolveMaintenanceConfigFromInput({
        pruneAfter: "30d",
        maxDiskBytes: false,
      }),
      log: { warn: () => {}, info: () => {} },
      artifacts: artifacts(),
    });

    expect(store[dashboardKey]?.archivedAt).toEqual(expect.any(Number));
  });

  it("does not archive in warn mode", async () => {
    const dashboardKey = "agent:main:dashboard:warn-only";
    const store = { [dashboardKey]: entry(Date.now() - 10 * DAY_MS) };

    await applyFileBackedSessionStoreMaintenance({
      storePath: "/tmp/openclaw-sessions/sessions.json",
      store,
      maintenanceConfig: resolveMaintenanceConfigFromInput({
        mode: "warn",
        archiveDashboardAfter: "7d",
        maxDiskBytes: false,
      }),
      log: { warn: () => {}, info: () => {} },
      artifacts: artifacts(),
    });

    expect(store[dashboardKey]?.archivedAt).toBeUndefined();
  });
});
