import { describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { buildChannelSummary } from "./channel-summary.js";

const isFixtureAccountConfigured = (account: unknown) =>
  Boolean((account as { configured?: boolean }).configured);
const isFixtureAccountEnabled = (account: unknown) =>
  Boolean((account as { enabled?: boolean }).enabled);
const summaryPluginActions = {
  describeMessageTool: () => ({ actions: ["send"] as const }),
};

function makeSlackHttpSummaryPlugin(): ChannelPlugin {
  return {
    id: "slack",
    meta: {
      id: "slack",
      label: "Slack",
      selectionLabel: "Slack",
      docsPath: "/channels/slack",
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["primary"],
      defaultAccountId: () => "primary",
      inspectAccount: (cfg) =>
        (cfg as { marker?: string }).marker === "source"
          ? {
              accountId: "primary",
              name: "Primary",
              enabled: true,
              configured: true,
              mode: "http",
              botToken: "xoxb-http",
              signingSecret: "",
              botTokenSource: "config",
              signingSecretSource: "config", // pragma: allowlist secret
              botTokenStatus: "available",
              signingSecretStatus: "configured_unavailable", // pragma: allowlist secret
            }
          : {
              accountId: "primary",
              name: "Primary",
              enabled: true,
              configured: false,
              mode: "http",
              botToken: "xoxb-http",
              botTokenSource: "config",
              botTokenStatus: "available",
            },
      resolveAccount: () => ({
        accountId: "primary",
        name: "Primary",
        enabled: true,
        configured: false,
        mode: "http",
        botToken: "xoxb-http",
        botTokenSource: "config",
        botTokenStatus: "available",
      }),
      isConfigured: isFixtureAccountConfigured,
      isEnabled: () => true,
    },
    actions: summaryPluginActions,
  };
}

function makeTelegramSummaryPlugin(params: {
  enabled: boolean;
  configured: boolean;
  linked?: boolean;
  statusState?: string;
  authAgeMs?: number;
  allowFrom?: string[];
}): ChannelPlugin {
  const getAccount = () => ({
    accountId: "primary",
    name: "Main Bot",
    enabled: params.enabled,
    configured: params.configured,
    linked: params.linked,
    allowFrom: params.allowFrom ?? [],
    dmPolicy: "mutuals",
    tokenSource: "env",
  });

  return {
    id: "telegram",
    meta: {
      id: "telegram",
      label: "Telegram",
      selectionLabel: "Telegram",
      docsPath: "/channels/telegram",
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["primary"],
      defaultAccountId: () => "primary",
      inspectAccount: getAccount,
      resolveAccount: getAccount,
      isConfigured: isFixtureAccountConfigured,
      isEnabled: isFixtureAccountEnabled,
      formatAllowFrom: () => ["alice", "bob", "carol"],
    },
    status: {
      buildChannelSummary: async () => ({
        statusState: params.statusState,
        linked: params.linked,
        configured: params.configured,
        authAgeMs: params.authAgeMs,
        self: { e164: "+15551234567" },
      }),
    },
    actions: summaryPluginActions,
  };
}

function makeSignalSummaryPlugin(params: { enabled: boolean; configured: boolean }): ChannelPlugin {
  const getAccount = () => ({
    accountId: "desktop",
    name: "Desktop",
    enabled: params.enabled,
    configured: params.configured,
    appTokenSource: "env",
    baseUrl: "https://signal.example.test",
    port: 31337,
    cliPath: "/usr/local/bin/signal-cli",
    dbPath: "/tmp/signal.db",
  });

  return {
    id: "signal",
    meta: {
      id: "signal",
      label: "Signal",
      selectionLabel: "Signal",
      docsPath: "/channels/signal",
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => ["desktop"],
      defaultAccountId: () => "desktop",
      inspectAccount: getAccount,
      resolveAccount: getAccount,
      isConfigured: isFixtureAccountConfigured,
      isEnabled: isFixtureAccountEnabled,
    },
    actions: summaryPluginActions,
  };
}

function makeFallbackSummaryPlugin(params: {
  configured: boolean;
  enabled: boolean;
  accountIds?: string[];
  defaultAccountId?: string;
}): ChannelPlugin {
  const getAccount = (_cfg: unknown, accountId?: string | null) => ({
    accountId,
    enabled: params.enabled,
    configured: params.configured,
  });

  return {
    id: "fallback-plugin",
    meta: {
      id: "fallback-plugin",
      label: "Fallback",
      selectionLabel: "Fallback",
      docsPath: "/channels/fallback",
      blurb: "test",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => params.accountIds ?? [],
      defaultAccountId: () => params.defaultAccountId ?? "default",
      inspectAccount: getAccount,
      resolveAccount: getAccount,
      isConfigured: isFixtureAccountConfigured,
      isEnabled: isFixtureAccountEnabled,
    },
    actions: summaryPluginActions,
  };
}

describe("buildChannelSummary", () => {
  it("preserves Slack HTTP signing-secret unavailable state from source config", async () => {
    const lines = await buildChannelSummary({ marker: "resolved", channels: {} } as never, {
      colorize: false,
      includeAllowFrom: false,
      plugins: [makeSlackHttpSummaryPlugin()],
      sourceConfig: { marker: "source", channels: {} } as never,
    });

    expect(lines).toContain("Slack: configured");
    expect(lines).toContain(
      "  - primary (Primary) (bot:config, signing:config, secret unavailable in this command path)",
    );
  });

  it("shows disabled status without configured account detail lines", async () => {
    const lines = await buildChannelSummary({ channels: {} } as never, {
      colorize: false,
      includeAllowFrom: true,
      plugins: [makeTelegramSummaryPlugin({ enabled: false, configured: false })],
    });

    expect(lines).toEqual(["Telegram: disabled +15551234567"]);
  });

  it("includes linked summary metadata and truncates allow-from details", async () => {
    const lines = await buildChannelSummary({ channels: {} } as never, {
      colorize: false,
      includeAllowFrom: true,
      plugins: [
        makeTelegramSummaryPlugin({
          enabled: true,
          configured: true,
          linked: true,
          authAgeMs: 300_000,
          allowFrom: ["alice", "bob", "carol"],
        }),
      ],
    });

    expect(lines).toContain("Telegram: linked +15551234567 auth 5m ago");
    expect(lines).toContain("  - primary (Main Bot) (dm:mutuals, token:env, allow:alice,bob)");
  });

  it("shows not-linked status when linked metadata is explicitly false", async () => {
    const lines = await buildChannelSummary({ channels: {} } as never, {
      colorize: false,
      includeAllowFrom: false,
      plugins: [
        makeTelegramSummaryPlugin({
          enabled: true,
          configured: true,
          linked: false,
        }),
      ],
    });

    expect(lines).toContain("Telegram: not linked +15551234567");
    expect(lines).toContain("  - primary (Main Bot) (dm:mutuals, token:env)");
  });

  it("prefers plugin statusState when provided", async () => {
    const lines = await buildChannelSummary({ channels: {} } as never, {
      colorize: false,
      includeAllowFrom: false,
      plugins: [
        makeTelegramSummaryPlugin({
          enabled: true,
          configured: true,
          statusState: "unstable",
        }),
      ],
    });

    expect(lines).toContain("Telegram: auth stabilizing +15551234567");
  });

  it("renders non-slack account detail fields for configured accounts", async () => {
    const lines = await buildChannelSummary({ channels: {} } as never, {
      colorize: false,
      includeAllowFrom: false,
      plugins: [makeSignalSummaryPlugin({ enabled: false, configured: true })],
    });

    expect(lines).toEqual([
      "Signal: disabled",
      "  - desktop (Desktop) (disabled, app:env, https://signal.example.test, port:31337, cli:/usr/local/bin/signal-cli, db:/tmp/signal.db)",
    ]);
  });

  it("uses the channel label and default account id when no accounts exist", async () => {
    const lines = await buildChannelSummary({ channels: {} } as never, {
      colorize: false,
      includeAllowFrom: false,
      plugins: [
        makeFallbackSummaryPlugin({
          enabled: true,
          configured: true,
          accountIds: [],
          defaultAccountId: "fallback-account",
        }),
      ],
    });

    expect(lines).toEqual(["Fallback: configured", "  - fallback-account"]);
  });

  it("shows not-configured status when enabled accounts exist without configured ones", async () => {
    const lines = await buildChannelSummary({ channels: {} } as never, {
      colorize: false,
      includeAllowFrom: false,
      plugins: [
        makeFallbackSummaryPlugin({
          enabled: true,
          configured: false,
          accountIds: ["fallback-account"],
        }),
      ],
    });

    expect(lines).toEqual(["Fallback: not configured"]);
  });
});
