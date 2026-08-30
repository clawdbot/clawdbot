// Covers current plugin metadata snapshot generation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeConfiguredProviderCatalogModelId } from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { describe, expect, it, vi } from "vitest";
import {
  getCurrentPluginMetadataSnapshot,
  installTemporaryCurrentPluginMetadataSnapshot,
  isCurrentPluginMetadataSnapshotRuntimeGeneration,
  isScopedPluginMetadataSnapshotRuntimeGeneration,
  setGatewayPluginMetadataSnapshot,
  withPluginMetadataSnapshotScope,
} from "./current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import { getGlobalHookRunnerRegistry } from "./hook-runner-global-state.js";
import { withPluginInstallRoots } from "./install-root-context.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import { writePersistedInstalledPluginIndexSync } from "./installed-plugin-index-store-write.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { resolvePluginControlPlaneFingerprint } from "./plugin-control-plane-context.js";
import {
  clearPluginMetadataLifecycleCaches,
  retainGatewayPluginMetadata,
} from "./plugin-metadata-lifecycle.js";
import {
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { resolveProviderRuntimePlugin } from "./provider-hook-runtime.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "./runtime/generation-scope.js";

function createSnapshot(
  params: {
    config?: Parameters<typeof resolveInstalledPluginIndexPolicyHash>[0];
    pluginIds?: readonly string[];
    normalizationAlias?: string;
    registrySource?: PluginMetadataSnapshot["registrySource"];
    workspaceDir?: string;
  } = {},
): PluginMetadataSnapshot {
  const plugins: PluginManifestRecord[] = params.normalizationAlias
    ? [
        {
          id: "fixture",
          channels: [],
          providers: [],
          cliBackends: [],
          skills: [],
          hooks: [],
          origin: "config",
          rootDir: "/fixture",
          source: "test",
          manifestPath: "/fixture/openclaw.plugin.json",
          modelIdNormalization: {
            providers: {
              fixture: {
                aliases: { raw: params.normalizationAlias },
              },
            },
          },
        },
      ]
    : [];
  return {
    policyHash: resolveInstalledPluginIndexPolicyHash(params.config),
    ...(params.pluginIds !== undefined ? { pluginIds: params.pluginIds } : {}),
    ...(params.registrySource ? { registrySource: params.registrySource } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    index: {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash: resolveInstalledPluginIndexPolicyHash(params.config),
      generatedAtMs: 1,
      installRecords: {},
      plugins: [],
      diagnostics: [],
    },
    registryDiagnostics: [],
    manifestRegistry: { plugins, diagnostics: [] },
    plugins,
    diagnostics: [],
    byPluginId: new Map(),
    normalizePluginId: (pluginId) => pluginId,
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: 0,
    },
  };
}

describe("current plugin metadata snapshot", () => {
  it("returns the current snapshot only for matching config policy and workspace", () => {
    const config = { plugins: { allow: ["demo"] } };
    const snapshot = createSnapshot({ config, workspaceDir: "/workspace/a" });
    setCurrentPluginMetadataSnapshot(snapshot, { config });

    expect(getCurrentPluginMetadataSnapshot({ config, workspaceDir: "/workspace/a" })).toBe(
      snapshot,
    );
    expect(getCurrentPluginMetadataSnapshot({ config })).toBeUndefined();
    expect(
      getCurrentPluginMetadataSnapshot({
        config: { plugins: { allow: ["other"] } },
        workspaceDir: "/workspace/a",
      }),
    ).toBeUndefined();
    expect(
      getCurrentPluginMetadataSnapshot({ config, workspaceDir: "/workspace/b" }),
    ).toBeUndefined();
  });

  it("keeps owner-prepared metadata scoped to nested async work", async () => {
    const globalConfig = { plugins: { allow: ["global"] } };
    const scopedConfig = { plugins: { allow: ["scoped"] } };
    const globalSnapshot = createSnapshot({
      config: globalConfig,
      workspaceDir: "/workspace/global",
    });
    const scopedSnapshot = createSnapshot({
      config: scopedConfig,
      workspaceDir: "/workspace/scoped",
    });
    setCurrentPluginMetadataSnapshot(globalSnapshot, { config: globalConfig });

    await withPluginMetadataSnapshotScope(
      scopedSnapshot,
      async () => {
        await Promise.resolve();
        expect(
          getCurrentPluginMetadataSnapshot({
            config: scopedConfig,
            workspaceDir: "/workspace/scoped",
          }),
        ).toBe(scopedSnapshot);
        expect(
          getCurrentPluginMetadataSnapshot({
            config: globalConfig,
            workspaceDir: "/workspace/global",
          }),
        ).toBe(globalSnapshot);
      },
      { config: scopedConfig },
    );

    expect(
      getCurrentPluginMetadataSnapshot({
        config: scopedConfig,
        workspaceDir: "/workspace/scoped",
      }),
    ).toBeUndefined();
    expect(
      getCurrentPluginMetadataSnapshot({
        config: globalConfig,
        workspaceDir: "/workspace/global",
      }),
    ).toBe(globalSnapshot);
  });

  it("carries prepared metadata and registry across nested agent workspaces", async () => {
    const config = { plugins: { allow: ["scoped"] } };
    const pluginWorkspaceDir = "/workspace/plugins";
    const agentWorkspaceDir = "/workspace/agent-run";
    const metadataSnapshot = createSnapshot({ config, workspaceDir: pluginWorkspaceDir });
    const pluginRegistry = createEmptyPluginRegistry();
    setCurrentPluginMetadataSnapshot(undefined);

    await withPluginRuntimeGenerationScope(
      { config, metadataSnapshot, pluginRegistry },
      async () => {
        await Promise.resolve();
        expect(getCurrentPluginMetadataSnapshot({ config, workspaceDir: agentWorkspaceDir })).toBe(
          metadataSnapshot,
        );
        expect(getCurrentPluginMetadataSnapshot({ config, workspaceDir: pluginWorkspaceDir })).toBe(
          metadataSnapshot,
        );
        expect(
          getCurrentPluginMetadataSnapshot({
            config: { plugins: { allow: ["derived-run-policy"] } },
            env: { OPENCLAW_BUNDLED_PLUGINS_DIR: "/plugins/redirected-run" },
            workspaceDir: agentWorkspaceDir,
          }),
        ).toBe(metadataSnapshot);
        expect(isCurrentPluginMetadataSnapshotRuntimeGeneration(metadataSnapshot)).toBe(true);
        expect(isScopedPluginMetadataSnapshotRuntimeGeneration(metadataSnapshot)).toBe(true);
        expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(pluginRegistry);
      },
    );

    expect(isCurrentPluginMetadataSnapshotRuntimeGeneration(metadataSnapshot)).toBe(false);
    expect(isScopedPluginMetadataSnapshotRuntimeGeneration(metadataSnapshot)).toBe(false);
    expect(
      getCurrentPluginMetadataSnapshot({ config, workspaceDir: agentWorkspaceDir }),
    ).toBeUndefined();
    expect(getPluginRuntimeGatewayRequestScope()).toBeUndefined();
  });

  it("isolates a finite registry-less nested generation and restores the outer generation on rejection", async () => {
    const outerConfig = { plugins: { allow: ["outer"] } };
    const innerConfig = { plugins: { allow: ["inner"] } };
    const outerSnapshot = createSnapshot({ config: outerConfig, workspaceDir: "/workspace/outer" });
    const innerSnapshot = createSnapshot({
      config: innerConfig,
      workspaceDir: "/workspace/inner",
      pluginIds: ["inner"],
    });
    const outerRegistry = createEmptyPluginRegistry();
    outerRegistry.providers.push({
      pluginId: "outer",
      source: "test",
      provider: { id: "outer", label: "Outer", auth: [] },
    });
    outerRegistry.trustedToolPolicies = [
      {
        pluginId: "outer",
        pluginName: "Outer",
        source: "test",
        policy: {
          id: "outer-policy",
          description: "outer",
          evaluate: () => undefined,
        },
      },
    ];
    setActivePluginRegistry(outerRegistry, "outer-generation", "default", "/workspace/outer");

    try {
      await withPluginRuntimeGenerationScope(
        {
          config: outerConfig,
          metadataSnapshot: outerSnapshot,
          pluginRegistry: outerRegistry,
        },
        async () => {
          await expect(
            withPluginRuntimeGenerationScope(
              {
                config: innerConfig,
                metadataSnapshot: innerSnapshot,
              },
              async () => {
                await Promise.resolve();
                expect(
                  getCurrentPluginMetadataSnapshot({
                    config: innerConfig,
                    workspaceDir: "/workspace/inner",
                  }),
                ).toBe(innerSnapshot);
                expect(
                  resolvePluginMetadataSnapshot({
                    config: outerConfig,
                    workspaceDir: "/workspace/outer",
                  }),
                ).toBe(innerSnapshot);
                expect(resolvePluginMetadataSnapshot({ pluginIds: [] }).pluginIds).toEqual([]);
                expect(() => resolvePluginMetadataSnapshot({ pluginIds: ["outer"] })).toThrow(
                  "cannot widen a prepared scope",
                );
                expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).not.toBe(
                  outerRegistry,
                );
                expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry?.providers).toEqual(
                  [],
                );
                expect(resolveProviderRuntimePlugin({ provider: "outer" })).toBeUndefined();
                expect(getGlobalHookRunnerRegistry()?.trustedToolPolicies).toEqual([]);
                throw new Error("inner generation failed");
              },
            ),
          ).rejects.toThrow("inner generation failed");

          expect(
            getCurrentPluginMetadataSnapshot({
              config: outerConfig,
              workspaceDir: "/workspace/outer",
            }),
          ).toBe(outerSnapshot);
          expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(outerRegistry);
          expect(resolveProviderRuntimePlugin({ provider: "outer" })?.id).toBe("outer");
          expect(
            getGlobalHookRunnerRegistry()?.trustedToolPolicies?.map((entry) => entry.policy.id),
          ).toEqual(["outer-policy"]);
        },
      );

      expect(getCurrentPluginMetadataSnapshot()).toBeUndefined();
      expect(getPluginRuntimeGatewayRequestScope()).toBeUndefined();
    } finally {
      resetPluginRuntimeStateForTest();
    }
  });

  it("lets configless nested readers inherit explicit owner discovery context", () => {
    const config = {
      plugins: {
        allow: ["scoped"],
        load: { paths: ["/plugins/scoped"] },
      },
    };
    const snapshot = createSnapshot({ config, workspaceDir: "/workspace/scoped" });
    setCurrentPluginMetadataSnapshot(undefined);

    withPluginMetadataSnapshotScope(
      snapshot,
      () => {
        expect(
          getCurrentPluginMetadataSnapshot({
            requireDefaultDiscoveryContext: true,
          }),
        ).toBe(snapshot);
        expect(getCurrentPluginMetadataSnapshot({ config })).toBe(snapshot);
      },
      { config },
    );

    expect(
      getCurrentPluginMetadataSnapshot({
        allowWorkspaceScopedSnapshot: true,
        requireDefaultDiscoveryContext: true,
      }),
    ).toBeUndefined();
  });

  it("isolates concurrent owner-prepared metadata scopes", async () => {
    const firstConfig = { plugins: { allow: ["first"] } };
    const secondConfig = { plugins: { allow: ["second"] } };
    const first = createSnapshot({ config: firstConfig, workspaceDir: "/workspace/first" });
    const second = createSnapshot({ config: secondConfig, workspaceDir: "/workspace/second" });

    const [firstResult, secondResult] = await Promise.all([
      withPluginMetadataSnapshotScope(
        first,
        async () => {
          await Promise.resolve();
          return getCurrentPluginMetadataSnapshot({
            config: firstConfig,
            workspaceDir: "/workspace/first",
          });
        },
        { config: firstConfig },
      ),
      withPluginMetadataSnapshotScope(
        second,
        async () => {
          await Promise.resolve();
          return getCurrentPluginMetadataSnapshot({
            config: secondConfig,
            workspaceDir: "/workspace/second",
          });
        },
        { config: secondConfig },
      ),
    ]);

    expect(firstResult).toBe(first);
    expect(secondResult).toBe(second);
  });

  it("falls through nested scopes and restores the parent after rejection", async () => {
    const outerConfig = { plugins: { allow: ["outer"] } };
    const innerConfig = { plugins: { allow: ["inner"] } };
    const outer = createSnapshot({ config: outerConfig, workspaceDir: "/workspace/outer" });
    const inner = createSnapshot({ config: innerConfig, workspaceDir: "/workspace/inner" });
    setCurrentPluginMetadataSnapshot(undefined);

    await withPluginMetadataSnapshotScope(
      outer,
      async () => {
        await expect(
          withPluginMetadataSnapshotScope(
            inner,
            async () => {
              expect(
                getCurrentPluginMetadataSnapshot({
                  config: outerConfig,
                  workspaceDir: "/workspace/outer",
                }),
              ).toBe(outer);
              throw new Error("scope failed");
            },
            { config: innerConfig },
          ),
        ).rejects.toThrow("scope failed");
        expect(
          getCurrentPluginMetadataSnapshot({
            config: outerConfig,
            workspaceDir: "/workspace/outer",
          }),
        ).toBe(outer);
      },
      { config: outerConfig },
    );
  });

  it("reuses prepared compatible config identities without filesystem probes", () => {
    const sourceConfig = { plugins: { allow: ["source"] } };
    const runtimeConfig = { plugins: { allow: ["runtime"] } };
    const snapshot = createSnapshot({ config: sourceConfig, workspaceDir: "/workspace" });
    const env = { HOME: path.join(os.tmpdir(), "prepared-metadata-alias-home") };
    const preparedConfigFingerprint = resolvePluginControlPlaneFingerprint({
      config: sourceConfig,
      env,
      index: snapshot.index,
      workspaceDir: snapshot.workspaceDir,
    });
    const rootProbes = vi.spyOn(fs, "existsSync");
    try {
      withPluginMetadataSnapshotScope(
        snapshot,
        () => {
          expect(
            getCurrentPluginMetadataSnapshot({
              config: runtimeConfig,
              env,
              workspaceDir: "/workspace",
            }),
          ).toBe(snapshot);
          expect(rootProbes).not.toHaveBeenCalled();
          expect(
            getCurrentPluginMetadataSnapshot({
              config: {
                plugins: { ...runtimeConfig.plugins, load: { paths: ["/plugins/foreign"] } },
              },
              env,
              workspaceDir: "/workspace",
            }),
          ).toBeUndefined();
        },
        {
          config: sourceConfig,
          compatibleConfigs: [runtimeConfig],
          env,
          preparedConfigFingerprint,
        },
      );
    } finally {
      rootProbes.mockRestore();
    }
  });

  it("invalidates a generic scope when the config identity has a different policy", () => {
    const config = { plugins: { allow: ["source"] } };
    const workspaceDir = "/workspace";
    const snapshot = createSnapshot({ config, workspaceDir });
    config.plugins.allow = ["runtime"];

    withPluginMetadataSnapshotScope(
      snapshot,
      () => {
        expect(getCurrentPluginMetadataSnapshot({ config, workspaceDir })).toBeUndefined();
      },
      { config },
    );
  });

  it("trusts the config identity paired with an immutable runtime generation", () => {
    const sourceConfig = { plugins: { allow: ["source"] } };
    const runtimeConfig = { plugins: { allow: ["runtime"] } };
    const workspaceDir = "/workspace";
    const snapshot = createSnapshot({ config: sourceConfig, workspaceDir });

    withPluginRuntimeGenerationScope({ config: runtimeConfig, metadataSnapshot: snapshot }, () => {
      expect(getCurrentPluginMetadataSnapshot({ config: runtimeConfig, workspaceDir })).toBe(
        snapshot,
      );
    });
  });

  it("can opt into reusing the stored workspace scope for unscoped control-plane readers", () => {
    const config = { plugins: { allow: ["demo"] } };
    const snapshot = createSnapshot({ config, workspaceDir: "/workspace/a" });
    setCurrentPluginMetadataSnapshot(snapshot, { config });

    expect(
      getCurrentPluginMetadataSnapshot({
        config,
        allowWorkspaceScopedSnapshot: true,
      }),
    ).toBe(snapshot);
  });

  it("rejects a current snapshot when plugin load paths change", () => {
    const config = { plugins: { load: { paths: ["/plugins/one"] } } };
    const snapshot = createSnapshot({ config });
    setCurrentPluginMetadataSnapshot(snapshot, { config });

    expect(getCurrentPluginMetadataSnapshot({ config })).toBe(snapshot);
    expect(
      getCurrentPluginMetadataSnapshot({
        config: { plugins: { load: { paths: ["/plugins/two"] } } },
      }),
    ).toBeUndefined();
  });

  it("rejects configless default-discovery reuse for snapshots created with load paths", () => {
    const config = { plugins: { allow: ["demo"], load: { paths: ["/plugins/one"] } } };
    const snapshot = createSnapshot({ config });
    setCurrentPluginMetadataSnapshot(snapshot, { config });

    expect(
      getCurrentPluginMetadataSnapshot({
        allowWorkspaceScopedSnapshot: true,
        requireDefaultDiscoveryContext: true,
      }),
    ).toBeUndefined();
  });

  it("reuses published configless default-discovery metadata without filesystem probes", () => {
    const config = { plugins: { allow: ["demo"] } };
    const snapshot = createSnapshot({ config });
    const env = { HOME: path.join(os.tmpdir(), "prepared-metadata-default-home") };
    setCurrentPluginMetadataSnapshot(snapshot, { config, env });

    const rootProbes = vi.spyOn(fs, "existsSync");
    try {
      expect(
        getCurrentPluginMetadataSnapshot({
          env,
          allowWorkspaceScopedSnapshot: true,
          requireDefaultDiscoveryContext: true,
        }),
      ).toBe(snapshot);
      expect(rootProbes).not.toHaveBeenCalled();
    } finally {
      rootProbes.mockRestore();
    }
  });

  it("rejects configless default-discovery reuse for scoped snapshots", () => {
    const config = { plugins: { allow: ["demo"] } };
    const snapshot = createSnapshot({ config, pluginIds: ["demo"] });
    setCurrentPluginMetadataSnapshot(snapshot, { config });

    expect(getCurrentPluginMetadataSnapshot({ config })).toBeUndefined();
    expect(
      getCurrentPluginMetadataSnapshot({
        allowWorkspaceScopedSnapshot: true,
      }),
    ).toBeUndefined();
  });

  it("requires exact plugin scope when the caller requests scoped reuse", () => {
    const config = { plugins: { allow: ["demo", "other"] } };
    const unscoped = createSnapshot({ config });
    setCurrentPluginMetadataSnapshot(unscoped, { config });

    expect(getCurrentPluginMetadataSnapshot({ config, pluginIds: ["demo"] })).toBeUndefined();

    const scoped = createSnapshot({ config, pluginIds: ["other", "demo"] });
    setCurrentPluginMetadataSnapshot(scoped, { config });

    expect(getCurrentPluginMetadataSnapshot({ config })).toBeUndefined();
    expect(getCurrentPluginMetadataSnapshot({ config, allowScopedSnapshot: true })).toBe(scoped);
    expect(getCurrentPluginMetadataSnapshot({ config, pluginIds: ["demo", "other"] })).toBe(scoped);
    expect(getCurrentPluginMetadataSnapshot({ config, pluginIds: ["demo"] })).toBeUndefined();

    const retained = createSnapshot({ config, pluginIds: ["demo"] });
    withPluginRuntimeGenerationScope({ config, metadataSnapshot: retained }, () => {
      expect(getCurrentPluginMetadataSnapshot({ config })).toBe(retained);
      expect(
        getCurrentPluginMetadataSnapshot({ config, pluginIds: ["demo", "other"] }),
      ).toBeUndefined();
    });
  });

  it("requires exact plugin scope when the caller derives scope from the current index", () => {
    const config = { plugins: { allow: ["demo", "other"] } };
    const pluginIdScope = {
      key: "test-scope",
      resolve: () => ["demo", "other"],
    };
    const unscoped = createSnapshot({ config });
    setCurrentPluginMetadataSnapshot(unscoped, { config });

    expect(getCurrentPluginMetadataSnapshot({ config, pluginIdScope })).toBeUndefined();

    const scoped = createSnapshot({ config, pluginIds: ["other", "demo"] });
    setCurrentPluginMetadataSnapshot(scoped, { config });

    expect(getCurrentPluginMetadataSnapshot({ config, pluginIdScope })).toBe(scoped);
  });

  it("rejects exact cached config when env-resolved plugin load paths change", () => {
    const config = { plugins: { load: { paths: ["~/plugins"] } } };
    const snapshot = createSnapshot({ config });
    const snapshotEnv = {
      HOME: "/home/snapshot",
      OPENCLAW_HOME: undefined,
    } as NodeJS.ProcessEnv;
    const requestedEnv = {
      HOME: "/home/requested",
      OPENCLAW_HOME: undefined,
    } as NodeJS.ProcessEnv;
    setCurrentPluginMetadataSnapshot(snapshot, { config, env: snapshotEnv });

    expect(getCurrentPluginMetadataSnapshot({ config, env: snapshotEnv })).toBe(snapshot);
    expect(getCurrentPluginMetadataSnapshot({ config, env: requestedEnv })).toBeUndefined();
  });

  it("rejects exact cached config when explicit bundled plugin roots change", () => {
    const config = {};
    const snapshot = createSnapshot({ config });
    const snapshotEnv = {
      HOME: "/home/snapshot",
      OPENCLAW_HOME: undefined,
      OPENCLAW_BUNDLED_PLUGINS_DIR: "/plugins/snapshot",
    } as NodeJS.ProcessEnv;
    const requestedEnv = {
      HOME: "/home/snapshot",
      OPENCLAW_HOME: undefined,
      OPENCLAW_BUNDLED_PLUGINS_DIR: "/plugins/requested",
    } as NodeJS.ProcessEnv;
    setCurrentPluginMetadataSnapshot(snapshot, { config, env: snapshotEnv });

    expect(getCurrentPluginMetadataSnapshot({ config, env: snapshotEnv })).toBe(snapshot);
    expect(getCurrentPluginMetadataSnapshot({ config, env: requestedEnv })).toBeUndefined();

    withPluginMetadataSnapshotScope(
      snapshot,
      () => {
        expect(getCurrentPluginMetadataSnapshot({ config, env: snapshotEnv })).toBe(snapshot);
        expect(getCurrentPluginMetadataSnapshot({ config, env: requestedEnv })).toBeUndefined();
      },
      { config, env: snapshotEnv },
    );
  });

  it("keeps ordinary metadata within its captured pinned install roots", () => {
    const config = {};
    const snapshot = createSnapshot({ config });
    const roots = {
      extensionsDir: "/plugins/extensions",
      gitDir: "/plugins/git",
      npmDir: "/plugins/npm",
      stateDir: "/plugins/state",
    };
    withPluginInstallRoots(roots, () => {
      setCurrentPluginMetadataSnapshot(snapshot, { config });
      expect(getCurrentPluginMetadataSnapshot({ config })).toBe(snapshot);

      withPluginInstallRoots({ ...roots, npmDir: "/plugins/replacement/npm" }, () => {
        expect(getCurrentPluginMetadataSnapshot({ config })).toBeUndefined();
      });

      expect(getCurrentPluginMetadataSnapshot({ config })).toBe(snapshot);
    });
    expect(getCurrentPluginMetadataSnapshot({ config })).toBeUndefined();
  });

  it("reuses exact cached config after in-place policy changes before reload", () => {
    const config = { plugins: { allow: ["demo"] } };
    const snapshot = createSnapshot({ config });
    setCurrentPluginMetadataSnapshot(snapshot, { config });

    expect(getCurrentPluginMetadataSnapshot({ config })).toBe(snapshot);

    config.plugins.allow = ["other"];

    expect(getCurrentPluginMetadataSnapshot({ config })).toBe(snapshot);
  });

  it("reuses exact cached config after in-place load path changes before reload", () => {
    const config = { plugins: { load: { paths: ["/plugins/one"] } } };
    const snapshot = createSnapshot({ config });
    setCurrentPluginMetadataSnapshot(snapshot, { config });

    expect(getCurrentPluginMetadataSnapshot({ config })).toBe(snapshot);

    config.plugins.load.paths.push("/plugins/two");

    expect(getCurrentPluginMetadataSnapshot({ config })).toBe(snapshot);
  });

  it("rejects exact cached config after in-place env root changes", () => {
    const config = {};
    const snapshot = createSnapshot({ config });
    const env = {
      HOME: "/home/snapshot",
      OPENCLAW_HOME: undefined,
    } as NodeJS.ProcessEnv;
    setCurrentPluginMetadataSnapshot(snapshot, { config, env });

    expect(getCurrentPluginMetadataSnapshot({ config, env })).toBe(snapshot);

    env.HOME = "/home/requested";

    expect(getCurrentPluginMetadataSnapshot({ config, env })).toBeUndefined();
  });

  it("keeps source-policy compatibility when storing an auto-enabled runtime config", () => {
    const sourceConfig = { channels: { telegram: { botToken: "token" } } };
    const autoEnabledConfig = {
      ...sourceConfig,
      plugins: { allow: ["telegram"] },
    };
    const snapshot = createSnapshot({ config: sourceConfig });
    setCurrentPluginMetadataSnapshot(snapshot, { config: autoEnabledConfig });

    expect(getCurrentPluginMetadataSnapshot({ config: sourceConfig })).toBe(snapshot);
    expect(getCurrentPluginMetadataSnapshot({ config: autoEnabledConfig })).toBeUndefined();
  });

  it("accepts explicit compatible configs for gateway runtime reuse", () => {
    const sourceConfig = { channels: { telegram: { botToken: "token" } } };
    const runtimeConfig = {
      ...sourceConfig,
      plugins: { allow: ["telegram"] },
    };
    const snapshot = createSnapshot({ config: sourceConfig, workspaceDir: "/workspace" });
    setCurrentPluginMetadataSnapshot(snapshot, {
      config: sourceConfig,
      compatibleConfigs: [runtimeConfig],
      workspaceDir: "/workspace",
    });

    expect(
      getCurrentPluginMetadataSnapshot({ config: sourceConfig, workspaceDir: "/workspace" }),
    ).toBe(snapshot);
    expect(
      getCurrentPluginMetadataSnapshot({ config: runtimeConfig, workspaceDir: "/workspace" }),
    ).toBe(snapshot);
  });

  it("clears the current snapshot", () => {
    setCurrentPluginMetadataSnapshot(createSnapshot());
    clearCurrentPluginMetadataSnapshot();

    expect(getCurrentPluginMetadataSnapshot()).toBeUndefined();
  });

  it("clears the complete current snapshot when its metadata lifecycle is invalidated", () => {
    const config = { plugins: { allow: ["demo"] } };
    setCurrentPluginMetadataSnapshot(createSnapshot({ config }), { config });

    clearPluginMetadataLifecycleCaches();

    expect(getCurrentPluginMetadataSnapshot({ config })).toBeUndefined();
  });

  it("keeps derived registry snapshots as the current process snapshot", () => {
    const persisted = createSnapshot({ registrySource: "persisted" });
    const derived = createSnapshot({ registrySource: "derived" });
    setCurrentPluginMetadataSnapshot(persisted);
    setCurrentPluginMetadataSnapshot(derived);

    expect(getCurrentPluginMetadataSnapshot()).toBe(derived);
  });

  it("restores the previous current snapshot after a temporary lease", () => {
    const firstConfig = { plugins: { allow: ["first"] } };
    const secondConfig = {
      plugins: { allow: ["second"], load: { paths: ["/plugins/temporary"] } },
    };
    const first = createSnapshot({ config: firstConfig });
    const second = createSnapshot({ config: secondConfig });
    setCurrentPluginMetadataSnapshot(first, { config: firstConfig });

    const lease = installTemporaryCurrentPluginMetadataSnapshot(second, {
      config: secondConfig,
    });
    expect(getCurrentPluginMetadataSnapshot({ config: secondConfig })).toBe(second);
    expect(
      getCurrentPluginMetadataSnapshot({ requireDefaultDiscoveryContext: true }),
    ).toBeUndefined();
    expect(lease.release()).toBe(true);

    expect(getCurrentPluginMetadataSnapshot({ config: firstConfig })).toBe(first);
    expect(getCurrentPluginMetadataSnapshot({ requireDefaultDiscoveryContext: true })).toBe(first);
    expect(getCurrentPluginMetadataSnapshot({ config: secondConfig })).toBeUndefined();
    expect(lease.release()).toBe(false);
  });

  it("restores exact config identity and environment across a temporary metadata snapshot", () => {
    const config = { plugins: { load: { paths: ["~/plugins"] } } };
    const snapshot = createSnapshot({ config });
    const originalEnv = {
      HOME: "/home/original-snapshot",
      OPENCLAW_HOME: undefined,
    } as NodeJS.ProcessEnv;
    const changedEnv = {
      HOME: "/home/changed-snapshot",
      OPENCLAW_HOME: undefined,
    } as NodeJS.ProcessEnv;
    setCurrentPluginMetadataSnapshot(snapshot, { config, env: originalEnv });

    const lease = installTemporaryCurrentPluginMetadataSnapshot(createSnapshot());
    expect(lease.release()).toBe(true);

    expect(getCurrentPluginMetadataSnapshot({ config, env: originalEnv })).toBe(snapshot);
    expect(getCurrentPluginMetadataSnapshot({ config, env: changedEnv })).toBeUndefined();
  });

  it("restores exact config identity after in-place changes", () => {
    const config = { plugins: { allow: ["first"] } };
    const snapshot = createSnapshot({ config });
    setCurrentPluginMetadataSnapshot(snapshot, { config });

    const lease = installTemporaryCurrentPluginMetadataSnapshot(createSnapshot());
    expect(lease.release()).toBe(true);
    config.plugins.allow = ["changed"];

    expect(getCurrentPluginMetadataSnapshot({ config })).toBe(snapshot);
  });

  it("does not release a temporary lease over a newer publication or lifecycle clear", () => {
    const original = createSnapshot();
    const temporary = createSnapshot();
    const newer = createSnapshot();
    setCurrentPluginMetadataSnapshot(original);

    const clearedLease = installTemporaryCurrentPluginMetadataSnapshot(temporary);
    clearCurrentPluginMetadataSnapshot();
    expect(clearedLease.release()).toBe(false);
    expect(getCurrentPluginMetadataSnapshot()).toBeUndefined();

    const replacedLease = installTemporaryCurrentPluginMetadataSnapshot(temporary);
    const releaseGateway = retainGatewayPluginMetadata();
    try {
      setGatewayPluginMetadataSnapshot(newer);
      expect(replacedLease.release()).toBe(false);
      expect(getCurrentPluginMetadataSnapshot()).toBe(newer);
      expect(isCurrentPluginMetadataSnapshotRuntimeGeneration(newer)).toBe(true);
      expect(isScopedPluginMetadataSnapshotRuntimeGeneration(newer)).toBe(false);
      expect(() => setGatewayPluginMetadataSnapshot(original)).toThrow("after shutdown");
      expect(() => installTemporaryCurrentPluginMetadataSnapshot(temporary)).toThrow(
        "after shutdown",
      );
      setCurrentPluginMetadataSnapshot(original);
      expect(getCurrentPluginMetadataSnapshot()).toBe(newer);
    } finally {
      releaseGateway();
    }
    expect(getCurrentPluginMetadataSnapshot()).toBeUndefined();
  });

  it("unwinds nested temporary leases when they release out of order", () => {
    const original = createSnapshot();
    const outerSnapshot = createSnapshot();
    const innerSnapshot = createSnapshot();
    setCurrentPluginMetadataSnapshot(original);

    const outer = installTemporaryCurrentPluginMetadataSnapshot(outerSnapshot);
    const inner = installTemporaryCurrentPluginMetadataSnapshot(innerSnapshot);

    expect(outer.release()).toBe(false);
    expect(getCurrentPluginMetadataSnapshot()).toBe(innerSnapshot);
    expect(inner.release()).toBe(true);
    expect(getCurrentPluginMetadataSnapshot()).toBe(original);
    expect(inner.release()).toBe(false);
  });

  it("restores the exact captured model normalization records", () => {
    const original = createSnapshot({ normalizationAlias: "original" });
    const temporary = createSnapshot({ normalizationAlias: "temporary" });
    const env = {
      HOME: "/home/original-snapshot",
      OPENCLAW_HOME: undefined,
    } as NodeJS.ProcessEnv;
    setCurrentPluginMetadataSnapshot(original, { env });
    expect(normalizeConfiguredProviderCatalogModelId("fixture", "raw")).toBe("original");

    const lease = installTemporaryCurrentPluginMetadataSnapshot(temporary);
    expect(normalizeConfiguredProviderCatalogModelId("fixture", "raw")).toBe("temporary");

    expect(lease.release()).toBe(true);
    expect(normalizeConfiguredProviderCatalogModelId("fixture", "raw")).toBe("original");
  });

  it("clears the current snapshot when the persisted installed index changes", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-metadata-"));
    try {
      setCurrentPluginMetadataSnapshot(createSnapshot());

      writePersistedInstalledPluginIndexSync(createSnapshot().index, { stateDir: tempDir });

      expect(getCurrentPluginMetadataSnapshot()).toBeUndefined();
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
