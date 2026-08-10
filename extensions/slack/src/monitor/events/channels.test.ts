// Slack tests cover channels plugin behavior.
import type { AllMiddlewareArgs } from "@slack/bolt";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const enqueueSystemEventMock = vi.hoisted(() => vi.fn());
let registerSlackChannelEvents: typeof import("./channels.js").registerSlackChannelEvents;
let registerSlackChannelIdChangedEvent: typeof import("./channels.js").registerSlackChannelIdChangedEvent;
let createSlackSystemEventTestHarness: typeof import("./system-event-test-harness.js").createSlackSystemEventTestHarness;

vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

type SlackChannelHandler = (args: {
  event: Record<string, unknown>;
  body: unknown;
  context?: Record<string, unknown>;
  client?: AllMiddlewareArgs["client"];
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
  registerSlackChannelIdChangedEvent({ ctx: harness.ctx, trackEvent: params?.trackEvent });
  return {
    ctx: harness.ctx,
    getHandler: (name: string) => harness.getHandler(name) as SlackChannelHandler | null,
  };
}

function requireChannelHandler(handler: SlackChannelHandler | null): SlackChannelHandler {
  if (!handler) {
    throw new Error("expected Slack channel handler");
  }
  return handler;
}

describe("registerSlackChannelEvents", () => {
  beforeAll(async () => {
    ({ registerSlackChannelEvents, registerSlackChannelIdChangedEvent } =
      await import("./channels.js"));
    ({ createSlackSystemEventTestHarness } = await import("./system-event-test-harness.js"));
  });

  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
  });

  it("does not track mismatched events", async () => {
    const trackEvent = vi.fn();
    const { getHandler } = createChannelContext({
      trackEvent,
      shouldDropMismatchedSlackEvent: () => true,
    });
    const createdHandler = requireChannelHandler(getHandler("channel_created"));

    await createdHandler({
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
    const { getHandler } = createChannelContext({ trackEvent });
    const createdHandler = requireChannelHandler(getHandler("channel_created"));

    await createdHandler({
      event: {
        channel: { id: "C1", name: "general" },
      },
      body: {},
    });

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventMock).toHaveBeenCalledWith("Slack channel created: #general.", {
      sessionKey: "agent:main:main",
      contextKey: "slack:channel:created:C1",
    });
  });

  it("keeps enterprise channel notifications isolated by listener workspace", async () => {
    const { ctx, getHandler } = createChannelContext();
    ctx.installationIdentity = {
      kind: "enterprise",
      apiAppId: "A_GRID",
      enterpriseId: "E_GRID",
    };
    const resolveSessionKey = vi.fn(
      (input: Parameters<typeof ctx.resolveSlackSystemEventSessionKey>[0]) =>
        `session:${input.eventScope?.teamId ?? "workspace"}`,
    );
    ctx.resolveSlackSystemEventSessionKey = resolveSessionKey;

    const cases = [
      {
        name: "channel_created",
        event: { channel: { id: "C1", name: "general" } },
        message: "Slack channel created: #general.",
        kind: "created",
      },
      {
        name: "channel_rename",
        event: { channel: { id: "C1", name: "old-name", name_normalized: "new-name" } },
        message: "Slack channel renamed: #new-name.",
        kind: "renamed",
      },
    ] as const;

    for (const teamId of ["T111", "T222"]) {
      for (const eventCase of cases) {
        const handler = requireChannelHandler(getHandler(eventCase.name));
        await handler({
          event: eventCase.event,
          body: { api_app_id: "A_GRID" },
          context: {
            isEnterpriseInstall: true,
            enterpriseId: "E_GRID",
            teamId,
          },
          client: { token: `listener-${teamId}` } as AllMiddlewareArgs["client"],
        });
      }
    }

    expect(enqueueSystemEventMock).toHaveBeenCalledTimes(4);
    for (const [index, teamId] of ["T111", "T222"].entries()) {
      for (const [caseIndex, eventCase] of cases.entries()) {
        expect(enqueueSystemEventMock).toHaveBeenNthCalledWith(
          index * cases.length + caseIndex + 1,
          eventCase.message,
          {
            sessionKey: `session:${teamId}`,
            contextKey: `slack:channel:${teamId}:${eventCase.kind}:C1`,
          },
        );
      }
    }
  });

  it.each(["channel_created", "channel_rename"])(
    "rejects enterprise %s events without validated listener scope",
    async (eventName) => {
      const trackEvent = vi.fn();
      const { ctx, getHandler } = createChannelContext({ trackEvent });
      ctx.installationIdentity = {
        kind: "enterprise",
        apiAppId: "A_GRID",
        enterpriseId: "E_GRID",
      };
      const handler = requireChannelHandler(getHandler(eventName));

      await handler({
        event: { channel: { id: "C1", name: "general" } },
        body: { api_app_id: "A_GRID" },
        context: {
          isEnterpriseInstall: true,
          enterpriseId: "E_GRID",
        },
        client: { token: "listener" } as AllMiddlewareArgs["client"],
      });

      expect(trackEvent).not.toHaveBeenCalled();
      expect(enqueueSystemEventMock).not.toHaveBeenCalled();
    },
  );
});
