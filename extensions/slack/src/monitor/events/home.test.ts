// Slack tests cover home plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let registerSlackHomeEvents: typeof import("./home.js").registerSlackHomeEvents;
let createSlackSystemEventTestHarness: typeof import("./system-event-test-harness.js").createSlackSystemEventTestHarness;

type HomeHandler = (args: { event: Record<string, unknown>; body: unknown }) => Promise<void>;

function createHomeContext(params?: {
  slashCommandName?: string;
  trackEvent?: () => void;
  shouldDropMismatchedSlackEvent?: (body: unknown) => boolean;
}) {
  const harness = createSlackSystemEventTestHarness();
  const publish = vi.fn().mockResolvedValue({ ok: true });
  if (params?.shouldDropMismatchedSlackEvent) {
    harness.ctx.shouldDropMismatchedSlackEvent = params.shouldDropMismatchedSlackEvent;
  }
  harness.ctx.botToken = "xoxb-test";
  (harness.ctx.app as unknown as { client: { views: { publish: typeof publish } } }).client = {
    views: { publish },
  };
  registerSlackHomeEvents({
    ctx: harness.ctx,
    slashCommandName: params?.slashCommandName,
    trackEvent: params?.trackEvent,
  });
  return {
    publish,
    getHomeHandler: () => harness.getHandler("app_home_opened") as HomeHandler | null,
  };
}

describe("registerSlackHomeEvents", () => {
  beforeAll(async () => {
    ({ registerSlackHomeEvents } = await import("./home.js"));
    ({ createSlackSystemEventTestHarness } = await import("./system-event-test-harness.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("publishes the Home tab without an inactive slash command hint", async () => {
    const trackEvent = vi.fn();
    const { publish, getHomeHandler } = createHomeContext({ trackEvent });
    const handler = getHomeHandler();
    if (!handler) {
      throw new Error("expected Slack Home handler");
    }

    await handler({
      event: {
        type: "app_home_opened",
        user: "U123",
        channel: "D123",
        tab: "home",
        event_ts: "123.456",
      },
      body: { api_app_id: "A1" },
    });

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledWith({
      token: "xoxb-test",
      user_id: "U123",
      view: expect.any(Object),
    });
    expect(publish.mock.calls[0]?.[0]?.view.blocks[1]).toMatchObject({
      type: "section",
      text: {
        text: "Send a DM or mention OpenClaw in a channel to start a session.",
      },
    });
  });

  it("publishes the configured slash command name", async () => {
    const { publish, getHomeHandler } = createHomeContext({ slashCommandName: "acme" });

    await getHomeHandler()!({
      event: {
        type: "app_home_opened",
        user: "U123",
        channel: "D123",
        tab: "home",
      },
      body: {},
    });

    expect(publish).toHaveBeenCalledWith({
      token: "xoxb-test",
      user_id: "U123",
      view: expect.any(Object),
    });
    expect(publish.mock.calls[0]?.[0]?.view.blocks[1]).toMatchObject({
      type: "section",
      text: {
        text: "Send a DM, mention OpenClaw in a channel, or use `/acme` to start a session.",
      },
    });
  });

  it("does not publish when Slack reports the Messages tab", async () => {
    const trackEvent = vi.fn();
    const { publish, getHomeHandler } = createHomeContext({ trackEvent });

    await getHomeHandler()!({
      event: {
        type: "app_home_opened",
        user: "U123",
        channel: "D123",
        tab: "messages",
      },
      body: {},
    });

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(publish).not.toHaveBeenCalled();
  });

  it("does not track or publish mismatched events", async () => {
    const trackEvent = vi.fn();
    const { publish, getHomeHandler } = createHomeContext({
      trackEvent,
      shouldDropMismatchedSlackEvent: () => true,
    });

    await getHomeHandler()!({
      event: {
        type: "app_home_opened",
        user: "U123",
        tab: "home",
      },
      body: { api_app_id: "A_OTHER" },
    });

    expect(trackEvent).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });
});
