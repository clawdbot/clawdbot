// Slack tests cover members plugin behavior.
import type { AllMiddlewareArgs } from "@slack/bolt";
import { WebClient } from "@slack/web-api";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const memberMocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
  reportJoin: vi.fn(),
}));
let registerSlackMemberEvents: typeof import("./members.js").registerSlackMemberEvents;
let initSlackHarness: typeof import("./system-event-test-harness.js").createSlackSystemEventTestHarness;
type MemberOverrides = import("./system-event-test-harness.js").SlackSystemEventTestOverrides;

vi.mock("openclaw/plugin-sdk/channel-join-intro-runtime", () => ({
  reportChannelRoomJoin: memberMocks.reportJoin,
}));

vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({
  enqueueRoutedSystemEvent: (
    text: unknown,
    route: { sessionKey: unknown },
    options: Record<string, unknown>,
  ) => memberMocks.enqueue(text, { ...options, sessionKey: route.sessionKey }),
}));
type MemberHandler = import("./system-event-test-harness.js").SlackSystemEventHandler;

type MemberCaseArgs = {
  event?: Record<string, unknown>;
  body?: unknown;
  context?: AllMiddlewareArgs["context"];
  client?: AllMiddlewareArgs["client"];
  overrides?: MemberOverrides;
  handler?: "joined" | "left";
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
};

function makeMemberEvent(overrides?: { channel?: string; user?: string }) {
  return {
    type: "member_joined_channel",
    user: overrides?.user ?? "U1",
    channel: overrides?.channel ?? "D1",
    event_ts: "123.456",
  };
}

function getMemberHandlers(params: {
  overrides?: MemberOverrides;
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
}) {
  const harness = initSlackHarness(params.overrides);
  if (params.shouldDropMismatchedSlackEvent) {
    harness.ctx.shouldDropMismatchedSlackEvent = params.shouldDropMismatchedSlackEvent;
  }
  registerSlackMemberEvents({ ctx: harness.ctx, trackEvent: params.trackEvent });
  return {
    joined: harness.getHandler("member_joined_channel") as MemberHandler | null,
    left: harness.getHandler("member_left_channel") as MemberHandler | null,
  };
}

async function runMemberCase(args: MemberCaseArgs = {}): Promise<void> {
  memberMocks.enqueue.mockClear();
  const handlers = getMemberHandlers({
    overrides: args.overrides,
    trackEvent: args.trackEvent,
    shouldDropMismatchedSlackEvent: args.shouldDropMismatchedSlackEvent,
  });
  const key = args.handler ?? "joined";
  const handler = handlers[key];
  if (!handler) {
    throw new Error(`expected Slack member ${key} handler`);
  }
  await handler({
    event: (args.event ?? makeMemberEvent()) as Record<string, unknown>,
    body: args.body ?? { event_id: "Ev-member-default" },
    context: args.context,
    client: args.client,
  });
}

