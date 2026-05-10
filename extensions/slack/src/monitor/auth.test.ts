import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMonitorContext } from "./context.js";

const readChannelIngressStoreAllowFromForDmPolicyMock = vi.hoisted(() => vi.fn());
let authorizeSlackSystemEventSender: typeof import("./auth.js").authorizeSlackSystemEventSender;
let clearSlackAllowFromCacheForTest: typeof import("./auth.js").clearSlackAllowFromCacheForTest;
let resolveSlackEffectiveAllowFrom: typeof import("./auth.js").resolveSlackEffectiveAllowFrom;
let resolveSlackCommandIngress: typeof import("./auth.js").resolveSlackCommandIngress;

vi.mock("openclaw/plugin-sdk/channel-ingress-runtime", async () => {
  const actual = await vi.importActual<
    typeof import("openclaw/plugin-sdk/channel-ingress-runtime")
  >("openclaw/plugin-sdk/channel-ingress-runtime");
  return {
    ...actual,
    readChannelIngressStoreAllowFromForDmPolicy: (...args: unknown[]) =>
      readChannelIngressStoreAllowFromForDmPolicyMock(...args),
  };
});

function makeSlackCtx(allowFrom: string[]): SlackMonitorContext {
  return {
    allowFrom,
    accountId: "main",
    dmPolicy: "pairing",
  } as unknown as SlackMonitorContext;
}

function makeAuthorizeCtx(params?: {
  allowFrom?: string[];
  channelsConfig?: Record<string, { users?: string[] }>;
  resolveUserName?: (userId: string) => Promise<{ name?: string }>;
  resolveChannelName?: (
    channelId: string,
  ) => Promise<{ name?: string; type?: "im" | "mpim" | "channel" | "group" }>;
}) {
  return {
    allowFrom: params?.allowFrom ?? [],
    accountId: "main",
    dmPolicy: "open",
    dmEnabled: true,
    allowNameMatching: false,
    channelsConfig: params?.channelsConfig ?? {},
    channelsConfigKeys: Object.keys(params?.channelsConfig ?? {}),
    defaultRequireMention: true,
    isChannelAllowed: vi.fn(() => true),
    resolveUserName: vi.fn(
      params?.resolveUserName ?? ((_) => Promise.resolve({ name: undefined })),
    ),
    resolveChannelName: vi.fn(
      params?.resolveChannelName ?? ((_) => Promise.resolve({ name: "general", type: "channel" })),
    ),
  } as unknown as SlackMonitorContext;
}

describe("resolveSlackEffectiveAllowFrom", () => {
  beforeAll(async () => {
    ({
      authorizeSlackSystemEventSender,
      clearSlackAllowFromCacheForTest,
      resolveSlackEffectiveAllowFrom,
    } = await import("./auth.js"));
  });

  beforeEach(() => {
    readChannelIngressStoreAllowFromForDmPolicyMock.mockReset();
    clearSlackAllowFromCacheForTest();
  });

  it("falls back to channel config allowFrom when pairing store throws", async () => {
    readChannelIngressStoreAllowFromForDmPolicyMock.mockRejectedValueOnce(new Error("boom"));

    const effective = await resolveSlackEffectiveAllowFrom(makeSlackCtx(["u1"]), {
      includePairingStore: true,
    });

    expect(effective).toEqual(["u1"]);
  });

  it("treats malformed non-array pairing-store responses as empty", async () => {
    readChannelIngressStoreAllowFromForDmPolicyMock.mockReturnValueOnce(undefined);

    const effective = await resolveSlackEffectiveAllowFrom(makeSlackCtx(["u1"]), {
      includePairingStore: true,
    });

    expect(effective).toEqual(["u1"]);
  });

  it("reads pairing-store allowFrom when requested", async () => {
    readChannelIngressStoreAllowFromForDmPolicyMock.mockResolvedValue(["u2"]);
    const ctx = makeSlackCtx(["u1"]);

    const effective = await resolveSlackEffectiveAllowFrom(ctx, { includePairingStore: true });

    expect(effective).toEqual(["u1", "u2"]);
    expect(readChannelIngressStoreAllowFromForDmPolicyMock).toHaveBeenCalledTimes(1);
  });

  it("does not read pairing-store allowFrom unless requested", async () => {
    readChannelIngressStoreAllowFromForDmPolicyMock.mockResolvedValue(["u2"]);

    const effective = await resolveSlackEffectiveAllowFrom(makeSlackCtx(["u1"]));

    expect(effective).toEqual(["u1"]);
    expect(readChannelIngressStoreAllowFromForDmPolicyMock).not.toHaveBeenCalled();
  });
});

