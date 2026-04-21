import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listChannelPlugins: vi.fn(),
  resolveOutboundChannelPlugin: vi.fn(),
}));

const deliverableChannelIds = vi.hoisted(() => ["alpha", "beta", "gamma", "delta", "muted"]);

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
  resolveOutboundChannelPlugin: mocks.resolveOutboundChannelPlugin,
}));

type ChannelSelectionModule = typeof import("./channel-selection.js");
type RuntimeModule = typeof import("../../runtime.js");

let __testing: ChannelSelectionModule["__testing"];
let listConfiguredMessageChannels: ChannelSelectionModule["listConfiguredMessageChannels"];
let resolveMessageChannelSelection: ChannelSelectionModule["resolveMessageChannelSelection"];
let runtimeModule: RuntimeModule;

beforeAll(async () => {
  runtimeModule = await import("../../runtime.js");
  ({ __testing, listConfiguredMessageChannels, resolveMessageChannelSelection } =
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
    errorSpy = vi.spyOn(runtimeModule.defaultRuntime, "error").mockImplementation(() => undefined);
    mocks.listChannelPlugins.mockReset();
    mocks.listChannelPlugins.mockReturnValue([]);
    mocks.resolveOutboundChannelPlugin.mockReset();
    mocks.resolveOutboundChannelPlugin.mockImplementation(({ channel }: { channel: string }) => ({
      id: channel,
    }));
    __testing.resetLoggedChannelSelectionErrors();
    errorSpy.mockClear();
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
});

describe("resolveMessageChannelSelection", () => {
  beforeEach(() => {
    mocks.listChannelPlugins.mockReset();
    mocks.listChannelPlugins.mockReturnValue([]);
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
    await expect(expectResolvedSelection(params)).resolves.toEqual(expected);
    verify?.(setupResult as never);
  });

  it.each([
    {
      params: { cfg: {} as never, channel: "channel:C123", fallbackChannel: "not-a-channel" },
      expectedMessage: "Unknown channel: channel:c123",
    },
    {
      setup: () => {
        mocks.resolveOutboundChannelPlugin.mockReturnValue(undefined);
      },
      params: { cfg: {} as never, channel: "alpha" },
      expectedMessage: "Channel is unavailable: alpha",
    },
    {
      params: { cfg: {} as never },
      expectedMessage: "Channel is required (no configured channels detected).",
    },
    {
      setup: () => {
        mocks.listChannelPlugins.mockReturnValue([
          makePlugin({ id: "beta", isConfigured: async () => true }),
          makePlugin({ id: "gamma", isConfigured: async () => true }),
        ]);
      },
      params: { cfg: {} as never },
      expectedMessage: "Channel is required when multiple channels are configured: beta, gamma",
    },
  ])("rejects invalid channel selection for %j", async ({ setup, params, expectedMessage }) => {
    setup?.();
    await expect(expectResolvedSelection(params)).rejects.toThrow(expectedMessage);
  });
});