describe("registerSlackMemberEvents", () => {
  beforeAll(async () => {
    ({ registerSlackMemberEvents } = await import("./members.js"));
    ({ createSlackSystemEventTestHarness: initSlackHarness } =
      await import("./system-event-test-harness.js"));
  });

  beforeEach(() => {
    memberMocks.enqueue.mockClear();
    memberMocks.reportJoin.mockReset().mockResolvedValue({ kind: "posted" });
  });

  const cases: Array<{ name: string; args: MemberCaseArgs; calls: number }> = [
    {
      name: "enqueues DM member events when dmPolicy is open",
      args: { overrides: { dmPolicy: "open" } },
      calls: 1,
    },
    {
      name: "blocks DM member events when dmPolicy is disabled",
      args: { overrides: { dmPolicy: "disabled" } },
      calls: 0,
    },
    {
      name: "blocks DM member events for unauthorized senders in allowlist mode",
      args: {
        overrides: { dmPolicy: "allowlist", allowFrom: ["U2"] },
        event: makeMemberEvent({ user: "U1" }),
      },
      calls: 0,
    },
    {
      name: "allows DM member events for authorized senders in allowlist mode",
      args: {
        handler: "left" as const,
        overrides: { dmPolicy: "allowlist", allowFrom: ["U1"] },
        event: { ...makeMemberEvent({ user: "U1" }), type: "member_left_channel" },
      },
      calls: 1,
    },
    {
      name: "blocks channel member events for users outside channel users allowlist",
      args: {
        overrides: {
          dmPolicy: "open",
          channelType: "channel",
          channelUsers: ["U_OWNER"],
        },
        event: makeMemberEvent({ channel: "C1", user: "U_ATTACKER" }),
      },
      calls: 0,
    },
  ];
  it.each(cases)("$name", async ({ args, calls }) => {
    await runMemberCase(args);
    expect(memberMocks.enqueue).toHaveBeenCalledTimes(calls);
  });

  it("introduces the joined bot in an allowed room despite sender and mention requirements", async () => {
    const harness = initSlackHarness({ channelType: "channel", channelUsers: ["U_OWNER"] });
    harness.ctx.cfg = { channels: { slack: { groupPolicy: "open" } } };
    harness.ctx.accountId = "default";
    harness.ctx.resolveChannelName = vi.fn(async () => ({
      name: "deploys",
      type: "channel" as const,
      purpose: "Coordinate production deployments",
      topic: "Current release: 42",
    }));
    harness.ctx.resolveUserName = vi.fn(async () => ({ name: "Morgan" }));
    harness.ctx.app.client = new WebClient("xoxb-test");
    const readHistory = vi
      .spyOn(harness.ctx.app.client.conversations, "history")
      .mockResolvedValue({
        ok: true,
        messages: [
          { user: "U_NEW", text: "Release 42 is ready" },
          { user: "U_OLD", text: "Watch the rollback checklist" },
        ],
      });
    registerSlackMemberEvents({ ctx: harness.ctx });
    const handler = harness.getHandler("member_joined_channel");
    if (!handler) {
      throw new Error("expected Slack member joined handler");
    }

    await handler({
      event: { ...makeMemberEvent({ channel: "C1", user: "U_BOT" }), inviter: "U_OWNER" },
      body: { event_id: "Ev-self-join" },
    });

    expect(memberMocks.reportJoin).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel: "slack",
        accountId: "default",
        conversationId: "C1",
        deliverTo: "channel:C1",
        inviterLabel: "Morgan",
        roomAllowed: true,
        route: { agentId: "main", sessionKey: "agent:main:main" },
      }),
    );
    const request = memberMocks.reportJoin.mock.calls[0]?.[0] as Parameters<
      typeof import("openclaw/plugin-sdk/channel-join-intro-runtime").reportChannelRoomJoin
    >[0];
    await expect(request.resolveRoomContext({ messageLimit: 30 })).resolves.toEqual({
      title: "#deploys",
      purpose: "Coordinate production deployments\nCurrent release: 42",
      recentMessages: [
        { sender: "U_OLD", text: "Watch the rollback checklist" },
        { sender: "U_NEW", text: "Release 42 is ready" },
      ],
    });
    expect(readHistory).toHaveBeenCalledWith({
      channel: "C1",
      limit: 30,
      latest: undefined,
      oldest: undefined,
    });
    expect(memberMocks.enqueue).not.toHaveBeenCalled();
  });

  it("reports a denied bot self-join using conversation policy without applying sender policy", async () => {
    const harness = initSlackHarness({ channelType: "channel", channelUsers: ["U_OWNER"] });
    harness.ctx.cfg = { channels: { slack: { groupPolicy: "allowlist" } } };
    harness.ctx.accountId = "default";
    harness.ctx.isChannelAllowed = vi.fn(() => false);
    registerSlackMemberEvents({ ctx: harness.ctx });
    const handler = harness.getHandler("member_joined_channel");
    if (!handler) {
      throw new Error("expected Slack member joined handler");
    }

    await handler({
      event: makeMemberEvent({ channel: "C1", user: "U_BOT" }),
      body: { event_id: "Ev-self-denied" },
    });

    expect(harness.ctx.isChannelAllowed).toHaveBeenCalledWith({
      teamId: "T_TEST",
      channelId: "C1",
      channelName: "general",
      channelType: "channel",
    });
    expect(memberMocks.reportJoin).toHaveBeenCalledWith(
      expect.objectContaining({ roomAllowed: false }),
    );
    expect(memberMocks.enqueue).not.toHaveBeenCalled();
  });

  it("keeps room metadata when Slack denies the joined room's message history", async () => {
    const harness = initSlackHarness({ channelType: "group" });
    harness.ctx.cfg = { channels: { slack: { groupPolicy: "open" } } };
    harness.ctx.accountId = "default";
    harness.ctx.app.client = new WebClient("xoxb-test");
    vi.spyOn(harness.ctx.app.client.conversations, "history").mockRejectedValue(
      new Error("missing_scope"),
    );
    registerSlackMemberEvents({ ctx: harness.ctx });
    const handler = harness.getHandler("member_joined_channel");
    if (!handler) {
      throw new Error("expected Slack member joined handler");
    }

    await handler({
      event: makeMemberEvent({ channel: "G1", user: "U_BOT" }),
      body: { event_id: "Ev-self-private" },
    });

    const request = memberMocks.reportJoin.mock.calls[0]?.[0] as Parameters<
      typeof import("openclaw/plugin-sdk/channel-join-intro-runtime").reportChannelRoomJoin
    >[0];
    await expect(request.resolveRoomContext({ messageLimit: 30 })).resolves.toEqual({
      title: "#general",
      purpose: undefined,
    });
  });

  it("keeps a human member join on the existing sender-authorized system-event path", async () => {
    await runMemberCase({
      overrides: { channelType: "channel", channelUsers: ["U_OWNER"] },
      event: makeMemberEvent({ channel: "C1", user: "U_OWNER" }),
    });

    expect(memberMocks.reportJoin).not.toHaveBeenCalled();
    expect(memberMocks.enqueue).toHaveBeenCalledWith(
      "Slack: alice joined #general.",
      expect.objectContaining({ sessionKey: "agent:main:main" }),
    );
  });

  it("never introduces the bot into a direct-message conversation", async () => {
    await runMemberCase({
      overrides: { dmPolicy: "open" },
      event: makeMemberEvent({ channel: "D1", user: "U_BOT" }),
    });

    expect(memberMocks.reportJoin).not.toHaveBeenCalled();
  });

  it("does not track mismatched events", async () => {
    const trackEvent = vi.fn();
    await runMemberCase({
      trackEvent,
      shouldDropMismatchedSlackEvent: () => true,
      body: { api_app_id: "A_OTHER" },
    });

    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("tracks accepted member events", async () => {
    const trackEvent = vi.fn();
    await runMemberCase({ trackEvent });

    expect(trackEvent).toHaveBeenCalledTimes(1);
  });

  it("keys each queued event by the envelope occurrence", async () => {
    await runMemberCase({ body: { event_id: "Ev-member-2" } });

    expect(memberMocks.enqueue).toHaveBeenCalledWith(
      "Slack: alice joined #direct.",
      expect.objectContaining({
        contextKey: "slack:member:joined:D1:U1:Ev-member-2",
      }),
    );
  });

  it("uses the stable user ID when the post-auth name lookup fails", async () => {
    const harness = initSlackHarness({
      channelType: "channel",
      channelUsers: ["U1"],
    });
    const resolveUserName = vi.fn(async () => ({ error: new Error("users.info failed") }));
    harness.ctx.resolveUserName = resolveUserName;
    registerSlackMemberEvents({ ctx: harness.ctx });
    const handler = harness.getHandler("member_joined_channel");
    if (!handler) {
      throw new Error("expected Slack member joined handler");
    }

    await handler({
      event: makeMemberEvent({ channel: "C1", user: "U1" }),
      body: { event_id: "Ev-member-id-fallback" },
    });

    expect(resolveUserName).toHaveBeenCalledOnce();
    expect(memberMocks.enqueue).toHaveBeenCalledWith(
      "Slack: U1 joined #general.",
      expect.objectContaining({
        contextKey: "slack:member:joined:C1:U1:Ev-member-id-fallback",
      }),
    );
  });

  it("keeps enterprise member events isolated by listener workspace", async () => {
    const harness = initSlackHarness();
    harness.ctx.installationIdentity = {
      kind: "enterprise",
      apiAppId: "A_GRID",
      enterpriseId: "E_GRID",
    };
    const resolveChannelName = vi.fn(harness.ctx.resolveChannelName);
    const resolveUserName = vi.fn(harness.ctx.resolveUserName);
    const resolveSessionKey = vi.fn(
      (input: Parameters<typeof harness.ctx.resolveSlackSystemEventRoute>[0]) => ({
        agentId: "main",
        sessionKey: `session:${input.eventScope?.teamId ?? "workspace"}`,
      }),
    );
    harness.ctx.resolveChannelName = resolveChannelName;
    harness.ctx.resolveUserName = resolveUserName;
    harness.ctx.resolveSlackSystemEventRoute = resolveSessionKey;
    registerSlackMemberEvents({ ctx: harness.ctx });
    const handler = harness.getHandler("member_joined_channel");
    if (!handler) {
      throw new Error("expected Slack member joined handler");
    }

    for (const teamId of ["T111", "T222"]) {
      await handler({
        event: makeMemberEvent(),
        body: { api_app_id: "A_GRID", event_id: `Ev-member-${teamId}` },
        context: {
          isEnterpriseInstall: true,
          enterpriseId: "E_GRID",
          teamId,
        } as AllMiddlewareArgs["context"],
        client: { token: `listener-${teamId}` } as AllMiddlewareArgs["client"],
      });
    }

    expect(memberMocks.enqueue).toHaveBeenNthCalledWith(1, expect.any(String), {
      sessionKey: "session:T111",
      contextKey: "slack:member:T111:joined:D1:U1:Ev-member-T111",
    });
    expect(memberMocks.enqueue).toHaveBeenNthCalledWith(2, expect.any(String), {
      sessionKey: "session:T222",
      contextKey: "slack:member:T222:joined:D1:U1:Ev-member-T222",
    });
    expect(resolveChannelName).toHaveBeenCalledWith(
      "D1",
      expect.objectContaining({ teamId: "T111" }),
    );
    expect(resolveUserName).toHaveBeenCalledWith("U1", expect.objectContaining({ teamId: "T222" }));
  });

  it("rejects enterprise member events without validated listener scope", async () => {
    const trackEvent = vi.fn();
    const harness = initSlackHarness();
    harness.ctx.installationIdentity = {
      kind: "enterprise",
      apiAppId: "A_GRID",
      enterpriseId: "E_GRID",
    };
    registerSlackMemberEvents({ ctx: harness.ctx, trackEvent });
    const handler = harness.getHandler("member_joined_channel");
    if (!handler) {
      throw new Error("expected Slack member joined handler");
    }

    await handler({
      event: makeMemberEvent(),
      body: { api_app_id: "A_GRID" },
      context: {
        isEnterpriseInstall: true,
        enterpriseId: "E_GRID",
      } as AllMiddlewareArgs["context"],
      client: { token: "listener" } as AllMiddlewareArgs["client"],
    });

    expect(trackEvent).not.toHaveBeenCalled();
    expect(memberMocks.enqueue).not.toHaveBeenCalled();
  });
});
