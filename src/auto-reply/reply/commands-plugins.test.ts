import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { handlePluginsCommand } from "./commands-plugins.js";
import { buildPluginsCommandParams } from "./commands.test-harness.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const validateConfigObjectWithPluginsMock = vi.hoisted(() => vi.fn());
const replaceConfigFileMock = vi.hoisted(() => vi.fn(async () => undefined));
const buildPluginRegistrySnapshotReportMock = vi.hoisted(() => vi.fn());
const buildPluginDiagnosticsReportMock = vi.hoisted(() => vi.fn());
const buildPluginInspectReportMock = vi.hoisted(() => vi.fn());
const buildAllPluginInspectReportsMock = vi.hoisted(() => vi.fn());
const formatPluginCompatibilityNoticeMock = vi.hoisted(() => vi.fn(() => "ok"));
const refreshPluginRegistryAfterConfigMutationMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../../cli/npm-resolution.js", () => ({
  buildNpmInstallRecordFields: vi.fn(),
}));

vi.mock("../../cli/plugins-command-helpers.js", () => ({
  createPluginInstallLogger: vi.fn(() => ({})),
  resolveFileNpmSpecToLocalPath: vi.fn(() => null),
}));

vi.mock("../../cli/plugins-install-persist.js", () => ({
  persistPluginInstall: vi.fn(async () => undefined),
}));

vi.mock("../../cli/plugins-registry-refresh.js", () => ({
  refreshPluginRegistryAfterConfigMutation: refreshPluginRegistryAfterConfigMutationMock,
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
  replaceConfigFile: replaceConfigFileMock,
}));

vi.mock("../../infra/archive.js", () => ({
  resolveArchiveKind: vi.fn(() => null),
}));

vi.mock("../../infra/clawhub.js", () => ({
  parseClawHubPluginSpec: vi.fn(() => null),
}));

vi.mock("../../plugins/clawhub.js", () => ({
  installPluginFromClawHub: vi.fn(),
}));

vi.mock("../../plugins/install.js", () => ({
  installPluginFromNpmSpec: vi.fn(),
  installPluginFromPath: vi.fn(),
}));

vi.mock("../../plugins/installed-plugin-index-records.js", () => ({
  loadInstalledPluginIndexInstallRecords: vi.fn(
    async (params = {}) => params.config?.plugins?.installs ?? {},
  ),
}));

vi.mock("../../plugins/status.js", () => ({
  buildAllPluginInspectReports: buildAllPluginInspectReportsMock,
  buildPluginDiagnosticsReport: buildPluginDiagnosticsReportMock,
  buildPluginInspectReport: buildPluginInspectReportMock,
  buildPluginRegistrySnapshotReport: buildPluginRegistrySnapshotReportMock,
  formatPluginCompatibilityNotice: formatPluginCompatibilityNoticeMock,
}));

vi.mock("../../plugins/toggle-config.js", () => ({
  setPluginEnabledInConfig: vi.fn((config: OpenClawConfig, id: string, enabled: boolean) => ({
    ...config,
    plugins: {
      ...config.plugins,
      entries: {
        ...config.plugins?.entries,
        [id]: { enabled },
      },
    },
  })),
}));

vi.mock("../../utils.js", async () => {
  const actual = await vi.importActual<typeof import("../../utils.js")>("../../utils.js");
  return {
    ...actual,
    resolveUserPath: vi.fn((value: string) => value),
  };
});

function buildCfg(): OpenClawConfig {
  return {
    plugins: { enabled: true },
    commands: { text: true, plugins: true },
  };
}

const WRITE_GATEWAY_SCOPES = ["operator.admin", "operator.write", "operator.pairing"];

function buildPluginsParams(
  commandBodyNormalized: string,
  cfg: OpenClawConfig,
  options?: { gatewayClientScopes?: string[] },
) {
  return buildPluginsCommandParams({
    commandBodyNormalized,
    cfg,
    gatewayClientScopes: options?.gatewayClientScopes,
  });
}

type MockCalls = {
  mock: { calls: unknown[][] };
};

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

function getNestedRecord(record: Record<string, unknown>, key: string, label: string) {
  return requireRecord(record[key], label);
}

