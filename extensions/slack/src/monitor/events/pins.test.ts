// Slack tests cover pins plugin behavior.
import type { AllMiddlewareArgs } from "@slack/bolt";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const pinEnqueueMock = vi.hoisted(() => vi.fn());
let registerSlackPinEvents: typeof import("./pins.js").registerSlackPinEvents;
let buildPinHarness: typeof import("./system-event-test-harness.js").createSlackSystemEventTestHarness;
type PinOverrides = import("./system-event-test-harness.js").SlackSystemEventTestOverrides;

vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({
  enqueueSystemEvent: (...args: unknown[]) => pinEnqueueMock(...args),
}));
type PinHandler = import("./system-event-test-harness.js").SlackSystemEventHandler;

type PinCase = {
  body?: unknown;
  event?: Record<string, unknown>;
  handler?: "added" | "removed";
  overrides?: PinOverrides;
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
};

function makePinEvent(overrides?: { channel?: string; user?: string }) {
  return {
    type: "pin_added",
    user: overrides?.user ?? "U1",
    channel_id: overrides?.channel ?? "D1",
    event_ts: "123.456",
    item: {
      type: "message",
      message: { ts: "123.456" },
    },
  };
}

function buildEnterpriseListenerArgs(teamId: string) {
  return {
    body: { api_app_id: "A_GRID" },
    context: {
      isEnterpriseInstall: true,
      enterpriseId: "E_GRID",
      teamId,
    } as AllMiddlewareArgs["context"],
    client: { token: `listener-${teamId}` } as AllMiddlewareArgs["client"],
  };
}

function installPinHandlers(args: {
  overrides?: PinOverrides;
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
}) {
  const harness = buildPinHarness(args.overrides);
  if (args.shouldDropMismatchedSlackEvent) {
    harness.ctx.shouldDropMismatchedSlackEvent = args.shouldDropMismatchedSlackEvent;
  }
  registerSlackPinEvents({ ctx: harness.ctx, trackEvent: args.trackEvent });
  return {
    added: harness.getHandler("pin_added") as PinHandler | null,
    removed: harness.getHandler("pin_removed") as PinHandler | null,
  };
}

async function runPinCase(input: PinCase = {}): Promise<void> {
  pinEnqueueMock.mockClear();
  const { added, removed } = installPinHandlers({
    overrides: input.overrides,
    trackEvent: input.trackEvent,
    shouldDropMismatchedSlackEvent: input.shouldDropMismatchedSlackEvent,
  });
  const handlerKey = input.handler ?? "added";
  const handler = handlerKey === "removed" ? removed : added;
  if (!handler) {
    throw new Error(`expected Slack pin ${handlerKey} handler`);
  }
  const event = (input.event ?? makePinEvent()) as Record<string, unknown>;
  const body = input.body ?? { event_id: "Ev-pin-default" };
  await handler({
    body,
    event,
  });
}

