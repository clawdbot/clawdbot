// Verifies metadata-backed setup registry descriptor lookup.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withPluginMetadataSnapshotScope } from "./current-plugin-metadata-snapshot.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  projectPluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "./runtime.js";

const loadPluginRegistrySnapshotMock = vi.hoisted(() => vi.fn());
const loadPluginManifestRegistryForInstalledIndexMock = vi.hoisted(() => vi.fn());
const loadPluginMetadataSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("./plugin-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-registry.js")>()),
  loadPluginRegistrySnapshot: loadPluginRegistrySnapshotMock,
}));
vi.mock("./manifest-registry-installed.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./manifest-registry-installed.js")>()),
  loadPluginManifestRegistryForInstalledIndex: loadPluginManifestRegistryForInstalledIndexMock,
}));
vi.mock("./plugin-metadata-snapshot.js", async (importOriginal) => {
  const current = await import("./current-plugin-metadata-snapshot.js");
  return {
    ...(await importOriginal<typeof import("./plugin-metadata-snapshot.js")>()),
    loadPluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
    resolvePluginMetadataSnapshot: (
      params: Parameters<typeof current.getCurrentPluginMetadataSnapshot>[0] & {
        allowWorkspaceScopedCurrent?: boolean;
      },
    ) =>
      current.getCurrentPluginMetadataSnapshot({
        config: params.config,
        env: params.env,
        workspaceDir: params.workspaceDir,
        allowWorkspaceScopedSnapshot: params.allowWorkspaceScopedCurrent,
      }) ?? loadPluginMetadataSnapshotMock(params),
  };
});

afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  resetPluginRuntimeStateForTest();
  loadPluginRegistrySnapshotMock.mockReset();
  loadPluginManifestRegistryForInstalledIndexMock.mockReset();
  loadPluginMetadataSnapshotMock.mockReset();
});

function createCurrentSnapshot(params: {
  manifestHash: string;
  cliBackends: string[];
  workspaceDir?: string;
}): PluginMetadataSnapshot {
  const policyHash = resolveInstalledPluginIndexPolicyHash({});
  const index: InstalledPluginIndex = {
    version: 1,
    hostContractVersion: "test-host",
    compatRegistryVersion: "test-compat",
    migrationVersion: 1,
    policyHash,
    generatedAtMs: 0,
    installRecords: {},
    plugins: [
      {
        pluginId: "openai",
        manifestPath: `/tmp/openai-${params.manifestHash}/openclaw.plugin.json`,
        manifestHash: params.manifestHash,
        source: `/tmp/openai-${params.manifestHash}/index.ts`,
        rootDir: `/tmp/openai-${params.manifestHash}`,
        origin: "bundled",
        enabled: true,
        enabledByDefault: true,
        startup: {
          sidecar: false,
          memory: false,
          agentHarnesses: [],
        },
        compat: [],
      },
    ],
    diagnostics: [],
  };
  const plugins = [
    {
      id: "openai",
      origin: "bundled",
      cliBackends: params.cliBackends,
    },
  ];
  return {
    policyHash,
    configFingerprint: params.manifestHash,
    workspaceDir: params.workspaceDir,
    index,
    plugins,
    manifestRegistry: { plugins, diagnostics: [] },
  } as unknown as PluginMetadataSnapshot;
}