describe("authorizeSlackSystemEventSender", () => {
  beforeAll(async () => {
    ({ authorizeSlackSystemEventSender, clearSlackAllowFromCacheForTest } =
      await import("./auth.js"));
  });

  beforeEach(() => {
    clearSlackAllowFromCacheForTest();
  });

  it("keeps non-interactive channel senders open when only global allowFrom is configured", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({ allowFrom: ["U_OWNER"] }),
      senderId: "U_ATTACKER",
      channelId: "C1",
    });

    expect(result).toEqual({
      allowed: true,
      channelType: "channel",
      channelName: "general",
    });
  });

  it("keeps channel users as the non-interactive gate even when global allowFrom is configured", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({
        allowFrom: ["U_OWNER"],
        channelsConfig: {
          C1: { users: ["U_ALLOWED"] },
        },
      }),
      senderId: "U_OWNER",
      channelId: "C1",
    });

    expect(result).toEqual({
      allowed: false,
      reason: "sender-not-channel-allowed",
      channelType: "channel",
      channelName: "general",
    });
  });

  it("uses the channel denial reason for non-interactive senders who miss a channel users allowlist", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({
        allowFrom: ["U_OWNER"],
        channelsConfig: {
          C1: { users: ["U_ALLOWED"] },
        },
      }),
      senderId: "U_ATTACKER",
      channelId: "C1",
    });

    expect(result).toEqual({
      allowed: false,
      reason: "sender-not-channel-allowed",
      channelType: "channel",
      channelName: "general",
    });
  });

  it("allows channel senders authorized by channel users even when not in global allowFrom", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({
        allowFrom: ["U_OWNER"],
        channelsConfig: {
          C1: { users: ["U_ALLOWED"] },
        },
      }),
      senderId: "U_ALLOWED",
      channelId: "C1",
    });

    expect(result).toEqual({
      allowed: true,
      channelType: "channel",
      channelName: "general",
    });
  });

  it("keeps channel interactions open when no global or channel allowlists are configured", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx(),
      senderId: "U_ANYONE",
      channelId: "C1",
    });

    expect(result).toEqual({
      allowed: true,
      channelType: "channel",
      channelName: "general",
    });
  });

  it("does not let a wildcard global allowFrom bypass non-interactive channel users restrictions", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({
        allowFrom: ["*"],
        channelsConfig: {
          C1: { users: ["U_ALLOWED"] },
        },
      }),
      senderId: "U_ATTACKER",
      channelId: "C1",
    });

    expect(result).toEqual({
      allowed: false,
      reason: "sender-not-channel-allowed",
      channelType: "channel",
      channelName: "general",
    });
  });

  it("still allows a channel user when the global allowFrom is wildcard", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({
        allowFrom: ["*"],
        channelsConfig: {
          C1: { users: ["U_ALLOWED"] },
        },
      }),
      senderId: "U_ALLOWED",
      channelId: "C1",
    });

    expect(result).toEqual({
      allowed: true,
      channelType: "channel",
      channelName: "general",
    });
  });

  it("does not give non-interactive owner bypass when channel users are configured, even if explicit owners are also listed", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({
        allowFrom: ["U_OWNER", "*"],
        channelsConfig: {
          C1: { users: ["U_ALLOWED"] },
        },
      }),
      senderId: "U_ATTACKER",
      channelId: "C1",
    });

    expect(result).toEqual({
      allowed: false,
      reason: "sender-not-channel-allowed",
      channelType: "channel",
      channelName: "general",
    });
  });

  it("keeps explicit owners behind the non-interactive channel users gate when allowFrom also contains wildcard", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({
        allowFrom: ["U_OWNER", "*"],
        channelsConfig: {
          C1: { users: ["U_ALLOWED"] },
        },
      }),
      senderId: "U_OWNER",
      channelId: "C1",
    });

    expect(result).toEqual({
      allowed: false,
      reason: "sender-not-channel-allowed",
      channelType: "channel",
      channelName: "general",
    });
  });

  it("allows senders without channel context when no allowFrom is configured", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx(),
      senderId: "U_ANYONE",
    });

    expect(result).toEqual({
      allowed: true,
      channelType: "channel",
      channelName: undefined,
    });
  });
});

