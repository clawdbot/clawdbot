// Tests plugin command install, listing, and config behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { PluginCapabilityConsentReview } from "../../plugins/capability-summary.js";
import { recordInstalledPluginIndexInstallOwner } from "../../plugins/installed-plugin-index-install-owner.js";
import { ManagedPluginLifecycleError } from "../../plugins/management-lifecycle-error.js";
import { createInstalledPluginIndexSnapshot } from "../../plugins/status.test-fixtures.js";
import { handlePluginsCommand } from "./commands-plugins.js";
import { buildPluginsCommandParams, type ConfigSnapshotMock } from "./commands.test-harness.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const loadPluginMetadataSnapshotMock = vi.hoisted(() => vi.fn());
const validateConfigObjectWithPluginsMock = vi.hoisted(() => vi.fn());
const replaceConfigFileMock = vi.hoisted(() => vi.fn(async (_params: unknown) => undefined));
const buildPluginRegistrySnapshotReportMock = vi.hoisted(() => vi.fn());
const buildPluginDiagnosticsReportMock = vi.hoisted(() => vi.fn());
const buildPluginInspectReportMock = vi.hoisted(() => vi.fn());
const buildAllPluginInspectReportsMock = vi.hoisted(() => vi.fn());
const formatPluginCompatibilityNoticeMock = vi.hoisted(() => vi.fn(() => "ok"));
const refreshPluginRegistryAfterConfigMutationMock = vi.hoisted(() => vi.fn(async () => undefined));
const resolvePluginCapabilityConsentMock = vi.hoisted(() =>
  vi.fn<typeof import("../../plugins/capability-consent.js").resolvePluginCapabilityConsent>(
    async () => undefined,
  ),
);
const resolvePendingPluginCapabilityReviewMock = vi.hoisted(() =>
  vi.fn<
    typeof import("../../plugins/capability-consent.js").resolvePendingPluginCapabilityReview
  >(),
);

vi.mock("../../plugins/capability-consent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/capability-consent.js")>()),
  resolvePluginCapabilityConsent: resolvePluginCapabilityConsentMock,
  resolvePendingPluginCapabilityReview: resolvePendingPluginCapabilityReviewMock,
}));

vi.mock("../../cli/npm-resolution.js", () => ({
  buildNpmInstallRecordFields: vi.fn(),
}));

vi.mock("../../cli/plugins-command-helpers.js", () => ({
  createPluginInstallLogger: vi.fn(() => ({})),
  resolveFileNpmSpecToLocalPath: vi.fn(() => null),
}));

vi.mock("../../plugins/install-persistence.js", () => ({
  persistPluginInstall: vi.fn(async () => undefined),
}));

vi.mock("../../plugins/registry-refresh.js", () => ({
  refreshPluginRegistryAfterConfigMutation: refreshPluginRegistryAfterConfigMutationMock,
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
  replaceConfigFile: replaceConfigFileMock,
  transformConfigFileWithRetry: async (params: {
    afterWrite?: unknown;
    transform: (
      currentConfig: OpenClawConfig,
      context: { snapshot: ConfigSnapshotMock; previousHash: string | null; attempt: number },
    ) =>
      | Promise<{ nextConfig: OpenClawConfig; result?: unknown }>
      | {
          nextConfig: OpenClawConfig;
          result?: unknown;
        };
  }) => {
    const snapshot = (await readConfigFileSnapshotMock()) as ConfigSnapshotMock;
    const previousHash = snapshot.hash ?? null;
    const currentConfig = structuredClone(
      snapshot.sourceConfig ?? snapshot.resolved ?? snapshot.runtimeConfig ?? snapshot.parsed ?? {},
    );
    const transformContext = { snapshot, previousHash, attempt: 0 };
    const transformed = await params.transform(currentConfig, transformContext);
    const afterWrite = params.afterWrite ?? { mode: "auto" };
    await replaceConfigFileMock({ nextConfig: transformed.nextConfig, afterWrite });
    return {
      path: snapshot.path ?? "/tmp/openclaw.json",
      previousHash,
      persistedHash: "persisted-hash",
      snapshot,
      nextConfig: transformed.nextConfig,
      result: transformed.result,
      attempts: 1,
      afterWrite,
      followUp: { action: "none" },
    };
  },
}));

