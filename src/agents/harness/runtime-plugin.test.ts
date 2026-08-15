// Verifies harness ownership, payload availability, and run-owned registry lookup.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resolveAgentRuntimePluginLoadPlan } from "./runtime-plugin-load-plan.js";
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
