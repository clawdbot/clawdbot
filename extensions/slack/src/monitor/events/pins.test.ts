import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const pinEnqueueMock = vi.hoisted(() => vi.fn());
let registerSlackPinEvents: typeof import("./pins.js").registerSlackPinEvents;
let buildPinHarness: typeof import("./system-event-test-harness.js").createSlackSystemEventTestHarness;
type PinOverrides = import("./system-event-test-harness.js").SlackSystemEventTestOverrides;

vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({
  enqueueSystemEvent: (...args: unknown[]) => pinEnqueueMock(...args),
}));
vi.mock("openclaw/plugin-sdk/system-event-runtime.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => pinEnqueueMock(...args),
}));
vi.mock("openclaw/plugin-sdk/security-runtime", () => ({
  readStoreAllowFromForDmPolicy: async () => [],
}));

type PinHandler = (args: { event: Record<string, unknown>; body: unknown }) => Promise<void>;

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
  expect(handler).toBeTruthy();
  const event = (input.event ?? makePinEvent()) as Record<string, unknown>;
  const body = input.body ?? {};
  await handler!({
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
});
