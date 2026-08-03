import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SlackMonitorContext } from "./context.js";

const readChannelIngressStoreAllowFromForDmPolicyMock = vi.hoisted(() => vi.fn());
let authorizeSlackBotRoomMessage: typeof import("./auth.js").authorizeSlackBotRoomMessage;
let authorizeSlackSystemEventSender: typeof import("./auth.js").authorizeSlackSystemEventSender;
let resolveSlackEffectiveAllowFrom: typeof import("./auth.js").resolveSlackEffectiveAllowFrom;
let resolveSlackCommandIngress: typeof import("./auth.js").resolveSlackCommandIngress;

beforeAll(async () => {
  ({
    authorizeSlackBotRoomMessage,
    authorizeSlackSystemEventSender,
    resolveSlackCommandIngress,
    resolveSlackEffectiveAllowFrom,
  } = await import("./auth.js"));
});

beforeEach(() => {
  readChannelIngressStoreAllowFromForDmPolicyMock.mockReset();
  delete process.env.OPENCLAW_SLACK_CHANNEL_MEMBERS_CACHE_TTL_MS;
});

afterEach(() => {
  delete process.env.OPENCLAW_SLACK_CHANNEL_MEMBERS_CACHE_TTL_MS;
});

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
  dmPolicy?: SlackMonitorContext["dmPolicy"];
  resolveUserName?: (userId: string) => Promise<{ name?: string }>;
  resolveChannelName?: (
    channelId: string,
  ) => Promise<{ name?: string; type?: "im" | "mpim" | "channel" | "group" }>;
}) {
  return {
    allowFrom: params?.allowFrom ?? [],
    accountId: "main",
    dmPolicy: params?.dmPolicy ?? "open",
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

type AuthorizeContextOptions = Parameters<typeof makeAuthorizeCtx>[0];
type AuthorizeRequest = Omit<Parameters<typeof authorizeSlackSystemEventSender>[0], "ctx">;
type AuthorizeExpected = Awaited<ReturnType<typeof authorizeSlackSystemEventSender>>;
type AuthorizeCase = {
  name: string;
  ctx?: AuthorizeContextOptions;
  request: AuthorizeRequest;
  expected: AuthorizeExpected;
};

const allowedChannel: AuthorizeExpected = {
  allowed: true,
  channelType: "channel",
  channelName: "general",
};
const deniedChannel: AuthorizeExpected = {
  allowed: false,
  reason: "sender-not-channel-allowed",
  channelType: "channel",
  channelName: "general",
};
const channelUsers = { C1: { users: ["U_ALLOWED"] } };

function interactiveRequest(
  senderId: string,
  request: Omit<
    Partial<AuthorizeRequest>,
    "senderId" | "expectedSenderId" | "interactiveEvent"
  > = {},
): AuthorizeRequest {
  return { senderId, expectedSenderId: senderId, interactiveEvent: true, ...request };
}

function makeChannelMemberAuth(
  conversationsMembers = vi.fn(async () => ({ members: ["UOWNER"], response_metadata: {} })),
) {
  const ctx = {
    allowFrom: [],
    accountId: "main",
    allowNameMatching: false,
    app: { client: { conversations: { members: conversationsMembers } } },
    botToken: "xoxb-test",
  } as unknown as SlackMonitorContext;
  const authorize = () =>
    authorizeSlackBotRoomMessage({
      ctx,
      channelId: "C1",
      senderId: "U_BOT",
      allowFromLower: ["uowner"],
    });
  return { authorize, conversationsMembers };
}

describe("resolveSlackEffectiveAllowFrom", () => {
  it.each([
    [
      "falls back to channel config allowFrom when pairing store throws",
      () =>
        readChannelIngressStoreAllowFromForDmPolicyMock.mockRejectedValueOnce(new Error("boom")),
      true,
      ["u1"],
      undefined,
    ],
    [
      "treats malformed non-array pairing-store responses as empty",
      () => readChannelIngressStoreAllowFromForDmPolicyMock.mockReturnValueOnce(undefined),
      true,
      ["u1"],
      undefined,
    ],
    [
      "reads pairing-store allowFrom when requested",
      () => readChannelIngressStoreAllowFromForDmPolicyMock.mockResolvedValue(["u2"]),
      true,
      ["u1", "u2"],
      1,
    ],
    [
      "does not read pairing-store allowFrom unless requested",
      () => readChannelIngressStoreAllowFromForDmPolicyMock.mockResolvedValue(["u2"]),
      false,
      ["u1"],
      0,
    ],
  ] as const)("%s", async (_name, setup, includePairingStore, expected, expectedCalls) => {
    setup();
    const effective = await resolveSlackEffectiveAllowFrom(
      makeSlackCtx(["u1"]),
      includePairingStore ? { includePairingStore } : undefined,
    );

    expect(effective).toEqual(expected);
    if (expectedCalls !== undefined) {
      expect(readChannelIngressStoreAllowFromForDmPolicyMock).toHaveBeenCalledTimes(expectedCalls);
    }
  });
});

describe("authorizeSlackSystemEventSender", () => {
  it.each([
    [
      "ignores non-decimal channel member cache ttl env values",
      () => {
        process.env.OPENCLAW_SLACK_CHANNEL_MEMBERS_CACHE_TTL_MS = "0x0";
      },
      1,
    ],
    [
      "drops cached channel members when the current clock is not a valid date timestamp",
      () => {
        vi.spyOn(Date, "now")
          .mockReturnValueOnce(1_700_000_000_000)
          .mockReturnValueOnce(1_700_000_000_000)
          .mockReturnValueOnce(Number.NaN)
          .mockReturnValue(1_700_000_000_000);
      },
      2,
    ],
    [
      "does not cache channel members when the expiry timestamp would exceed the valid date range",
      () => vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000),
      2,
    ],
  ] as const)("%s", async (_name, setup, expectedCalls) => {
    setup();
    const { authorize, conversationsMembers } = makeChannelMemberAuth();

    await expect(authorize()).resolves.toBe(true);
    await expect(authorize()).resolves.toBe(true);
    expect(conversationsMembers).toHaveBeenCalledTimes(expectedCalls);
  });

  it("still coalesces in-flight channel member lookups when durable cache expiry is invalid", async () => {
    vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    type MembersResponse = { members: string[]; response_metadata: Record<string, never> };
    let resolveMembers: (value: MembersResponse) => void;
    const membersPromise = new Promise<MembersResponse>((resolve) => {
      resolveMembers = resolve;
    });
    const { authorize, conversationsMembers } = makeChannelMemberAuth(vi.fn(() => membersPromise));

    const first = authorize();
    const second = authorize();
    resolveMembers!({ members: ["UOWNER"], response_metadata: {} });

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(conversationsMembers).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "keeps non-interactive channel senders open when only global allowFrom is configured",
      ctx: { allowFrom: ["U_OWNER"] },
      request: { senderId: "U_ATTACKER", channelId: "C1" },
      expected: allowedChannel,
    },
    {
      name: "allows MPIM system-event senders in the configured allowFrom",
      ctx: {
        allowFrom: ["U_OWNER"],
        resolveChannelName: async () => ({ name: "group-dm", type: "mpim" as const }),
      },
      request: { senderId: "U_OWNER", channelId: "G_MPIM" },
      expected: {
        allowed: true,
        channelType: "mpim",
        channelName: "group-dm",
      },
    },
    {
      name: "keeps channel users as the non-interactive gate even when global allowFrom is configured",
      ctx: { allowFrom: ["U_OWNER"], channelsConfig: channelUsers },
      request: { senderId: "U_OWNER", channelId: "C1" },
      expected: deniedChannel,
    },
    {
      name: "uses the channel denial reason for non-interactive senders who miss a channel users allowlist",
      ctx: { allowFrom: ["U_OWNER"], channelsConfig: channelUsers },
      request: { senderId: "U_ATTACKER", channelId: "C1" },
      expected: deniedChannel,
    },
    {
      name: "allows channel senders authorized by channel users even when not in global allowFrom",
      ctx: { allowFrom: ["U_OWNER"], channelsConfig: channelUsers },
      request: { senderId: "U_ALLOWED", channelId: "C1" },
      expected: allowedChannel,
    },
    {
      name: "keeps channel interactions open when no global or channel allowlists are configured",
      request: { senderId: "U_ANYONE", channelId: "C1" },
      expected: allowedChannel,
    },
    {
      name: "does not let a wildcard global allowFrom bypass non-interactive channel users restrictions",
      ctx: { allowFrom: ["*"], channelsConfig: channelUsers },
      request: { senderId: "U_ATTACKER", channelId: "C1" },
      expected: deniedChannel,
    },
    {
      name: "still allows a channel user when the global allowFrom is wildcard",
      ctx: { allowFrom: ["*"], channelsConfig: channelUsers },
      request: { senderId: "U_ALLOWED", channelId: "C1" },
      expected: allowedChannel,
    },
    {
      name: "does not give non-interactive owner bypass when channel users are configured, even if explicit owners are also listed",
      ctx: { allowFrom: ["U_OWNER", "*"], channelsConfig: channelUsers },
      request: { senderId: "U_ATTACKER", channelId: "C1" },
      expected: deniedChannel,
    },
    {
      name: "keeps explicit owners behind the non-interactive channel users gate when allowFrom also contains wildcard",
      ctx: { allowFrom: ["U_OWNER", "*"], channelsConfig: channelUsers },
      request: { senderId: "U_OWNER", channelId: "C1" },
      expected: deniedChannel,
    },
    {
      name: "allows senders without channel context when no allowFrom is configured",
      request: { senderId: "U_ANYONE" },
      expected: { allowed: true, channelType: "channel", channelName: undefined },
    },
  ] satisfies AuthorizeCase[])("$name", async ({ ctx, request, expected }) => {
    await expect(
      authorizeSlackSystemEventSender({ ctx: makeAuthorizeCtx(ctx), ...request }),
    ).resolves.toEqual(expected);
  });

  it("does not use pairing-store allowFrom for MPIM system events", async () => {
    readChannelIngressStoreAllowFromForDmPolicyMock.mockResolvedValue(["U_ATTACKER"]);
    const result = await authorizeSlackSystemEventSender({
      ctx: makeAuthorizeCtx({
        allowFrom: [],
        dmPolicy: "pairing",
        resolveChannelName: async () => ({ name: "group-dm", type: "mpim" }),
      }),
      senderId: "U_ATTACKER",
      channelId: "G_MPIM",
    });

    expect(result).toEqual({
      allowed: false,
      reason: "sender-not-allowlisted",
      channelType: "mpim",
      channelName: "group-dm",
    });
    expect(readChannelIngressStoreAllowFromForDmPolicyMock).not.toHaveBeenCalled();
  });
});

