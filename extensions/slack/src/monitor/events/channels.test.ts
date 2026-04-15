import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const enqueueSystemEventMock = vi.hoisted(() => vi.fn());
let registerSlackChannelEvents: typeof import("./channels.js").registerSlackChannelEvents;
let createSlackSystemEventTestHarness: typeof import("./system-event-test-harness.js").createSlackSystemEventTestHarness;

async function createChannelRuntimeMock() {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/infra-runtime")>(
    "openclaw/plugin-sdk/infra-runtime",
  );
  return {
    ...actual,
    enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
  };
}

vi.mock("openclaw/plugin-sdk/infra-runtime", createChannelRuntimeMock);
vi.mock("openclaw/plugin-sdk/infra-runtime.js", createChannelRuntimeMock);

type SlackChannelHandler = (args: {
  event: Record<string, unknown>;
  body: unknown;
}) => Promise<void>;

function createChannelContext(params?: {
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
}) {
  const harness = createSlackSystemEventTestHarness();
  if (params?.shouldDropMismatchedSlackEvent) {
    harness.ctx.shouldDropMismatchedSlackEvent = params.shouldDropMismatchedSlackEvent;
  }
  registerSlackChannelEvents({ ctx: harness.ctx, trackEvent: params?.trackEvent });
  return {
    getCreatedHandler: () => harness.getHandler("channel_created") as SlackChannelHandler | null,
  };
}

describe("registerSlackChannelEvents", () => {
  beforeAll(async () => {
    ({ registerSlackChannelEvents } = await import("./channels.js"));
    ({ createSlackSystemEventTestHarness } = await import("./system-event-test-harness.js"));
  });

  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
  });

  it("does not track mismatched events", async () => {
    const trackEvent = vi.fn();
    const { getCreatedHandler } = createChannelContext({
      trackEvent,
      shouldDropMismatchedSlackEvent: () => true,
    });
    const createdHandler = getCreatedHandler();
    expect(createdHandler).toBeTruthy();

    await createdHandler!({
      event: {
        channel: { id: "C1", name: "general" },
      },
      body: { api_app_id: "A_OTHER" },
    });

    expect(trackEvent).not.toHaveBeenCalled();
    expect(enqueueSystemEventMock).not.toHaveBeenCalled();
  });

  it("tracks accepted events", async () => {
    const trackEvent = vi.fn();
    const { getCreatedHandler } = createChannelContext({ trackEvent });
    const createdHandler = getCreatedHandler();
    expect(createdHandler).toBeTruthy();

    await createdHandler!({
      event: {
        channel: { id: "C1", name: "general" },
      },
      body: {},
    });

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(1);
  });
});
