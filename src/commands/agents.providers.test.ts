// Agents provider tests cover provider status index construction for configured agents.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createAccountListHelpers } from "../plugin-sdk/account-helpers.js";
import { createScopedChannelConfigAdapter } from "../plugin-sdk/channel-config-helpers.js";
import type { OfficialExternalPluginRepairHint } from "../plugins/official-external-plugin-repair-hints.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { resolveAgentRoute } from "../routing/resolve-route.js";
import {
  buildProviderStatusIndex,
  buildProviderSummaryMetadataIndex,
  listProvidersForAgent,
  summarizeBindings,
} from "./agents.providers.js";

const mocks = vi.hoisted(() => ({
  listReadOnlyChannelPluginsForConfig: vi.fn(),
  getChannelPlugin: vi.fn(),
  normalizeChannelId: vi.fn((value: unknown) =>
    typeof value === "string" && value.trim().length > 0 ? value : null,
  ),
  resolveChannelDefaultAccountId: vi.fn(() => "default"),
  isChannelVisibleInConfiguredLists: vi.fn(() => true),
  listExplicitConfiguredChannelIdsForConfig: vi.fn(() => [] as string[]),
  resolveMissingOfficialExternalChannelPluginRepairHints: vi.fn<
    () => OfficialExternalPluginRepairHint[]
  >(() => []),
}));

vi.mock("../channels/plugins/index.js", () => ({
  getChannelPlugin: (...args: Parameters<typeof mocks.getChannelPlugin>) =>
    mocks.getChannelPlugin(...args),
  normalizeChannelId: (...args: Parameters<typeof mocks.normalizeChannelId>) =>
    mocks.normalizeChannelId(...args),
}));

vi.mock("../channels/plugins/read-only.js", () => ({
  listReadOnlyChannelPluginsForConfig: (
    ...args: Parameters<typeof mocks.listReadOnlyChannelPluginsForConfig>
  ) => mocks.listReadOnlyChannelPluginsForConfig(...args),
}));

vi.mock("../channels/plugins/helpers.js", () => ({
  resolveChannelDefaultAccountId: (
    ...args: Parameters<typeof mocks.resolveChannelDefaultAccountId>
  ) => mocks.resolveChannelDefaultAccountId(...args),
}));

vi.mock("../channels/plugins/exposure.js", () => ({
  isChannelVisibleInConfiguredLists: (
    ...args: Parameters<typeof mocks.isChannelVisibleInConfiguredLists>
  ) => mocks.isChannelVisibleInConfiguredLists(...args),
}));

vi.mock("../plugins/channel-plugin-ids.js", () => ({
  listExplicitConfiguredChannelIdsForConfig: mocks.listExplicitConfiguredChannelIdsForConfig,
}));

vi.mock("../plugins/official-external-plugin-repair-hints.js", () => ({
  resolveMissingOfficialExternalChannelPluginRepairHints:
    mocks.resolveMissingOfficialExternalChannelPluginRepairHints,
}));

function createAccountSelectionFixture(): ChannelPlugin<ChannelAccountSnapshot> {
  const accounts = new Map<string, ChannelAccountSnapshot>([
    ["default", { accountId: "default", name: "Default", configured: false, enabled: true }],
    ["alpha", { accountId: "alpha", name: "Alpha", configured: false, enabled: true }],
    ["beta", { accountId: "beta", name: "Beta", configured: false, enabled: false }],
  ]);
  const resolveAccount = (_cfg: OpenClawConfig, accountId?: string | null) => {
    const account = accounts.get(accountId ?? "alpha");
    if (!account) {
      throw new Error("Unexpected fixture account");
    }
    return account;
  };
  return {
    id: "telegram",
    meta: {
      id: "telegram",
      label: "Telegram",
      selectionLabel: "Telegram",
      docsPath: "/channels/telegram",
      blurb: "Fixture channel",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      listAccountIds: () => [...accounts.keys()],
      defaultAccountId: () => "alpha",
      resolveAccount,
      inspectAccount: resolveAccount,
      describeAccount: (account) => account,
    },
  };
}