describe("setup-registry descriptor lookup", () => {
  it("keeps descriptors inside a narrower view of the same metadata generation", async () => {
    const { resolvePluginSetupCliBackendDescriptor } = await import("./setup-registry.runtime.js");
    const snapshot = createCurrentSnapshot({ manifestHash: "scoped", cliBackends: ["Scoped-CLI"] });
    const narrowed = projectPluginMetadataSnapshot(snapshot, []);
    const resolve = (view: PluginMetadataSnapshot) =>
      withPluginMetadataSnapshotScope(
        view,
        () => resolvePluginSetupCliBackendDescriptor({ backend: "scoped-cli" }),
        { trustConfigIdentity: true },
      );

    expect(resolve(snapshot)).toEqual({ pluginId: "openai", backend: { id: "Scoped-CLI" } });
    expect(resolve(narrowed)).toBeUndefined();
    expect(resolve(snapshot)).toEqual({ pluginId: "openai", backend: { id: "Scoped-CLI" } });
    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("applies current enablement policy without rebuilding the prepared backend inventory", async () => {
    const { resolvePluginSetupCliBackendDescriptor, resolvePluginSetupCliBackendIds } =
      await import("./setup-registry.runtime.js");
    const snapshot = createCurrentSnapshot({ manifestHash: "policy", cliBackends: ["Policy-CLI"] });
    withPluginMetadataSnapshotScope(
      snapshot,
      () => {
        for (const enabled of [true, false, true]) {
          const config = { plugins: { entries: { openai: { enabled } } } };
          expect(resolvePluginSetupCliBackendDescriptor({ backend: "policy-cli", config })).toEqual(
            enabled ? { pluginId: "openai", backend: { id: "Policy-CLI" } } : undefined,
          );
          expect(resolvePluginSetupCliBackendIds({ config })).toEqual(
            enabled ? ["Policy-CLI"] : [],
          );
        }
      },
      { trustConfigIdentity: true },
    );
    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("uses enabled metadata cliBackends", async () => {
    loadPluginMetadataSnapshotMock.mockReturnValue({
      index: {
        diagnostics: [],
        plugins: [
          {
            pluginId: "openai",
            origin: "bundled",
            enabled: true,
          },
          {
            pluginId: "disabled",
            origin: "bundled",
            enabled: false,
          },
          {
            pluginId: "local",
            origin: "workspace",
            enabled: true,
          },
        ],
      },
      plugins: [
        {
          id: "openai",
          origin: "bundled",
          cliBackends: ["Codex-CLI", "legacy-openai-cli"],
        },
        {
          id: "disabled",
          origin: "bundled",
          cliBackends: ["disabled-cli"],
        },
        {
          id: "local",
          origin: "workspace",
          cliBackends: ["local-cli"],
        },
      ],
    });

    const { resolvePluginSetupCliBackendDescriptor } = await import("./setup-registry.runtime.js");

    expect(resolvePluginSetupCliBackendDescriptor({ backend: "codex-cli" })).toEqual({
      pluginId: "openai",
      backend: { id: "Codex-CLI" },
    });
    expect(resolvePluginSetupCliBackendDescriptor({ backend: "local-cli" })).toEqual({
      pluginId: "local",
      backend: { id: "local-cli" },
    });
    expect(resolvePluginSetupCliBackendDescriptor({ backend: "disabled-cli" })).toBeUndefined();
    expect(loadPluginMetadataSnapshotMock).toHaveBeenCalledTimes(3);
    expect(loadPluginMetadataSnapshotMock).toHaveBeenCalledWith({
      allowWorkspaceScopedCurrent: true,
      env: process.env,
    });
  });

  it("refreshes cliBackends when the current metadata snapshot changes", async () => {
    const { resolvePluginSetupCliBackendDescriptor } = await import("./setup-registry.runtime.js");

    setCurrentPluginMetadataSnapshot(
      createCurrentSnapshot({
        manifestHash: "alpha",
        cliBackends: ["Codex-CLI"],
      }),
      { config: {}, env: process.env },
    );

    expect(resolvePluginSetupCliBackendDescriptor({ backend: "codex-cli" })).toEqual({
      pluginId: "openai",
      backend: { id: "Codex-CLI" },
    });
    expect(resolvePluginSetupCliBackendDescriptor({ backend: "next-cli" })).toBeUndefined();

    setCurrentPluginMetadataSnapshot(
      createCurrentSnapshot({
        manifestHash: "bravo",
        cliBackends: ["Next-CLI"],
      }),
      { config: {}, env: process.env },
    );

    expect(resolvePluginSetupCliBackendDescriptor({ backend: "codex-cli" })).toBeUndefined();
    expect(resolvePluginSetupCliBackendDescriptor({ backend: "next-cli" })).toEqual({
      pluginId: "openai",
      backend: { id: "Next-CLI" },
    });
    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("uses workspace-scoped current metadata through the active plugin runtime", async () => {
    const { resolvePluginSetupCliBackendDescriptor } = await import("./setup-registry.runtime.js");

    setActivePluginRegistry(
      createEmptyPluginRegistry(),
      "workspace-a",
      "gateway-bindable",
      "/workspace/a",
    );
    setCurrentPluginMetadataSnapshot(
      createCurrentSnapshot({
        manifestHash: "alpha",
        cliBackends: ["Codex-CLI"],
        workspaceDir: "/workspace/a",
      }),
      { config: {}, env: process.env },
    );

    expect(resolvePluginSetupCliBackendDescriptor({ backend: "codex-cli", config: {} })).toEqual({
      pluginId: "openai",
      backend: { id: "Codex-CLI" },
    });
    expect(
      resolvePluginSetupCliBackendDescriptor({ backend: "next-cli", config: {} }),
    ).toBeUndefined();

    setCurrentPluginMetadataSnapshot(
      createCurrentSnapshot({
        manifestHash: "bravo",
        cliBackends: ["Next-CLI"],
        workspaceDir: "/workspace/a",
      }),
      { config: {}, env: process.env },
    );

    expect(
      resolvePluginSetupCliBackendDescriptor({ backend: "codex-cli", config: {} }),
    ).toBeUndefined();
    expect(resolvePluginSetupCliBackendDescriptor({ backend: "next-cli", config: {} })).toEqual({
      pluginId: "openai",
      backend: { id: "Next-CLI" },
    });
    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("reuses the lifecycle-owned workspace when no runtime workspace is active", async () => {
    loadPluginMetadataSnapshotMock.mockReturnValue({
      index: {
        diagnostics: [],
        plugins: [],
      },
      plugins: [],
    });

    const { resolvePluginSetupCliBackendDescriptor } = await import("./setup-registry.runtime.js");

    setCurrentPluginMetadataSnapshot(
      createCurrentSnapshot({
        manifestHash: "alpha",
        cliBackends: ["Codex-CLI"],
        workspaceDir: "/workspace/a",
      }),
      { config: {}, env: process.env },
    );

    expect(resolvePluginSetupCliBackendDescriptor({ backend: "codex-cli", config: {} })).toEqual({
      pluginId: "openai",
      backend: { id: "Codex-CLI" },
    });
    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });
});
