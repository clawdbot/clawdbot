// Slack tests cover members plugin behavior.
import type { AllMiddlewareArgs } from "@slack/bolt";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const memberMocks = vi.hoisted(() => ({
  enqueue: vi.fn(),
}));
let registerSlackMemberEvents: typeof import("./members.js").registerSlackMemberEvents;
let initSlackHarness: typeof import("./system-event-test-harness.js").createSlackSystemEventTestHarness;
type MemberOverrides = import("./system-event-test-harness.js").SlackSystemEventTestOverrides;

vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({
  enqueueSystemEvent: (...args: unknown[]) => memberMocks.enqueue(...args),
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
      (input: Parameters<typeof harness.ctx.resolveSlackSystemEventSessionKey>[0]) =>
        `session:${input.eventScope?.teamId ?? "workspace"}`,
    );
    harness.ctx.resolveChannelName = resolveChannelName;
    harness.ctx.resolveUserName = resolveUserName;
    harness.ctx.resolveSlackSystemEventSessionKey = resolveSessionKey;
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