function createRawListedAccountFixture() {
  const helpers = createAccountListHelpers("imessage");
  const calls: Array<string | null | undefined> = [];
  const resolveAccount = (cfg: OpenClawConfig, requestedId?: string | null) => {
    calls.push(requestedId);
    const accountId = normalizeAccountId(requestedId);
    const account = resolveAccountEntry(cfg.channels?.imessage?.accounts, accountId);
    return {
      accountId,
      name: account?.name,
      enabled: account?.enabled !== false,
      configured: true,
    };
  };
  const plugin: ChannelPlugin<ReturnType<typeof resolveAccount>> = {
    id: "imessage",
    meta: {
      id: "imessage",
      label: "iMessage",
      selectionLabel: "iMessage",
      docsPath: "/channels/imessage",
      blurb: "Fixture channel",
    },
    capabilities: { chatTypes: ["direct"] },
    config: {
      ...createScopedChannelConfigAdapter({
        sectionKey: "imessage",
        listAccountIds: helpers.listAccountIds,
        defaultAccountId: helpers.resolveDefaultAccountId,
        resolveAccount,
        clearBaseFields: [],
        resolveAllowFrom: () => [],
        formatAllowFrom: (values) => values.map(String),
      }),
      describeAccount: (account) => account,
    },
  };
  return { plugin, calls };
}