function expectPluginEnabledInConfig(config: unknown, enabled: boolean) {
  const configRecord = requireRecord(config, "config");
  const plugins = getNestedRecord(configRecord, "plugins", "config.plugins");
  const entries = getNestedRecord(plugins, "entries", "config.plugins.entries");
  const superpowers = getNestedRecord(entries, "superpowers", "superpowers entry");
  expect(superpowers.enabled).toBe(enabled);
}

function expectLastReplaceConfig(enabled: boolean) {
  const calls = (replaceConfigFileMock as unknown as MockCalls).mock.calls;
  const [payload] = calls.at(-1) ?? [];
  const payloadRecord = requireRecord(payload, "replace config payload");
  expect(Object.keys(payloadRecord).toSorted()).toEqual(["afterWrite", "nextConfig"]);
  expect(payloadRecord.afterWrite).toEqual({ mode: "auto" });
  expectPluginEnabledInConfig(payloadRecord.nextConfig, enabled);
}

function expectLastRegistryRefresh(enabled: boolean) {
  const calls = (refreshPluginRegistryAfterConfigMutationMock as unknown as MockCalls).mock.calls;
  const [payload] = calls.at(-1) ?? [];
  const payloadRecord = requireRecord(payload, "registry refresh payload");
  expect(Object.keys(payloadRecord).toSorted()).toEqual(["config", "logger", "reason"]);
  expect(payloadRecord.reason).toBe("policy-changed");
  const logger = getNestedRecord(payloadRecord, "logger", "registry refresh logger");
  expect(logger.warn).toEqual(expect.any(Function));
  expectPluginEnabledInConfig(payloadRecord.config, enabled);
}

