// Real config IO; update packages, provider authentication, and host actions are stubbed.
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createConfigIO,
  readConfigFileSnapshot,
  resetConfigRuntimeState,
} from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV } from "../../infra/update-post-core-context.js";
import { defaultRuntime } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";

const controls = vi.hoisted(() => ({ root: "" }));

vi.mock("../../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistryCore: () => ({ plugins: [], diagnostics: [] }),
}));
vi.mock("../../plugins/plugin-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/plugin-registry.js")>()),
  loadPluginManifestRegistryForPluginRegistry: () => ({ plugins: [], diagnostics: [] }),
}));
vi.mock("../../plugins/doctor-contract-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/doctor-contract-registry.js")>()),
  listPluginDoctorLegacyConfigRules: () => [],
  applyPluginDoctorCompatibilityMigrations: () => ({ next: null, changes: [] }),
}));
vi.mock("../../plugins/update-cohort.js", () => ({
  convergePluginReleaseCohort: async ({ config }: { config: OpenClawConfig }) => {
    vi.stubEnv("UPDATE_PROVENANCE_TOKEN", "synthetic-after");
    return {
      config: { ...config, gateway: { ...config.gateway, port: 19001 } },
      changed: true,
      sync: {
        changed: false,
        summary: { errors: [], warnings: [], switchedToBundled: [], switchedToNpm: [] },
      },
      missingPayloads: [],
      remainingMissingPayloads: [],
      repairedMissingPayloadIds: new Set(),
      repairOutcomes: [],
      updateOutcomes: [],
      npmChanged: false,
    };
  },
}));
vi.mock("../../commands/doctor/shared/post-core-plugin-convergence.js", () => ({
  runPostCorePluginConvergence: async () => ({
    changes: [],
    warnings: [],
    installRecords: {},
    errored: false,
  }),
}));
vi.mock("../../plugins/registry-refresh.js", () => ({
  refreshPluginRegistryAfterConfigMutation: vi.fn(),
}));
vi.mock("../plugins-location-bridges.js", () => ({
  listPersistedBundledPluginLocationBridges: async () => [],
}));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  readPackageVersion: async () => "2026.9.2",
  resolveUpdateRoot: async () => controls.root,
}));
vi.mock("./update-command-fresh-doctor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-fresh-doctor.js")>()),
  runUpdateFinalizationDoctorInFreshProcess: vi.fn(async () => {}),
  completePostCorePluginUpdate: async ({ pluginUpdate }: { pluginUpdate: unknown }) => ({
    pluginUpdate,
    configSnapshot: await readConfigFileSnapshot(),
  }),
}));

import { repairLegacyConfigForUpdateChannel } from "../../commands/doctor/legacy-config-repair.js";
import { convergeUpdatePlugins } from "./update-command-convergence.js";
import { updateFinalizeCommand } from "./update-command-finalize.js";
import { updatePluginsAfterCoreUpdate } from "./update-command-plugins.js";
import { resumePostCoreUpdate } from "./update-command-resume.js";

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  resetConfigRuntimeState();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("update config provenance", () => {
  it.each([
    { flow: "plugins", requestedChannel: undefined },
    { flow: "legacy", requestedChannel: undefined },
    ...["converge", "resume", "finalize"].flatMap((flow) =>
      [undefined, "beta" as const].map((requestedChannel) => ({ flow, requestedChannel })),
    ),
  ])(
    "retains env refs through $flow (channel: $requestedChannel)",
    async ({ flow, requestedChannel }) => {
      await withTempHome(async (home) => {
        controls.root = home;
        const stateDir = path.join(home, ".openclaw");
        const configPath = path.join(stateDir, "openclaw.json");
        vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
        vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
        vi.stubEnv("UPDATE_PROVENANCE_TOKEN", "synthetic-before");
        await fs.mkdir(stateDir, { recursive: true });
        await fs.writeFile(
          configPath,
          JSON.stringify({
            gateway: {
              mode: "local",
              ...(flow === "legacy" ? { bind: "localhost" } : {}),
              auth: { mode: "token", token: "${UPDATE_PROVENANCE_TOKEN}" },
            },
          }),
        );
        vi.stubEnv(POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV, requestedChannel);
        resetConfigRuntimeState();
        const prepared = await createConfigIO({
          pluginValidation: "skip",
        }).readConfigFileSnapshotForWrite();
        expect(prepared.snapshot.sourceConfig.gateway?.auth?.token).toBe("synthetic-before");
        if (flow === "plugins") {
          expect(prepared.snapshot.valid).toBe(true);
          await updatePluginsAfterCoreUpdate({
            root: home,
            channel: "stable",
            configSnapshot: prepared.snapshot,
            configWriteOptions: prepared.writeOptions,
            timeoutMs: 1000,
            json: true,
            pluginInstallRecords: {},
          });
        } else if (flow === "legacy") {
          vi.stubEnv("UPDATE_PROVENANCE_TOKEN", "synthetic-after");
          const result = await repairLegacyConfigForUpdateChannel({
            configSnapshot: prepared.snapshot,
            configWriteOptions: prepared.writeOptions,
            jsonMode: true,
          });
          expect(result.repaired).toBe(true);
        } else if (flow === "converge") {
          await convergeUpdatePlugins({
            result: {
              status: "ok",
              mode: "git",
              root: home,
              before: { sha: "same", version: "2026.9.2" },
              after: { sha: "same", version: "2026.9.2" },
              steps: [],
              durationMs: 0,
            },
            root: home,
            installKindChanged: false,
            configSnapshot: prepared.snapshot,
            requestedChannel: requestedChannel ?? null,
            storedChannel: null,
            channel: "stable",
            downgradeRisk: false,
            opts: { json: true },
            preUpdatePluginInstallRecords: {},
            startedAt: Date.now(),
            updateStepTimeoutMs: 1000,
          });
        } else if (flow === "resume") {
          // The real exit is a process boundary, not part of config persistence.
          vi.spyOn(defaultRuntime, "exit").mockImplementation(() => undefined as never);
          vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
          await resumePostCoreUpdate({
            root: home,
            channel: "stable",
            opts: { json: true },
            timeoutMs: 1000,
          });
        } else {
          vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
          await updateFinalizeCommand({
            channel: requestedChannel,
            json: true,
            deferCompletionCache: true,
          });
        }
        const saved = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
        expect(saved.gateway?.auth?.token).toBe("${UPDATE_PROVENANCE_TOKEN}");
        if (flow !== "legacy") {
          expect(saved.gateway?.port).toBe(19001);
        } else {
          expect(saved.gateway?.bind).toBe("loopback");
        }
        if (requestedChannel) {
          expect(saved.update?.channel).toBe(requestedChannel);
        } else {
          expect(saved.update?.channel).toBeUndefined();
        }
        const after = await readConfigFileSnapshot();
        expect(after.sourceConfig.gateway?.auth?.token).toBe("synthetic-after");
      });
    },
  );
});
