import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  assertAgentHarnessRunAdmission,
  claimAgentSessionWriter,
} from "../agents/embedded-agent-runner/run/session-bootstrap.js";
import { resolveAgentRunSessionTarget } from "../agents/run-session-target.js";
import { readConfigFileSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import * as providerAuthPersistence from "../plugins/provider-auth-persistence.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { projectInferenceRoute, sameDefaultInferenceRoute } from "./inference-route.js";
import type { ActivateSetupInferenceDeps } from "./setup-inference-core.js";
import {
  applyManualAuthConfig,
  commitManualAuthProfiles,
  persistManualAuthProfiles,
  rollbackManualAuthProfiles,
} from "./setup-inference-persist.js";
import { buildPreparedProviderTestPlan } from "./setup-inference-plan-helpers.js";
import { completeSetupInferenceConfig } from "./setup-inference-verify.js";
import { createSystemAgentModelSelectionUpdater } from "./setup-model-selection.js";

const tempRoots = createTempDirTracker();

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  tempRoots.cleanup();
});

describe("setup completion session ownership", () => {
  it.each([undefined, "openclaw"] as const)(
    "keeps a named owner's completion out of durable sessions (runtime: %s)",
    async (harness) => {
      const root = tempRoots.make("openclaw-setup-completion-");
      const stateDir = path.join(root, "state");
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const config: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: { research: {} },
          defaults: {
            model: { primary: "openai/gpt-5.6-luna" },
            ...(harness
              ? { models: { "openai/gpt-5.6-luna": { agentRuntime: { id: harness } } } }
              : {}),
          },
        },
      };
      const before = structuredClone(config);
      const runEmbeddedAgent = vi.fn<NonNullable<ActivateSetupInferenceDeps["runEmbeddedAgent"]>>(
        async (params) => {
          expect(params.agentId).toBe("research");
          expect(params.agentHarnessRuntimeOverride).toBe(harness);
          expect(params.prompt).toBe("Suggest a short project name.");
          // Follow the runner's admission -> target -> writer order with real accessors.
          assertAgentHarnessRunAdmission(params);
          const sessionTarget = await resolveAgentRunSessionTarget({
            ...params,
            missingSessionKey: "create",
          });
          await claimAgentSessionWriter({ ...params, sessionTarget });
          return {
            payloads: [{ text: "Small Harbor" }],
            meta: {
              durationMs: 1,
              executionTrace: { winnerProvider: params.provider, winnerModel: params.model },
            },
          };
        },
      );

      const result = await completeSetupInferenceConfig({
        config,
        prompt: "Suggest a short project name.",
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        deps: { runEmbeddedAgent },
      });
      await expect(
        fs.access(path.join(stateDir, "agents", "research", "agent", "openclaw-agent.sqlite")),
      ).rejects.toThrow();
      expect(result).toMatchObject({
        ok: true,
        text: "Small Harbor",
        modelRef: "openai/gpt-5.6-luna",
      });
      expect(runEmbeddedAgent).toHaveBeenCalledOnce();
      expect(config).toEqual(before);
    },
  );
});

function createFreshProviderPlan() {
  const root = tempRoots.make("openclaw-manual-auth-conflict-");
  vi.stubEnv("OPENCLAW_HOME", root);
  vi.stubEnv("OPENCLAW_STATE_DIR", path.join(root, "state"));
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
  const sourceConfig: OpenClawConfig = { gateway: { mode: "local" } };
  const runtimeConfig: OpenClawConfig = {
    ...sourceConfig,
    gateway: { ...sourceConfig.gateway, port: 18789 },
  };
  const preparedConfig: OpenClawConfig = {
    ...runtimeConfig,
    plugins: { entries: { "fixture-provider": { enabled: true } } },
    models: {
      providers: {
        "fixture-provider": {
          baseUrl: "https://provider.example/v1",
          api: "openai-completions",
          models: [],
        },
      },
    },
  };
  const plan = buildPreparedProviderTestPlan({
    cfg: runtimeConfig,
    sourceCfg: sourceConfig,
    preparedConfig,
    profiles: [],
    modelRef: "fixture-provider/fixture-model",
    pluginId: "fixture-provider",
    routeAgentId: "main",
    agentDir: path.join(root, "state", "agents", "main", "agent"),
  });
  if ("error" in plan) {
    throw new Error(plan.error);
  }
  if (!plan.manualAuth) {
    throw new Error("Prepared provider plan omitted manual auth");
  }
  return { sourceConfig, runtimeConfig, preparedConfig, manualAuth: plan.manualAuth };
}

