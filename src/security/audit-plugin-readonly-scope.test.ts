import { beforeEach, describe, expect, it, vi } from "vitest";

const applyPluginAutoEnableMock = vi.hoisted(() => vi.fn());
const getActivePluginRegistryMock = vi.hoisted(() => vi.fn());
const loadPluginMetadataRegistrySnapshotMock = vi.hoisted(() => vi.fn());
const resolveConfiguredChannelPluginIdsMock = vi.hoisted(() => vi.fn());

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => applyPluginAutoEnableMock(...args),
}));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  resolveConfiguredChannelPluginIds: (...args: unknown[]) =>
    resolveConfiguredChannelPluginIdsMock(...args),
}));

vi.mock("../plugins/runtime.js", () => ({
  getActivePluginRegistry: (...args: unknown[]) => getActivePluginRegistryMock(...args),
}));

vi.mock("../plugins/runtime/metadata-registry-loader.js", () => ({
  loadPluginMetadataRegistrySnapshot: (...args: unknown[]) =>
    loadPluginMetadataRegistrySnapshotMock(...args),
}));

const { collectPluginSecurityAuditFindings, runSecurityAudit } = await import("./audit.js");

function createAuditContext(params: {
  sourceConfig: Parameters<typeof collectPluginSecurityAuditFindings>[0]["sourceConfig"];
  plugins: Parameters<typeof collectPluginSecurityAuditFindings>[0]["plugins"];
}): Parameters<typeof collectPluginSecurityAuditFindings>[0] {
  return {
    cfg: params.sourceConfig,
    sourceConfig: params.sourceConfig,
    env: {},
    platform: process.platform,
    includeFilesystem: false,
    includeChannelSecurity: true,
    deep: false,
    deepTimeoutMs: 5000,
    stateDir: "/tmp/openclaw-test-state",
    configPath: "/tmp/openclaw-test-config.json",
    plugins: params.plugins,
    loadPluginSecurityCollectors: true,
    configSnapshot: null,
    codeSafetySummaryCache: new Map<string, Promise<unknown>>(),
  };
}

describe("security audit read-only plugin scope", () => {
  beforeEach(() => {
    applyPluginAutoEnableMock.mockReset();
    getActivePluginRegistryMock.mockReset();
    loadPluginMetadataRegistrySnapshotMock.mockReset();
    resolveConfiguredChannelPluginIdsMock.mockReset();
    getActivePluginRegistryMock.mockReturnValue(null);
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

    await collectPluginSecurityAuditFindings(
      createAuditContext({
        sourceConfig,
        plugins: [],
      }),
    );

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

    await collectPluginSecurityAuditFindings(
      createAuditContext({
        sourceConfig,
        plugins: [{ id: "external-channel-plugin" }] as never,
      }),
    );

    expect(loadPluginMetadataRegistrySnapshotMock).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["audit-plugin"],
      }),
    );
  });

  it("skips plugin runtime and collector discovery when collector loading is disabled", async () => {
    const sourceConfig = {
      plugins: {
        allow: ["audit-plugin"],
      },
    };

    const findings = await collectPluginSecurityAuditFindings({
      ...createAuditContext({
        sourceConfig,
        plugins: [],
      }),
      loadPluginSecurityCollectors: false,
    });

    expect(findings).toEqual([]);
    expect(getActivePluginRegistryMock).not.toHaveBeenCalled();
    expect(applyPluginAutoEnableMock).not.toHaveBeenCalled();
    expect(loadPluginMetadataRegistrySnapshotMock).not.toHaveBeenCalled();
  });

  it("keeps plain security audit off plugin collector runtime discovery by default", async () => {
    const sourceConfig = {
      plugins: {
        allow: ["audit-plugin"],
      },
    };

    await runSecurityAudit({
      config: sourceConfig,
      sourceConfig,
      env: {},
      includeFilesystem: false,
      includeChannelSecurity: false,
      stateDir: "/tmp/openclaw-test-state",
      configPath: "/tmp/openclaw-test-config.json",
    });

    expect(getActivePluginRegistryMock).not.toHaveBeenCalled();
    expect(applyPluginAutoEnableMock).not.toHaveBeenCalled();
    expect(loadPluginMetadataRegistrySnapshotMock).not.toHaveBeenCalled();
  });
});
