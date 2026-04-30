import { describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/config.js";

const {
  collectEnabledInsecureOrDangerousFlagsMock,
  listReadOnlyChannelPluginsForConfigMock,
  hasConfiguredChannelsForReadOnlyScopeMock,
} = vi.hoisted(() => ({
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
    listReadOnlyChannelPluginsForConfigMock(...args),
}));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  hasConfiguredChannelsForReadOnlyScope: (...args: unknown[]) =>
    hasConfiguredChannelsForReadOnlyScopeMock(...args),
  resolveConfiguredChannelPluginIds: () => [],
}));

const { runSecurityAudit } = await import("./audit.js");

describe("security audit channel read-only setup fallback", () => {
  it("uses setup fallback plugins so bundled channel security adapters are audited", async () => {
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

    expect(listReadOnlyChannelPluginsForConfigMock).toHaveBeenCalledWith(
      cfg,
      expect.objectContaining({
        includePersistedAuthState: true,
        includeSetupRuntimeFallback: true,
      }),
    );
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "channels.telegram.dm.open" }),
        expect.objectContaining({ checkId: "channels.telegram.dm.scope_main_multiuser" }),
      ]),
    );
  });
});
