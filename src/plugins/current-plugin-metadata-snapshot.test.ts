// Covers current plugin metadata snapshot generation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  collectManifestModelIdNormalizationPolicies,
  normalizeConfiguredProviderCatalogModelId,
} from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { describe, expect, it, vi } from "vitest";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import {
  getCurrentPluginMetadataSnapshot,
  installTemporaryCurrentPluginMetadataSnapshot,
  isCurrentPluginMetadataSnapshotRuntimeGeneration,
  setGatewayPluginMetadataSnapshot,
  withPluginMetadataSnapshotScope,
} from "./current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import { getGlobalHookRunnerRegistry } from "./hook-runner-global-state.js";
import { withPluginInstallRoots } from "./install-root-context.js";
import * as installedPluginIndexPolicy from "./installed-plugin-index-policy.js";
import { writePersistedInstalledPluginIndexSync } from "./installed-plugin-index-store-write.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import * as pluginControlPlaneContext from "./plugin-control-plane-context.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  restorePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
import { classifyProviderFailoverSignalWithPlugin } from "./provider-failover.js";
import { resolveProviderRuntimePlugin } from "./provider-hook-runtime.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationScope } from "./runtime/generation-scope.js";

function createSnapshot(
  params: {
    config?: Parameters<typeof installedPluginIndexPolicy.resolveInstalledPluginIndexPolicyHash>[0];
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
  const index: PluginMetadataSnapshot["index"] = {
    version: 1,
    hostContractVersion: "test",
    compatRegistryVersion: "test",
    migrationVersion: 1,
    policyHash: installedPluginIndexPolicy.resolveInstalledPluginIndexPolicyHash(params.config),
    generatedAtMs: 1,
    installRecords: {},
    plugins: [],
    diagnostics: [],
  };
  return {
    policyHash: installedPluginIndexPolicy.resolveInstalledPluginIndexPolicyHash(params.config),
    ...(params.pluginIds !== undefined ? { pluginIds: params.pluginIds } : {}),
    ...(params.registrySource ? { registrySource: params.registrySource } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    index,
    registryIndex: index,
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
      modelIdNormalizationPolicies: collectManifestModelIdNormalizationPolicies(plugins),
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

    const controlPlaneFingerprint = vi.spyOn(
      pluginControlPlaneContext,
      "resolvePluginControlPlaneFingerprint",
    );
    const policyHash = vi.spyOn(
      installedPluginIndexPolicy,
      "resolveInstalledPluginIndexPolicyHash",
    );
    try {
      await withPluginRuntimeGenerationScope({ metadataSnapshot, pluginRegistry }, async () => {
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
        expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(pluginRegistry);
      });

      expect(isCurrentPluginMetadataSnapshotRuntimeGeneration(metadataSnapshot)).toBe(false);
      expect(
        getCurrentPluginMetadataSnapshot({ config, workspaceDir: agentWorkspaceDir }),
      ).toBeUndefined();
      expect(getPluginRuntimeGatewayRequestScope()).toBeUndefined();
      expect(controlPlaneFingerprint).not.toHaveBeenCalled();
      expect(policyHash).not.toHaveBeenCalled();
    } finally {
      controlPlaneFingerprint.mockRestore();
      policyHash.mockRestore();
    }
  });

  it("isolates a registry-less nested generation and restores the outer generation on rejection", async () => {
    const outerConfig = { plugins: { allow: ["outer"] } };
    const innerConfig = { plugins: { allow: ["inner"] } };
    const outerSnapshot = createSnapshot({ config: outerConfig, workspaceDir: "/workspace/outer" });
    const innerSnapshot = createSnapshot({ config: innerConfig, workspaceDir: "/workspace/inner" });
    const outerRegistry = createEmptyPluginRegistry();
    outerRegistry.providers.push({
      pluginId: "outer",
      source: "test",
      provider: { id: "outer", label: "Outer", auth: [], classifyFailoverReason: () => "billing" },
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
          metadataSnapshot: outerSnapshot,
          pluginRegistry: outerRegistry,
        },
        async () => {
          await expect(
            withPluginRuntimeGenerationScope(
              {
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
                expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).not.toBe(
                  outerRegistry,
                );
                expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry?.providers).toEqual(
                  [],
                );
                expect(resolveProviderRuntimePlugin({ provider: "outer" })).toBeUndefined();
                expect(
                  classifyProviderFailoverSignalWithPlugin({
                    provider: "outer",
                    context: { provider: "outer", errorMessage: "fixture failure" },
                  }),
                ).toBeUndefined();
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
            classifyProviderFailoverSignalWithPlugin({
              provider: "outer",
              context: { provider: "outer", errorMessage: "fixture failure" },
            }),
          ).toBe("billing");
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

  it("supports compatible config identities within an owner-prepared scope", () => {
    const sourceConfig = { plugins: { allow: ["source"] } };
    const runtimeConfig = { plugins: { allow: ["runtime"] } };
    const snapshot = createSnapshot({ config: sourceConfig, workspaceDir: "/workspace" });

    withPluginMetadataSnapshotScope(
      snapshot,
      () => {
        expect(
          getCurrentPluginMetadataSnapshot({
            config: runtimeConfig,
            workspaceDir: "/workspace",
          }),
        ).toBe(snapshot);
      },
      {
        config: sourceConfig,
        compatibleConfigs: [runtimeConfig],
      },
    );
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

  it("enters an immutable runtime generation without probing discovery roots", () => {
    const sourceConfig = { plugins: { allow: ["source"] } };
    const runtimeConfig = { plugins: { allow: ["runtime"] } };
    const workspaceDir = "/workspace";
    const snapshot = createSnapshot({ config: sourceConfig, workspaceDir });

    const rootProbes = vi.spyOn(fs, "existsSync");
    try {
      withPluginRuntimeGenerationScope({ metadataSnapshot: snapshot }, () => {
        expect(getCurrentPluginMetadataSnapshot({ config: runtimeConfig, workspaceDir })).toBe(
          snapshot,
        );
      });
      expect(rootProbes).not.toHaveBeenCalled();
    } finally {
      rootProbes.mockRestore();
    }
  });

  it("keeps prepared metadata usable when the launch directory is removed", () => {
    const config = {};
    const snapshot = createSnapshot({ config });
    setCurrentPluginMetadataSnapshot(snapshot, { config });
    const launchCwd = process.cwd();
    const cwd = vi.spyOn(process, "cwd");
    try {
      cwd.mockImplementation(() => {
        throw new Error("ENOENT: uv_cwd");
      });
      expect(getCurrentPluginMetadataSnapshot({ config })).toBeUndefined();
      withPluginRuntimeGenerationScope({ metadataSnapshot: snapshot }, () => {
        expect(getCurrentPluginMetadataSnapshot({ config })).toBe(snapshot);
      });

      cwd.mockReturnValue(launchCwd);
      expect(getCurrentPluginMetadataSnapshot({ config })).toBe(snapshot);
    } finally {
      cwd.mockRestore();
    }
  });

  it("rejects a workspace-scoped snapshot when the caller does not provide workspace scope", () => {
    const config = { plugins: { allow: ["demo"] } };
    const snapshot = createSnapshot({ config, workspaceDir: "/workspace/a" });
    setCurrentPluginMetadataSnapshot(snapshot, { config });

    expect(getCurrentPluginMetadataSnapshot({ config })).toBeUndefined();
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
    const snapshot = createSnapshot({ config, normalizationAlias: "scoped" });
    setCurrentPluginMetadataSnapshot(snapshot, { config });

    try {
      expect(
        getCurrentPluginMetadataSnapshot({
          allowWorkspaceScopedSnapshot: true,
          requireDefaultDiscoveryContext: true,
        }),
      ).toBeUndefined();
      expect(normalizeConfiguredProviderCatalogModelId("fixture", "raw")).toBe("raw");

      const lease = installTemporaryCurrentPluginMetadataSnapshot(
        createSnapshot({ normalizationAlias: "temporary" }),
      );
      expect(normalizeConfiguredProviderCatalogModelId("fixture", "raw")).toBe("temporary");
      expect(lease.release()).toBe(true);
      expect(normalizeConfiguredProviderCatalogModelId("fixture", "raw")).toBe("raw");
    } finally {
      clearCurrentPluginMetadataSnapshot();
    }
  });

  it.each([
    {
      name: "development root",
      env: { HOME: "/home/metadata" },
      changedEnv: { HOME: "/home/metadata", OPENCLAW_DEV_SOURCE_ROOT: process.cwd() },
    },
    {
      name: "Termux prefix",
      env: { PREFIX: "/data/data/com.termux/files/usr", ANDROID_DATA: "/data" },
      changedEnv: { PREFIX: "/other/com.termux/files/usr", ANDROID_DATA: "/data" },
    },
    {
      name: "Termux detection",
      env: { PREFIX: "/data/data/com.termux/files/usr", ANDROID_DATA: "/data" },
      changedEnv: { PREFIX: "/data/data/com.termux/files/usr" },
    },
  ])(
    "reuses configless metadata without probing discovery roots and checks $name",
    ({ env, changedEnv }) => {
      const config = { plugins: { allow: ["demo"] } };
      const snapshot = createSnapshot({ config });
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
        expect(
          getCurrentPluginMetadataSnapshot({
            env: changedEnv,
            requireDefaultDiscoveryContext: true,
          }),
        ).toBeUndefined();
        expect(rootProbes).not.toHaveBeenCalled();
      } finally {
        rootProbes.mockRestore();
      }
    },
  );

  it.each(["supplied", "ambient"] as const)(
    "rejects configless default-discovery reuse when %s bundled-directory trust changes",
    (trustSource) => {
      const overrideRoot = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-metadata-bundled-trust-")),
      );
      const originalTrust = process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
      const env: NodeJS.ProcessEnv = {
        VITEST: "true",
        OPENCLAW_BUNDLED_PLUGINS_DIR: overrideRoot,
      };
      delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;

      try {
        const snapshot = createSnapshot();
        const originalRoot = resolveBundledPluginsDir(env);
        expect(originalRoot).toBeDefined();
        expect(originalRoot).not.toBe(overrideRoot);
        setCurrentPluginMetadataSnapshot(snapshot, { env });
        const request = { env, requireDefaultDiscoveryContext: true };
        expect(getCurrentPluginMetadataSnapshot(request)).toBe(snapshot);

        withPluginRuntimeGenerationScope({ metadataSnapshot: snapshot }, () => {
          const trustEnv = trustSource === "supplied" ? env : process.env;
          trustEnv.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = "1";
          expect(resolveBundledPluginsDir(env)).toBe(overrideRoot);
          expect(getCurrentPluginMetadataSnapshot(request)).toBe(snapshot);
        });

        expect(getCurrentPluginMetadataSnapshot(request)).toBeUndefined();
      } finally {
        clearCurrentPluginMetadataSnapshot();
        if (originalTrust === undefined) {
          delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
        } else {
          process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR = originalTrust;
        }
        fs.rmSync(overrideRoot, { recursive: true, force: true });
      }
    },
  );

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

  it.each([
    { config: { plugins: { load: { paths: ["~/plugins"] } } }, key: "HOME" },
    { config: {}, key: "HOME" },
    { config: {}, key: "OPENCLAW_BUNDLED_PLUGINS_DIR" },
  ])("rejects ordinary metadata when $key changes for $config", ({ config, key }) => {
    const snapshot = createSnapshot({ config });
    const snapshotEnv = {
      HOME: "/home/snapshot",
      OPENCLAW_HOME: undefined,
      [key]: "/plugins/snapshot",
    };
    const requestedEnv = { ...snapshotEnv, [key]: "/plugins/requested" };
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

  it("restores a temporary lease while its publication is current", () => {
    const firstConfig = { plugins: { allow: ["first"] } };
    const temporaryConfig = { plugins: { allow: ["temporary"] } };
    const first = createSnapshot({ config: firstConfig });
    const temporary = createSnapshot({ config: temporaryConfig });
    setCurrentPluginMetadataSnapshot(first, { config: firstConfig });

    const lease = installTemporaryCurrentPluginMetadataSnapshot(temporary, {
      config: temporaryConfig,
    });

    expect(lease.release()).toBe(true);
    expect(getCurrentPluginMetadataSnapshot({ config: firstConfig })).toBe(first);
    expect(lease.release()).toBe(false);
  });

  it("does not release a temporary lease over a newer publication or lifecycle clear", () => {
    const original = createSnapshot({ normalizationAlias: "original" });
    const temporary = createSnapshot({ normalizationAlias: "temporary" });
    const newer = createSnapshot({ normalizationAlias: "newer" });
    setCurrentPluginMetadataSnapshot(original);

    const clearedLease = installTemporaryCurrentPluginMetadataSnapshot(temporary);
    clearCurrentPluginMetadataSnapshot();
    expect(clearedLease.release()).toBe(false);
    expect(getCurrentPluginMetadataSnapshot()).toBeUndefined();
    expect(normalizeConfiguredProviderCatalogModelId("fixture", "raw")).toBe("raw");

    const replacedLease = installTemporaryCurrentPluginMetadataSnapshot(temporary);
    setGatewayPluginMetadataSnapshot(newer);
    expect(replacedLease.release()).toBe(false);
    expect(getCurrentPluginMetadataSnapshot()).toBe(newer);
    expect(normalizeConfiguredProviderCatalogModelId("fixture", "raw")).toBe("newer");
  });

  it("unwinds nested temporary leases when they release out of order", () => {
    const original = createSnapshot({ normalizationAlias: "original" });
    const outerSnapshot = createSnapshot({ normalizationAlias: "outer" });
    const innerSnapshot = createSnapshot({ normalizationAlias: "inner" });
    setCurrentPluginMetadataSnapshot(original);

    const outer = installTemporaryCurrentPluginMetadataSnapshot(outerSnapshot);
    const inner = installTemporaryCurrentPluginMetadataSnapshot(innerSnapshot);

    expect(outer.release()).toBe(false);
    expect(getCurrentPluginMetadataSnapshot()).toBe(innerSnapshot);
    expect(normalizeConfiguredProviderCatalogModelId("fixture", "raw")).toBe("inner");
    expect(inner.release()).toBe(true);
    expect(getCurrentPluginMetadataSnapshot()).toBe(original);
    expect(normalizeConfiguredProviderCatalogModelId("fixture", "raw")).toBe("original");
    expect(inner.release()).toBe(false);
  });

  it("publishes and restores prepared model policies without enumerating declarations", () => {
    const enumerate = vi.fn((target: object) => Reflect.ownKeys(target));
    const prepare = (alias: string) =>
      restorePluginMetadataSnapshot(
        createPluginMetadataSnapshotFixture({
          plugins: [
            {
              id: "fixture",
              modelIdNormalization: {
                providers: new Proxy(
                  { fixture: { aliases: { raw: alias } } },
                  { ownKeys: (target) => enumerate(target) },
                ),
              },
            },
          ],
        }),
      );
    const original = prepare("original");
    const temporary = prepare("temporary");
    const empty = restorePluginMetadataSnapshot(createPluginMetadataSnapshotFixture());
    const env = {
      HOME: "/home/original-snapshot",
      OPENCLAW_HOME: undefined,
    } as NodeJS.ProcessEnv;
    enumerate.mockClear();

    try {
      setCurrentPluginMetadataSnapshot(original, { env });
      expect(normalizeConfiguredProviderCatalogModelId("fixture", "raw")).toBe("original");

      const lease = installTemporaryCurrentPluginMetadataSnapshot(temporary);
      expect(normalizeConfiguredProviderCatalogModelId("fixture", "raw")).toBe("temporary");

      const emptyLease = installTemporaryCurrentPluginMetadataSnapshot(empty);
      expect(normalizeConfiguredProviderCatalogModelId("fixture", "raw")).toBe("raw");
      expect(emptyLease.release()).toBe(true);
      expect(normalizeConfiguredProviderCatalogModelId("fixture", "raw")).toBe("temporary");

      expect(lease.release()).toBe(true);
      expect(normalizeConfiguredProviderCatalogModelId("fixture", "raw")).toBe("original");
      clearCurrentPluginMetadataSnapshot();
      expect(normalizeConfiguredProviderCatalogModelId("fixture", "raw")).toBe("raw");
      expect(enumerate).not.toHaveBeenCalled();
    } finally {
      clearCurrentPluginMetadataSnapshot();
    }
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
