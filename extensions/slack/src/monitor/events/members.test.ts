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
vi.mock("openclaw/plugin-sdk/system-event-runtime.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => memberMocks.enqueue(...args),
}));
vi.mock("openclaw/plugin-sdk/security-runtime", () => ({
  readStoreAllowFromForDmPolicy: async () => [],
}));

type MemberHandler = (args: { event: Record<string, unknown>; body: unknown }) => Promise<void>;

type MemberCaseArgs = {
  event?: Record<string, unknown>;
  body?: unknown;
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
  expect(handler).toBeTruthy();
  await handler!({
    event: (args.event ?? makeMemberEvent()) as Record<string, unknown>,
    body: args.body ?? {},
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
});
