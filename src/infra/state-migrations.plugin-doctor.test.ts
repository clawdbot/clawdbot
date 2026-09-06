import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { listPluginDoctorStateMigrationEntries } from "../plugins/doctor-contract-registry.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { runPostSessionPluginDoctorStateRepairs } from "./state-migrations.plugin-doctor.js";

const controls = vi.hoisted(() => ({
  entries: [] as ReturnType<typeof listPluginDoctorStateMigrationEntries>,
  failSettlement: false,
}));

vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>()),
  listPluginDoctorStateMigrationEntries: () => controls.entries,
}));

vi.mock("../plugins/plugin-lifecycle-lease.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/plugin-lifecycle-lease.js")>();
  return {
    ...actual,
    withPluginLifecycleLease: ((options, run) =>
      actual.withPluginLifecycleLease(options, async (lease) => {
        const result = await run(lease);
        // The lease owner validates again after the callback returns. Model a lost
        // lease at that boundary, after migrations have already committed.
        if (controls.failSettlement) {
          throw new Error("lease settlement failed");
        }
        return result;
      })) satisfies typeof actual.withPluginLifecycleLease,
  };
});

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  controls.entries = [];
  controls.failSettlement = false;
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

describe("plugin Doctor migration settlement", () => {
  it.each(["none", "later-action", "lease-settlement"] as const)(
    "preserves completed mutations and replay truth when failure is %s",
    async (failure) => {
      const root = await tempDirs.make("openclaw-plugin-doctor-settlement-");
      const env = {
        ...process.env,
        HOME: root,
        OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
        OPENCLAW_STATE_DIR: root,
      };
      const markers = [path.join(root, "first"), path.join(root, "second")] as const;
      controls.failSettlement = failure === "lease-settlement";
      controls.entries = markers.map((marker, index) => ({
        pluginId: "settlement-owner",
        channelIds: [],
        trustedForDurableStores: false,
        migration: {
          id: `action-${index}`,
          label: `Action ${index}`,
          phase: "after-session-repair",
          detectLegacyState: () => (fs.existsSync(marker) ? null : { preview: ["pending"] }),
          migrateLegacyState: () => {
            if (failure === "later-action" && index === 1) {
              throw new Error("second action failed");
            }
            fs.writeFileSync(marker, "committed");
            return { changes: [`committed action ${index}`], warnings: [] };
          },
        },
      }));
      const params = {
        config: {},
        env,
        maintenanceAuthority: { assertCurrent() {} },
        plannedActions: controls.entries.map(({ pluginId, migration }) => ({
          pluginId,
          id: migration.id,
        })),
      };

      const first = await runPostSessionPluginDoctorStateRepairs(params);

      expect(fs.readFileSync(markers[0], "utf8")).toBe("committed");
      expect(fs.existsSync(markers[1])).toBe(failure !== "later-action");
      expect(first.changes).toEqual(
        failure === "later-action"
          ? ["committed action 0"]
          : ["committed action 0", "committed action 1"],
      );
      if (failure === "none") {
        expect(first.warnings).toEqual([]);
      } else {
        expect(first.warnings.join("\n")).toContain(
          failure === "later-action" ? "second action failed" : "lease settlement failed",
        );
      }

      const replay = await runPostSessionPluginDoctorStateRepairs(params);
      expect(replay.changes).toEqual([]);
      expect(fs.readFileSync(markers[0], "utf8")).toBe("committed");
    },
  );
});
