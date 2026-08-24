// Covers message channel selection from explicit input, tool context fallback,
// configured accounts, and missing official external plugin repair hints.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";

const mocks = vi.hoisted(() => ({
  listChannelPlugins: vi.fn(),
  listRuntimeVisibleChannelPlugins: vi.fn(),
  resolveOutboundChannelPlugin: vi.fn(),
  missingOfficialExternalChannels: new Set<string>(),
}));

const deliverableChannelIds = vi.hoisted(() => [
  "alpha",
  "beta",
  "gamma",
  "delta",
  "feishu",
  "muted",
  "whatsapp",
]);

vi.mock("../../channels/plugins/index.js", () => ({
  getLoadedChannelPlugin: vi.fn(),
  listChannelPlugins: mocks.listChannelPlugins,
}));

vi.mock("../../utils/message-channel.js", () => ({
  listDeliverableMessageChannels: () => deliverableChannelIds,
  isDeliverableMessageChannel: (value: string) => deliverableChannelIds.includes(value),
  normalizeMessageChannel: (value?: string | null) =>
    typeof value === "string" ? value.trim().toLowerCase() : undefined,
}));

vi.mock("./channel-resolution.js", () => ({
  normalizeDeliverableOutboundChannel: (value?: string | null) => {
    const normalized = typeof value === "string" ? value.trim().toLowerCase() : undefined;
    return normalized && deliverableChannelIds.includes(normalized) ? normalized : undefined;
  },
  resolveOutboundChannelPlugin: mocks.resolveOutboundChannelPlugin,
}));

vi.mock("./runtime-visible-channels.js", () => ({
  // Defaults to the process-root list; scoped-registry tests override it.
  listRuntimeVisibleChannelPlugins: (...args: unknown[]) =>
    mocks.listRuntimeVisibleChannelPlugins(...args) ?? mocks.listChannelPlugins(...args),
}));

vi.mock("../../plugins/official-external-plugin-repair-hints.js", () => ({
  resolveMissingOfficialExternalChannelPluginRepairHint: ({ channelId }: { channelId: string }) =>
    mocks.missingOfficialExternalChannels.has(channelId)
      ? {
          pluginId: channelId,
          channelId,
          label: channelId === "whatsapp" ? "WhatsApp" : "Feishu",
          installSpec: `@openclaw/${channelId}`,
          installCommand: `openclaw plugins install @openclaw/${channelId}`,
          doctorFixCommand: "openclaw doctor --fix",
          repairHint: `Install the official external plugin with: openclaw plugins install @openclaw/${channelId}, or run: openclaw doctor --fix.`,
        }
      : null,
  resolveMissingOfficialExternalChannelPluginRepairHints: ({
    channelIds,
  }: {
    channelIds: string[];
  }) =>
    channelIds.flatMap((channelId) =>
      mocks.missingOfficialExternalChannels.has(channelId)
        ? [
            {
              pluginId: channelId,
              channelId,
              label: channelId === "whatsapp" ? "WhatsApp" : "Feishu",
              installSpec: `@openclaw/${channelId}`,
              installCommand: `openclaw plugins install @openclaw/${channelId}`,
              doctorFixCommand: "openclaw doctor --fix",
              repairHint: `Install the official external plugin with: openclaw plugins install @openclaw/${channelId}, or run: openclaw doctor --fix.`,
            },
          ]
        : [],
    ),
}));

type ChannelSelectionModule = typeof import("./channel-selection.js");

let listConfiguredMessageChannels: ChannelSelectionModule["listConfiguredMessageChannels"];
let resolveMessageChannelSelection: ChannelSelectionModule["resolveMessageChannelSelection"];

beforeAll(async () => {
  ({ listConfiguredMessageChannels, resolveMessageChannelSelection } =
    await import("./channel-selection.js"));
});