describe("prepared provider config commit", () => {
  it.each(["runtime", "source"] as const)(
    "accepts its own fresh plugin enablement against unchanged %s configuration",
    (kind) => {
      const fixture = createFreshProviderPlan();
      const config = kind === "runtime" ? fixture.runtimeConfig : fixture.sourceConfig;
      const before = structuredClone(config);
      const applied = applyManualAuthConfig(config, fixture.manualAuth, fixture.sourceConfig);
      expect(applied.plugins?.entries?.["fixture-provider"]).toEqual({ enabled: true });
      expect(applied.models?.providers?.["fixture-provider"]).toEqual(
        fixture.preparedConfig.models?.providers?.["fixture-provider"],
      );
      expect(applied.gateway).toEqual(config.gateway);
      expect(config).toEqual(before);
    },
  );

  it.each(["runtime", "source"] as const)(
    "still rejects concurrent provider edits and selected-plugin disablement in %s configuration",
    (kind) => {
      const fixture = createFreshProviderPlan();
      const base = kind === "runtime" ? fixture.runtimeConfig : fixture.sourceConfig;
      const concurrentConfigs: OpenClawConfig[] = [
        {
          ...base,
          models: {
            providers: {
              "fixture-provider": {
                baseUrl: "https://operator.example/v1",
                api: "openai-completions",
                models: [],
              },
            },
          },
        },
        { ...base, plugins: { entries: { "fixture-provider": { enabled: false } } } },
      ];
      for (const config of concurrentConfigs) {
        const before = structuredClone(config);
        expect(() => applyManualAuthConfig(config, fixture.manualAuth, config)).toThrow(
          "Provider configuration changed during the live inference test",
        );
        expect(config).toEqual(before);
      }
    },
  );

  it("validates current plugin policy before checking conflicts", () => {
    const fixture = createFreshProviderPlan();
    const config: OpenClawConfig = { ...fixture.sourceConfig, plugins: { enabled: false } };
    expect(() => applyManualAuthConfig(config, fixture.manualAuth, config)).toThrow(
      "Provider plugin fixture-provider is plugins disabled.",
    );
    expect(config.plugins?.enabled).toBe(false);
  });

  it("preserves an unrelated operator edit while applying the prepared provider", () => {
    const fixture = createFreshProviderPlan();
    const config: OpenClawConfig = {
      ...fixture.sourceConfig,
      gateway: { mode: "local", port: 19000 },
    };
    const applied = applyManualAuthConfig(config, fixture.manualAuth, config);
    expect(applied.gateway?.port).toBe(19000);
    expect(applied.plugins?.entries?.["fixture-provider"]?.enabled).toBe(true);
  });
});