vi.mock("../../infra/archive.js", () => ({
  resolveArchiveKind: vi.fn(() => null),
}));

vi.mock("../../infra/clawhub-spec.js", () => ({
  parseClawHubPluginSpec: vi.fn(() => null),
}));

vi.mock("../../plugins/clawhub.js", () => ({
  CLAWHUB_INSTALL_ERROR_CODE: {},
  installPluginFromClawHub: vi.fn(),
}));

vi.mock("../../plugins/install.js", () => ({
  installPluginFromNpmSpec: vi.fn(),
  installPluginFromPath: vi.fn(),
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/plugin-metadata-snapshot.js")>()),
  loadPluginMetadataSnapshot: loadPluginMetadataSnapshotMock,
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
  options?: { gatewayClientScopes?: string[]; omitGatewayClientScopes?: boolean },
) {
  const params = buildPluginsCommandParams({
    commandBodyNormalized,
    cfg,
    gatewayClientScopes: options?.gatewayClientScopes,
  });
  if (options?.omitGatewayClientScopes) {
    delete params.ctx.GatewayClientScopes;
  }
  return params;
}

type MockCalls = {
  mock: { calls: unknown[][] };
};

const requireRecord = createRequireRecord("object", "expected-label");

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

function expectLastRegistryRefresh() {
  const calls = (refreshPluginRegistryAfterConfigMutationMock as unknown as MockCalls).mock.calls;
  const [payload] = calls.at(-1) ?? [];
  const payloadRecord = requireRecord(payload, "registry refresh payload");
  expect(Object.keys(payloadRecord).toSorted()).toEqual(["logger", "reason"]);
  expect(payloadRecord.reason).toBe("policy-changed");
  const logger = getNestedRecord(payloadRecord, "logger", "registry refresh logger");
  expect(logger.warn).toEqual(expect.any(Function));
}

describe("handlePluginsCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadPluginMetadataSnapshotMock.mockReturnValue({
      index: createInstalledPluginIndexSnapshot([]),
    });
    resolvePluginCapabilityConsentMock.mockReset().mockResolvedValue(undefined);
    resolvePendingPluginCapabilityReviewMock.mockReset();
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

  it("reports package-owned provenance for child inspection and all aliases", async () => {
    const install = {
      source: "npm",
      spec: "@example/pack@1.2.3",
      version: "1.2.3",
      installPath: "/plugins/pack",
      integrity: "sha512-pack",
    };
    const reports = ["pack/one", "pack/two"].map((id) => ({
      plugin: { id },
      compatibility: [],
      tools: [{ name: "runtime_tool" }],
    }));
    const index = {
      ...createInstalledPluginIndexSnapshot(
        reports.map(({ plugin }) =>
          recordInstalledPluginIndexInstallOwner(
            { pluginId: plugin.id, rootDir: install.installPath },
            "pack",
          ),
        ),
      ),
      installRecords: { pack: install },
    };
    loadPluginMetadataSnapshotMock.mockReturnValue({ index });
    buildAllPluginInspectReportsMock.mockReturnValue(reports);

    for (const action of ["inspect", "show", "get"]) {
      for (const report of reports) {
        buildPluginInspectReportMock.mockReturnValue(report);
        const result = await handlePluginsCommand(
          buildPluginsParams(`/plugins ${action} ${report.plugin.id}`, buildCfg()),
          true,
        );
        const payload = JSON.parse(
          result?.reply?.text?.split("```json\n")[1]?.split("\n```")[0] ?? "null",
        );
        expect(payload).toEqual({ ...report, compatibilityWarnings: [], install });
      }
      const result = await handlePluginsCommand(
        buildPluginsParams(`/plugin ${action} all`, buildCfg()),
        true,
      );
      const payload = JSON.parse(
        result?.reply?.text?.split("```json\n")[1]?.split("\n```")[0] ?? "null",
      );
      expect(payload).toEqual(
        reports.map((inspect) => ({ inspect, compatibilityWarnings: [], install })),
      );
    }
    expect(buildPluginDiagnosticsReportMock).toHaveBeenCalled();
    expect(buildPluginRegistrySnapshotReportMock).not.toHaveBeenCalled();
  });

  it("keeps bare inspection on the runtime report", async () => {
    const result = await handlePluginsCommand(
      buildPluginsParams("/plugins inspect", buildCfg()),
      true,
    );
    expect(result?.reply?.text).toContain("superpowers");
    expect(buildPluginDiagnosticsReportMock).toHaveBeenCalledTimes(1);
    expect(buildPluginRegistrySnapshotReportMock).not.toHaveBeenCalled();
  });

  it.each(["list", "inspect pack/one", "enable pack/one"])(
    "rejects invalid config before loading plugin state for %s",
    async (action) => {
      readConfigFileSnapshotMock.mockResolvedValue({ valid: false, path: "/tmp/openclaw.json" });
      const result = await handlePluginsCommand(
        buildPluginsParams(`/plugins ${action}`, buildCfg(), {
          gatewayClientScopes: WRITE_GATEWAY_SCOPES,
        }),
        true,
      );
      expect(result?.reply?.text).toBe("⚠️ Config file is invalid; fix it before using /plugins.");
      expect(buildPluginDiagnosticsReportMock).not.toHaveBeenCalled();
      expect(buildPluginRegistrySnapshotReportMock).not.toHaveBeenCalled();
      expect(replaceConfigFileMock).not.toHaveBeenCalled();
    },
  );

  it.each(["missing", "ambiguous", "conflicting"])(
    "does not attribute chat install metadata when ownership is %s",
    async (ownership) => {
      const inspect = { plugin: { id: "pack/one" }, compatibility: [] };
      const index = {
        ...createInstalledPluginIndexSnapshot([
          recordInstalledPluginIndexInstallOwner(
            { pluginId: inspect.plugin.id, rootDir: "/plugins/pack" },
            ownership === "conflicting" ? "pack" : undefined,
            ownership === "ambiguous",
          ),
        ]),
        installRecords: {
          pack: { source: "npm", installPath: "/plugins/pack" },
          "pack/one": { source: "npm", installPath: "/plugins/unrelated" },
        },
      };
      loadPluginMetadataSnapshotMock.mockReturnValue({ index });
      buildPluginInspectReportMock.mockReturnValue(inspect);
      buildAllPluginInspectReportsMock.mockReturnValue([inspect]);
      for (const name of [inspect.plugin.id, "all"]) {
        const result = await handlePluginsCommand(
          buildPluginsParams(`/plugins inspect ${name}`, buildCfg()),
          true,
        );
        const payload = JSON.parse(
          result?.reply?.text?.split("```json\n")[1]?.split("\n```")[0] ?? "null",
        );
        expect(Array.isArray(payload) ? payload[0].install : payload.install).toBeNull();
      }
    },
  );

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

  it("blocks channel-authorized non-owner plugin toggles before config mutation", async () => {
    const params = buildPluginsParams("/plugins enable superpowers", buildCfg(), {
      omitGatewayClientScopes: true,
    });
    params.command.channel = "telegram";
    params.command.channelId = "telegram";
    params.command.surface = "telegram";
    params.command.senderId = "telegram-user-3";
    params.command.senderIsOwner = false;
    params.command.isAuthorizedSender = true;
    params.ctx.Provider = "telegram";
    params.ctx.Surface = "telegram";

    const result = await handlePluginsCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(refreshPluginRegistryAfterConfigMutationMock).not.toHaveBeenCalled();
  });

  it("allows gateway clients with operator.admin to toggle plugins", async () => {
    validateConfigObjectWithPluginsMock.mockImplementation((next) => ({ ok: true, config: next }));
    const params = buildPluginsParams("/plugins disable superpowers", buildCfg(), {
      gatewayClientScopes: ["operator.admin", "operator.write"],
    });
    params.command.senderIsOwner = false;

    const result = await handlePluginsCommand(params, true);

    expect(result?.reply?.text).toContain('Plugin "superpowers" disabled');
    expectLastReplaceConfig(false);
    expectLastRegistryRefresh();
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
    expectLastRegistryRefresh();

    const disableParams = buildPluginsParams("/plugins disable superpowers", buildCfg(), {
      gatewayClientScopes: WRITE_GATEWAY_SCOPES,
    });
    disableParams.command.senderIsOwner = true;

    const disableResult = await handlePluginsCommand(disableParams, true);
    expect(disableResult?.reply?.text).toContain('Plugin "superpowers" disabled');
    expectLastReplaceConfig(false);
    expectLastRegistryRefresh();
  });

  it("does not enable a managed plugin when capability consent is required", async () => {
    validateConfigObjectWithPluginsMock.mockImplementation((next) => ({ ok: true, config: next }));
    const review: PluginCapabilityConsentReview = {
      pluginId: "superpowers",
      name: "Super Powers",
      reviewToken: "pending-review",
      source: { kind: "npm", spec: "@acme/superpowers", integrity: "sha512-superpowers" },
      declared: {
        channels: [],
        providers: [],
        tools: ["superpowers_run"],
        contracts: [],
        hooks: [],
        mcpServers: [],
        cliCommands: [],
        cliBackends: [],
        skills: [],
        dangerousConfigFlags: [],
      },
      grants: {
        hooks: {
          allowPromptInjection: { effective: true },
          allowConversationAccess: { effective: false },
        },
      },
    };
    resolvePendingPluginCapabilityReviewMock.mockReturnValue(review);
    resolvePluginCapabilityConsentMock.mockImplementation(async ({ onCapabilityConsent }) => {
      const accepted = await onCapabilityConsent?.(review);
      if (accepted?.reviewToken !== review.reviewToken) {
        throw new ManagedPluginLifecycleError('Plugin "superpowers" requires capability consent.', {
          capabilityConsent: { pluginId: review.pluginId, reviewToken: review.reviewToken },
        });
      }
    });
    const params = buildPluginsParams("/plugins enable superpowers", buildCfg(), {
      gatewayClientScopes: WRITE_GATEWAY_SCOPES,
    });

    const result = await handlePluginsCommand(params, true);

    expect(result?.reply?.text).toContain("Tools: superpowers_run");
    expect(result?.reply?.text).toContain("Integrity: sha512-superpowers");
    expect(result?.reply?.text).toContain(
      "rerun /plugins enable superpowers --accept-capabilities",
    );
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
    expect(refreshPluginRegistryAfterConfigMutationMock).not.toHaveBeenCalled();

    const accepted = await handlePluginsCommand(
      buildPluginsParams("/plugins enable superpowers --accept-capabilities", buildCfg(), {
        gatewayClientScopes: WRITE_GATEWAY_SCOPES,
      }),
      true,
    );

    expect(accepted?.reply?.text).toContain('Plugin "superpowers" enabled');
    expectLastReplaceConfig(true);
    expectLastRegistryRefresh();
  });

  it.each([
    "--accept-capabilities",
    "--accept-capabilities superpowers",
    "superpowers --accept-capabilities --accept-capabilities",
  ])("rejects malformed enable consent flags: %s", async (argumentsText) => {
    const result = await handlePluginsCommand(
      buildPluginsParams(`/plugins enable ${argumentsText}`, buildCfg(), {
        gatewayClientScopes: WRITE_GATEWAY_SCOPES,
      }),
      true,
    );

    expect(result?.reply?.text).toContain(
      "Usage: /plugins enable <plugin-id-or-name> [--accept-capabilities]",
    );
    expect(readConfigFileSnapshotMock).not.toHaveBeenCalled();
    expect(replaceConfigFileMock).not.toHaveBeenCalled();
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
    params.command.isAuthorizedSender = false;
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
