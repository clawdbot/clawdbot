// Slack tests cover channels plugin behavior.
import type { AllMiddlewareArgs } from "@slack/bolt";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { enqueueSystemEventMock, mutateConfigFileMock, readConfigSnapshotMock } = vi.hoisted(() => ({
  enqueueSystemEventMock: vi.fn(),
  mutateConfigFileMock: vi.fn(),
  readConfigSnapshotMock: vi.fn(),
}));
let registerSlackChannelEvents: typeof import("./channels.js").registerSlackChannelEvents;
let registerSlackChannelIdChangedEvent: typeof import("./channels.js").registerSlackChannelIdChangedEvent;
let createSlackSystemEventTestHarness: typeof import("./system-event-test-harness.js").createSlackSystemEventTestHarness;

vi.mock("openclaw/plugin-sdk/system-event-runtime", () => ({
  enqueueRoutedSystemEvent: (
    text: unknown,
    route: { sessionKey: unknown },
    options: Record<string, unknown>,
  ) => enqueueSystemEventMock(text, { ...options, sessionKey: route.sessionKey }),
}));
vi.mock("openclaw/plugin-sdk/channel-config-writes", () => ({
  resolveChannelConfigWrites: () => true,
}));
vi.mock("openclaw/plugin-sdk/config-mutation", () => ({
  mutateConfigFile: (...args: unknown[]) => mutateConfigFileMock(...args),
  readConfigFileSnapshotForWrite: (...args: unknown[]) => readConfigSnapshotMock(...args),
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
    getCreatedHandler: () => harness.getHandler("channel_created") as SlackChannelHandler | null,
  };
}

function requireChannelHandler(handler: SlackChannelHandler | null): SlackChannelHandler {
  if (!handler) {
    throw new Error("expected Slack channel_created handler");
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
    mutateConfigFileMock.mockReset();
    readConfigSnapshotMock.mockReset();
  });

  it("does not track mismatched events", async () => {
    const trackEvent = vi.fn();
    const { getCreatedHandler } = createChannelContext({
      trackEvent,
      shouldDropMismatchedSlackEvent: () => true,
    });
    const createdHandler = requireChannelHandler(getCreatedHandler());

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
    const { getCreatedHandler } = createChannelContext({ trackEvent });
    const createdHandler = requireChannelHandler(getCreatedHandler());

    await createdHandler({
      event: {
        channel: { id: "C1", name: "general" },
      },
      body: { event_id: "Ev-channel-1" },
    });

    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(enqueueSystemEventMock).toHaveBeenCalledWith("Slack channel created: #general.", {
      sessionKey: "agent:main:main",
      contextKey: "slack:channel:created:C1:Ev-channel-1",
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
      (input: Parameters<typeof ctx.resolveSlackSystemEventRoute>[0]) => ({
        agentId: "main",
        sessionKey: `session:${input.eventScope?.teamId ?? "workspace"}`,
      }),
    );
    ctx.resolveSlackSystemEventRoute = resolveSessionKey;

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
          body: { api_app_id: "A_GRID", event_id: `Ev-${eventCase.name}-${teamId}` },
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
            contextKey: `slack:channel:${teamId}:${eventCase.kind}:C1:Ev-${eventCase.name}-${teamId}`,
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
        body: { api_app_id: "A_GRID", event_id: `Ev-${eventName}` },
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

  it("keeps live config unchanged when channel-ID persistence fails, then retries", async () => {
    const oldChannelId = "C_OLD";
    const newChannelId = "C_NEW";
    const initialConfig = {
      channels: { slack: { channels: { [oldChannelId]: { enabled: true } } } },
    };
    let persistedConfig = structuredClone(initialConfig);
    const persistenceError = new Error("disk full");
    readConfigSnapshotMock.mockImplementation(async () => ({
      snapshot: {
        hash: "base-hash",
        sourceConfig: structuredClone(persistedConfig),
      },
    }));
    mutateConfigFileMock
      .mockRejectedValueOnce(persistenceError)
      .mockImplementationOnce(
        async (params: { mutate: (draft: typeof initialConfig) => unknown }) => {
          const draft = structuredClone(persistedConfig);
          const result = params.mutate(draft);
          persistedConfig = draft;
          return { result, nextConfig: draft };
        },
      );
    const { ctx, getHandler } = createChannelContext();
    ctx.cfg = structuredClone(initialConfig) as never;
    ctx.accountId = "default";
    ctx.runtime.error = vi.fn();
    const handler = requireChannelHandler(getHandler("channel_id_changed"));
    const turnAdoptionLifecycle = {
      admission: "exclusive",
      abortSignal: new AbortController().signal,
      onAdopted: vi.fn(),
      onDeferred: vi.fn(),
      onAbandoned: vi.fn(),
    };
    const args = {
      event: {
        type: "channel_id_changed",
        old_channel_id: oldChannelId,
        new_channel_id: newChannelId,
      },
      body: {},
      context: { openclawIngressLifecycle: turnAdoptionLifecycle },
    };

    await expect(handler(args)).rejects.toBe(persistenceError);
    expect(ctx.cfg.channels?.slack?.channels).toHaveProperty(oldChannelId);
    expect(ctx.cfg.channels?.slack?.channels).not.toHaveProperty(newChannelId);
    expect(persistedConfig.channels.slack.channels).toHaveProperty(oldChannelId);

    await expect(handler(args)).resolves.toBeUndefined();
    expect(ctx.cfg.channels?.slack?.channels).not.toHaveProperty(oldChannelId);
    expect(ctx.cfg.channels?.slack?.channels).toHaveProperty(newChannelId);
    expect(persistedConfig.channels.slack.channels).not.toHaveProperty(oldChannelId);
    expect(persistedConfig.channels.slack.channels).toHaveProperty(newChannelId);
    expect(mutateConfigFileMock).toHaveBeenCalledTimes(2);
  });
});