describe("buildProviderStatusIndex", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listExplicitConfiguredChannelIdsForConfig.mockReturnValue([]);
    mocks.resolveMissingOfficialExternalChannelPluginRepairHints.mockReturnValue([]);
  });

  it("prefers inspectAccount for read-only status surfaces", async () => {
    const inspectAccount = vi.fn(() => ({ enabled: true, configured: true, name: "Work" }));
    const resolveAccount = vi.fn(() => {
      throw new Error("should not be used when inspectAccount exists");
    });
    const plugin = {
      id: "workchat",
      meta: { label: "WorkChat" },
      config: {
        listAccountIds: () => ["work"],
        inspectAccount,
        resolveAccount,
        describeAccount: () => ({ configured: true, enabled: true, linked: true, name: "Work" }),
      },
      status: {},
    } as never;

    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([plugin]);
    mocks.getChannelPlugin.mockReturnValue(plugin);

    const map = await buildProviderStatusIndex({} as OpenClawConfig);

    expect(mocks.listReadOnlyChannelPluginsForConfig).toHaveBeenCalledWith(
      {},
      { includeSetupFallbackPlugins: false },
    );
    expect(resolveAccount).not.toHaveBeenCalled();
    expect(inspectAccount).toHaveBeenCalledWith({}, "work");
    const status = map.get("workchat:work");
    expect(status?.provider).toBe("workchat");
    expect(status?.accountId).toBe("work");
    expect(status?.state).toBe("linked");
    expect(status?.configured).toBe(true);
    expect(status?.enabled).toBe(true);
    expect(status?.name).toBe("Work");
  });

  it("keeps unresolved configured SecretRef accounts visible without exposing their refs", async () => {
    const plugin = {
      id: "quietchat",
      meta: { label: "QuietChat" },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => {
          throw new Error("unresolved SecretRef: PRIVATE_PROVIDER_TOKEN");
        },
      },
      status: {},
    } as never;

    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([plugin]);
    mocks.getChannelPlugin.mockReturnValue(plugin);

    await expect(buildProviderStatusIndex({} as OpenClawConfig)).resolves.toEqual(
      new Map([
        [
          "quietchat:default",
          {
            provider: "quietchat",
            providerLabel: "QuietChat",
            accountId: "default",
            state: "configured unavailable",
            configured: true,
            visibleInConfiguredLists: true,
          },
        ],
      ]),
    );
    const statuses = await buildProviderStatusIndex({} as OpenClawConfig);
    expect(
      listProvidersForAgent({
        summaryIsDefault: true,
        cfg: {} as OpenClawConfig,
        bindings: [],
        providerStatus: statuses,
        providerMetadata: buildProviderSummaryMetadataIndex({} as OpenClawConfig),
      }),
    ).toEqual(["QuietChat default: configured unavailable"]);
    expect(JSON.stringify([...statuses.values()])).not.toContain("PRIVATE_PROVIDER_TOKEN");
  });

  it("keeps configured-but-unavailable Telegram-style accounts in default agent output", async () => {
    const account = {
      accountId: "default",
      enabled: true,
      configured: true,
      tokenStatus: "configured_unavailable" as const,
    };
    const plugin = {
      id: "telegram",
      meta: { label: "Telegram" },
      config: {
        listAccountIds: () => ["default"],
        inspectAccount: () => account,
        resolveAccount: () => account,
        describeAccount: () => ({
          accountId: "default",
          enabled: true,
          configured: true,
          tokenStatus: "configured_unavailable" as const,
        }),
        isConfigured: () => false,
      },
      status: {},
    } as never;
    const cfg = {
      channels: {
        telegram: {
          enabled: true,
          tokenFile: "/nonexistent/token",
        },
      },
    } as OpenClawConfig;
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([plugin]);

    const statuses = await buildProviderStatusIndex(cfg);

    expect(statuses.get("telegram:default")).toMatchObject({
      configured: true,
      state: "configured unavailable",
    });
    expect(
      listProvidersForAgent({
        summaryIsDefault: true,
        cfg,
        bindings: [],
        providerStatus: statuses,
        providerMetadata: buildProviderSummaryMetadataIndex(cfg),
      }),
    ).toEqual(["Telegram default: configured unavailable"]);
  });

  it("does not mark a healthy Slack account unavailable for an optional unresolved user token", async () => {
    const account = {
      accountId: "default",
      enabled: true,
      configured: true,
      botTokenStatus: "available" as const,
      appTokenStatus: "available" as const,
      userTokenStatus: "configured_unavailable" as const,
    };
    const plugin = {
      id: "slack",
      meta: { label: "Slack" },
      config: {
        listAccountIds: () => ["default"],
        inspectAccount: () => account,
        resolveAccount: () => account,
        describeAccount: () => ({ accountId: "default", enabled: true, configured: true }),
        isConfigured: () => true,
      },
      status: {},
    } as never;
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([plugin]);

    expect(
      (await buildProviderStatusIndex({} as OpenClawConfig)).get("slack:default"),
    ).toMatchObject({ configured: true, state: "configured" });
  });

  it("does not treat an incomplete Slack account as configured when a required token is missing", async () => {
    const account = {
      accountId: "default",
      enabled: true,
      configured: false,
      botTokenStatus: "configured_unavailable" as const,
      appTokenStatus: "missing" as const,
      userTokenStatus: "missing" as const,
    };
    const plugin = {
      id: "slack",
      meta: { label: "Slack" },
      config: {
        listAccountIds: () => ["default"],
        inspectAccount: () => account,
        resolveAccount: () => account,
        describeAccount: () => ({ accountId: "default", enabled: true, configured: true }),
        isConfigured: () => false,
      },
      status: {},
    } as never;
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([plugin]);

    expect(
      (await buildProviderStatusIndex({} as OpenClawConfig)).get("slack:default"),
    ).toMatchObject({ configured: false, state: "not configured" });
  });

  it("keeps a fully configured Slack account visible when a required token is unavailable", async () => {
    const account = {
      accountId: "default",
      enabled: true,
      configured: true,
      botTokenStatus: "configured_unavailable" as const,
      appTokenStatus: "available" as const,
      userTokenStatus: "missing" as const,
    };
    const plugin = {
      id: "slack",
      meta: { label: "Slack" },
      config: {
        listAccountIds: () => ["default"],
        inspectAccount: () => account,
        resolveAccount: () => account,
        describeAccount: () => ({ accountId: "default", enabled: true, configured: false }),
        isConfigured: () => false,
      },
      status: {},
    } as never;
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([plugin]);

    expect(
      (await buildProviderStatusIndex({} as OpenClawConfig)).get("slack:default"),
    ).toMatchObject({ configured: true, state: "configured unavailable" });
  });

  it("does not inspect linkage for an unconfigured account", async () => {
    const isLinked = vi.fn(() => {
      throw new Error("linkage unavailable");
    });
    const plugin = {
      id: "quietchat",
      meta: { label: "QuietChat" },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true }),
        isConfigured: () => false,
        isLinked,
      },
    } as never;
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([plugin]);

    const status = (await buildProviderStatusIndex({} as OpenClawConfig)).get("quietchat:default");

    expect(status?.state).toBe("not configured");
    expect(isLinked).not.toHaveBeenCalled();
  });

  it("uses the shipped custom state resolver when canonical linkage is unknown", async () => {
    const resolveAccountState = vi.fn(() => "enabled" as const);
    const plugin = {
      id: "legacychat",
      meta: { label: "LegacyChat" },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => ({ enabled: true, configured: true }),
        isConfigured: () => true,
      },
      status: { resolveAccountState },
    } as never;
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([plugin]);

    const status = (await buildProviderStatusIndex({} as OpenClawConfig)).get("legacychat:default");

    expect(status?.state).toBe("enabled");
    expect(resolveAccountState).toHaveBeenCalledOnce();
  });

  it("rethrows unexpected read-only account resolution errors", async () => {
    const plugin = {
      id: "quietchat",
      meta: { label: "QuietChat" },
      config: {
        listAccountIds: () => ["default"],
        resolveAccount: () => {
          throw new Error("plugin crash");
        },
      },
      status: {},
    } as never;

    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([plugin]);
    mocks.getChannelPlugin.mockReturnValue(plugin);

    await expect(buildProviderStatusIndex({} as OpenClawConfig)).rejects.toThrow("plugin crash");
  });

  it("keeps configured missing external channels in provider metadata", () => {
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    mocks.listExplicitConfiguredChannelIdsForConfig.mockReturnValue(["feishu"]);
    mocks.resolveMissingOfficialExternalChannelPluginRepairHints.mockReturnValue([
      {
        channelId: "feishu",
        pluginId: "feishu",
        label: "Feishu",
        installSpec: "@openclaw/feishu",
        installCommand: "openclaw plugins install @openclaw/feishu",
        doctorFixCommand: "openclaw doctor --fix",
        repairHint:
          "Install the official external plugin with: openclaw plugins install @openclaw/feishu, or run: openclaw doctor --fix.",
      },
    ]);

    expect(
      buildProviderSummaryMetadataIndex({ channels: { feishu: { appId: "cli_xxx" } } } as never),
    ).toEqual(
      new Map([
        [
          "feishu",
          {
            label: "Feishu",
            defaultAccountId: "default",
            visibleInConfiguredLists: true,
            repairHint:
              "Install the official external plugin with: openclaw plugins install @openclaw/feishu, or run: openclaw doctor --fix.",
          },
        ],
      ]),
    );
  });

  it("skips missing-plugin resolution for channels already represented in metadata", () => {
    const plugin = {
      id: "feishu",
      meta: { label: "Feishu" },
      config: {
        listAccountIds: () => ["default"],
      },
    } as never;
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([plugin]);
    mocks.listExplicitConfiguredChannelIdsForConfig.mockReturnValue(["feishu"]);

    expect(
      buildProviderSummaryMetadataIndex({ channels: { feishu: { appId: "cli_xxx" } } } as never)
        .size,
    ).toBe(1);
    expect(mocks.resolveMissingOfficialExternalChannelPluginRepairHints).toHaveBeenCalledWith({
      config: { channels: { feishu: { appId: "cli_xxx" } } },
      channelIds: [],
    });
  });

  it.each([
    { selector: undefined, ids: ["default"], route: "default" },
    { selector: "", ids: ["default"], route: "default" },
    { selector: " \t ", ids: ["default"], route: "default" },
    { selector: "default", ids: ["default"], route: "default" },
    { selector: "alpha", ids: ["alpha"], route: "alpha" },
    { selector: " ALPHA ", ids: ["alpha"], route: "alpha" },
    { selector: "*", ids: ["default", "alpha", "beta"], route: "*" },
    { selector: " * ", ids: ["default", "alpha", "beta"], route: "*" },
    { selector: "absent", ids: ["absent"], route: "absent" },
  ])("renders canonical account selector $selector", async ({ selector, ids, route }) => {
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([createAccountSelectionFixture()]);
    const cfg: OpenClawConfig = {};
    const providerStatus = await buildProviderStatusIndex(cfg);
    const providerMetadata = new Map([
      [
        "telegram",
        { label: "Telegram", defaultAccountId: "alpha", visibleInConfiguredLists: true },
      ],
    ]);
    const bindings = [{ agentId: "proof", match: { channel: "telegram", accountId: selector } }];
    const lines = new Map([
      ["default", "Telegram default (Default): not configured"],
      ["alpha", "Telegram alpha (Alpha): not configured"],
      ["beta", "Telegram beta (Beta): disabled"],
      ["absent", "Telegram absent: unknown"],
    ]);
    expect(
      listProvidersForAgent({
        summaryIsDefault: false,
        cfg,
        bindings,
        providerStatus,
        providerMetadata,
      }),
    ).toEqual(ids.map((id) => lines.get(id)));
    expect(summarizeBindings(cfg, bindings, providerMetadata)).toEqual(["Telegram " + route]);
  });

  it("keeps configured-scope inventory separate from mixed-owner route precedence", async () => {
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([createAccountSelectionFixture()]);
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: { fallback: {}, specific: {}, defaultscope: {}, idle: {} },
      },
      bindings: [
        { agentId: "fallback", match: { channel: "telegram", accountId: " * " } },
        { agentId: "specific", match: { channel: "telegram", accountId: " ALPHA " } },
        { agentId: "defaultscope", match: { channel: "telegram", accountId: " " } },
        {
          agentId: "fallback",
          match: { channel: "telegram", accountId: "*", peer: { kind: "direct", id: "vip" } },
        },
      ],
    };
    const providerStatus = await buildProviderStatusIndex(cfg);
    const providerMetadata = new Map([
      [
        "telegram",
        { label: "Telegram", defaultAccountId: "alpha", visibleInConfiguredLists: true },
      ],
    ]);
    for (const [accountId, peerId, agentId, matchedBy] of [
      [undefined, "ordinary", "defaultscope", "binding.account"],
      [" ", "ordinary", "defaultscope", "binding.account"],
      ["default", "ordinary", "defaultscope", "binding.account"],
      ["alpha", "ordinary", "specific", "binding.account"],
      ["beta", "ordinary", "fallback", "binding.channel"],
      ["alpha", "vip", "fallback", "binding.peer"],
    ] as const) {
      expect(
        resolveAgentRoute({
          cfg,
          channel: "telegram",
          accountId,
          peer: { kind: "direct", id: peerId },
        }),
      ).toMatchObject({ agentId, matchedBy });
    }
    expect(
      resolveAgentRoute({
        cfg,
        channel: "discord",
        accountId: "alpha",
        defaultAgentId: "fallback",
        peer: { kind: "direct", id: "ordinary" },
      }),
    ).toMatchObject({ agentId: "fallback", matchedBy: "default" });
    expect(() =>
      resolveAgentRoute({
        cfg,
        channel: "discord",
        accountId: "alpha",
        peer: { kind: "direct", id: "ordinary" },
      }),
    ).toThrow("Multiple agents are configured");
    const rows = (agentId: string) =>
      listProvidersForAgent({
        summaryIsDefault: false,
        cfg,
        bindings: cfg.bindings!.filter((binding) => binding.agentId === agentId),
        providerStatus,
        providerMetadata,
      });
    expect(rows("fallback")).toEqual([
      "Telegram default (Default): not configured",
      "Telegram alpha (Alpha): not configured",
      "Telegram beta (Beta): disabled",
    ]);
    expect(rows("specific")).toEqual(["Telegram alpha (Alpha): not configured"]);
    expect(rows("defaultscope")).toEqual(["Telegram default (Default): not configured"]);
    expect(rows("idle")).toEqual([]);
  });

  it.each([false, true])("preserves unbound default=%s filtering", async (summaryIsDefault) => {
    const plugin = createAccountSelectionFixture();
    plugin.config.isConfigured = (account) => account.accountId === "alpha";
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([plugin]);
    expect(
      listProvidersForAgent({
        summaryIsDefault,
        cfg: {},
        bindings: [],
        providerStatus: await buildProviderStatusIndex({}),
        providerMetadata: new Map(),
      }),
    ).toEqual(summaryIsDefault ? ["Telegram alpha (Alpha): configured"] : []);
  });

  it.each([
    { repairHint: undefined, expected: "Telegram *: unknown" },
    { repairHint: "Install Telegram.", expected: "Telegram *: missing plugin - Install Telegram." },
  ])("preserves empty wildcard diagnostic $expected", async ({ repairHint, expected }) => {
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    expect(
      listProvidersForAgent({
        summaryIsDefault: false,
        cfg: {},
        bindings: [{ agentId: "proof", match: { channel: "telegram", accountId: " * " } }],
        providerStatus: await buildProviderStatusIndex({}),
        providerMetadata: new Map([
          [
            "telegram",
            {
              label: "Telegram",
              defaultAccountId: "alpha",
              visibleInConfiguredLists: true,
              repairHint,
            },
          ],
        ]),
      }),
    ).toEqual([expected]);
  });

  it.each(
    [
      ["alpha"],
      ["Alpha"],
      [" ALPHA "],
      ["*", "Alpha"],
      ["Alpha", "*"],
      ["*", "alpha", "Alpha"],
    ].map((selectors) => ({ selectors })),
  )("joins raw listed Alpha through canonical selectors $selectors", async ({ selectors }) => {
    const cfg: OpenClawConfig = {
      channels: { imessage: { accounts: { Alpha: { name: "Work", enabled: true } } } },
    };
    const { plugin, calls } = createRawListedAccountFixture();
    expect(plugin.config.listAccountIds(cfg)).toEqual(["Alpha"]);
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([plugin]);
    const providerStatus = await buildProviderStatusIndex(cfg);
    expect(calls).toEqual(["Alpha"]);
    expect(
      listProvidersForAgent({
        summaryIsDefault: false,
        cfg,
        bindings: selectors.map((accountId) => ({
          agentId: "proof",
          match: { channel: "imessage", accountId },
        })),
        providerStatus,
        providerMetadata: new Map([
          [
            "imessage",
            { label: "iMessage", defaultAccountId: "default", visibleInConfiguredLists: true },
          ],
        ]),
      }),
    ).toEqual(["iMessage Alpha (Work): configured"]);
  });

  it("canonicalizes raw listed ids for unavailable account status records", async () => {
    const cfg: OpenClawConfig = {
      channels: { imessage: { accounts: { Alpha: { enabled: true } } } },
    };
    const { plugin, calls } = createRawListedAccountFixture();
    plugin.config.resolveAccount = (_cfg, requestedId) => {
      calls.push(requestedId);
      throw new Error("unresolved SecretRef: synthetic fixture");
    };
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([plugin]);
    const providerStatus = await buildProviderStatusIndex(cfg);
    expect(calls).toEqual(["Alpha"]);
    expect(
      listProvidersForAgent({
        summaryIsDefault: false,
        cfg,
        bindings: [{ agentId: "proof", match: { channel: "imessage", accountId: "alpha" } }],
        providerStatus,
        providerMetadata: new Map([
          [
            "imessage",
            { label: "iMessage", defaultAccountId: "default", visibleInConfiguredLists: true },
          ],
        ]),
      }),
    ).toEqual(["iMessage Alpha: configured unavailable"]);
  });

  it("prefers the exact canonical record when listed account aliases collide", async () => {
    const cfg: OpenClawConfig = {
      channels: {
        imessage: {
          accounts: {
            Alpha: { name: "Alias", enabled: true },
            alpha: { name: "Exact", enabled: true },
          },
        },
      },
    };
    const { plugin, calls } = createRawListedAccountFixture();
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([plugin]);
    const providerStatus = await buildProviderStatusIndex(cfg);
    expect(calls).toEqual(plugin.config.listAccountIds(cfg));
    expect(
      listProvidersForAgent({
        summaryIsDefault: false,
        cfg,
        bindings: ["*", "Alpha", "alpha"].map((accountId) => ({
          agentId: "proof",
          match: { channel: "imessage", accountId },
        })),
        providerStatus,
        providerMetadata: new Map([
          [
            "imessage",
            { label: "iMessage", defaultAccountId: "default", visibleInConfiguredLists: true },
          ],
        ]),
      }),
    ).toEqual(["iMessage alpha (Exact): configured"]);
    expect(cfg.channels?.imessage?.accounts?.Alpha?.name).toBe("Alias");
  });

  it("keeps wildcard scope diagnostics distinct from the concrete default key", async () => {
    mocks.listReadOnlyChannelPluginsForConfig.mockReturnValue([]);
    const cfg: OpenClawConfig = {};
    const bindings = ["*", "default"].map((accountId) => ({
      agentId: "proof",
      match: { channel: "imessage", accountId },
    }));
    const providerMetadata = new Map([
      [
        "imessage",
        { label: "iMessage", defaultAccountId: "default", visibleInConfiguredLists: true },
      ],
    ]);
    expect(summarizeBindings(cfg, bindings, providerMetadata)).toEqual([
      "iMessage *",
      "iMessage default",
    ]);
    expect(
      listProvidersForAgent({
        summaryIsDefault: false,
        cfg,
        bindings,
        providerMetadata,
        providerStatus: await buildProviderStatusIndex(cfg),
      }),
    ).toEqual(["iMessage *: unknown", "iMessage default: unknown"]);
  });

  it("uses repair hints instead of unknown for bound missing external channels", () => {
    const lines = listProvidersForAgent({
      summaryIsDefault: false,
      cfg: { channels: { feishu: { appId: "cli_xxx" } } } as never,
      bindings: [{ match: { channel: "feishu" } }] as never,
      providerStatus: new Map(),
      providerMetadata: new Map([
        [
          "feishu",
          {
            label: "Feishu",
            defaultAccountId: "default",
            visibleInConfiguredLists: true,
            repairHint:
              "Install the official external plugin with: openclaw plugins install @openclaw/feishu, or run: openclaw doctor --fix.",
          },
        ],
      ]),
    });

    expect(lines).toEqual([
      "Feishu default: missing plugin - Install the official external plugin with: openclaw plugins install @openclaw/feishu, or run: openclaw doctor --fix.",
    ]);
  });

  it("keeps bound missing external channels when runtime registry normalization is unavailable", () => {
    mocks.normalizeChannelId.mockReturnValueOnce(null);

    const lines = listProvidersForAgent({
      summaryIsDefault: false,
      cfg: { channels: { feishu: { appId: "cli_xxx" } } } as never,
      bindings: [{ match: { channel: "feishu" } }] as never,
      providerStatus: new Map(),
      providerMetadata: new Map([
        [
          "feishu",
          {
            label: "Feishu",
            defaultAccountId: "default",
            visibleInConfiguredLists: true,
            repairHint:
              "Install the official external plugin with: openclaw plugins install @openclaw/feishu, or run: openclaw doctor --fix.",
          },
        ],
      ]),
    });

    expect(lines).toEqual([
      "Feishu default: missing plugin - Install the official external plugin with: openclaw plugins install @openclaw/feishu, or run: openclaw doctor --fix.",
    ]);
  });

  it("shows missing external plugin repair hints for default agent summaries", () => {
    const lines = listProvidersForAgent({
      summaryIsDefault: true,
      cfg: { channels: { feishu: { appId: "cli_xxx" } } } as never,
      bindings: [],
      providerStatus: new Map(),
      providerMetadata: new Map([
        [
          "feishu",
          {
            label: "Feishu",
            defaultAccountId: "default",
            visibleInConfiguredLists: true,
            repairHint:
              "Install the official external plugin with: openclaw plugins install @openclaw/feishu, or run: openclaw doctor --fix.",
          },
        ],
      ]),
    });

    expect(lines).toEqual([
      "Feishu default: missing plugin - Install the official external plugin with: openclaw plugins install @openclaw/feishu, or run: openclaw doctor --fix.",
    ]);
  });

  it("keeps route summaries when runtime registry normalization is unavailable", () => {
    mocks.normalizeChannelId.mockReturnValueOnce(null);

    expect(
      summarizeBindings(
        { channels: { feishu: { appId: "cli_xxx" } } } as never,
        [{ match: { channel: "feishu" } }] as never,
        new Map([
          [
            "feishu",
            {
              label: "Feishu",
              defaultAccountId: "default",
              visibleInConfiguredLists: true,
            },
          ],
        ]),
      ),
    ).toEqual(["Feishu default"]);
  });
});
