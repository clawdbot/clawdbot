import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const loadConfigMock = vi.hoisted(() => vi.fn());
const getChannelPluginMock = vi.hoisted(() => vi.fn());
const listChannelPluginsMock = vi.hoisted(() => vi.fn());
const isDeliverableMessageChannelMock = vi.hoisted(() => vi.fn());
const normalizeMessageChannelMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    getRuntimeConfig: (...args: unknown[]) => loadConfigMock(...args),
  };
});

vi.mock("../channels/plugins/index.js", async () => {
  const actual = await vi.importActual<typeof import("../channels/plugins/index.js")>(
    "../channels/plugins/index.js",
  );
  return {
    ...actual,
    getChannelPlugin: (...args: unknown[]) => getChannelPluginMock(...args),
    listChannelPlugins: (...args: unknown[]) => listChannelPluginsMock(...args),
  };
});

vi.mock("../utils/message-channel.js", () => ({
  INTERNAL_MESSAGE_CHANNEL: "web",
  isDeliverableMessageChannel: (...args: unknown[]) => isDeliverableMessageChannelMock(...args),
  normalizeMessageChannel: (...args: unknown[]) => normalizeMessageChannelMock(...args),
}));

type ExecApprovalSurfaceModule = typeof import("./exec-approval-surface.js");

let resolveExecApprovalInitiatingSurfaceState: ExecApprovalSurfaceModule["resolveExecApprovalInitiatingSurfaceState"];
let supportsNativeExecApprovalClient: ExecApprovalSurfaceModule["supportsNativeExecApprovalClient"];

