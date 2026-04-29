import { afterEach, describe, expect, it, vi } from "vitest";

const loadPluginRegistrySnapshotMock = vi.hoisted(() => vi.fn());
const loadPluginManifestRegistryForInstalledIndexMock = vi.hoisted(() => vi.fn());

vi.mock("./plugin-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./plugin-registry.js")>()),
  loadPluginRegistrySnapshot: loadPluginRegistrySnapshotMock,
}));
vi.mock("./manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex: loadPluginManifestRegistryForInstalledIndexMock,
}));

afterEach(() => {
  loadPluginRegistrySnapshotMock.mockReset();
  loadPluginManifestRegistryForInstalledIndexMock.mockReset();
});

describe("setup-registry runtime fallback", () => {
  it("uses bundled registry cliBackends when the setup-registry runtime is unavailable", async () => {
    loadPluginRegistrySnapshotMock.mockReturnValue({
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
    });
    loadPluginManifestRegistryForInstalledIndexMock.mockReturnValue({
      diagnostics: [],
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
    expect(loadPluginRegistrySnapshotMock).toHaveBeenCalledTimes(3);
    expect(loadPluginRegistrySnapshotMock).toHaveBeenCalledWith({});
    expect(loadPluginManifestRegistryForInstalledIndexMock).toHaveBeenCalledWith({
      index: expect.objectContaining({
        plugins: expect.arrayContaining([expect.objectContaining({ pluginId: "openai" })]),
      }),
    });
  });

  it("preserves fail-closed setup lookup when the runtime module explicitly declines to resolve", async () => {
    loadPluginRegistrySnapshotMock.mockReturnValue({
      diagnostics: [],
      plugins: [
        {
          pluginId: "openai",
          origin: "bundled",
          enabled: true,
        },
      ],
    });

    const { __testing, resolvePluginSetupCliBackendRuntime } =
      await import("./setup-registry.runtime.js");
    __testing.resetRuntimeState();
    __testing.setRuntimeModuleForTest({
      resolvePluginSetupCliBackend: () => undefined,
    });

    expect(resolvePluginSetupCliBackendRuntime({ backend: "codex-cli" })).toBeUndefined();
    expect(loadPluginRegistrySnapshotMock).not.toHaveBeenCalled();
  });
});
