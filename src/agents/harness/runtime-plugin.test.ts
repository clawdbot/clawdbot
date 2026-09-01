// Verifies harness ownership, payload availability, and run-owned registry lookup.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginMetadataSnapshot,
  makeRegistry,
} from "../../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as installedManifests from "../../plugins/manifest-registry-installed.js";
import { restorePluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  createAgentRuntimeMetadataPluginIdScope,
  resolveAgentRuntimePluginLoadPlan,
} from "./runtime-plugin-load-plan.js";
import {
  ensureSelectedAgentHarnessPlugin,
  resolveAgentHarnessRuntimeAvailability,
} from "./runtime-plugin.js";

const mocks = vi.hoisted(() => ({
  resolveActivatableProviderOwnerPluginIds: vi.fn(),
  resolveBundledProviderCompatPluginIds: vi.fn(),
  resolveManifestActivationPlan: vi.fn(),
  resolveOwningPluginIdsForProvider: vi.fn(),
}));

function installedProviderRecord(
  pluginId: string,
  options: {
    providers?: string[];
    contracts?: Record<string, string[]>;
    modelSupportPrefixes?: string[];
  } = {},
) {
  return {
    pluginId,
    startup: { sidecar: false, memory: false, agentHarnesses: [] },
    contributions: {
      providers: options.providers ?? [],
      modelCatalogProviders: [],
      modelSupportPrefixes: options.modelSupportPrefixes ?? [],
      modelSupportPatterns: [],
      autoEnableProviderIds: [],
      channels: [],
      channelConfigs: [],
      commandAliases: [],
      contracts: options.contracts ?? {},
    },
    compat: [],
  };
}

vi.mock("../../plugins/providers.js", () => ({
  resolveActivatableProviderOwnerPluginIds: mocks.resolveActivatableProviderOwnerPluginIds,
  resolveBundledProviderCompatPluginIds: mocks.resolveBundledProviderCompatPluginIds,
  resolveOwningPluginIdsForProvider: mocks.resolveOwningPluginIdsForProvider,
  resolveOwningPluginIdsForProviderRef: mocks.resolveOwningPluginIdsForProvider,
}));

vi.mock("../../plugins/activation-planner.js", () => ({
  resolveManifestActivationPlan: mocks.resolveManifestActivationPlan,
}));