describe("resolveExecApprovalInitiatingSurfaceState", () => {
  beforeAll(async () => {
    ({ resolveExecApprovalInitiatingSurfaceState, supportsNativeExecApprovalClient } =
      await import("./exec-approval-surface.js"));
  });

  beforeEach(() => {
    loadConfigMock.mockReset();
    getChannelPluginMock.mockReset();
    listChannelPluginsMock.mockReset();
    isDeliverableMessageChannelMock.mockReset();
    normalizeMessageChannelMock.mockReset();
    normalizeMessageChannelMock.mockImplementation((value?: string | null) =>
      typeof value === "string" ? value.trim().toLowerCase() : undefined,
    );
    isDeliverableMessageChannelMock.mockImplementation(
      (value?: string) => value === "slack" || value === "discord" || value === "telegram",
    );
  });

  it.each([
    {
      channel: null,
      expected: {
        kind: "enabled",
        channel: undefined,
        channelLabel: "this platform",
        accountId: undefined,
      },
    },
    {
      channel: "tui",
      expected: {
        kind: "enabled",
        channel: "tui",
        channelLabel: "terminal UI",
        accountId: undefined,
      },
    },
    {
      channel: "web",
      expected: {
        kind: "enabled",
        channel: "web",
        channelLabel: "Web UI",
        accountId: undefined,
      },
    },
  ])("treats built-in initiating surface %j", ({ channel, expected }) => {
    expect(resolveExecApprovalInitiatingSurfaceState({ channel })).toEqual(expected);
  });

  it("uses the provided cfg for telegram and discord client enablement", () => {
    getChannelPluginMock.mockImplementation((channel: string) =>
      channel === "telegram"
        ? {
            meta: { label: "Telegram" },
            approvalCapability: {
              getActionAvailabilityState: () => ({ kind: "enabled" }),
            },
          }
        : channel === "discord"
          ? {
              meta: { label: "Discord" },
              approvalCapability: {
                getActionAvailabilityState: () => ({ kind: "disabled" }),
              },
            }
          : undefined,
    );
    const cfg = { channels: {} };

    expect(
      resolveExecApprovalInitiatingSurfaceState({
        channel: "telegram",
        accountId: "main",
        cfg: cfg as never,
      }),
    ).toEqual({
      kind: "enabled",
      channel: "telegram",
      channelLabel: "Telegram",
      accountId: "main",
    });
    expect(
      resolveExecApprovalInitiatingSurfaceState({
        channel: "discord",
        accountId: "main",
        cfg: cfg as never,
      }),
    ).toEqual({
      kind: "disabled",
      channel: "discord",
      channelLabel: "Discord",
      accountId: "main",
    });

    expect(loadConfigMock).not.toHaveBeenCalled();
  });

  it("reads approval availability from approvalCapability when auth is omitted", () => {
    const getActionAvailabilityState = vi.fn(() => ({ kind: "disabled" as const }));
    getChannelPluginMock.mockReturnValue({
      meta: { label: "Discord" },
      approvalCapability: {
        getActionAvailabilityState,
      },
    });

    expect(
      resolveExecApprovalInitiatingSurfaceState({
        channel: "discord",
        accountId: "main",
        cfg: {} as never,
      }),
    ).toEqual({
      kind: "disabled",
      channel: "discord",
      channelLabel: "Discord",
      accountId: "main",
    });
    expect(getActionAvailabilityState).toHaveBeenCalledWith({
      cfg: {} as never,
      accountId: "main",
      action: "approve",
      approvalKind: "exec",
    });
  });

  it("prefers exec-initiating-surface state over generic approval availability", () => {
    const getExecInitiatingSurfaceState = vi.fn(() => ({ kind: "disabled" as const }));
    const getActionAvailabilityState = vi.fn(() => ({ kind: "enabled" as const }));
    getChannelPluginMock.mockReturnValue({
      meta: { label: "Matrix" },
      approvalCapability: {
        native: {},
        getExecInitiatingSurfaceState,
        getActionAvailabilityState,
      },
    });

    expect(
      resolveExecApprovalInitiatingSurfaceState({
        channel: "matrix",
        accountId: "default",
        cfg: {} as never,
      }),
    ).toEqual({
      kind: "disabled",
      channel: "matrix",
      channelLabel: "Matrix",
      accountId: "default",
    });
    expect(getExecInitiatingSurfaceState).toHaveBeenCalledWith({
      cfg: {} as never,
      accountId: "default",
      action: "approve",
    });
    expect(getActionAvailabilityState).not.toHaveBeenCalled();
  });

  it("does not treat plugin-only approval availability as exec availability", () => {
    getChannelPluginMock.mockReturnValue({
      meta: { label: "Matrix" },
      approvalCapability: {
        native: {},
        getActionAvailabilityState: ({ approvalKind }: { approvalKind?: "exec" | "plugin" }) =>
          approvalKind === "plugin" ? { kind: "enabled" as const } : { kind: "disabled" as const },
      },
    });

    expect(
      resolveExecApprovalInitiatingSurfaceState({
        channel: "matrix",
        accountId: "default",
        cfg: {} as never,
      }),
    ).toEqual({
      kind: "disabled",
      channel: "matrix",
      channelLabel: "Matrix",
      accountId: "default",
    });
  });

  it("loads config lazily when cfg is omitted and marks unsupported channels", () => {
    loadConfigMock.mockReturnValueOnce({ loaded: true });
    getChannelPluginMock.mockImplementation((channel: string) =>
      channel === "telegram"
        ? {
            meta: { label: "Telegram" },
            approvalCapability: {
              getActionAvailabilityState: () => ({ kind: "disabled" }),
            },
          }
        : undefined,
    );

    expect(
      resolveExecApprovalInitiatingSurfaceState({
        channel: "telegram",
        accountId: "main",
      }),
    ).toEqual({
      kind: "disabled",
      channel: "telegram",
      channelLabel: "Telegram",
      accountId: "main",
    });
    expect(loadConfigMock).toHaveBeenCalledOnce();

    expect(resolveExecApprovalInitiatingSurfaceState({ channel: "signal" })).toEqual({
      kind: "unsupported",
      channel: "signal",
      channelLabel: "Signal",
      accountId: undefined,
    });
  });

  it("treats deliverable chat channels without a custom adapter as enabled", () => {
    expect(resolveExecApprovalInitiatingSurfaceState({ channel: "slack" })).toEqual({
      kind: "enabled",
      channel: "slack",
      channelLabel: "Slack",
      accountId: undefined,
    });
  });

  it("treats exec-specific initiating-surface hooks as native exec client support", () => {
    getChannelPluginMock.mockReturnValue({
      meta: { label: "Matrix" },
      approvalCapability: {
        native: {},
        getExecInitiatingSurfaceState: () => ({ kind: "enabled" as const }),
      },
    });

    expect(supportsNativeExecApprovalClient("matrix")).toBe(true);
  });
});