describe("resolveSlackCommandIngress", () => {
  beforeAll(async () => {
    ({ resolveSlackCommandIngress, clearSlackAllowFromCacheForTest } = await import("./auth.js"));
  });

  beforeEach(() => {
    clearSlackAllowFromCacheForTest();
  });

  it("does not authorize commands when sender denial stops before the command gate", async () => {
    const result = await resolveSlackCommandIngress({
      ctx: makeAuthorizeCtx(),
      senderId: "U_DENIED",
      channelType: "channel",
      channelId: "C1",
      ownerAllowFromLower: ["u_owner"],
      channelUsers: ["U_ALLOWED"],
      allowTextCommands: false,
      hasControlCommand: true,
      eventKind: "button",
      modeWhenAccessGroupsOff: "configured",
    });

    expect(result.ingress.decision).toBe("block");
    expect(result.commandAccess.authorized).toBe(false);
    expect(result.commandAccess.shouldBlockControlCommand).toBe(false);
  });
});

describe("authorizeSlackSystemEventSender interactiveEvent", () => {
  beforeAll(async () => {
    ({ authorizeSlackSystemEventSender, clearSlackAllowFromCacheForTest } =
      await import("./auth.js"));
  });

  beforeEach(() => {
    clearSlackAllowFromCacheForTest();
  });

  it("rejects interactive events when expectedSenderId is not provided", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({ allowFrom: ["U_OWNER"] }),
      senderId: "U_OWNER",
      channelId: "C1",
      interactiveEvent: true,
    });

    expect(result).toEqual({
      allowed: false,
      reason: "missing-expected-sender",
    });
  });

  it("allows interactive events when expectedSenderId matches senderId", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({ allowFrom: ["U_OWNER"] }),
      senderId: "U_OWNER",
      channelId: "C1",
      expectedSenderId: "U_OWNER",
      interactiveEvent: true,
    });

    expect(result).toEqual({
      allowed: true,
      channelType: "channel",
      channelName: "general",
    });
  });

  it("allows interactive channel senders who match the global allowFrom even when channel users are configured", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({
        allowFrom: ["U_OWNER"],
        channelsConfig: {
          C1: { users: ["U_ALLOWED"] },
        },
      }),
      senderId: "U_OWNER",
      channelId: "C1",
      expectedSenderId: "U_OWNER",
      interactiveEvent: true,
    });

    expect(result).toEqual({
      allowed: true,
      channelType: "channel",
      channelName: "general",
    });
  });

  it("uses a combined denial reason when an interactive sender matches neither global nor channel allowlists", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({
        allowFrom: ["U_OWNER"],
        channelsConfig: {
          C1: { users: ["U_ALLOWED"] },
        },
      }),
      senderId: "U_ATTACKER",
      channelId: "C1",
      expectedSenderId: "U_ATTACKER",
      interactiveEvent: true,
    });

    expect(result).toEqual({
      allowed: false,
      reason: "sender-not-authorized",
      channelType: "channel",
      channelName: "general",
    });
  });

  it("keeps interactive channel events open when no allowlists are configured", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx(),
      senderId: "U_ANYONE",
      channelId: "C1",
      expectedSenderId: "U_ANYONE",
      interactiveEvent: true,
    });

    expect(result).toEqual({
      allowed: true,
      channelType: "channel",
      channelName: "general",
    });
  });

  it("preserves explicit owner access for interactive events when allowFrom also contains wildcard", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({
        allowFrom: ["U_OWNER", "*"],
        channelsConfig: {
          C1: { users: ["U_ALLOWED"] },
        },
      }),
      senderId: "U_OWNER",
      channelId: "C1",
      expectedSenderId: "U_OWNER",
      interactiveEvent: true,
    });

    expect(result).toEqual({
      allowed: true,
      channelType: "channel",
      channelName: "general",
    });
  });

  it("keeps interactive no-channel events open when no allowFrom is configured", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx(),
      senderId: "U_ANYONE",
      expectedSenderId: "U_ANYONE",
      interactiveEvent: true,
    });

    expect(result).toEqual({
      allowed: true,
      channelType: "channel",
      channelName: undefined,
    });
  });

  it("denies interactive no-channel events when sender is not in allowFrom", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({ allowFrom: ["U_OWNER"] }),
      senderId: "U_ATTACKER",
      expectedSenderId: "U_ATTACKER",
      interactiveEvent: true,
    });

    expect(result).toEqual({
      allowed: false,
      reason: "sender-not-allowlisted",
    });
  });

  it("allows interactive no-channel events when sender is in allowFrom", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({ allowFrom: ["U_OWNER"] }),
      senderId: "U_OWNER",
      expectedSenderId: "U_OWNER",
      interactiveEvent: true,
    });

    expect(result).toEqual({
      allowed: true,
      channelType: "channel",
      channelName: undefined,
    });
  });

  it("rejects interactive events with ambiguous channel type", async () => {
    // Channel ID "X1" has no recognized prefix (D, C, G) so the type is ambiguous
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({
        allowFrom: ["U_OWNER"],
        resolveChannelName: () => Promise.resolve({ name: "mystery" }),
      }),
      senderId: "U_OWNER",
      channelId: "X1",
      expectedSenderId: "U_OWNER",
      interactiveEvent: true,
    });

    expect(result).toEqual({
      allowed: false,
      reason: "ambiguous-channel-type",
      channelType: "channel",
      channelName: "mystery",
    });
  });

  it("allows interactive events when channel type is known from ID prefix", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({ allowFrom: ["U_OWNER"] }),
      senderId: "U_OWNER",
      channelId: "C1",
      expectedSenderId: "U_OWNER",
      interactiveEvent: true,
    });

    expect(result).toEqual({
      allowed: true,
      channelType: "channel",
      channelName: "general",
    });
  });

  it("allows interactive events when channel type is known from explicit type", async () => {
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({
        allowFrom: ["U_OWNER"],
        resolveChannelName: () => Promise.resolve({ name: "mystery", type: "group" }),
      }),
      senderId: "U_OWNER",
      channelId: "X1",
      channelType: "group",
      expectedSenderId: "U_OWNER",
      interactiveEvent: true,
    });

    expect(result).toEqual({
      allowed: true,
      channelType: "group",
      channelName: "mystery",
    });
  });

  it("does not apply interactiveEvent restrictions to non-interactive events", async () => {
    // Same scenario as the denying test above, but without interactiveEvent flag
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx(),
      senderId: "U_ANYONE",
      channelId: "C1",
    });

    expect(result).toEqual({
      allowed: true,
      channelType: "channel",
      channelName: "general",
    });
  });
});
