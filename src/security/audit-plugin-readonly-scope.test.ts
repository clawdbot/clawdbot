import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const applyPluginAutoEnableMock = vi.hoisted(() => vi.fn());
const loadPluginMetadataRegistrySnapshotMock = vi.hoisted(() => vi.fn());
const resolveConfiguredChannelPluginIdsMock = vi.hoisted(() => vi.fn());

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => applyPluginAutoEnableMock(...args),
}));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  resolveConfiguredChannelPluginIds: (...args: unknown[]) =>
    resolveConfiguredChannelPluginIdsMock(...args),
}));

vi.mock("../plugins/runtime/metadata-registry-loader.js", () => ({
  loadPluginMetadataRegistrySnapshot: (...args: unknown[]) =>
    loadPluginMetadataRegistrySnapshotMock(...args),
}));

let runSecurityAudit: typeof import("./audit.js").runSecurityAudit;

describe("security audit read-only plugin scope", () => {
  beforeAll(async () => {
    ({ runSecurityAudit } = await import("./audit.js"));
  });

  beforeEach(() => {
    applyPluginAutoEnableMock.mockReset();
    loadPluginMetadataRegistrySnapshotMock.mockReset();
    resolveConfiguredChannelPluginIdsMock.mockReset();
    applyPluginAutoEnableMock.mockImplementation((params: { config: unknown }) => ({
      config: params.config,
      changes: [],
      autoEnabledReasons: {},
    }));
    loadPluginMetadataRegistrySnapshotMock.mockReturnValue({
      securityAuditCollectors: [],
    });
    resolveConfiguredChannelPluginIdsMock.mockReturnValue([]);
  });

  it("keeps configured channel owner collectors when the provided channel plugin list omits them", async () => {
    const sourceConfig = {
      plugins: {
        allow: ["external-channel-plugin", "audit-plugin"],
      },
    };
    applyPluginAutoEnableMock.mockReturnValue({
      config: sourceConfig,
      changes: [],
      autoEnabledReasons: {
        "external-channel-plugin": ["channel:external"],
        "audit-plugin": ["explicit"],
      },
    });
    resolveConfiguredChannelPluginIdsMock.mockReturnValue(["external-channel-plugin"]);

    await runSecurityAudit({
      config: sourceConfig,
      sourceConfig,
      env: {} as NodeJS.ProcessEnv,
      includeFilesystem: false,
      includeChannelSecurity: true,
      plugins: [],
    });

    expect(resolveConfiguredChannelPluginIdsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        config: sourceConfig,
        activationSourceConfig: sourceConfig,
        env: {},
      }),
    );
    expect(loadPluginMetadataRegistrySnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["external-channel-plugin", "audit-plugin"],
      }),
    );
  });

  it("removes configured channel owner collectors only when channel security will audit them", async () => {
    const sourceConfig = {
      plugins: {
        allow: ["external-channel-plugin", "audit-plugin"],
      },
    };
    applyPluginAutoEnableMock.mockReturnValue({
      config: sourceConfig,
      changes: [],
      autoEnabledReasons: {
        "external-channel-plugin": ["channel:external"],
        "audit-plugin": ["explicit"],
      },
    });
    resolveConfiguredChannelPluginIdsMock.mockReturnValue(["external-channel-plugin"]);

    await runSecurityAudit({
      config: sourceConfig,
      sourceConfig,
      env: {} as NodeJS.ProcessEnv,
      includeFilesystem: false,
      includeChannelSecurity: true,
      plugins: [{ id: "external-channel-plugin" }] as never,
    });

    expect(loadPluginMetadataRegistrySnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["audit-plugin"],
      }),
    );
  });
});
