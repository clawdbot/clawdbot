import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { enforceSessionDiskBudget } from "./disk-budget.js";
import { applyFileBackedSessionStoreMaintenance } from "./store-maintenance-operations.js";
import {
  archiveStaleDashboardEntries,
  capEntryCount,
  pruneStaleEntries,
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
  it("uses the latest activity signal and preserves active keys", () => {
    const now = 40 * DAY_MS;
    const staleKey = "agent:main:dashboard:stale";
    const activeKey = "agent:main:dashboard:active";
    const preservedKey = "agent:main:dashboard:preserved";
    const store = {
      [staleKey]: entry(now - 10 * DAY_MS, {
        lastActivityAt: now - 9 * DAY_MS,
        lastInteractionAt: now - 8 * DAY_MS,
        sessionStartedAt: now - 20 * DAY_MS,
      }),
      [activeKey]: entry(now - 10 * DAY_MS, { lastInteractionAt: now - DAY_MS }),
      [preservedKey]: entry(now - 10 * DAY_MS),
    };

    expect(
      archiveStaleDashboardEntries(store, 7 * DAY_MS, {
        nowMs: now,
        preserveKeys: new Set([preservedKey]),
      }),
    ).toBe(1);
    expect(store[staleKey]?.archivedAt).toBe(now);
    expect(store[staleKey]?.archivedBy).toEqual({
      type: "system",
      id: "session-maintenance",
      label: "Session maintenance",
    });
    expect(store[activeKey]?.archivedAt).toBeUndefined();
    expect(store[preservedKey]?.archivedAt).toBeUndefined();
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

describe("maintenance-archived sessions under pressure", () => {
  const maintenanceArchive = { type: "system", id: "session-maintenance" } as const;

  it("entry cap reclaims maintenance archives oldest-first but keeps user archives", () => {
    const now = 40 * DAY_MS;
    const store: Record<string, SessionEntry> = {
      "agent:main:dashboard:user-archived": entry(now - 20 * DAY_MS, {
        archivedAt: now - 15 * DAY_MS,
      }),
      "agent:main:dashboard:human-archived": entry(now - 20 * DAY_MS, {
        archivedAt: now - 15 * DAY_MS,
        archivedBy: { type: "human", id: "profile-1" },
      }),
      "agent:main:dashboard:stale-1": entry(now - 12 * DAY_MS),
      "agent:main:dashboard:stale-2": entry(now - 11 * DAY_MS),
      "agent:main:dashboard:stale-3": entry(now - 10 * DAY_MS),
      "agent:main:dashboard:live": entry(now),
    };

    expect(archiveStaleDashboardEntries(store, 7 * DAY_MS, { nowMs: now })).toBe(3);
    expect(capEntryCount(store, 4, { log: false })).toBe(2);
    expect(Object.keys(store).toSorted()).toEqual([
      "agent:main:dashboard:human-archived",
      "agent:main:dashboard:live",
      "agent:main:dashboard:stale-3",
      "agent:main:dashboard:user-archived",
    ]);
  });

  it("age pruning keeps maintenance archives", () => {
    const store: Record<string, SessionEntry> = {
      "agent:main:dashboard:old": entry(Date.now() - 45 * DAY_MS, {
        archivedAt: Date.now() - 38 * DAY_MS,
        archivedBy: { ...maintenanceArchive },
      }),
    };

    expect(pruneStaleEntries(store, 30 * DAY_MS, { log: false })).toBe(0);
    expect(store).toHaveProperty("agent:main:dashboard:old");
  });

  it("keeps the newest conversation when auto-archived rows alone exceed maxEntries", async () => {
    const now = Date.now();
    const liveKey = "agent:main:dashboard:live";
    const store: Record<string, SessionEntry> = { [liveKey]: entry(now) };
    for (let index = 0; index < 6; index += 1) {
      store[`agent:main:dashboard:stale-${index}`] = entry(now - (10 + index) * DAY_MS);
    }
    let report: { archived: number; capped: number } | undefined;

    await applyFileBackedSessionStoreMaintenance({
      storePath: "/tmp/openclaw-sessions/sessions.json",
      store,
      maintenanceConfig: resolveMaintenanceConfigFromInput({ maxEntries: 4, maxDiskBytes: false }),
      onMaintenanceApplied: (applied) => {
        report = { archived: applied.archived, capped: applied.capped };
      },
      log: { warn: () => {}, info: () => {} },
      artifacts: artifacts(),
    });

    expect(report).toEqual({ archived: 6, capped: 3 });
    expect(Object.keys(store).toSorted()).toEqual([
      liveKey,
      "agent:main:dashboard:stale-0",
      "agent:main:dashboard:stale-1",
      "agent:main:dashboard:stale-2",
    ]);
  });

  it("disk budget evicts maintenance archives before user archives and active work", async () => {
    await withTestDir({ prefix: "openclaw-dashboard-archive-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const maintenanceArchivedKey = "agent:main:dashboard:auto-archived";
      const userArchivedKey = "agent:main:dashboard:user-archived";
      const activeKey = "agent:main:main";
      const store: Record<string, SessionEntry> = {
        [maintenanceArchivedKey]: entry(1, {
          archivedAt: 2,
          archivedBy: { ...maintenanceArchive },
          displayName: "m".repeat(2000),
        }),
        [userArchivedKey]: entry(2, { archivedAt: 3, displayName: "u".repeat(2000) }),
        [activeKey]: entry(3),
      };
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");

      const result = await enforceSessionDiskBudget({
        store,
        storePath,
        activeSessionKey: activeKey,
        maintenance: { maxDiskBytes: 1000, highWaterBytes: 500 },
        warnOnly: false,
      });

      expect(result?.removedEntries).toBe(1);
      expect(store[maintenanceArchivedKey]).toBeUndefined();
      expect(store).toHaveProperty(userArchivedKey);
      expect(store).toHaveProperty(activeKey);
    });
  });
});