describe("registerSlackPinEvents", () => {
  beforeAll(async () => {
    ({ registerSlackPinEvents } = await import("./pins.js"));
    ({ createSlackSystemEventTestHarness: buildPinHarness } =
      await import("./system-event-test-harness.js"));
  });

  beforeEach(() => {
    pinEnqueueMock.mockClear();
  });

  const cases: Array<{ name: string; args: PinCase; expectedCalls: number }> = [
    {
      name: "enqueues DM pin system events when dmPolicy is open",
      args: { overrides: { dmPolicy: "open" } },
      expectedCalls: 1,
    },
    {
      name: "blocks DM pin system events when dmPolicy is disabled",
      args: { overrides: { dmPolicy: "disabled" } },
      expectedCalls: 0,
    },
    {
      name: "blocks DM pin system events for unauthorized senders in allowlist mode",
      args: {
        overrides: { dmPolicy: "allowlist", allowFrom: ["U2"] },
        event: makePinEvent({ user: "U1" }),
      },
      expectedCalls: 0,
    },
    {
      name: "allows DM pin system events for authorized senders in allowlist mode",
      args: {
        overrides: { dmPolicy: "allowlist", allowFrom: ["U1"] },
        event: makePinEvent({ user: "U1" }),
      },
      expectedCalls: 1,
    },
    {
      name: "blocks channel pin events for users outside channel users allowlist",
      args: {
        overrides: {
          dmPolicy: "open",
          channelType: "channel",
          channelUsers: ["U_OWNER"],
        },
        event: makePinEvent({ channel: "C1", user: "U_ATTACKER" }),
      },
      expectedCalls: 0,
    },
  ];
  it.each(cases)("$name", async ({ args, expectedCalls }) => {
    await runPinCase(args);
    expect(pinEnqueueMock).toHaveBeenCalledTimes(expectedCalls);
  });

  it("does not track mismatched events", async () => {
    const trackEvent = vi.fn();
    await runPinCase({
      trackEvent,
      shouldDropMismatchedSlackEvent: () => true,
      body: { api_app_id: "A_OTHER" },
    });

    expect(trackEvent).not.toHaveBeenCalled();
  });

  it("tracks accepted pin events", async () => {
    const trackEvent = vi.fn();
    await runPinCase({ trackEvent });

    expect(trackEvent).toHaveBeenCalledTimes(1);
  });

  it("keys each queued event by the envelope occurrence", async () => {
    await runPinCase({ body: { event_id: "Ev-pin-2" } });

    expect(pinEnqueueMock).toHaveBeenCalledWith("Slack: alice pinned a message in #direct.", {
      sessionKey: "agent:main:main",
      contextKey: "slack:pin:added:D1:123.456:Ev-pin-2",
    });
  });

  it("keeps enterprise pin events isolated by listener workspace", async () => {
    const harness = buildPinHarness();
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
    registerSlackPinEvents({ ctx: harness.ctx });
    const handler = harness.getHandler("pin_added") as PinHandler | null;
    if (!handler) {
      throw new Error("expected Slack pin added handler");
    }

    for (const teamId of ["T111", "T222"]) {
      await handler({
        event: makePinEvent(),
        ...buildEnterpriseListenerArgs(teamId),
        body: { api_app_id: "A_GRID", event_id: `Ev-pin-${teamId}` },
      });
    }

    expect(pinEnqueueMock).toHaveBeenNthCalledWith(1, expect.any(String), {
      sessionKey: "session:T111",
      contextKey: "slack:pin:T111:added:D1:123.456:Ev-pin-T111",
    });
    expect(pinEnqueueMock).toHaveBeenNthCalledWith(2, expect.any(String), {
      sessionKey: "session:T222",
      contextKey: "slack:pin:T222:added:D1:123.456:Ev-pin-T222",
    });
    expect(resolveChannelName).toHaveBeenCalledWith(
      "D1",
      expect.objectContaining({ teamId: "T111" }),
    );
    expect(resolveUserName).toHaveBeenCalledWith("U1", expect.objectContaining({ teamId: "T222" }));
  });

  it("rejects enterprise pin events without validated listener scope", async () => {
    const trackEvent = vi.fn();
    const harness = buildPinHarness();
    harness.ctx.installationIdentity = {
      kind: "enterprise",
      apiAppId: "A_GRID",
      enterpriseId: "E_GRID",
    };
    registerSlackPinEvents({ ctx: harness.ctx, trackEvent });
    const handler = harness.getHandler("pin_added") as PinHandler | null;
    if (!handler) {
      throw new Error("expected Slack pin added handler");
    }

    await handler({
      event: makePinEvent(),
      body: { api_app_id: "A_GRID" },
      context: {
        isEnterpriseInstall: true,
        enterpriseId: "E_GRID",
      } as AllMiddlewareArgs["context"],
      client: { token: "listener" } as AllMiddlewareArgs["client"],
    });

    expect(trackEvent).not.toHaveBeenCalled();
    expect(pinEnqueueMock).not.toHaveBeenCalled();
  });
});
