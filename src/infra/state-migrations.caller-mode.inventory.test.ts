import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listPluginDoctorStateMigrationEntries } from "../plugins/doctor-contract-registry.js";
import { clearPluginDoctorContractRegistryCache } from "../plugins/doctor-contract-registry.test-fixtures.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { autoMigrateLegacyState } from "./state-migrations.doctor.js";
import { runPostSessionPluginDoctorStateRepairs } from "./state-migrations.plugin-doctor.js";
import { resetAutoMigrateLegacyStateDirForTest } from "./state-migrations.state-dir.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  vi.unstubAllEnvs();
  clearPluginDoctorContractRegistryCache();
  resetAutoMigrateLegacyStateDirForTest();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

it.each([
  "readable",
  "staging-unavailable",
  "undeclared-post-action",
  "changed-phase",
  "changed-authority",
  "automatic-cache",
] as const)(
  "does not silently drop a live post-session action when inventory is %s",
  async (inventory) => {
    const root = await tempDirs.make("openclaw-doctor-live-inventory-");
    const stateDir = path.join(root, "state");
    const pluginId = "inventory-owner";
    const pluginRoot = path.join(root, pluginId);
    const mutationPath = path.join(root, "migrated");
    const cacheRoot = path.join(root, "cache");
    fs.mkdirSync(pluginRoot);
    if (inventory === "staging-unavailable") {
      fs.writeFileSync(cacheRoot, "not a directory");
    } else {
      fs.mkdirSync(cacheRoot);
    }
    vi.stubEnv("XDG_CACHE_HOME", cacheRoot);
    const action = { id: "session-action", phase: "after-session-repair", doctorOnly: true };
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({
        name: "@test/inventory-owner",
        version: "0.0.0",
        type: "commonjs",
        openclaw: { extensions: ["./index.cjs"] },
      }),
    );
    fs.writeFileSync(
      path.join(pluginRoot, "openclaw.plugin.json"),
      JSON.stringify({
        id: pluginId,
        configSchema: {},
        doctorContract: {
          stateMigrations:
            inventory === "undeclared-post-action"
              ? []
              : [
                  {
                    ...action,
                    ...(inventory === "changed-phase" ? { phase: undefined } : {}),
                    ...(inventory === "changed-authority" ? { doctorOnly: false } : {}),
                  },
                ],
        },
      }),
    );
    fs.writeFileSync(path.join(pluginRoot, "index.cjs"), "module.exports = {};\n");
    fs.writeFileSync(
      path.join(pluginRoot, "doctor-contract-api.cjs"),
      `const fs = require("node:fs");
module.exports = { stateMigrations: [{
  ...${JSON.stringify(action)}, label: "Session action",
  detectLegacyState: () => fs.existsSync(${JSON.stringify(mutationPath)}) ? null : { preview: ["pending"] },
  migrateLegacyState: () => {
    fs.writeFileSync(${JSON.stringify(mutationPath)}, "migrated");
    return { changes: ["migrated session action"], warnings: [] };
  },
}] };\n`,
    );
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main", default: true }] },
      plugins: { load: { paths: [pluginRoot] }, entries: { [pluginId]: { enabled: true } } },
    };
    const env = {
      ...process.env,
      HOME: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    };
    fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, JSON.stringify(cfg));
    openOpenClawStateDatabase({ env });
    closeOpenClawStateDatabaseForTest();
    clearPluginDoctorContractRegistryCache();
    if (inventory === "staging-unavailable") {
      // Ordinary reads remain valid. Clear their cache so the next inventory must
      // attempt its own artifact-preserving snapshot rather than reuse this result.
      expect(listPluginDoctorStateMigrationEntries({ config: cfg, env })).toHaveLength(1);
      clearPluginDoctorContractRegistryCache();
    }

    const params = {
      cfg,
      env,
      homedir: () => root,
      doctorOnlyStateMigrations: inventory !== "automatic-cache",
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    };
    const result = await autoMigrateLegacyState(params);

    expect(fs.existsSync(mutationPath)).toBe(false);
    if (inventory === "automatic-cache") {
      expect(result.stepReceipts.length).toBeGreaterThan(0);
      await expect(autoMigrateLegacyState(params)).resolves.toMatchObject({
        mode: "automatic",
        skipped: true,
        changes: [],
        stepReceipts: [],
      });
      return;
    }
    if (inventory !== "readable") {
      expect(result.stepReceipts).toContainEqual(expect.objectContaining({ outcome: "refused" }));
      const blocker = result.stepReceipts.findIndex((receipt) => receipt.outcome === "refused");
      expect(result.stepReceipts[blocker]).toMatchObject({
        id:
          inventory === "staging-unavailable"
            ? "plugin-migration-preparation"
            : "plugin-doctor-state",
        refusal: {
          code:
            inventory === "staging-unavailable" ? "plugin-inventory-unavailable" : "step-refused",
        },
      });
      expect(result.stepReceipts.slice(blocker + 1)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "plugin-doctor-post-session-state",
            outcome: "refused",
            refusal: expect.objectContaining({ code: "blocked-by-prior-refusal" }),
          }),
        ]),
      );
      for (const receipt of result.stepReceipts.slice(blocker + 1)) {
        expect(receipt).toMatchObject({
          outcome: "refused",
          refusal: { code: "blocked-by-prior-refusal" },
        });
      }
      expect(result.postSessionPluginMigration).toBeUndefined();
      if (inventory === "undeclared-post-action") {
        const repeated = await autoMigrateLegacyState(params);
        expect(
          repeated.stepReceipts.map(({ id, outcome, refusal }) => ({ id, outcome, refusal })),
        ).toEqual(
          result.stepReceipts.map(({ id, outcome, refusal }) => ({ id, outcome, refusal })),
        );
      }
      return;
    }
    expect(result.warnings).toEqual([]);
    // A preflight may stop before session health consumes its handoff. A later
    // explicit Doctor invocation must still plan that pending owner from live state.
    const repeated = await autoMigrateLegacyState(params);
    expect(repeated.postSessionPluginMigration).toEqual(result.postSessionPluginMigration);
    expect(repeated.stepReceipts.length).toBeGreaterThan(0);
    const prepared = repeated.postSessionPluginMigration;
    expect(prepared?.step).toMatchObject({
      source: [{ kind: "owner", id: `plugin:${pluginId}:session-action` }],
      target: [{ kind: "owner", id: `plugin:${pluginId}:doctor-state` }],
      requiredness: "conditional",
    });
    await expect(
      runPostSessionPluginDoctorStateRepairs({
        config: cfg,
        env,
        maintenanceAuthority: { assertCurrent() {} },
        plannedActions: prepared?.plannedActions,
      }),
    ).resolves.toEqual({ changes: ["migrated session action"], warnings: [] });
    expect(fs.readFileSync(mutationPath, "utf8")).toBe("migrated");
  },
);