describe("manual auth rollback", () => {
  it("preserves the primary activation failure when protected commit also fails", async () => {
    const primaryError = new Error("synthetic activation failure");
    const releaseError = new Error("synthetic protected release failure");
    const message = "Activation failed and protected storage could not be released.";
    const receipt = {
      agentDir: "/synthetic/agent",
      profiles: [],
      insertedProfileIds: new Set<string>(),
      protectedPersistence: {
        profiles: [],
        rollback: vi.fn(async () => {}),
        commit: vi.fn(async () => {
          throw releaseError;
        }),
      },
    };

    const failure = await commitManualAuthProfiles(receipt, { primaryError, message }).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({
      message,
      errors: [primaryError, releaseError],
      cause: primaryError,
    });
  });

  it("does not duplicate a shared activation and protected release failure", async () => {
    const primaryError = new Error("synthetic shared failure");
    const receipt = {
      agentDir: "/synthetic/agent",
      profiles: [],
      insertedProfileIds: new Set<string>(),
      protectedPersistence: {
        profiles: [],
        rollback: vi.fn(async () => {}),
        commit: vi.fn(async () => {
          throw primaryError;
        }),
      },
    };

    await expect(
      commitManualAuthProfiles(receipt, {
        primaryError,
        message: "must not wrap the same failure twice",
      }),
    ).rejects.toBe(primaryError);
  });

  it("keeps the persistence failure first when protected rollback also fails", async () => {
    const persistenceError = new Error("synthetic profile persistence failure");
    const rollbackError = new Error("synthetic protected rollback failure");
    const profiles = [
      {
        profileId: "fixture:default",
        credential: {
          type: "token" as const,
          provider: "fixture",
          token: "synthetic-token",
        },
      },
    ];
    const rollback = vi.fn(async () => {
      throw rollbackError;
    });
    const stage = vi
      .spyOn(providerAuthPersistence, "stageProviderAuthProfilesForPersistence")
      .mockResolvedValueOnce({
        profiles,
        commit: vi.fn(async () => {}),
        rollback,
      });

    let failure: unknown;
    try {
      await persistManualAuthProfiles({
        profiles,
        agentDir: "/synthetic/agent",
        deps: {
          updateAuthProfileStoreWithLock: vi.fn(async () => {
            throw persistenceError;
          }),
        },
        secretStorage: { config: {} },
      });
    } catch (error) {
      failure = error;
    }
    stage.mockRestore();

    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors).toEqual([persistenceError, rollbackError]);
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("settles protected storage after indeterminate profile removal", async () => {
    const insertedProfileIds = new Set(["fixture:inserted"]);
    const rollback = vi.fn(async (_retainProfileIds?: ReadonlySet<string>) => {});
    const commit = vi.fn(async () => {});
    const updateAuthProfileStoreWithLock = vi.fn(async () => null);

    await expect(
      rollbackManualAuthProfiles(
        {
          agentDir: "/synthetic/agent",
          profiles: [
            {
              profileId: "fixture:inserted",
              credential: {
                type: "token",
                provider: "fixture",
                token: "synthetic-token",
              },
            },
          ],
          insertedProfileIds,
          protectedPersistence: {
            profiles: [],
            rollback,
            commit,
          },
        },
        {
          updateAuthProfileStoreWithLock,
          loadPersistedAuthProfileStore: () => null,
        },
      ),
    ).resolves.toBe(false);

    expect(updateAuthProfileStoreWithLock).toHaveBeenCalledTimes(3);
    expect(rollback).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledOnce();
  });

  it("surfaces protected storage release failure after indeterminate profile removal", async () => {
    const releaseError = new Error("synthetic lock release failure");
    const updateAuthProfileStoreWithLock = vi.fn(async () => null);

    await expect(
      rollbackManualAuthProfiles(
        {
          agentDir: "/synthetic/agent",
          profiles: [
            {
              profileId: "fixture:inserted",
              credential: {
                type: "token",
                provider: "fixture",
                token: "synthetic-token",
              },
            },
          ],
          insertedProfileIds: new Set(["fixture:inserted"]),
          protectedPersistence: {
            profiles: [],
            rollback: vi.fn(async () => {}),
            commit: vi.fn(async () => {
              throw releaseError;
            }),
          },
        },
        {
          updateAuthProfileStoreWithLock,
          loadPersistedAuthProfileStore: () => null,
        },
      ),
    ).rejects.toBe(releaseError);
  });
});

describe("provider installation changes runtime defaults without editing source", () => {
  it.each([
    { name: "empty", properties: {}, defaults: {} },
    {
      name: "nonempty",
      properties: { timeoutMs: { type: "integer", default: 1000 } },
      defaults: { timeoutMs: 1000 },
    },
  ])(
    "accepts $name materialized plugin config while rejecting authored changes",
    async ({ properties, defaults }) => {
      const root = tempRoots.make("openclaw-installed-provider-defaults-");
      const stateDir = path.join(root, "state");
      const configPath = path.join(stateDir, "openclaw.json");
      vi.stubEnv("HOME", root);
      vi.stubEnv("OPENCLAW_HOME", root);
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
      vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", "1");
      const source: OpenClawConfig = { gateway: { mode: "local" }, plugins: { entries: {} } };
      await fs.mkdir(stateDir, { recursive: true });
      const sourceBytes = JSON.stringify(source) + "\n";
      await fs.writeFile(configPath, sourceBytes);
      const before = await withPluginLifecycleLease({}, async () => readConfigFileSnapshot());
      expect(before.valid).toBe(true);
      expect(before.runtimeConfig.plugins?.entries?.["fixture-provider"]).toBeUndefined();

      // Reproduce the installer's managed npm layout without invoking a package
      // manager. Both snapshots and the final conflict check use their real owners.
      const projectRoot = path.join(stateDir, "npm", "projects", "fixture-provider");
      const pluginRoot = path.join(projectRoot, "node_modules", "@fixture", "provider");
      await fs.mkdir(pluginRoot, { recursive: true });
      await fs.writeFile(
        path.join(projectRoot, "package.json"),
        JSON.stringify({
          private: true,
          dependencies: { "@fixture/provider": "1.0.0" },
        }),
      );
      await fs.writeFile(
        path.join(pluginRoot, "package.json"),
        JSON.stringify({
          name: "@fixture/provider",
          version: "1.0.0",
          openclaw: { extensions: ["./index.cjs"] },
        }),
      );
      await fs.writeFile(
        path.join(pluginRoot, "openclaw.plugin.json"),
        JSON.stringify({
          id: "fixture-provider",
          providers: ["fixture-provider"],
          configSchema: { type: "object", additionalProperties: false, properties },
        }),
      );
      await fs.writeFile(
        path.join(pluginRoot, "index.cjs"),
        'module.exports = { id: "fixture-provider", register() {} };\n',
      );

      await withPluginLifecycleLease({}, async () => {
        const after = await readConfigFileSnapshot();
        expect(after.valid).toBe(true);
        expect(after.hash).toBe(before.hash);
        expect(await fs.readFile(configPath, "utf8")).toBe(sourceBytes);
        expect(after.sourceConfig).toEqual(before.sourceConfig);
        expect(after.sourceConfig.plugins?.entries?.["fixture-provider"]).toBeUndefined();
        expect(after.runtimeConfig.plugins?.entries?.["fixture-provider"]).toEqual({
          config: defaults,
        });
        const projectPair = (runtime: OpenClawConfig, sourceConfig: OpenClawConfig) => {
          return projectInferenceRoute(runtime, "main", {}, sourceConfig);
        };
        const baselineProjection = await projectPair(before.runtimeConfig, before.sourceConfig);
        const rereadProjection = await projectPair(after.runtimeConfig, after.sourceConfig);
        expect(sameDefaultInferenceRoute(baselineProjection, rereadProjection)).toBe(true);
        const preparedConfig: OpenClawConfig = {
          ...before.runtimeConfig,
          plugins: {
            ...before.runtimeConfig.plugins,
            entries: {
              ...before.runtimeConfig.plugins?.entries,
              "fixture-provider": { enabled: true },
            },
          },
          models: {
            providers: {
              "fixture-provider": {
                baseUrl: "https://provider.example/v1",
                api: "openai-completions",
                models: [],
              },
            },
          },
        };
        const plan = buildPreparedProviderTestPlan({
          cfg: before.runtimeConfig,
          sourceCfg: before.sourceConfig,
          preparedConfig,
          profiles: [],
          modelRef: "fixture-provider/fixture-model",
          pluginId: "fixture-provider",
          routeAgentId: "main",
          agentDir: path.join(stateDir, "agents", "main", "agent"),
        });
        if ("error" in plan) {
          throw new Error(plan.error);
        }
        const manualAuth = plan.manualAuth;
        if (!manualAuth) {
          throw new Error("Prepared provider plan omitted manual auth");
        }
        const runtimeResult = applyManualAuthConfig(
          after.runtimeConfig,
          manualAuth,
          after.sourceConfig,
        );
        const sourceResult = applyManualAuthConfig(
          after.sourceConfig,
          manualAuth,
          after.sourceConfig,
        );
        expect(runtimeResult.plugins?.entries?.["fixture-provider"]).toEqual({
          config: defaults,
          enabled: true,
        });
        expect(sourceResult.plugins?.entries?.["fixture-provider"]).toEqual({ enabled: true });
        expect(sourceResult.models?.providers?.["fixture-provider"]).toEqual(
          preparedConfig.models?.providers?.["fixture-provider"],
        );

        const selectModel = await createSystemAgentModelSelectionUpdater({
          model: "fixture-provider/fixture-model",
          agentRuntimeId: "openclaw",
        });
        const verifiedRuntime = selectModel(plan.config);
        const candidateSource = selectModel(sourceResult);
        const stagedRuntime = selectModel(runtimeResult);
        const verifiedProjection = await projectPair(verifiedRuntime, candidateSource);
        const stagedProjection = await projectPair(stagedRuntime, candidateSource);
        expect(sameDefaultInferenceRoute(verifiedProjection, stagedProjection)).toBe(true);
        expect(stagedProjection.route).toMatchObject({
          modelLabel: "fixture-provider/fixture-model",
          runner: "embedded",
          agentHarnessRuntimeOverride: "openclaw",
        });
        const changedPluginPolicies: Array<OpenClawConfig["plugins"]> = [
          { ...candidateSource.plugins, enabled: false },
          { ...candidateSource.plugins, allow: ["fixture-provider"] },
          { ...candidateSource.plugins, deny: ["fixture-provider"] },
          {
            ...candidateSource.plugins,
            entries: { "fixture-provider": { enabled: false } },
          },
          {
            ...candidateSource.plugins,
            entries: { "fixture-provider": { enabled: true, config: { timeoutMs: 2000 } } },
          },
        ];
        for (const plugins of changedPluginPolicies) {
          const changed = await projectPair(stagedRuntime, { ...candidateSource, plugins });
          expect(sameDefaultInferenceRoute(stagedProjection, changed)).toBe(false);
        }
        const changeModel = await createSystemAgentModelSelectionUpdater({
          model: "fixture-provider/different-model",
          agentRuntimeId: "openclaw",
        });
        const changedExecution = await projectPair(changeModel(stagedRuntime), candidateSource);
        expect(sameDefaultInferenceRoute(stagedProjection, changedExecution)).toBe(false);

        // Genuine edits to the touched source remain conflicts for both execution
        // and persistence projections, even though runtime defaults are ignored.
        const changedSources: OpenClawConfig[] = [
          {
            ...after.sourceConfig,
            plugins: { entries: { "fixture-provider": { enabled: false } } },
          },
          {
            ...after.sourceConfig,
            models: {
              providers: {
                "fixture-provider": {
                  baseUrl: "https://operator.example/v1",
                  api: "openai-completions",
                  models: [],
                },
              },
            },
          },
        ];
        for (const changedSource of changedSources) {
          for (const projection of [after.runtimeConfig, changedSource]) {
            expect(() => applyManualAuthConfig(projection, manualAuth, changedSource)).toThrow(
              "Provider configuration changed during the live inference test",
            );
          }
        }
        expect(await fs.readFile(configPath, "utf8")).toBe(sourceBytes);
      });
    },
  );
});
