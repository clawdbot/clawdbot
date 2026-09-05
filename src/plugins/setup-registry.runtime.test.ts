// Verifies metadata-backed setup registry descriptor lookup.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withPluginMetadataSnapshotScope } from "./current-plugin-metadata-snapshot.js";
import { setCurrentPluginMetadataSnapshot } from "./current-plugin-metadata.test-support.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import * as installedPluginIndex from "./installed-plugin-index.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  projectPluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "./plugin-metadata.test-support.js";
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
  vi.restoreAllMocks();
});

function createCurrentSnapshot(params: {
  manifestHash: string;
  cliBackends: string[];
  workspaceDir?: string;
}): PluginMetadataSnapshot {
  const policyHash = resolveInstalledPluginIndexPolicyHash({});
  const snapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "openai",
        rootDir: `/tmp/openai-${params.manifestHash}`,
        cliBackends: params.cliBackends,
        enabledByDefault: true,
      },
    ],
  });
  snapshot.index.policyHash = policyHash;
  return {
    ...snapshot,
    policyHash,
    configFingerprint: params.manifestHash,
    workspaceDir: params.workspaceDir,
  };
}

describe("setup-registry descriptor lookup", () => {
  it("evaluates activation only for owners of the requested CLI backend", async () => {
    const { resolvePluginSetupCliBackendDescriptor } = await import("./setup-registry.runtime.js");
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        { id: "unrelated-provider", providers: ["unrelated"] },
        { id: "other-cli", cliBackends: ["other-cli"] },
        { id: "target-owner", cliBackends: ["Target-CLI"] },
      ],
    });
    const activation = vi.spyOn(installedPluginIndex, "isInstalledPluginEnabled");
    withPluginMetadataSnapshotScope(
      snapshot,
      () => {
        expect(resolvePluginSetupCliBackendDescriptor({ backend: "target-cli" })).toEqual({
          pluginId: "target-owner",
          backend: { id: "Target-CLI" },
        });
        expect(activation.mock.calls.map(([, pluginId]) => pluginId)).toEqual(["target-owner"]);
        activation.mockClear();
        expect(resolvePluginSetupCliBackendDescriptor({ backend: "missing-cli" })).toBeUndefined();
        expect(activation).not.toHaveBeenCalled();
      },
      { trustConfigIdentity: true },
    );
  });

  it("preserves declaration order across case-equivalent owners and setup contributions", async () => {
    const { resolvePluginSetupCliBackendDescriptor, resolvePluginSetupCliBackendIds } =
      await import("./setup-registry.runtime.js");
    const snapshot = createPluginMetadataSnapshotFixture({
      plugins: [
        { id: "first-owner", cliBackends: ["Shared-CLI"] },
        {
          id: "second-owner",
          cliBackends: ["shared-cli"],
          setup: { cliBackends: ["shared-cli", "SHARED-CLI", "setup-cli"] },
        },
        { id: "third-owner", cliBackends: ["Shared-CLI"] },
      ],
    });
    const config = { plugins: { entries: { "first-owner": { enabled: false } } } };
    withPluginMetadataSnapshotScope(
      snapshot,
      () => {
        expect(resolvePluginSetupCliBackendDescriptor({ backend: "SHARED-CLI", config })).toEqual({
          pluginId: "second-owner",
          backend: { id: "shared-cli" },
        });
        expect(resolvePluginSetupCliBackendIds({ config })).toEqual([
          "shared-cli",
          "shared-cli",
          "SHARED-CLI",
          "setup-cli",
          "Shared-CLI",
        ]);
        expect(resolvePluginSetupCliBackendDescriptor({ backend: "SETUP-CLI", config })).toEqual({
          pluginId: "second-owner",
          backend: { id: "setup-cli" },
        });
      },
      { trustConfigIdentity: true },
    );
  });

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
    const snapshot = createPluginMetadataSnapshotFixture({
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
    for (const record of snapshot.index.plugins) {
      record.enabled = record.pluginId !== "disabled";
    }
    loadPluginMetadataSnapshotMock.mockReturnValue(snapshot);

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
    loadPluginMetadataSnapshotMock.mockReturnValue(createPluginMetadataSnapshotFixture());

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