describe("harness runtime plugins", () => {
  beforeEach(() => {
    mocks.resolveActivatableProviderOwnerPluginIds.mockReset().mockReturnValue([]);
    mocks.resolveBundledProviderCompatPluginIds.mockReset().mockReturnValue([]);
    mocks.resolveOwningPluginIdsForProvider.mockReset().mockReturnValue(undefined);
    mocks.resolveManifestActivationPlan.mockReset().mockReturnValue({
      entries: [{ pluginId: "codex", origin: "bundled" }],
    });
  });

  it("looks up a selected harness in the run-owned registry without loading plugins", async () => {
    const pluginRegistry = createEmptyPluginRegistry();
    pluginRegistry.agentHarnesses.push({
      pluginId: "codex",
      source: "test",
      harness: {
        id: "codex",
        label: "Codex",
        supports: () => ({ supported: true }),
        runAttempt: async () => {
          throw new Error("unused");
        },
      },
    });

    await ensureSelectedAgentHarnessPlugin({
      provider: "openai",
      modelId: "gpt-5.5",
      agentHarnessRuntimeOverride: "codex",
      workspaceDir: "/tmp/workspace",
      pluginRegistry,
    });

    expect(pluginRegistry.agentHarnesses).toHaveLength(1);
  });

  it("explains how to recover when the selected harness registration is missing", async () => {
    await expect(
      ensureSelectedAgentHarnessPlugin({
        provider: "openai",
        modelId: "gpt-5.5",
        agentHarnessRuntimeOverride: "codex",
        workspaceDir: "/tmp/workspace",
        pluginRegistry: createEmptyPluginRegistry(),
      }),
    ).rejects.toThrow(
      'Agent harness runtime "codex" is unavailable because its plugin registration is missing from this prepared run. Enable or reinstall the plugin that provides this runtime, restart the Gateway, then retry.',
    );
  });

  it("force-activates a default-disabled harness owner selected for a run", () => {
    const plan = resolveAgentRuntimePluginLoadPlan({
      config: {},
      workspaceDir: "/tmp/workspace",
      selections: [{ provider: "openai", modelId: "gpt-5.5", runtime: "codex" }],
    });

    expect(plan.pluginIds).toContain("codex");
    expect(plan.config?.plugins?.entries?.codex).toEqual({ enabled: true });
  });

  it("includes the selected provider owner for the default runtime", () => {
    mocks.resolveOwningPluginIdsForProvider.mockReturnValueOnce(["openai"]);
    mocks.resolveActivatableProviderOwnerPluginIds.mockReturnValueOnce(["openai"]);
    const plan = resolveAgentRuntimePluginLoadPlan({
      config: { plugins: { allow: ["openai"] } },
      workspaceDir: "/tmp/workspace",
      selections: [{ provider: "openai", modelId: "gpt-5.5", runtime: "openclaw" }],
    });

    expect(plan.pluginIds).toEqual(["openai"]);
    expect(plan.config?.plugins?.entries?.openai).toEqual({ enabled: true });
  });

  it("scopes cold metadata to selected runtime candidates from the installed index", () => {
    const scope = createAgentRuntimeMetadataPluginIdScope({
      config: { plugins: { slots: { memory: "none" } } },
      workspaceDir: "/tmp/workspace",
      selections: [
        { provider: "selected-provider", modelId: "selected-model", runtime: "openclaw" },
      ],
    });
    expect(
      scope.resolve({
        index: {
          plugins: [
            installedProviderRecord("selected-plugin", { providers: ["selected-provider"] }),
            installedProviderRecord("unrelated-plugin", {
              providers: ["unrelated-provider"],
            }),
          ],
        } as never,
      }),
    ).toEqual(["selected-plugin"]);
  });

  it("retains shorthand model owners while resolving the fallback provider", () => {
    const scope = createAgentRuntimeMetadataPluginIdScope({
      config: { plugins: { slots: { memory: "none" } } },
      workspaceDir: "/tmp/workspace",
      selections: [{ provider: "fallback-provider", modelId: "magic-model" }],
      shorthandModelIds: ["magic-model"],
    });
    expect(
      scope.resolve({
        index: {
          plugins: [
            installedProviderRecord("fallback-provider", {
              providers: ["fallback-provider"],
            }),
            installedProviderRecord("magic-model-owner", {
              modelSupportPrefixes: ["magic-"],
            }),
          ],
        } as never,
      }),
    ).toEqual(["fallback-provider", "magic-model-owner"]);
  });

  it("prefers the direct model provider owner over unrelated provider contributions", () => {
    const scope = createAgentRuntimeMetadataPluginIdScope({
      config: { plugins: { slots: { memory: "none" } } },
      workspaceDir: "/tmp/workspace",
      selections: [{ provider: "selected-provider", modelId: "selected-model" }],
    });
    expect(
      scope.resolve({
        index: {
          plugins: [
            installedProviderRecord("selected-provider", {
              providers: ["selected-provider"],
            }),
            installedProviderRecord("embedding-helper", {
              contracts: { embeddingProviders: ["selected-provider"] },
            }),
          ],
        } as never,
      }),
    ).toEqual(["selected-provider"]);
  });

  it("keeps metadata unscoped for ambiguous indirect provider ownership", () => {
    const scope = createAgentRuntimeMetadataPluginIdScope({
      config: { plugins: { slots: { memory: "none" } } },
      workspaceDir: "/tmp/workspace",
      selections: [{ provider: "provider-alias", modelId: "selected-model" }],
    });
    expect(
      scope.resolve({
        index: {
          plugins: [
            installedProviderRecord("first-owner", { providers: ["provider-alias"] }),
            installedProviderRecord("second-owner", { providers: ["provider-alias"] }),
          ],
        } as never,
      }),
    ).toBeUndefined();
  });

  it("includes the selected provider owner when policy selects an omitted harness", () => {
    mocks.resolveOwningPluginIdsForProvider.mockReturnValueOnce(["openai"]);
    mocks.resolveActivatableProviderOwnerPluginIds.mockReturnValueOnce(["openai"]);
    mocks.resolveManifestActivationPlan.mockReturnValueOnce({ entries: [] });
    const plan = resolveAgentRuntimePluginLoadPlan({
      config: { plugins: { allow: ["openai"] } },
      workspaceDir: "/tmp/workspace",
      selections: [{ provider: "openai", modelId: "gpt-5" }],
    });

    expect(plan.pluginIds).toEqual(["openai"]);
    expect(plan.config?.plugins?.entries?.openai).toEqual({ enabled: true });
  });

  it("includes and enables the context-engine owner in the prepared load plan", () => {
    const plan = resolveAgentRuntimePluginLoadPlan({
      config: { plugins: { slots: { contextEngine: "custom-context-engine" } } },
      workspaceDir: "/tmp/workspace",
      basePluginIds: [],
      selections: [],
    });

    expect(plan.pluginIds).toEqual(["custom-context-engine"]);
    expect(plan.config?.plugins?.allow).toEqual(["custom-context-engine"]);
    expect(plan.config?.plugins?.entries?.["custom-context-engine"]).toEqual({ enabled: true });
  });

  const memorySelectionCases: Array<{
    name: string;
    config: OpenClawConfig;
    expectedPluginIds: string[];
  }> = [
    {
      name: "implicit plugin configuration",
      config: {},
      expectedPluginIds: [],
    },
    {
      name: "explicit unrelated plugin configuration",
      config: {
        plugins: {
          entries: { "custom-context-engine": { enabled: true } },
        },
      },
      expectedPluginIds: [],
    },
    {
      name: "an explicitly selected default memory slot",
      config: { plugins: { slots: { memory: "memory-core" } } },
      expectedPluginIds: ["memory-core"],
    },
    {
      name: "an explicitly enabled default memory plugin",
      config: { plugins: { entries: { "memory-core": { enabled: true } } } },
      expectedPluginIds: ["memory-core"],
    },
    {
      name: "an explicitly disabled memory slot",
      config: { plugins: { slots: { memory: "none" } } },
      expectedPluginIds: [],
    },
    {
      name: "an explicitly selected alternative memory slot",
      config: { plugins: { slots: { memory: "memory-lancedb" } } },
      expectedPluginIds: ["memory-lancedb"],
    },
    {
      name: "an explicitly disabled default memory plugin",
      config: { plugins: { entries: { "memory-core": { enabled: false } } } },
      expectedPluginIds: [],
    },
  ];

  it.each(memorySelectionCases)(
    "preserves config-owned memory selection for $name",
    ({ config, expectedPluginIds }) => {
      const plan = resolveAgentRuntimePluginLoadPlan({
        config,
        workspaceDir: "/tmp/workspace",
        selections: [],
      });

      expect(plan.pluginIds ?? []).toEqual(expectedPluginIds);
      expect(plan.config).toMatchObject(config);
      for (const pluginId of expectedPluginIds) {
        expect(plan.config?.plugins?.entries?.[pluginId]).toEqual({ enabled: true });
      }
    },
  );

  it("reuses prepared memory aliases while applying current activation policy", () => {
    const config: OpenClawConfig = { plugins: { slots: { memory: "fixture-memory" } } };
    const snapshot = createPluginMetadataSnapshot({
      config,
      manifestRegistry: makeRegistry([
        { id: "fixture-memory", channels: [], providers: ["memory-alias"] },
      ]),
    });
    snapshot.index.plugins = [
      {
        ...installedProviderRecord("fixture-memory"),
        origin: "config",
        rootDir: "/fake/fixture-memory",
        manifestPath: "/fake/fixture-memory/openclaw.plugin.json",
        manifestHash: "fixture",
        enabled: true,
        enabledByDefault: true,
        startup: { sidecar: false, memory: true, agentHarnesses: [] },
      },
    ];
    const metadataSnapshot = restorePluginMetadataSnapshot(snapshot);
    const rebuildManifests = vi
      .spyOn(installedManifests, "loadPluginManifestRegistryForInstalledIndex")
      .mockReturnValue(metadataSnapshot.manifestRegistry);
    try {
      for (const enabled of [true, false, true]) {
        config.plugins!.entries = { "memory-alias": { enabled } };
        const plan = resolveAgentRuntimePluginLoadPlan({
          config,
          metadataSnapshot,
          workspaceDir: "/tmp/agent-workspace",
          selections: [],
        });
        expect(plan.pluginIds ?? []).toEqual(enabled ? ["fixture-memory"] : []);
      }
      expect(rebuildManifests).not.toHaveBeenCalled();
    } finally {
      rebuildManifests.mockRestore();
    }
  });

  it("keeps standalone activation unrestricted when no complete startup base exists", () => {
    const plan = resolveAgentRuntimePluginLoadPlan({
      config: {
        plugins: {
          entries: { "custom-context-engine": { enabled: true } },
        },
      },
      workspaceDir: "/tmp/workspace",
      selections: [{ provider: "openai", modelId: "gpt-5.5", runtime: "codex" }],
    });

    expect(plan.config?.plugins?.allow).toBeUndefined();
    expect(plan.config?.plugins?.entries).toMatchObject({
      "custom-context-engine": { enabled: true },
      codex: { enabled: true },
    });
  });

  it("checks restrictive allowlists against the selected harness owner plugin id", () => {
    mocks.resolveManifestActivationPlan.mockReturnValueOnce({
      entries: [{ pluginId: "custom-harness-plugin", origin: "workspace" }],
    });
    const plan = resolveAgentRuntimePluginLoadPlan({
      config: { plugins: { allow: ["custom-harness-plugin"] } },
      workspaceDir: "/tmp/workspace",
      selections: [
        { provider: "custom-provider", modelId: "custom-model", runtime: "custom-harness" },
      ],
    });

    expect(plan.pluginIds).toEqual(["custom-harness-plugin"]);
    expect(plan.config?.plugins?.entries?.["custom-harness-plugin"]).toEqual({ enabled: true });
  });

  it("preserves startup-scoped plugins when selected owners synthesize an allowlist", () => {
    const plan = resolveAgentRuntimePluginLoadPlan({
      config: { plugins: { slots: { memory: "memory-core" } } },
      workspaceDir: "/tmp/workspace",
      basePluginIds: ["telegram"],
      selections: [{ provider: "openai", modelId: "gpt-5.5", runtime: "codex" }],
    });

    expect(plan.pluginIds).toEqual(["codex", "memory-core", "telegram"]);
    expect(plan.config?.plugins?.allow).toEqual(["telegram", "memory-core", "codex"]);
  });

  it("does not restore stale startup plugins excluded by a restrictive reload allowlist", () => {
    const plan = resolveAgentRuntimePluginLoadPlan({
      config: { plugins: { allow: ["codex"] } },
      workspaceDir: "/tmp/workspace",
      basePluginIds: ["telegram"],
      selections: [{ provider: "openai", modelId: "gpt-5.5", runtime: "codex" }],
    });

    expect(plan.pluginIds).toEqual(["codex"]);
    expect(plan.config?.plugins?.allow).toEqual(["codex"]);
  });

  it("retains safe provider-owner dependencies for an explicitly allowed Codex harness", () => {
    mocks.resolveOwningPluginIdsForProvider.mockReturnValueOnce(["openai"]);
    mocks.resolveActivatableProviderOwnerPluginIds.mockReturnValueOnce(["openai"]);
    const plan = resolveAgentRuntimePluginLoadPlan({
      config: { plugins: { allow: ["codex"] } },
      workspaceDir: "/tmp/workspace",
      selections: [{ provider: "openai", modelId: "gpt-5.5", runtime: "codex" }],
    });

    expect(plan.pluginIds).toEqual(["codex", "openai"]);
    expect(plan.config?.plugins?.allow).toEqual(["codex", "openai"]);
    expect(plan.config?.plugins?.entries).toMatchObject({
      codex: { enabled: true },
      openai: { enabled: true },
    });
  });

  it("reports a manifest-owned harness as statically available", () => {
    expect(
      resolveAgentHarnessRuntimeAvailability({
        runtime: "codex",
        provider: "openai",
        workspaceDir: "/tmp/workspace",
        payloadFailures: [],
        payloadCheckedPluginIds: ["codex"],
        selectedPluginRootDirs: new Map([["codex", "/tmp/plugins/codex"]]),
      }),
    ).toEqual({ status: "available", ownerPluginIds: ["codex"] });
  });

  it("reports a harness unavailable when no enabled owner plugin can activate", () => {
    mocks.resolveManifestActivationPlan.mockReturnValueOnce({ entries: [] });

    expect(
      resolveAgentHarnessRuntimeAvailability({
        runtime: "codex",
        provider: "openai",
        workspaceDir: "/tmp/workspace",
        payloadFailures: [],
        payloadCheckedPluginIds: [],
        selectedPluginRootDirs: new Map(),
      }),
    ).toEqual({
      status: "unavailable",
      ownerPluginIds: [],
      reason: "owner-plugin-not-activatable",
      detail: 'No enabled plugin owns agent harness "codex".',
    });
  });

  it("reports a quarantined owner payload and ignores stale artifacts", () => {
    const base = {
      runtime: "codex",
      provider: "openai",
      workspaceDir: "/tmp/workspace",
      payloadCheckedPluginIds: ["codex"],
      selectedPluginRootDirs: new Map([["codex", "/tmp/plugins/codex"]]),
    };
    expect(
      resolveAgentHarnessRuntimeAvailability({
        ...base,
        payloadFailures: [
          {
            pluginId: "codex",
            installPath: "/tmp/plugins/codex",
            reason: "missing-package-dir",
          },
        ],
      }),
    ).toMatchObject({ status: "unavailable", reason: "owner-plugin-degraded" });
    expect(
      resolveAgentHarnessRuntimeAvailability({
        ...base,
        payloadFailures: [
          {
            pluginId: "codex",
            installPath: "/tmp/plugins/stale-codex",
            reason: "missing-package-dir",
          },
        ],
      }),
    ).toEqual({ status: "available", ownerPluginIds: ["codex"] });
  });

  it("reports an owner whose payload was not checked", () => {
    expect(
      resolveAgentHarnessRuntimeAvailability({
        runtime: "codex",
        provider: "openai",
        workspaceDir: "/tmp/workspace",
        payloadFailures: [],
        payloadCheckedPluginIds: [],
        selectedPluginRootDirs: new Map([["codex", "/tmp/plugins/codex"]]),
      }),
    ).toMatchObject({ status: "unavailable", reason: "owner-plugin-unverified" });
  });

  it("keeps a restrictive allowlist authoritative", () => {
    const config = { plugins: { allow: ["telegram"] } } as OpenClawConfig;
    mocks.resolveManifestActivationPlan.mockReturnValueOnce({ entries: [] });
    expect(
      resolveAgentHarnessRuntimeAvailability({
        runtime: "codex",
        provider: "openai",
        config,
        workspaceDir: "/tmp/workspace",
        payloadFailures: [],
        payloadCheckedPluginIds: [],
        selectedPluginRootDirs: new Map(),
      }),
    ).toMatchObject({ status: "unavailable", ownerPluginIds: [] });
  });
});