describe("handlePluginsCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readConfigFileSnapshotMock.mockResolvedValue({
      valid: true,
      path: "/tmp/openclaw.json",
      sourceConfig: buildCfg(),
      resolved: buildCfg(),
      hash: "config-1",
    });
    validateConfigObjectWithPluginsMock.mockReturnValue({
      ok: true,
      config: buildCfg(),
      issues: [],
    });
    buildPluginRegistrySnapshotReportMock.mockReturnValue({
      workspaceDir: "/tmp/plugins-workspace",
      plugins: [
        {
          id: "superpowers",
          name: "superpowers",
          status: "disabled",
          format: "openclaw",
          bundleFormat: "claude",
        },
      ],
    });
    buildPluginDiagnosticsReportMock.mockReturnValue({
      workspaceDir: "/tmp/plugins-workspace",
      plugins: [
        {
          id: "superpowers",
          name: "superpowers",
          status: "disabled",
          format: "openclaw",
          bundleFormat: "claude",
        },
      ],
    });
    buildPluginInspectReportMock.mockReturnValue({
      plugin: {
        id: "superpowers",
      },
      compatibility: [],
      bundleFormat: "claude",
      shape: { commands: ["review"] },
    });
    buildAllPluginInspectReportsMock.mockReturnValue([
      {
        plugin: { id: "superpowers" },
        compatibility: [],
      },
    ]);
  });

  it("lists discovered plugins and inspects plugin details", async () => {
    const listResult = await handlePluginsCommand(
      buildPluginsParams("/plugins list", buildCfg()),
      true,
    );
    expect(listResult?.reply?.text).toContain("Plugins");
    expect(listResult?.reply?.text).toContain("superpowers");
    expect(listResult?.reply?.text).toContain("[disabled]");

    const showResult = await handlePluginsCommand(
      buildPluginsParams("/plugins inspect superpowers", buildCfg()),
      true,
    );
    expect(showResult?.reply?.text).toContain('"id": "superpowers"');
    expect(showResult?.reply?.text).toContain('"bundleFormat": "claude"');
    expect(showResult?.reply?.text).toContain('"shape"');
    expect(showResult?.reply?.text).toContain('"compatibilityWarnings": []');

    const inspectAllResult = await handlePluginsCommand(
      buildPluginsParams("/plugins inspect all", buildCfg()),
      true,
    );
    expect(inspectAllResult?.reply?.text).toContain("```json");
    expect(inspectAllResult?.reply?.text).toContain('"plugin"');
    expect(inspectAllResult?.reply?.text).toContain('"compatibilityWarnings"');
    expect(inspectAllResult?.reply?.text).toContain('"superpowers"');
  });

  it("rejects internal writes without operator.admin", async () => {
    const params = buildPluginsParams("/plugins enable superpowers", buildCfg());
    params.command.channel = "webchat";
    params.command.channelId = "webchat";
    params.command.surface = "webchat";
    params.ctx.Provider = "webchat";
    params.ctx.Surface = "webchat";
    params.ctx.GatewayClientScopes = ["operator.write"];

    const result = await handlePluginsCommand(params, true);
    expect(result?.reply?.text).toContain("requires operator.admin");
  });

  it("enables and disables a discovered plugin", async () => {
    validateConfigObjectWithPluginsMock.mockImplementation((next) => ({ ok: true, config: next }));

    const enableParams = buildPluginsParams("/plugins enable superpowers", buildCfg(), {
      gatewayClientScopes: WRITE_GATEWAY_SCOPES,
    });
    enableParams.command.senderIsOwner = true;

    const enableResult = await handlePluginsCommand(enableParams, true);
    expect(enableResult?.reply?.text).toContain('Plugin "superpowers" enabled');
    expectLastReplaceConfig(true);
    expectLastRegistryRefresh(true);

    const disableParams = buildPluginsParams("/plugins disable superpowers", buildCfg(), {
      gatewayClientScopes: WRITE_GATEWAY_SCOPES,
    });
    disableParams.command.senderIsOwner = true;

    const disableResult = await handlePluginsCommand(disableParams, true);
    expect(disableResult?.reply?.text).toContain('Plugin "superpowers" disabled');
    expectLastReplaceConfig(false);
    expectLastRegistryRefresh(false);
  });

  it("refuses plugin enablement in Nix mode before reading or replacing config", async () => {
    const previousNixMode = process.env.OPENCLAW_NIX_MODE;
    process.env.OPENCLAW_NIX_MODE = "1";
    try {
      const params = buildPluginsParams("/plugins enable superpowers", buildCfg(), {
        gatewayClientScopes: WRITE_GATEWAY_SCOPES,
      });
      params.command.senderIsOwner = true;

      const result = await handlePluginsCommand(params, true);
      expect(result?.reply?.text).toContain("OPENCLAW_NIX_MODE=1");
      expect(result?.reply?.text).toContain("nix-openclaw#quick-start");
      expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
      expect(replaceConfigFileMock).not.toHaveBeenCalled();
      expect(refreshPluginRegistryAfterConfigMutationMock).not.toHaveBeenCalled();
    } finally {
      if (previousNixMode === undefined) {
        delete process.env.OPENCLAW_NIX_MODE;
      } else {
        process.env.OPENCLAW_NIX_MODE = previousNixMode;
      }
    }
  });

  it("resolves write targets by indexed plugin name without loading diagnostics", async () => {
    buildPluginRegistrySnapshotReportMock.mockReturnValue({
      workspaceDir: "/tmp/plugins-workspace",
      plugins: [
        {
          id: "superpowers",
          name: "Super Powers",
          status: "disabled",
          format: "openclaw",
          bundleFormat: "claude",
        },
      ],
    });
    validateConfigObjectWithPluginsMock.mockImplementation((next) => ({ ok: true, config: next }));

    const params = buildPluginsParams("/plugins enable Super Powers", buildCfg(), {
      gatewayClientScopes: WRITE_GATEWAY_SCOPES,
    });
    params.command.senderIsOwner = true;

    const result = await handlePluginsCommand(params, true);
    expect(result?.reply?.text).toContain('Plugin "superpowers" enabled');
    expect(buildPluginRegistrySnapshotReportMock).toHaveBeenCalledTimes(1);
    expect(buildPluginDiagnosticsReportMock).not.toHaveBeenCalled();
  });

  it("returns an explicit unauthorized reply for native /plugins list", async () => {
    const params = buildPluginsParams("/plugins list", buildCfg());
    params.command.senderIsOwner = false;
    params.ctx.Provider = "telegram";
    params.ctx.Surface = "telegram";
    params.ctx.CommandSource = "native";
    params.command.channel = "telegram";
    params.command.channelId = "telegram";
    params.command.surface = "telegram";

    const result = await handlePluginsCommand(params, true);
    expect(result).toEqual({
      shouldContinue: false,
      reply: { text: "You are not authorized to use this command." },
    });
  });
});
