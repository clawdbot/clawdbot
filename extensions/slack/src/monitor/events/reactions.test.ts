import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const reactionQueueMock = vi.hoisted(() => vi.fn());
let registerSlackReactionEvents: typeof import("./reactions.js").registerSlackReactionEvents;
let createSlackSystemEventTestHarness: typeof import("./system-event-test-harness.js").createSlackSystemEventTestHarness;
type SlackSystemEventTestOverrides =
  import("./system-event-test-harness.js").SlackSystemEventTestOverrides;

vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({
  enqueueSystemEvent: (...args: unknown[]) => reactionQueueMock(...args),
}));
vi.mock("openclaw/plugin-sdk/system-event-runtime.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => reactionQueueMock(...args),
}));
type ReactionHandler = (args: { event: Record<string, unknown>; body: unknown }) => Promise<void>;

type ReactionRunInput = {
  handler?: "added" | "removed";
  overrides?: SlackSystemEventTestOverrides;
  event?: Record<string, unknown>;
  body?: unknown;
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
};

function buildReactionEvent(overrides?: { user?: string; channel?: string }) {
  return {
    type: "reaction_added",
    user: overrides?.user ?? "U1",
    reaction: "thumbsup",
    item: {
      type: "message",
      channel: overrides?.channel ?? "D1",
      ts: "123.456",
    },
    item_user: "UBOT",
  };
}

function createReactionHandlers(params: {
  overrides?: SlackSystemEventTestOverrides;
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
}) {
  const harness = createSlackSystemEventTestHarness(params.overrides);
  if (params.shouldDropMismatchedSlackEvent) {
    harness.ctx.shouldDropMismatchedSlackEvent = params.shouldDropMismatchedSlackEvent;
  }
  registerSlackReactionEvents({ ctx: harness.ctx, trackEvent: params.trackEvent });
  return {
    added: harness.getHandler("reaction_added") as ReactionHandler | null,
    removed: harness.getHandler("reaction_removed") as ReactionHandler | null,
  };
}

function requireReactionHandler(handler: ReactionHandler | null, name: string): ReactionHandler {
  if (!handler) {
    throw new Error(`expected Slack ${name} reaction handler`);
  }
  return handler;
}

async function executeReactionCase(input: ReactionRunInput = {}) {
  reactionQueueMock.mockClear();
  const handlers = createReactionHandlers({
    overrides: input.overrides,
    trackEvent: input.trackEvent,
    shouldDropMismatchedSlackEvent: input.shouldDropMismatchedSlackEvent,
  });
  const handlerName = input.handler ?? "added";
  const handler = requireReactionHandler(handlers[handlerName], handlerName);
  await handler({
    event: (input.event ?? buildReactionEvent()) as Record<string, unknown>,
    body: input.body ?? {},
  });
}