describe("resolveSlackCommandIngress", () => {
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

  it.each([
    ["blocks MPIM senders outside the configured allowFrom", "U_ATTACKER", "block", false],
    ["allows MPIM senders in the configured allowFrom", "U_OWNER", "allow", true],
  ] as const)("%s", async (_name, senderId, decision, allowed) => {
    const result = await resolveSlackCommandIngress({
      ctx: makeAuthorizeCtx(),
      senderId,
      channelType: "mpim",
      channelId: "G_MPIM",
      ownerAllowFromLower: ["u_owner"],
      allowTextCommands: false,
      hasControlCommand: false,
    });

    expect(result.senderAccess.decision).toBe(decision);
    expect(result.senderAccess.gate?.allowed).toBe(allowed);
  });
});

describe("authorizeSlackSystemEventSender interactiveEvent", () => {
  it.each([
    {
      name: "rejects interactive events when expectedSenderId is not provided",
      ctx: { allowFrom: ["U_OWNER"] },
      request: { senderId: "U_OWNER", channelId: "C1", interactiveEvent: true },
      expected: { allowed: false, reason: "missing-expected-sender" },
    },
    {
      name: "allows interactive events when expectedSenderId matches senderId",
      ctx: { allowFrom: ["U_OWNER"] },
      request: interactiveRequest("U_OWNER", { channelId: "C1" }),
      expected: allowedChannel,
    },
    {
      name: "allows interactive channel senders who match the global allowFrom even when channel users are configured",
      ctx: { allowFrom: ["U_OWNER"], channelsConfig: channelUsers },
      request: interactiveRequest("U_OWNER", { channelId: "C1" }),
      expected: allowedChannel,
    },
    {
      name: "uses a combined denial reason when an interactive sender matches neither global nor channel allowlists",
      ctx: { allowFrom: ["U_OWNER"], channelsConfig: channelUsers },
      request: interactiveRequest("U_ATTACKER", { channelId: "C1" }),
      expected: {
        allowed: false,
        reason: "sender-not-authorized",
        channelType: "channel",
        channelName: "general",
      },
    },
    {
      name: "keeps interactive channel events open when no allowlists are configured",
      request: interactiveRequest("U_ANYONE", { channelId: "C1" }),
      expected: allowedChannel,
    },
    {
      name: "preserves explicit owner access for interactive events when allowFrom also contains wildcard",
      ctx: { allowFrom: ["U_OWNER", "*"], channelsConfig: channelUsers },
      request: interactiveRequest("U_OWNER", { channelId: "C1" }),
      expected: allowedChannel,
    },
    {
      name: "keeps interactive no-channel events open when no allowFrom is configured",
      request: interactiveRequest("U_ANYONE"),
      expected: { allowed: true, channelType: "channel", channelName: undefined },
    },
    {
      name: "denies interactive no-channel events when sender is not in allowFrom",
      ctx: { allowFrom: ["U_OWNER"] },
      request: interactiveRequest("U_ATTACKER"),
      expected: { allowed: false, reason: "sender-not-allowlisted" },
    },
    {
      name: "allows interactive no-channel events when sender is in allowFrom",
      ctx: { allowFrom: ["U_OWNER"] },
      request: interactiveRequest("U_OWNER"),
      expected: { allowed: true, channelType: "channel", channelName: undefined },
    },
    {
      name: "rejects interactive events with ambiguous channel type",
      ctx: {
        allowFrom: ["U_OWNER"],
        resolveChannelName: async () => ({ name: "mystery" }),
      },
      request: interactiveRequest("U_OWNER", { channelId: "X1" }),
      expected: {
        allowed: false,
        reason: "ambiguous-channel-type",
        channelType: "channel",
        channelName: "mystery",
      },
    },
    {
      name: "allows interactive events when channel type is known from ID prefix",
      ctx: { allowFrom: ["U_OWNER"] },
      request: interactiveRequest("U_OWNER", { channelId: "C1" }),
      expected: allowedChannel,
    },
    {
      name: "allows interactive events when channel type is known from explicit type",
      ctx: {
        allowFrom: ["U_OWNER"],
        resolveChannelName: async () => ({ name: "mystery", type: "group" as const }),
      },
      request: interactiveRequest("U_OWNER", { channelId: "X1", channelType: "group" }),
      expected: { allowed: true, channelType: "group", channelName: "mystery" },
    },
    {
      name: "does not apply interactiveEvent restrictions to non-interactive events",
      request: { senderId: "U_ANYONE", channelId: "C1" },
      expected: allowedChannel,
    },
  ] satisfies AuthorizeCase[])("$name", async ({ ctx, request, expected }) => {
    await expect(
      authorizeSlackSystemEventSender({ ctx: makeAuthorizeCtx(ctx), ...request }),
    ).resolves.toEqual(expected);
  });
});
