import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearCurrentPluginMetadataSnapshot,
  resolvePluginMetadataControlPlaneFingerprint,
  setCurrentPluginMetadataSnapshot,
} from "./current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
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
vi.mock("./plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
}));

afterEach(() => {
  clearCurrentPluginMetadataSnapshot();
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
        startup: {
          sidecar: false,
          memory: false,
          deferConfiguredChannelFullLoadUntilAfterListen: false,
          agentHarnesses: [],
        },
        compat: [],
      },
    ],
    diagnostics: [],
  };
  return {
    policyHash,
    configFingerprint: resolvePluginMetadataControlPlaneFingerprint(
      {},
      {
        env: process.env,
        index,
        policyHash,
        workspaceDir: params.workspaceDir,
      },
    ),
    workspaceDir: params.workspaceDir,
    index,
    plugins: [
      {
        id: "openai",
        origin: "bundled",
        cliBackends: params.cliBackends,
      },
    ],
  } as unknown as PluginMetadataSnapshot;
}

describe("setup-registry runtime fallback", () => {
  it("uses bundled registry cliBackends when the setup-registry runtime is unavailable", async () => {
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
      ],
    });

    const { __testing, resolvePluginSetupCliBackendRuntime } =
      await import("./setup-registry.runtime.js");
    __testing.resetRuntimeState();
    __testing.setRuntimeModuleForTest(null);

    expect(resolvePluginSetupCliBackendRuntime({ backend: "codex-cli" })).toEqual({
      pluginId: "openai",
      backend: { id: "Codex-CLI" },
    });
    expect(resolvePluginSetupCliBackendRuntime({ backend: "local-cli" })).toBeUndefined();
    expect(resolvePluginSetupCliBackendRuntime({ backend: "disabled-cli" })).toBeUndefined();
    expect(loadPluginMetadataSnapshotMock).toHaveBeenCalledTimes(3);
    expect(loadPluginMetadataSnapshotMock).toHaveBeenCalledWith({
      config: {},
      env: process.env,
    });
  });

  it("refreshes bundled registry cliBackends when the current metadata snapshot changes", async () => {
    const { __testing, resolvePluginSetupCliBackendRuntime } =
      await import("./setup-registry.runtime.js");
    __testing.resetRuntimeState();
    __testing.setRuntimeModuleForTest(null);

    setCurrentPluginMetadataSnapshot(
      createCurrentSnapshot({
        manifestHash: "alpha",
        cliBackends: ["Codex-CLI"],
      }),
      { config: {}, env: process.env },
    );

    expect(resolvePluginSetupCliBackendRuntime({ backend: "codex-cli" })).toEqual({
      pluginId: "openai",
      backend: { id: "Codex-CLI" },
    });
    expect(resolvePluginSetupCliBackendRuntime({ backend: "next-cli" })).toBeUndefined();

    setCurrentPluginMetadataSnapshot(
      createCurrentSnapshot({
        manifestHash: "bravo",
        cliBackends: ["Next-CLI"],
      }),
      { config: {}, env: process.env },
    );

    expect(resolvePluginSetupCliBackendRuntime({ backend: "codex-cli" })).toBeUndefined();
    expect(resolvePluginSetupCliBackendRuntime({ backend: "next-cli" })).toEqual({
      pluginId: "openai",
      backend: { id: "Next-CLI" },
    });
    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("uses workspace-scoped current metadata through the active plugin runtime", async () => {
    const { __testing, resolvePluginSetupCliBackendRuntime } =
      await import("./setup-registry.runtime.js");
    __testing.resetRuntimeState();
    __testing.setRuntimeModuleForTest(null);

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

    expect(resolvePluginSetupCliBackendRuntime({ backend: "codex-cli", config: {} })).toEqual({
      pluginId: "openai",
      backend: { id: "Codex-CLI" },
    });
    expect(
      resolvePluginSetupCliBackendRuntime({ backend: "next-cli", config: {} }),
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
      resolvePluginSetupCliBackendRuntime({ backend: "codex-cli", config: {} }),
    ).toBeUndefined();
    expect(resolvePluginSetupCliBackendRuntime({ backend: "next-cli", config: {} })).toEqual({
      pluginId: "openai",
      backend: { id: "Next-CLI" },
    });
    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("preserves fail-closed setup lookup when the runtime module explicitly declines to resolve", async () => {
    loadPluginMetadataSnapshotMock.mockReturnValue({
      index: {
        diagnostics: [],
        plugins: [
          {
            pluginId: "openai",
            origin: "bundled",
            enabled: true,
          },
        ],
      },
      plugins: [],
    });

    const { __testing, resolvePluginSetupCliBackendRuntime } =
      await import("./setup-registry.runtime.js");
    __testing.resetRuntimeState();
    __testing.setRuntimeModuleForTest({
      resolvePluginSetupCliBackend: () => undefined,
    });

    expect(resolvePluginSetupCliBackendRuntime({ backend: "codex-cli" })).toBeUndefined();
    expect(loadPluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });
});
