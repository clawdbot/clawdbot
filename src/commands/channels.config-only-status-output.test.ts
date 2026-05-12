import { describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.js";
import { makeDirectPlugin } from "../test-utils/channel-plugin-test-fixtures.js";
import { formatConfigChannelsStatusLines } from "./channels/status-config-format.js";

const activeChannelPlugins = vi.hoisted(() => [] as ChannelPlugin[]);
const listReadOnlyChannelPluginsForConfig = vi.hoisted(() => vi.fn(() => activeChannelPlugins));

vi.mock("../channels/plugins/index.js", () => ({
  listChannelPlugins: () => activeChannelPlugins,
  getLoadedChannelPlugin: (id: string) => activeChannelPlugins.find((plugin) => plugin.id === id),
  getChannelPlugin: (id: string) => activeChannelPlugins.find((plugin) => plugin.id === id),
}));

vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig,
}));

vi.mock("../channels/plugins/status.js", () => ({
  buildReadOnlySourceChannelAccountSnapshot: async ({
    accountId,
    cfg,
    plugin,
  }: {
    accountId: string;
    cfg: unknown;
    plugin: ChannelPlugin;
  }) => {
    const account = await plugin.config.inspectAccount?.(cfg as never, accountId);
    return account ? { accountId, ...(account as Record<string, unknown>) } : null;
  },
  buildChannelAccountSnapshot: async ({
    accountId,
    cfg,
    plugin,
  }: {
    accountId: string;
    cfg: unknown;
    plugin: ChannelPlugin;
  }) => {
    const account =
      (await plugin.config.inspectAccount?.(cfg as never, accountId)) ??
      plugin.config.resolveAccount(cfg as never, accountId);
    return { accountId, ...(account as Record<string, unknown>) };
  },
}));

function registerSingleTestPlugin(_pluginId: string, plugin: ChannelPlugin) {
  activeChannelPlugins.splice(0, activeChannelPlugins.length, plugin);
}

async function formatLocalStatusSummary(
  cfg: unknown,
  options?: {
    sourceConfig?: unknown;
  },
) {
  const lines = await formatConfigChannelsStatusLines(
    cfg as never,
    { mode: "local" },
    options?.sourceConfig ? { sourceConfig: options.sourceConfig as never } : undefined,
  );
  return lines.join("\n");
}

function unresolvedTokenAccount() {
  return {
    name: "Primary",
    enabled: true,
    configured: true,
    token: "",
    tokenSource: "config",
    tokenStatus: "configured_unavailable",
  } as const;
}

function tokenOnlyPluginConfig() {
  return {
    listAccountIds: () => ["primary"],
    defaultAccountId: () => "primary",
    isConfigured: () => true,
    isEnabled: () => true,
  } as const;
}

function makeUnavailableTokenPlugin(): ChannelPlugin {
  return makeDirectPlugin({
    id: "token-only",
    label: "TokenOnly",
    docsPath: "/channels/token-only",
    config: {
      ...tokenOnlyPluginConfig(),
      resolveAccount: () => unresolvedTokenAccount(),
    },
  });
}

function makeResolvedTokenPlugin(): ChannelPlugin {
  return makeDirectPlugin({
    id: "token-only",
    label: "TokenOnly",
    docsPath: "/channels/token-only",
    config: {
      ...tokenOnlyPluginConfig(),
      inspectAccount: (cfg) =>
        (cfg as { secretResolved?: boolean }).secretResolved
          ? {
              accountId: "primary",
              name: "Primary",
              enabled: true,
              configured: true,
              token: "resolved-token",
              tokenSource: "config",
              tokenStatus: "available",
            }
          : { accountId: "primary", ...unresolvedTokenAccount() },
      resolveAccount: () => unresolvedTokenAccount(),
    },
  });
}

function makeResolvedTokenPluginWithoutInspectAccount(): ChannelPlugin {
  return makeDirectPlugin({
    id: "token-only",
    label: "TokenOnly",
    docsPath: "/channels/token-only",
    config: {
      listAccountIds: () => ["primary"],
      defaultAccountId: () => "primary",
      resolveAccount: (cfg) => {
        if (!(cfg as { secretResolved?: boolean }).secretResolved) {
          throw new Error("raw SecretRef reached resolveAccount");
        }
        return {
          name: "Primary",
          enabled: true,
          configured: true,
          token: "resolved-token",
          tokenSource: "config",
          tokenStatus: "available",
        };
      },
      isConfigured: () => true,
      isEnabled: () => true,
    },
  });
}