describe("registerSlackReactionEvents", () => {
  beforeAll(async () => {
    ({ registerSlackReactionEvents } = await import("./reactions.js"));
    ({ createSlackSystemEventTestHarness } = await import("./system-event-test-harness.js"));
  });

  beforeEach(() => {
    reactionQueueMock.mockClear();
  });

  const cases: Array<{ name: string; input: ReactionRunInput; expectedCalls: number }> = [
    {
      name: "enqueues DM reaction system events when dmPolicy is open",
      input: { overrides: { dmPolicy: "open" } },
      expectedCalls: 1,
    },
    {
      name: "blocks DM reaction system events when dmPolicy is disabled",
      input: { overrides: { dmPolicy: "disabled" } },
      expectedCalls: 0,
    },
    {
      name: "blocks DM reaction system events for unauthorized senders in allowlist mode",
      input: {
        overrides: { dmPolicy: "allowlist", allowFrom: ["U2"] },
        event: buildReactionEvent({ user: "U1" }),
      },
      expectedCalls: 0,
    },
    {
      name: "allows DM reaction system events for authorized senders in allowlist mode",
      input: {
        overrides: { dmPolicy: "allowlist", allowFrom: ["U1"] },
        event: buildReactionEvent({ user: "U1" }),
      },
      expectedCalls: 1,
    },
    {
      name: "enqueues channel reaction events regardless of dmPolicy",
      input: {
        handler: "removed",
        overrides: { dmPolicy: "disabled", channelType: "channel" },
        event: {
          ...buildReactionEvent({ channel: "C1" }),
          type: "reaction_removed",
        },
      },
      expectedCalls: 1,
    },
    {
      name: "blocks channel reaction events for users outside channel users allowlist",
      input: {
        overrides: {
          dmPolicy: "open",
          channelType: "channel",
          channelUsers: ["U_OWNER"],
        },
        event: buildReactionEvent({ channel: "C1", user: "U_ATTACKER" }),
      },
      expectedCalls: 0,
    },
    {
      name: "blocks reactions when reaction notifications are off",
      input: { overrides: { dmPolicy: "open", reactionMode: "off" } },
      expectedCalls: 0,
    },
    {
      name: "blocks own-mode reactions on messages not authored by the bot",
      input: {
        overrides: { dmPolicy: "open", reactionMode: "own" },
        event: {
          ...buildReactionEvent(),
          item_user: "U_OTHER",
        },
      },
      expectedCalls: 0,
    },
    {
      name: "allows own-mode reactions on messages authored by the bot",
      input: {
        overrides: { dmPolicy: "open", reactionMode: "own" },
        event: {
          ...buildReactionEvent(),
          item_user: "U_BOT",
        },
      },
      expectedCalls: 1,
    },
    {
      name: "blocks reactions from senders outside the reaction allowlist",
      input: {
        overrides: {
          dmPolicy: "open",
          reactionMode: "allowlist",
          reactionAllowlist: ["U2"],
        },
        event: buildReactionEvent({ user: "U1" }),
      },
      expectedCalls: 0,
    },
    {
      name: "blocks allowlist-mode reactions when the reaction allowlist is empty",
      input: {
        overrides: {
          dmPolicy: "open",
          reactionMode: "allowlist",
          reactionAllowlist: [],
        },
        event: buildReactionEvent({ user: "U1" }),
      },
      expectedCalls: 0,
    },
    {
      name: "allows reactions from senders inside the reaction allowlist",
      input: {
        overrides: {
          dmPolicy: "open",
          reactionMode: "allowlist",
          reactionAllowlist: ["U1"],
        },
        event: buildReactionEvent({ user: "U1" }),
      },
      expectedCalls: 1,
    },
  ];

  it.each(cases)("$name", async ({ input, expectedCalls }) => {
    await executeReactionCase(input);
    expect(reactionQueueMock).toHaveBeenCalledTimes(expectedCalls);
  });

  it("does not track mismatched events", async () => {
    const trackEvent = vi.fn();
    await executeReactionCase({
      trackEvent,
      shouldDropMismatchedSlackEvent: () => true,
      body: { api_app_id: "A_OTHER" },
    });

    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("tracks accepted message reactions", async () => {
    const trackEvent = vi.fn();
    await executeReactionCase({ trackEvent });

    expect(trackEvent).toHaveBeenCalledTimes(1);
  });

  it("marks queued reaction events as untrusted external content", async () => {
    await executeReactionCase();

    expect(reactionQueueMock).toHaveBeenCalledWith(expect.any(String), {
      sessionKey: "agent:main:main",
      contextKey: "slack:reaction:added:D1:123.456:U1:thumbsup",
      trusted: false,
    });
  });

  it("drops off-mode reactions before resolving Slack context", async () => {
    reactionQueueMock.mockClear();
    const harness = createSlackSystemEventTestHarness({ reactionMode: "off" });
    const resolveChannelName = vi.fn(harness.ctx.resolveChannelName);
    const resolveUserName = vi.fn(harness.ctx.resolveUserName);
    harness.ctx.resolveChannelName = resolveChannelName;
    harness.ctx.resolveUserName = resolveUserName;
    registerSlackReactionEvents({ ctx: harness.ctx });
    const handler = requireReactionHandler(
      harness.getHandler("reaction_added") as ReactionHandler | null,
      "added",
    );

    await handler({
      event: buildReactionEvent({ user: "U777", channel: "D123" }),
      body: {},
    });

    expect(resolveChannelName).not.toHaveBeenCalled();
    expect(resolveUserName).not.toHaveBeenCalled();
    expect(reactionQueueMock).not.toHaveBeenCalled();
  });

  it("drops own-mode reactions on non-bot messages before resolving Slack context", async () => {
    reactionQueueMock.mockClear();
    const harness = createSlackSystemEventTestHarness({ reactionMode: "own" });
    const resolveChannelName = vi.fn(harness.ctx.resolveChannelName);
    const resolveUserName = vi.fn(harness.ctx.resolveUserName);
    harness.ctx.resolveChannelName = resolveChannelName;
    harness.ctx.resolveUserName = resolveUserName;
    registerSlackReactionEvents({ ctx: harness.ctx });
    const handler = requireReactionHandler(
      harness.getHandler("reaction_added") as ReactionHandler | null,
      "added",
    );

    await handler({
      event: {
        ...buildReactionEvent({ user: "U777", channel: "D123" }),
        item_user: "U_OTHER",
      },
      body: {},
    });

    expect(resolveChannelName).not.toHaveBeenCalled();
    expect(resolveUserName).not.toHaveBeenCalled();
    expect(reactionQueueMock).not.toHaveBeenCalled();
  });

  it("passes sender context when resolving reaction session keys", async () => {
    reactionQueueMock.mockClear();
    const harness = createSlackSystemEventTestHarness();
    const resolveSessionKey = vi.fn().mockReturnValue("agent:ops:main");
    harness.ctx.resolveSlackSystemEventSessionKey = resolveSessionKey;
    registerSlackReactionEvents({ ctx: harness.ctx });
    const handler = requireReactionHandler(
      harness.getHandler("reaction_added") as ReactionHandler | null,
      "added",
    );

    await handler({
      event: buildReactionEvent({ user: "U777", channel: "D123" }),
      body: {},
    });

    expect(resolveSessionKey).toHaveBeenCalledWith({
      channelId: "D123",
      channelType: "im",
      senderId: "U777",
    });
  });
});
