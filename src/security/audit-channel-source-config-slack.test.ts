import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { stubAuditChannelPlugin } from "./audit-channel-test-helpers.js";
import { collectChannelSecurityFindings } from "./audit-channel.js";

function stubSlackPlugin(params: {
  resolveAccount: (cfg: OpenClawConfig, accountId: string | null | undefined) => unknown;
  inspectAccount?: (cfg: OpenClawConfig, accountId: string | null | undefined) => unknown;
  isConfigured?: (account: unknown, cfg: OpenClawConfig) => boolean;
}) {
  return stubAuditChannelPlugin({
    id: "slack",
    label: "Slack",
    commands: {
      nativeCommandsAutoEnabled: false,
      nativeSkillsAutoEnabled: false,
    },
    collectAuditFindings: async ({ account }) => {
      const config =
        (account as { config?: { slashCommand?: { enabled?: boolean }; allowFrom?: unknown } })
          .config ?? {};
      const slashCommandEnabled = config.slashCommand?.enabled === true;
      const allowFrom =
        Array.isArray(config.allowFrom) && config.allowFrom.length > 0 ? config.allowFrom : [];
      if (!slashCommandEnabled || allowFrom.length > 0) {
        return [];
      }
      return [
        {
          checkId: "channels.slack.commands.slash.no_allowlists",
          severity: "warn" as const,
          title: "Slack slash commands have no allowlists",
          detail: "test stub",
        },
      ];
    },
    ...params,
  });
}

function makeSlackHttpConfig(): OpenClawConfig {
  return {
    channels: {
      slack: {
        enabled: true,
        mode: "http",
        groupPolicy: "open",
        slashCommand: { enabled: true },
      },
    },
  } as OpenClawConfig;
}

function makeSlackInspection(
  channel: unknown,
  overrides: {
    enabled?: boolean;
    configured?: boolean;
    botTokenStatus?: string;
    signingSecretStatus?: string;
  },
) {
  return {
    accountId: "default",
    enabled: overrides.enabled ?? true,
    configured: overrides.configured ?? true,
    mode: "http",
    botTokenSource: "config",
    botTokenStatus: overrides.botTokenStatus ?? "configured_unavailable",
    signingSecretSource: "config",
    signingSecretStatus: overrides.signingSecretStatus ?? "configured_unavailable",
    config: channel,
  };
}

describe("security audit channel source-config fallback slack", () => {
  it("keeps source-configured channel security findings when resolved inspection is incomplete", async () => {
    const cases = [
      {
        name: "slack resolved inspection only exposes signingSecret status",
        sourceConfig: makeSlackHttpConfig(),
        resolvedConfig: makeSlackHttpConfig(),
        plugin: (sourceConfig: OpenClawConfig) =>
          stubSlackPlugin({
            inspectAccount: (cfg) => {
              const channel = cfg.channels?.slack ?? {};
              if (cfg === sourceConfig) {
                return makeSlackInspection(channel, {
                  enabled: false,
                });
              }
              return makeSlackInspection(channel, {
                botTokenStatus: "available",
                signingSecretStatus: "available",
              });
            },
            resolveAccount: (cfg) => ({ config: cfg.channels?.slack ?? {} }),
            isConfigured: (account) => Boolean((account as { configured?: boolean }).configured),
          }),
      },
      {
        name: "slack source config still wins when resolved inspection is unconfigured",
        sourceConfig: makeSlackHttpConfig(),
        resolvedConfig: makeSlackHttpConfig(),
        plugin: (sourceConfig: OpenClawConfig) =>
          stubSlackPlugin({
            inspectAccount: (cfg) => {
              const channel = cfg.channels?.slack ?? {};
              if (cfg === sourceConfig) {
                return makeSlackInspection(channel, {});
              }
              return makeSlackInspection(channel, {
                configured: false,
                botTokenStatus: "available",
                signingSecretStatus: "missing",
              });
            },
            resolveAccount: (cfg) => ({ config: cfg.channels?.slack ?? {} }),
            isConfigured: (account) => Boolean((account as { configured?: boolean }).configured),
          }),
      },
    ] as const;

    for (const testCase of cases) {
      const findings = await collectChannelSecurityFindings({
        cfg: testCase.resolvedConfig,
        sourceConfig: testCase.sourceConfig,
        plugins: [testCase.plugin(testCase.sourceConfig)],
      });

      const finding = findings.find(
        (entry) => entry.checkId === "channels.slack.commands.slash.no_allowlists",
      );
      if (!finding) {
        throw new Error(`Expected Slack no-allowlists finding for ${testCase.name}`);
      }
      expect(finding.severity, testCase.name).toBe("warn");
    }
  });
});
