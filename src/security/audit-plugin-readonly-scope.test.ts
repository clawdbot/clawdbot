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

let collectPluginSecurityAuditFindings: typeof import("./audit.js").collectPluginSecurityAuditFindings;

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
    configSnapshot: null,
    codeSafetySummaryCache: new Map<string, Promise<unknown>>(),
  };
}

describe("security audit read-only plugin scope", () => {
  beforeAll(async () => {
    ({ collectPluginSecurityAuditFindings } = await import("./audit.js"));
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
});