function makeUnavailableHttpSlackPlugin(): ChannelPlugin {
  return makeDirectPlugin({
    id: "slack",
    label: "Slack",
    docsPath: "/channels/slack",
    config: {
      listAccountIds: () => ["primary"],
      defaultAccountId: () => "primary",
      inspectAccount: () => ({
        accountId: "primary",
        name: "Primary",
        enabled: true,
        configured: true,
        mode: "http",
        botToken: "resolved-bot",
        botTokenSource: "config",
        botTokenStatus: "available",
        signingSecret: "",
        signingSecretSource: "config", // pragma: allowlist secret
        signingSecretStatus: "configured_unavailable", // pragma: allowlist secret
      }),
      resolveAccount: () => ({
        name: "Primary",
        enabled: true,
        configured: true,
      }),
      isConfigured: () => true,
      isEnabled: () => true,
    },
  });
}

function expectResolvedTokenStatusSummary(
  summary: string,
  options?: { includeUnavailableTokenLine?: boolean },
) {
  expect(summary).toContain("TokenOnly");
  expect(summary).toContain("configured");
  expect(summary).toContain("token:config");
  expect(summary).not.toContain("secret unavailable in this command path");
  if (options?.includeUnavailableTokenLine === false) {
    expect(summary).not.toContain("token:config (unavailable)");
  }
}

function requireReadOnlyPluginListCall(): unknown[] {
  const call = listReadOnlyChannelPluginsForConfig.mock.calls.at(0);
  if (!call) {
    throw new Error("expected listReadOnlyChannelPluginsForConfig call");
  }
  return call;
}

describe("config-only channels status output", () => {
  it("uses setup fallback plugins so configured external channels can be shown", async () => {
    registerSingleTestPlugin("token-only", makeUnavailableTokenPlugin());
    listReadOnlyChannelPluginsForConfig.mockClear();
    const cfg = { channels: { "token-only": { enabled: true } } };

    await formatLocalStatusSummary(cfg);

    expect(listReadOnlyChannelPluginsForConfig).toHaveBeenCalledOnce();
    expect(requireReadOnlyPluginListCall()).toStrictEqual([
      cfg,
      { activationSourceConfig: cfg, includeSetupFallbackPlugins: true },
    ]);
  });

  it("shows configured-but-unavailable credentials distinctly from not configured", async () => {
    registerSingleTestPlugin("token-only", makeUnavailableTokenPlugin());

    const joined = await formatLocalStatusSummary({ channels: {} });
    expect(joined).toContain("TokenOnly");
    expect(joined).toContain("TokenOnly primary");
    expect(joined).toContain("configured, secret unavailable in this command path");
    expect(joined).toContain("token:config (unavailable)");
  });

  it("prefers resolved config snapshots when command-local secret resolution succeeds", async () => {
    registerSingleTestPlugin("token-only", makeResolvedTokenPlugin());

    const joined = await formatLocalStatusSummary(
      { secretResolved: true, channels: {} },
      {
        sourceConfig: { channels: {} },
      },
    );
    expectResolvedTokenStatusSummary(joined, { includeUnavailableTokenLine: false });
  });

  it("does not resolve raw source config for extension channels without inspectAccount", async () => {
    registerSingleTestPlugin("token-only", makeResolvedTokenPluginWithoutInspectAccount());

    const joined = await formatLocalStatusSummary(
      { secretResolved: true, channels: {} },
      {
        sourceConfig: { channels: {} },
      },
    );
    expectResolvedTokenStatusSummary(joined);
  });

  it("renders Slack HTTP signing-secret availability in config-only status", async () => {
    registerSingleTestPlugin("slack", makeUnavailableHttpSlackPlugin());

    const joined = await formatLocalStatusSummary({ channels: {} });
    expect(joined).toContain("Slack");
    expect(joined).toContain("configured, secret unavailable in this command path");
    expect(joined).toContain("mode:http");
    expect(joined).toContain("bot:config");
    expect(joined).toContain("signing:config (unavailable)");
  });
});
