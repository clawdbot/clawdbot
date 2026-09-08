import { expect, it } from "vitest";
import {
  loadLegacySessionStore,
  saveLegacySessionStore,
} from "../../infra/state-migrations.legacy-session-store.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { SessionMaintenanceApplyReport } from "./store-maintenance-operations.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";

const DAY_MS = 24 * 60 * 60 * 1000;

it("preserves the legacy read pressure gates separately from write maintenance", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const now = Date.now();
    const probeKey = "agent:main:explicit:model-run-123e4567-e89b-12d3-a456-426614174000";
    const dashboardKey = "agent:main:dashboard:stale";
    const ordinaryKey = "agent:main:old";
    const source = {
      [probeKey]: { sessionId: "probe", updatedAt: now - 2 * DAY_MS },
      [dashboardKey]: { sessionId: "dashboard", updatedAt: now - 8 * DAY_MS },
      [ordinaryKey]: { sessionId: "ordinary", updatedAt: now - 40 * DAY_MS },
    };
    const storePath = await state.writeJson("legacy/sessions.json", source);
    const maintenance: ResolvedSessionMaintenanceConfig = {
      mode: "enforce",
      pruneAfterMs: 30 * DAY_MS,
      archiveDashboardAfterMs: 7 * DAY_MS,
      modelRunPruneAfterMs: DAY_MS,
      maxEntries: 2,
      preserveRecentMs: null,
      resetArchiveRetentionMs: null,
      maxDiskBytes: null,
      highWaterBytes: null,
    };

    const read = loadLegacySessionStore(storePath, {
      runMaintenance: true,
      maintenanceConfig: maintenance,
    });
    expect(read[probeKey]).toBeUndefined();
    expect(read[dashboardKey]?.archiveReason).toBe("stale-dashboard");
    expect(read[ordinaryKey]?.archivedAt).toBeUndefined();
    expect(Object.keys(read).toSorted()).toEqual([dashboardKey, ordinaryKey].toSorted());

    let report: SessionMaintenanceApplyReport | undefined;
    await saveLegacySessionStore(storePath, source, {
      maintenanceConfig: maintenance,
      onMaintenanceApplied: (result) => {
        report = result;
      },
    });
    const written = loadLegacySessionStore(storePath);
    expect(written[probeKey]).toBeUndefined();
    expect(written[dashboardKey]?.archiveReason).toBe("stale-dashboard");
    expect(written[ordinaryKey]?.archiveReason).toBe("age-retention");
    expect(report).toMatchObject({
      beforeCount: 3,
      afterCount: 2,
      modelRunPruned: 1,
      archived: 2,
      capArchived: 0,
      pruned: 0,
      capped: 0,
    });
  });
});
