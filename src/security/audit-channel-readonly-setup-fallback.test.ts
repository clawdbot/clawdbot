import { describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/config.js";

const {
  collectChannelSecurityFindingsMock,
  collectEnabledInsecureOrDangerousFlagsMock,
  listReadOnlyChannelPluginsForConfigMock,
  hasConfiguredChannelsForReadOnlyScopeMock,
} = vi.hoisted(() => ({
  collectChannelSecurityFindingsMock: vi.fn(async (..._args: unknown[]) => [
    {
      checkId: "channels.telegram.setup_fallback_audited",
      severity: "warn",
      title: "Telegram setup fallback audited",
    },
  ]),
  collectEnabledInsecureOrDangerousFlagsMock: vi.fn((_config: OpenClawConfig): string[] => []),
  listReadOnlyChannelPluginsForConfigMock: vi.fn(),
  hasConfiguredChannelsForReadOnlyScopeMock: vi.fn(),
}));

vi.mock("./dangerous-config-flags.js", () => ({
  collectEnabledInsecureOrDangerousFlags: (config: OpenClawConfig) =>
    collectEnabledInsecureOrDangerousFlagsMock(config),
}));

vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: (...args: unknown[]) =>
    (listReadOnlyChannelPluginsForConfigMock as (...params: unknown[]) => unknown)(...args),
}));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  hasConfiguredChannelsForReadOnlyScope: (...args: unknown[]) =>
    (hasConfiguredChannelsForReadOnlyScopeMock as (...params: unknown[]) => unknown)(...args),
  resolveConfiguredChannelPluginIds: () => [],
}));

vi.mock("./audit-channel.collect.runtime.js", () => ({
  collectChannelSecurityFindings: (...args: unknown[]) =>
    (collectChannelSecurityFindingsMock as (...params: unknown[]) => unknown)(...args),
}));

const collectNoFindings = vi.hoisted(() => vi.fn(() => []));
vi.mock("./audit.nondeep.runtime.js", () => ({
  collectAttackSurfaceSummaryFindings: collectNoFindings,
  collectExposureMatrixFindings: collectNoFindings,
  collectGatewayHttpNoAuthFindings: collectNoFindings,
  collectGatewayHttpSessionKeyOverrideFindings: collectNoFindings,
  collectHooksHardeningFindings: collectNoFindings,
  collectLikelyMultiUserSetupFindings: collectNoFindings,
  collectMinimalProfileOverrideFindings: collectNoFindings,
  collectModelHygieneFindings: collectNoFindings,
  collectNodeDangerousAllowCommandFindings: collectNoFindings,
  collectNodeDenyCommandPatternFindings: collectNoFindings,
  collectSandboxDangerousConfigFindings: collectNoFindings,
  collectSandboxDockerNoopFindings: collectNoFindings,
  collectSecretsInConfigFindings: collectNoFindings,
  collectSmallModelRiskFindings: collectNoFindings,
  collectSyncedFolderFindings: collectNoFindings,
  readConfigSnapshotForAudit: vi.fn(async () => null),
}));

const { runSecurityAudit } = await import("./audit.js");

describe("security audit channel read-only setup fallback", () => {
  it("passes setup fallback plugins to channel security collection", async () => {
    const plugin = {
      id: "telegram",
      meta: {
        id: "telegram",
        label: "Telegram",
        selectionLabel: "Telegram",
        docsPath: "/channels/telegram",
        blurb: "Test",
      },
      capabilities: { chatTypes: ["direct"] },
      config: {
        listAccountIds: () => ["default"],
        inspectAccount: () => ({ enabled: true, configured: true }),
        resolveAccount: () => ({}),
        isEnabled: () => true,
        isConfigured: () => true,
      },
      security: {
        resolveDmPolicy: () => ({
          policy: "open",
          allowFrom: ["*"],
          policyPath: "channels.telegram.dmPolicy",
          allowFromPath: "channels.telegram.",
          approveHint: "approve",
        }),
      },
    } satisfies ChannelPlugin;
    const cfg = {
      session: { dmScope: "main" },
      channels: { telegram: { enabled: true } },
    } satisfies OpenClawConfig;

    hasConfiguredChannelsForReadOnlyScopeMock.mockReturnValue(true);
    listReadOnlyChannelPluginsForConfigMock.mockReturnValue([plugin]);

    const report = await runSecurityAudit({
      config: cfg,
      sourceConfig: cfg,
      includeFilesystem: false,
      includeChannelSecurity: true,
      loadPluginSecurityCollectors: false,
    });

    const readOnlyPluginCalls = listReadOnlyChannelPluginsForConfigMock.mock
      .calls as unknown as Array<
      [
        OpenClawConfig,
        {
          includePersistedAuthState?: boolean;
          includeSetupFallbackPlugins?: boolean;
        },
      ]
    >;
    const readOnlyPluginCall = readOnlyPluginCalls[0];
    expect(readOnlyPluginCall?.[0]).toBe(cfg);
    expect(readOnlyPluginCall?.[1].includePersistedAuthState).toBe(true);
    expect(readOnlyPluginCall?.[1].includeSetupFallbackPlugins).toBe(true);

    const collectCalls = collectChannelSecurityFindingsMock.mock.calls as unknown as Array<
      [
        {
          cfg?: OpenClawConfig;
          sourceConfig?: OpenClawConfig;
          plugins?: ChannelPlugin[];
        },
      ]
    >;
    const collectParams = collectCalls[0]?.[0];
    expect(collectParams?.cfg).toBe(cfg);
    expect(collectParams?.sourceConfig).toBe(cfg);
    expect(collectParams?.plugins).toStrictEqual([plugin]);
    expect(report.findings.map((finding) => finding.checkId)).toContain(
      "channels.telegram.setup_fallback_audited",
    );
  });
});
