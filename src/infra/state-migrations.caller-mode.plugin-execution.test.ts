import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pluginDoctorContractRegistryLoaderState } from "../plugins/doctor-contract-registry-loader-state.js";
import { clearPluginDoctorContractRegistryCache } from "../plugins/doctor-contract-registry.test-fixtures.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  expectBlockedTailInPlanOrder,
  expectPlanReceiptDescriptorsToMatch,
  writeLegacyStateSchemaV1,
} from "./state-migrations.caller-mode.test-helpers.js";
import {
  autoMigrateLegacyState,
  detectLegacyStateMigrations,
  planLegacyStateMigrationsReadOnly,
  runLegacyStateMigrations,
} from "./state-migrations.doctor.js";
import { runPostSessionPluginDoctorStateRepairs } from "./state-migrations.plugin-doctor.js";
import { resetAutoMigrateLegacyStateDirForTest } from "./state-migrations.state-dir.js";

const tempDirs = createTrackedTempDirs();

async function makeFixture() {
  const root = await tempDirs.make("openclaw-doctor-caller-execution-");
  const homeDir = path.join(root, "home");
  const stateDir = path.join(root, "state");
  const configPath = path.join(root, "openclaw.json");
  fs.mkdirSync(homeDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.symlinkSync(
    path.resolve("extensions"),
    path.join(root, "extensions"),
    process.platform === "win32" ? "junction" : "dir",
  );
  fs.writeFileSync(configPath, "{}\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
    OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
  };
  return { root, homeDir, stateDir, configPath, env };
}

afterEach(async () => {
  pluginDoctorContractRegistryLoaderState.moduleLoaderFactory = undefined;
  resetAutoMigrateLegacyStateDirForTest();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
  vi.restoreAllMocks();
});

describe("legacy state migration caller plugin execution", () => {
  it("keeps absent migration descriptors stable when plugin migrations are disabled", async () => {
    const fixture = await makeFixture();
    fixture.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    const cfg: OpenClawConfig = { plugins: { enabled: false } };
    fs.writeFileSync(fixture.configPath, `${JSON.stringify(cfg)}\n`);
    const plan = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: { root: fixture.root, version: "test" },
      snapshot: {
        homeDir: fixture.homeDir,
        configPath: fixture.configPath,
        stateDir: fixture.stateDir,
      },
      env: fixture.env,
    });

    const result = await autoMigrateLegacyState({
      cfg,
      doctorOnlyStateMigrations: true,
      env: fixture.env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });

    expectPlanReceiptDescriptorsToMatch({
      plan: {
        ...plan,
        steps: plan.steps.filter((step) => step.id !== "plugin-doctor-post-session-state"),
      },
      receipts: result.stepReceipts,
    });
    expect(result.postSessionPluginMigration?.step).toMatchObject({
      id: "plugin-doctor-post-session-state",
      source: [],
      target: [],
      requiredness: "not-required",
    });
    expect(plan.steps.find((step) => step.id === "plugin-doctor-state")).toMatchObject({
      source: [],
      target: [],
      requiredness: "not-required",
    });
  });

  it.each([
    {
      name: "absent action",
      manifestIds: ["manifest-planned-action"],
      runtimeIds: ["runtime-only-action"],
      pendingIds: ["runtime-only-action"],
      refused: true,
    },
    {
      name: "reordered actions",
      manifestIds: ["first-action", "second-action"],
      runtimeIds: ["second-action", "first-action"],
      pendingIds: ["first-action", "second-action"],
      refused: true,
    },
    {
      name: "reordered exports with only the second action pending",
      manifestIds: ["first-action", "second-action"],
      runtimeIds: ["second-action", "first-action"],
      pendingIds: ["second-action"],
      refused: true,
    },
    {
      name: "missing resolved export",
      manifestIds: ["first-action", "second-action"],
      runtimeIds: ["second-action"],
      pendingIds: ["second-action"],
      refused: true,
    },
    {
      name: "missing exports with no pending preview",
      manifestIds: ["first-action"],
      runtimeIds: [],
      pendingIds: [],
      refused: true,
    },
    {
      name: "matching exports with only the second action pending",
      manifestIds: ["first-action", "second-action"],
      runtimeIds: ["first-action", "second-action"],
      pendingIds: ["second-action"],
      refused: false,
    },
  ])("validates runtime plugin $name against the immutable manifest order", async (testCase) => {
    const fixture = await makeFixture();
    const candidateRoot = path.join(fixture.root, "surprise-candidate");
    const bundledRoot = path.join(candidateRoot, "extensions");
    const pluginRoot = path.join(bundledRoot, "surprise-owner");
    const mutationPath = path.join(fixture.root, "unplanned-migration-ran");
    fs.mkdirSync(pluginRoot, { recursive: true });
    fs.writeFileSync(
      path.join(pluginRoot, "openclaw.plugin.json"),
      `${JSON.stringify({
        id: "surprise-owner",
        configSchema: { type: "object", additionalProperties: false, properties: {} },
        doctorContract: {
          stateMigrations: testCase.manifestIds.map((id) => ({ id })),
        },
      })}\n`,
    );
    fs.writeFileSync(
      path.join(pluginRoot, "index.ts"),
      'export default { id: "surprise-owner", name: "Surprise owner", register() {} };\n',
    );
    fs.writeFileSync(
      path.join(pluginRoot, "doctor-contract-api.ts"),
      `import fs from "node:fs";
export const stateMigrations = ${JSON.stringify(testCase.runtimeIds)}.map((id) => ({
  id,
  label: id,
  detectLegacyState: () => ${JSON.stringify(testCase.pendingIds)}.includes(id) ? { preview: [id + " pending"] } : null,
  migrateLegacyState: () => {
    fs.appendFileSync(${JSON.stringify(mutationPath)}, id + "\\n");
    return { changes: [id + " migrated"], warnings: [] };
  },
}));
`,
    );
    fixture.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledRoot;

    const plan = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: { root: candidateRoot, version: "test" },
      snapshot: {
        homeDir: fixture.homeDir,
        configPath: fixture.configPath,
        stateDir: fixture.stateDir,
      },
      env: fixture.env,
    });
    const plannedSources = testCase.manifestIds.map((id) => ({
      kind: "owner",
      id: `plugin:surprise-owner:${id}`,
    }));
    expect(plan.steps.find((step) => step.refusal !== undefined)).toMatchObject({
      id: "skill-workshop",
      outcome: "deferred",
      refusal: { code: "skill-workshop-planning-deferred" },
    });
    expect(plan.steps.find((step) => step.id === "plugin-doctor-state")).toMatchObject({
      source: plannedSources,
      outcome: "deferred",
      refusal: { code: "blocked-by-prior-refusal" },
    });

    const result = await autoMigrateLegacyState({
      cfg: {},
      doctorOnlyStateMigrations: true,
      env: fixture.env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });

    if (!testCase.refused) {
      expect(
        result.stepReceipts.find((receipt) => receipt.id === "plugin-doctor-state"),
      ).toMatchObject({
        source: plannedSources,
        outcome: "completed",
        changes: ["second-action migrated"],
        warnings: [],
      });
      expect(fs.readFileSync(mutationPath, "utf8")).toBe("second-action\n");
      return;
    }
    expect(
      result.stepReceipts.find((receipt) => receipt.id === "plugin-doctor-state"),
    ).toMatchObject({
      source: plannedSources,
      outcome: "refused",
      refusal: { code: "step-refused" },
      warnings: [expect.stringContaining("immutable action order")],
    });
    expectBlockedTailInPlanOrder({
      plan,
      receipts: result.stepReceipts,
      blockerId: "plugin-doctor-state",
    });
    expectPlanReceiptDescriptorsToMatch({ plan, receipts: result.stepReceipts });
    expect(fs.existsSync(mutationPath)).toBe(false);
  });

  it("executes selected external migrations and later core steps in live Doctor", async () => {
    const fixture = await makeFixture();
    const pluginId = "external-doctor-owner";
    const pluginRoot = path.join(fixture.root, pluginId);
    const mutationPath = path.join(fixture.stateDir, "external-plugin-migrated");
    const postSessionPath = path.join(fixture.stateDir, "external-plugin-session-migrated");
    const legacyAgentDir = path.join(fixture.stateDir, "agent");
    fixture.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    fs.mkdirSync(pluginRoot);
    fs.mkdirSync(legacyAgentDir);
    fs.writeFileSync(path.join(legacyAgentDir, "settings.json"), "{}\n");
    fs.writeFileSync(
      path.join(pluginRoot, "openclaw.plugin.json"),
      `${JSON.stringify({
        id: pluginId,
        name: "External Doctor Owner",
        version: "0.0.0-test",
        configSchema: {},
        doctorContract: { stateMigrations: true, resolveSessionStoreAgentIds: true },
      })}\n`,
    );
    fs.writeFileSync(
      path.join(pluginRoot, "package.json"),
      `${JSON.stringify({
        name: "@openclaw/external-doctor-owner",
        version: "0.0.0-test",
        type: "commonjs",
        openclaw: { extensions: ["./index.cjs"] },
      })}\n`,
    );
    fs.writeFileSync(path.join(pluginRoot, "index.cjs"), "module.exports = {};\n");
    fs.writeFileSync(
      path.join(pluginRoot, "doctor-contract-api.cjs"),
      `const fs = require("node:fs");
module.exports = { stateMigrations: [{
  id: "external-state",
  label: "External state",
  detectLegacyState: () => ({ preview: ["external state pending"] }),
  migrateLegacyState: () => {
    fs.writeFileSync(${JSON.stringify(mutationPath)}, "migrated\\n");
    return { changes: ["migrated external state"], warnings: [] };
  },
}, {
  id: "external-session-state",
  label: "External session state",
  doctorOnly: true,
  phase: "after-session-repair",
  detectLegacyState: () => fs.existsSync(${JSON.stringify(postSessionPath)})
    ? null : ({ preview: ["external session state pending"] }),
  migrateLegacyState: () => {
    fs.writeFileSync(${JSON.stringify(postSessionPath)}, "migrated\\n");
    return { changes: ["migrated external session state"], warnings: [] };
  },
}], resolveSessionStoreAgentIds: () => ["voice"] };
`,
    );
    const cfg: OpenClawConfig = {
      agents: { list: [{ id: "main", default: true }] },
      plugins: {
        load: { paths: [pluginRoot] },
        entries: { [pluginId]: { enabled: true } },
      },
    };
    fs.writeFileSync(fixture.configPath, `${JSON.stringify(cfg)}\n`);
    clearPluginDoctorContractRegistryCache();

    const copiedStatePlan = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: { root: fixture.root, version: "test" },
      snapshot: {
        homeDir: fixture.homeDir,
        configPath: fixture.configPath,
        stateDir: fixture.stateDir,
      },
      env: fixture.env,
    });
    expect(
      copiedStatePlan.steps.find((step) => step.id === "plugin-migration-preparation"),
    ).toMatchObject({
      outcome: "deferred",
      refusal: { code: "plugin-planning-deferred" },
    });
    expect(fs.existsSync(mutationPath)).toBe(false);
    clearPluginDoctorContractRegistryCache();

    const result = await autoMigrateLegacyState({
      cfg,
      doctorOnlyStateMigrations: true,
      env: fixture.env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });

    expect(
      result.stepReceipts.find((receipt) => receipt.id === "plugin-doctor-state"),
    ).toMatchObject({
      source: [{ kind: "owner", id: `plugin:${pluginId}:external-state` }],
      target: [{ kind: "owner", id: `plugin:${pluginId}:doctor-state` }],
      outcome: "completed",
    });
    expect(result.stepReceipts.find((receipt) => receipt.id === "agent-dir")).toMatchObject({
      outcome: "completed",
    });
    expect(
      result.stepReceipts.find((receipt) => receipt.id === "orphan-session-keys")?.source,
    ).toContainEqual({
      kind: "path",
      path: path.join(fixture.stateDir, "agents", "voice", "sessions", "sessions.json"),
    });
    expect(fs.readFileSync(mutationPath, "utf8")).toBe("migrated\n");
    expect(fs.existsSync(legacyAgentDir)).toBe(false);
    const postSession = expectDefined(
      result.postSessionPluginMigration,
      "prepared external plugin session migration",
    );
    expect(postSession.step).toMatchObject({
      source: [{ kind: "owner", id: `plugin:${pluginId}:external-session-state` }],
      target: [{ kind: "owner", id: `plugin:${pluginId}:doctor-state` }],
      requiredness: "conditional",
    });
    expect(fs.existsSync(postSessionPath)).toBe(false);
    const repairParams = {
      config: cfg,
      env: fixture.env,
      maintenanceAuthority: { assertCurrent() {} },
      plannedActions: postSession.plannedActions,
    };
    await expect(runPostSessionPluginDoctorStateRepairs(repairParams)).resolves.toMatchObject({
      changes: ["migrated external session state"],
      warnings: [],
    });
    expect(fs.readFileSync(postSessionPath, "utf8")).toBe("migrated\n");
    await expect(runPostSessionPluginDoctorStateRepairs(repairParams)).resolves.toMatchObject({
      changes: [],
      warnings: [],
    });
  });

  it.each([
    ...([undefined, "after-session-repair"] as const).flatMap((phase) =>
      [true, false].flatMap((legacyRoot) =>
        [true, false].flatMap((fromInstallIndex) =>
          (phase === undefined && !legacyRoot ? [false, true] : [false]).map((direct) => ({
            phase,
            legacyRoot,
            fromInstallIndex,
            direct,
            legacySchema: false,
            excludeDoctorOnly: false,
          })),
        ),
      ),
    ),
    ...[true, false].map((legacySchema) => ({
      phase: undefined,
      legacyRoot: false,
      fromInstallIndex: true,
      direct: true,
      legacySchema,
      excludeDoctorOnly: !legacySchema,
    })),
  ])(
    "discovers live plugin actions across index migration (legacy root: $legacyRoot, phase: $phase, indexed: $fromInstallIndex, direct: $direct, legacy schema: $legacySchema, ordinary-only: $excludeDoctorOnly)",
    async ({ phase, legacyRoot, fromInstallIndex, direct, legacySchema, excludeDoctorOnly }) => {
      const fixture = await makeFixture();
      // This execution fixture has no candidate package. Its config-root plugin directory
      // must contain only the live owner, not makeFixture's copied-plan bundled tree.
      fs.unlinkSync(path.join(fixture.root, "extensions"));
      const legacyStateDir = legacyRoot
        ? path.join(fixture.homeDir, ".clawdbot")
        : fixture.stateDir;
      const stateDir = legacyRoot ? path.join(fixture.homeDir, ".openclaw") : fixture.stateDir;
      const pluginId = "relocated-owner";
      const pluginRoot = fromInstallIndex
        ? path.join(fixture.root, pluginId)
        : path.join(legacyRoot ? fixture.root : stateDir, "extensions", pluginId);
      const markerPath = path.join(fixture.root, "relocated-action-ran");
      const doctorOnlyMarkerPath = path.join(fixture.root, "doctor-only-action-ran");
      fs.mkdirSync(pluginRoot, { recursive: true });
      fs.mkdirSync(path.join(legacyStateDir, "plugins"), { recursive: true });
      fs.writeFileSync(
        path.join(legacyStateDir, "plugins", "installs.json"),
        JSON.stringify({
          records: fromInstallIndex
            ? { [pluginId]: { source: "path", sourcePath: pluginRoot, installPath: pluginRoot } }
            : {},
        }),
      );
      fs.writeFileSync(
        path.join(pluginRoot, "package.json"),
        JSON.stringify({
          name: "@openclaw/relocated-owner",
          version: "0.0.0-test",
          type: "commonjs",
          openclaw: { extensions: ["./index.cjs"] },
        }),
      );
      fs.writeFileSync(
        path.join(pluginRoot, "openclaw.plugin.json"),
        JSON.stringify({
          id: pluginId,
          configSchema: {},
          doctorContract: { stateMigrations: true },
        }),
      );
      fs.writeFileSync(path.join(pluginRoot, "index.cjs"), "module.exports = {};\n");
      fs.writeFileSync(
        path.join(pluginRoot, "doctor-contract-api.cjs"),
        `const fs = require("node:fs");
module.exports = { stateMigrations: [{
  id: "relocated-action",
  label: "Relocated action",
  phase: ${JSON.stringify(phase)},
  detectLegacyState: () => fs.existsSync(${JSON.stringify(markerPath)}) ? null : { preview: ["pending relocated action"] },
  migrateLegacyState: () => {
    fs.writeFileSync(${JSON.stringify(markerPath)}, "migrated");
    return { changes: ["migrated relocated action"], warnings: [] };
  },
}${
          excludeDoctorOnly
            ? `, {
  id: "doctor-only-action",
  label: "Explicit repair only",
  doctorOnly: true,
  detectLegacyState: () => ({ preview: ["pending explicit repair"] }),
  migrateLegacyState: () => {
    fs.writeFileSync(${JSON.stringify(doctorOnlyMarkerPath)}, "must not run");
    return { changes: ["doctor-only action ran"], warnings: [] };
  },
}`
            : ""
        }] };\n`,
      );
      const cfg: OpenClawConfig = {
        agents: { list: [{ id: "main", default: true }] },
        plugins: { entries: { [pluginId]: { enabled: true } } },
      };
      fs.writeFileSync(fixture.configPath, `${JSON.stringify(cfg)}\n`);
      const env: NodeJS.ProcessEnv = {
        ...fixture.env,
        OPENCLAW_HOME: fixture.homeDir,
        OPENCLAW_TEST_FAST: "0",
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      };
      if (legacyRoot) {
        delete env.OPENCLAW_STATE_DIR;
      }
      if (legacySchema) {
        writeLegacyStateSchemaV1(resolveOpenClawStateSqlitePath(env));
      }
      clearPluginDoctorContractRegistryCache();

      const detected = direct
        ? await detectLegacyStateMigrations({
            cfg,
            env,
            doctorOnlyStateMigrations: !excludeDoctorOnly,
            legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
          })
        : undefined;
      if (legacySchema) {
        expect(detected?.stateSchema.hasLegacy).toBe(true);
      }
      const result = direct
        ? await runLegacyStateMigrations({
            detected: expectDefined(detected, "direct migration detection"),
            config: cfg,
            env,
            legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
          })
        : await autoMigrateLegacyState({
            cfg,
            doctorOnlyStateMigrations: true,
            env,
            homedir: () => fixture.homeDir,
            legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
          });

      expect(
        result.stepReceipts.find(
          (receipt) => receipt.id === (legacyRoot ? "state-dir" : "plugin-install-index"),
        ),
      ).toMatchObject({ outcome: "completed" });
      expect(fs.realpathSync(legacyStateDir)).toBe(fs.realpathSync(stateDir));
      expect(result.warnings).toEqual([]);
      if (legacySchema) {
        expect(result.stepReceipts.find((receipt) => receipt.id === "state-schema")).toMatchObject({
          outcome: "completed",
        });
      }
      const source = [{ kind: "owner", id: `plugin:${pluginId}:relocated-action` }];
      const target = [{ kind: "owner", id: `plugin:${pluginId}:doctor-state` }];
      if (phase === "after-session-repair") {
        const prepared = expectDefined(
          "postSessionPluginMigration" in result ? result.postSessionPluginMigration : undefined,
          "relocated post-session action",
        );
        expect(prepared.step).toMatchObject({ source, target, requiredness: "conditional" });
        expect(prepared.plannedActions).toEqual([{ pluginId, id: "relocated-action" }]);
        expect(fs.existsSync(markerPath)).toBe(false);
        await expect(
          runPostSessionPluginDoctorStateRepairs({
            config: cfg,
            env,
            maintenanceAuthority: { assertCurrent() {} },
            plannedActions: prepared.plannedActions,
          }),
        ).resolves.toMatchObject({ changes: ["migrated relocated action"], warnings: [] });
      } else {
        expect(
          result.stepReceipts.find((receipt) => receipt.id === "plugin-doctor-state"),
        ).toMatchObject({ source, target, requiredness: "conditional", outcome: "completed" });
      }
      expect(fs.readFileSync(markerPath, "utf8")).toBe("migrated");
      expect(fs.existsSync(doctorOnlyMarkerPath)).toBe(false);
    },
  );

  it("closes the exact plan after install-index refusal without later discovery or writes", async () => {
    const fixture = await makeFixture();
    fixture.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    const sourcePath = path.join(fixture.stateDir, "plugins", "installs.json");
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, "{invalid");
    const cfg: OpenClawConfig = { plugins: { enabled: false } };
    fs.writeFileSync(fixture.configPath, JSON.stringify(cfg));
    const plan = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: { root: fixture.root, version: "test" },
      snapshot: {
        homeDir: fixture.homeDir,
        stateDir: fixture.stateDir,
        configPath: fixture.configPath,
      },
      env: fixture.env,
    });
    const targetDiscovery = vi.fn(() => {
      throw new Error("target discovery after refusal");
    });
    const result = await autoMigrateLegacyState({
      cfg: Object.defineProperty({ ...cfg }, "session", { get: targetDiscovery }),
      pluginDoctorConfig: cfg,
      doctorOnlyStateMigrations: true,
      env: fixture.env,
      homedir: () => fixture.homeDir,
      legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
    });
    expectBlockedTailInPlanOrder({
      plan,
      receipts: result.stepReceipts,
      blockerId: "plugin-install-index",
    });
    expect(
      result.stepReceipts.find((receipt) => receipt.id === "plugin-install-index"),
    ).toMatchObject({
      outcome: "refused",
      requiredness: "required",
      refusal: { code: "step-refused" },
    });
    expect(targetDiscovery).not.toHaveBeenCalled();
    expect(fs.readFileSync(sourcePath, "utf8")).toBe("{invalid");
  });

  it("defers a dynamic bundled session-store owner without loading its contract in copied planning", async () => {
    const fixture = await makeFixture();
    const cfg: OpenClawConfig = {
      plugins: {
        entries: {
          "voice-call": { enabled: true, config: { agentId: "voice" } },
        },
      },
    };
    fs.writeFileSync(fixture.configPath, `${JSON.stringify(cfg)}\n`);
    const pluginLoader = vi.fn(() => {
      throw new Error("copied planning must not load a Doctor contract");
    });
    pluginDoctorContractRegistryLoaderState.moduleLoaderFactory = pluginLoader;
    const plan = await planLegacyStateMigrationsReadOnly({
      mode: "doctor",
      candidate: { root: fixture.root, version: "test" },
      snapshot: {
        homeDir: fixture.homeDir,
        configPath: fixture.configPath,
        stateDir: fixture.stateDir,
      },
      env: fixture.env,
    });
    expect(plan.steps.find((step) => step.id === "plugin-migration-preparation")).toMatchObject({
      source: expect.arrayContaining([{ kind: "owner", id: "plugin:voice-call" }]),
      outcome: "deferred",
      refusal: { code: "plugin-planning-deferred" },
    });
    expect(pluginLoader).not.toHaveBeenCalled();
  });
});