function makePlugin(params: {
  id: string;
  accountIds?: string[];
  resolveAccount?: (accountId: string) => unknown;
  isEnabled?: (account: unknown) => boolean;
  isConfigured?: (account: unknown) => boolean | Promise<boolean>;
}) {
  return {
    id: params.id,
    config: {
      listAccountIds: () => params.accountIds ?? ["default"],
      resolveAccount: (_cfg: unknown, accountId: string) =>
        params.resolveAccount ? params.resolveAccount(accountId) : {},
      ...(params.isEnabled ? { isEnabled: params.isEnabled } : {}),
      ...(params.isConfigured ? { isConfigured: params.isConfigured } : {}),
    },
  };
}

async function expectResolvedSelection(
  params: Parameters<typeof resolveMessageChannelSelection>[0],
): Promise<Awaited<ReturnType<typeof resolveMessageChannelSelection>>> {
  return await resolveMessageChannelSelection(params);
}

describe("listConfiguredMessageChannels", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(defaultRuntime, "error").mockImplementation(() => undefined);
    mocks.listChannelPlugins.mockReset();
    mocks.listChannelPlugins.mockReturnValue([]);
    mocks.resolveOutboundChannelPlugin.mockReset();
    mocks.resolveOutboundChannelPlugin.mockImplementation(({ channel }: { channel: string }) => ({
      id: channel,
    }));
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it.each([
    {
      plugins: [makePlugin({ id: "not-a-channel" }), makePlugin({ id: "alpha", accountIds: [] })],
      expected: [],
      expectedErrors: 0,
    },
    {
      plugins: [
        makePlugin({
          id: "beta",
          resolveAccount: () => ({ enabled: true }),
        }),
      ],
      expected: ["beta"],
      expectedErrors: 0,
    },
    {
      plugins: [
        makePlugin({
          id: "gamma",
          accountIds: ["disabled", "enabled"],
          resolveAccount: (accountId) =>
            accountId === "disabled" ? { enabled: false } : { enabled: true },
          isConfigured: (account) => (account as { enabled?: boolean }).enabled === true,
        }),
      ],
      expected: ["gamma"],
      expectedErrors: 0,
    },
    {
      plugins: [
        makePlugin({
          id: "muted",
          resolveAccount: () => ({ token: "x" }),
          isEnabled: () => false,
          isConfigured: () => true,
        }),
      ],
      expected: [],
      expectedErrors: 0,
    },
    {
      plugins: [
        makePlugin({
          id: "beta",
          resolveAccount: () => {
            throw new Error("boom");
          },
        }),
      ],
      expected: [],
      expectedErrors: 1,
    },
  ])("lists configured channels for %j", async ({ plugins, expected, expectedErrors }) => {
    mocks.listChannelPlugins.mockReturnValue(plugins);
    await expect(listConfiguredMessageChannels({} as never)).resolves.toEqual(expected);
    expect(errorSpy).toHaveBeenCalledTimes(expectedErrors);
  });

  it("refreshes recent errors and re-logs errors evicted from the bounded dedupe", async () => {
    const listWithAccounts = async (accountIds: string[]) => {
      mocks.listChannelPlugins.mockReturnValue([
        makePlugin({
          id: "alpha",
          accountIds,
          resolveAccount: () => {
            throw new Error("boom");
          },
        }),
      ]);
      await listConfiguredMessageChannels({} as never);
    };

    await listWithAccounts(Array.from({ length: 1024 }, (_, index) => `account-${index}`));
    expect(errorSpy).toHaveBeenCalledTimes(1024);

    await listWithAccounts(["account-0"]);
    expect(errorSpy).toHaveBeenCalledTimes(1024);

    await listWithAccounts(["account-overflow"]);
    expect(errorSpy).toHaveBeenCalledTimes(1025);
    await listWithAccounts(["account-0"]);
    expect(errorSpy).toHaveBeenCalledTimes(1025);
    await listWithAccounts(["account-1"]);
    expect(errorSpy).toHaveBeenCalledTimes(1026);
  });
});

describe("resolveMessageChannelSelection", () => {
  beforeEach(() => {
    mocks.listChannelPlugins.mockReset();
    mocks.listChannelPlugins.mockReturnValue([]);
    mocks.resolveOutboundChannelPlugin.mockReset();
    mocks.resolveOutboundChannelPlugin.mockImplementation(({ channel }: { channel: string }) => ({
      id: channel,
    }));
    mocks.missingOfficialExternalChannels.clear();
  });

  it.each([
    {
      params: { cfg: {} as never, channel: "alpha" },
      expected: {
        channel: "alpha",
        configured: [],
        source: "explicit",
      },
    },
    {
      setup: () => {
        const isConfigured = vi.fn(async () => true);
        mocks.listChannelPlugins.mockReturnValue([makePlugin({ id: "beta", isConfigured })]);
        return { isConfigured };
      },
      params: { cfg: {} as never, channel: "beta" },
      expected: {
        channel: "beta",
        configured: [],
        source: "explicit",
      },
      verify: ({ isConfigured }: { isConfigured?: ReturnType<typeof vi.fn> }) => {
        expect(isConfigured).not.toHaveBeenCalled();
      },
    },
    {
      params: { cfg: {} as never, channel: "channel:C123", fallbackChannel: "beta" },
      expected: {
        channel: "beta",
        configured: [],
        source: "tool-context-fallback",
      },
    },
    {
      params: { cfg: {} as never, fallbackChannel: "gamma" },
      expected: {
        channel: "gamma",
        configured: [],
        source: "tool-context-fallback",
      },
    },
    {
      setup: () => {
        mocks.listChannelPlugins.mockReturnValue([
          makePlugin({ id: "delta", isConfigured: async () => true }),
        ]);
      },
      params: { cfg: {} as never },
      expected: {
        channel: "delta",
        configured: ["delta"],
        source: "single-configured",
      },
    },
    {
      setup: () => {
        mocks.resolveOutboundChannelPlugin.mockImplementation(({ channel }: { channel: string }) =>
          channel === "beta" ? { id: "beta" } : undefined,
        );
      },
      params: { cfg: {} as never, channel: "alpha", fallbackChannel: "beta" },
      expected: {
        channel: "beta",
        configured: [],
        source: "tool-context-fallback",
      },
    },
  ])("resolves message channel selection for %j", async ({ setup, params, expected, verify }) => {
    const setupResult = setup?.();
    await expect(expectResolvedSelection(params)).resolves.toMatchObject(expected);
    verify?.(setupResult as never);
  });

  it("returns the exact bootstrapped plugin used to prove availability", async () => {
    const plugin = { id: "alpha" };
    mocks.resolveOutboundChannelPlugin.mockReturnValue(plugin);

    const selection = await expectResolvedSelection({ cfg: {} as never, channel: "alpha" });

    expect(selection.plugin).toBe(plugin);
  });

  it("returns the exact configured plugin used for single-channel selection", async () => {
    const plugin = makePlugin({ id: "delta", isConfigured: async () => true });
    mocks.listChannelPlugins.mockReturnValue([plugin]);

    const selection = await expectResolvedSelection({ cfg: {} as never });

    expect(selection.plugin).toBe(plugin);
  });

  it("allows bootstrap while checking explicit and fallback channels", async () => {
    const cfg = {} as never;
    const fallbackPlugin = { id: "beta" };
    mocks.resolveOutboundChannelPlugin.mockImplementation(({ channel }: { channel: string }) =>
      channel === "beta" ? fallbackPlugin : undefined,
    );

    const selection = await expectResolvedSelection({
      cfg,
      channel: "alpha",
      fallbackChannel: "beta",
    });
    expect(selection).toMatchObject({
      channel: "beta",
      configured: [],
      source: "tool-context-fallback",
    });
    expect(selection.plugin).toBe(fallbackPlugin);

    expect(mocks.resolveOutboundChannelPlugin).toHaveBeenNthCalledWith(1, {
      channel: "alpha",
      cfg,
      allowBootstrap: true,
    });
    expect(mocks.resolveOutboundChannelPlugin).toHaveBeenNthCalledWith(2, {
      channel: "beta",
      cfg,
      allowBootstrap: true,
    });
  });

  it("carries the admitted agent into channel bootstrap", async () => {
    const cfg = {} as never;

    await expectResolvedSelection({ cfg, channel: "alpha", agentId: "ops" });

    expect(mocks.resolveOutboundChannelPlugin).toHaveBeenCalledWith({
      channel: "alpha",
      cfg,
      agentId: "ops",
      allowBootstrap: true,
    });
  });

  it.each([
    {
      params: { cfg: {} as never, channel: "channel:C123", fallbackChannel: "not-a-channel" },
      expectedMessage:
        'Unknown channel "channel:c123". Run `openclaw channels list --all` to see configured and installable channels.',
    },
    {
      setup: () => {
        mocks.resolveOutboundChannelPlugin.mockReturnValue(undefined);
      },
      params: { cfg: {} as never, channel: "alpha" },
      expectedMessage: "Channel is unavailable: alpha",
    },
    {
      setup: () => {
        mocks.resolveOutboundChannelPlugin.mockReturnValue(undefined);
        mocks.missingOfficialExternalChannels.add("feishu");
      },
      params: {
        cfg: { channels: { feishu: { appId: "cli_xxx" } } } as never,
        channel: "feishu",
      },
      expectedMessage:
        "Channel is unavailable: feishu. Install the official external plugin with: openclaw plugins install @openclaw/feishu, or run: openclaw doctor --fix.",
    },
    {
      params: { cfg: {} as never },
      expectedMessage:
        "Channel is required (no configured channels detected). Run openclaw channels add to configure one",
    },
    {
      setup: () => {
        mocks.resolveOutboundChannelPlugin.mockReturnValue(undefined);
        mocks.missingOfficialExternalChannels.add("whatsapp");
      },
      params: { cfg: { channels: { whatsapp: { enabled: true } } } as never },
      expectedMessage:
        "Channel is required (no available channels detected). Configured official external channel WhatsApp is missing its plugin. Install the official external plugin with: openclaw plugins install @openclaw/whatsapp, or run: openclaw doctor --fix.",
    },
    {
      setup: () => {
        mocks.listChannelPlugins.mockReturnValue([
          makePlugin({
            id: "whatsapp",
            isConfigured: async () => false,
          }),
        ]);
      },
      params: { cfg: { channels: { whatsapp: { enabled: true } } } as never },
      expectedMessage:
        "Channel is required (no configured channels detected). Run openclaw channels add to configure one",
    },
    {
      setup: () => {
        mocks.listChannelPlugins.mockReturnValue([
          makePlugin({ id: "beta", isConfigured: async () => true }),
          makePlugin({ id: "gamma", isConfigured: async () => true }),
        ]);
      },
      params: { cfg: {} as never },
      expectedMessage:
        "Channel is required when multiple channels are configured: beta, gamma. Pass --channel <channel> to choose one.",
    },
  ])("rejects invalid channel selection for %j", async ({ setup, params, expectedMessage }) => {
    setup?.();
    await expect(expectResolvedSelection(params)).rejects.toThrow(expectedMessage);
  });
});

describe("resolveMessageChannelSelection (registry-scoped channel plugins)", () => {
  beforeEach(() => {
    mocks.listChannelPlugins.mockReset();
    mocks.listChannelPlugins.mockReturnValue([]);
    mocks.listRuntimeVisibleChannelPlugins.mockReset();
    mocks.resolveOutboundChannelPlugin.mockReset();
    mocks.resolveOutboundChannelPlugin.mockImplementation(({ channel }: { channel: string }) => ({
      id: channel,
    }));
  });

  it("defaults to the single configured channel seen only through the runtime-visible list", async () => {
    mocks.listRuntimeVisibleChannelPlugins.mockReturnValue([
      makePlugin({ id: "delta", resolveAccount: () => ({ enabled: true }) }),
    ]);

    const selection = await expectResolvedSelection({ cfg: {} as never });
    expect(selection.channel).toBe("delta");
    expect(selection.source).toBe("single-configured");
  });

  it("still reports no configured channels when the visible list is empty", async () => {
    mocks.listRuntimeVisibleChannelPlugins.mockReturnValue([]);

    await expect(expectResolvedSelection({ cfg: {} as never })).rejects.toThrow(
      "Channel is required (no configured channels detected).",
    );
  });
});
