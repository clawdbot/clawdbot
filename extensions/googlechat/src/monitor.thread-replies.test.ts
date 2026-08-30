// Google Chat thread-reply tests cover exact native thread delivery.
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import type { GoogleChatIngressLifecycle } from "./monitor-ingress.js";
import type { GoogleChatCoreRuntime, GoogleChatRuntimeEnv } from "./monitor-types.js";
import "./monitor.js";
import type { GoogleChatEvent } from "./types.js";

const apiMocks = vi.hoisted(() => ({
  deleteGoogleChatMessage: vi.fn(),
  sendGoogleChatMessage: vi.fn(),
  updateGoogleChatMessage: vi.fn(),
}));

const accessMocks = vi.hoisted(() => ({
  applyGoogleChatInboundAccessPolicy: vi.fn(),
}));

const routingMocks = vi.hoisted(() => ({
  processEvent: undefined as
    | ((
        event: GoogleChatEvent,
        target: Record<string, unknown>,
        turnAdoptionLifecycle?: GoogleChatIngressLifecycle,
      ) => Promise<void>)
    | undefined,
}));

const inboundMocks = vi.hoisted(() => ({
  buildEnvelope: vi.fn(({ body }: { body: string }) => body),
  resolveChannelInboundRouteEnvelope: vi.fn(),
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>();
  return {
    ...actual,
    resolveChannelInboundRouteEnvelope: inboundMocks.resolveChannelInboundRouteEnvelope,
  };
});

vi.mock("./api.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api.js")>();
  return {
    ...actual,
    deleteGoogleChatMessage: apiMocks.deleteGoogleChatMessage,
    sendGoogleChatMessage: apiMocks.sendGoogleChatMessage,
    updateGoogleChatMessage: apiMocks.updateGoogleChatMessage,
  };
});

vi.mock("./monitor-access.js", () => ({
  applyGoogleChatInboundAccessPolicy: accessMocks.applyGoogleChatInboundAccessPolicy,
}));

vi.mock("./monitor-routing.js", () => ({
  registerGoogleChatWebhookTarget: vi.fn(),
  setGoogleChatWebhookEventProcessor: vi.fn(
    (
      processEvent: (
        event: GoogleChatEvent,
        target: Record<string, unknown>,
        turnAdoptionLifecycle?: GoogleChatIngressLifecycle,
      ) => Promise<void>,
    ) => {
      routingMocks.processEvent = processEvent;
    },
  ),
}));

beforeEach(() => {
  apiMocks.deleteGoogleChatMessage.mockReset();
  apiMocks.sendGoogleChatMessage.mockReset().mockResolvedValue(null);
  apiMocks.updateGoogleChatMessage.mockReset().mockResolvedValue({});
  accessMocks.applyGoogleChatInboundAccessPolicy.mockReset();
  inboundMocks.buildEnvelope.mockReset().mockImplementation(({ body }: { body: string }) => body);
  inboundMocks.resolveChannelInboundRouteEnvelope
    .mockReset()
    .mockImplementation(({ accountId }: { accountId: string }) => ({
      route: {
        agentId: "agent-1",
        accountId,
        sessionKey: "session-1",
      },
      buildEnvelope: inboundMocks.buildEnvelope,
    }));
});

async function processGoogleChatTestEvent(params: {
  event: GoogleChatEvent;
  account: ResolvedGoogleChatAccount;
  config: Record<string, unknown>;
  runtime: GoogleChatRuntimeEnv;
  core: GoogleChatCoreRuntime;
  mediaMaxMb: number;
}): Promise<void> {
  if (!routingMocks.processEvent) {
    throw new Error("Expected Google Chat webhook event processor registration");
  }
  await routingMocks.processEvent(params.event, {
    account: params.account,
    config: params.config,
    runtime: params.runtime,
    core: params.core,
    mediaMaxMb: params.mediaMaxMb,
    path: "/googlechat",
  });
}

async function processGoogleChatThreadReplyTest(params: {
  runTurn: ReturnType<typeof vi.fn>;
  typingIndicator: "message" | "none";
  replyToMode?: "all" | "first";
  typingFails?: boolean;
  buildContext?: GoogleChatCoreRuntime["channel"]["inbound"]["buildContext"];
  config?: Record<string, unknown>;
}) {
  const requestedThread = "spaces/CLASSIFY/threads/Requested";
  const messageName = "spaces/CLASSIFY/messages/1";
  const account = {
    accountId: "work",
    config: { replyToMode: params.replyToMode ?? "all", typingIndicator: params.typingIndicator },
    credentialSource: "inline" as const,
  } as ResolvedGoogleChatAccount;
  const runtime = { error: vi.fn(), log: vi.fn() } satisfies GoogleChatRuntimeEnv;
  const core = {
    logging: { shouldLogVerbose: () => false },
    channel: {
      inbound: {
        buildContext: params.buildContext ?? vi.fn((payload: unknown) => payload),
        run: params.runTurn,
      },
      text: {
        resolveChunkMode: vi.fn(() => "markdown"),
        chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
      },
    },
  } as unknown as GoogleChatCoreRuntime;

  accessMocks.applyGoogleChatInboundAccessPolicy.mockResolvedValue({
    ok: true,
    commandAuthorized: undefined,
    effectiveWasMentioned: undefined,
    groupBotLoopProtection: undefined,
    groupSystemPrompt: undefined,
  });
  if (params.typingFails) {
    apiMocks.sendGoogleChatMessage.mockRejectedValueOnce(new Error("typing unavailable"));
  } else if (params.typingIndicator === "message") {
    apiMocks.sendGoogleChatMessage.mockResolvedValueOnce({
      messageName: "spaces/CLASSIFY/messages/typing",
      threadName: requestedThread,
    });
  }

  await processGoogleChatTestEvent({
    event: {
      type: "MESSAGE",
      space: { name: "spaces/CLASSIFY", spaceType: "SPACE" },
      message: {
        name: messageName,
        text: "hello",
        thread: { name: requestedThread },
        sender: { name: "users/alice", displayName: "Alice", type: "HUMAN" },
      },
    },
    account,
    config: params.config ?? {},
    runtime,
    core,
    mediaMaxMb: 10,
  });

  return { account, requestedThread, runtime };
}

describe("googlechat monitor thread reply delivery", () => {
  it("keeps direct replies in the inbound thread when targets are message resources", async () => {
    const messageTarget = "spaces/CLASSIFY/messages/1";
    const runTurn = vi.fn(
      async (params: {
        adapter: {
          resolveTurn: () => {
            delivery: {
              preparePayload: (payload: { text: string; replyToId?: string }) => {
                text: string;
                replyToId?: string;
              };
              deliver: (payload: { text: string; replyToId?: string }) => Promise<void>;
            };
          };
        };
      }) => {
        const turn = params.adapter.resolveTurn();
        const streamingPayload = turn.delivery.preparePayload({
          text: "streaming reply",
          replyToId: messageTarget,
        });
        await turn.delivery.deliver(streamingPayload);
        const finalPayload = turn.delivery.preparePayload({
          text: "final reply",
          replyToId: messageTarget,
        });
        await turn.delivery.deliver(finalPayload);
      },
    );

    const { account, requestedThread } = await processGoogleChatThreadReplyTest({
      runTurn,
      typingIndicator: "message",
    });

    expect(apiMocks.updateGoogleChatMessage).toHaveBeenCalledWith({
      account,
      messageName: "spaces/CLASSIFY/messages/typing",
      text: "streaming reply",
    });
    expect(apiMocks.deleteGoogleChatMessage).not.toHaveBeenCalled();
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledTimes(2);
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenNthCalledWith(2, {
      account,
      space: "spaces/CLASSIFY",
      text: "final reply",
      thread: requestedThread,
    });
  });

  it("stops pinning replies after a durable first reply is delivered", async () => {
    const observedPayloads = vi.fn();
    const runTurn = vi.fn(
      async (params: {
        adapter: {
          resolveTurn: () => {
            delivery: {
              preparePayload: (payload: { text: string; replyToId?: string }) => {
                text: string;
                replyToId?: string;
              };
              onDelivered: (
                payload: { text: string; replyToId?: string },
                info: { kind: string },
                result: { visibleReplySent: boolean },
              ) => void;
            };
          };
        };
      }) => {
        const turn = params.adapter.resolveTurn();
        const firstPayload = turn.delivery.preparePayload({ text: "first final" });
        turn.delivery.onDelivered(firstPayload, { kind: "final" }, { visibleReplySent: true });
        const secondPayload = turn.delivery.preparePayload({ text: "second final" });
        observedPayloads(firstPayload, secondPayload);
      },
    );

    await processGoogleChatThreadReplyTest({
      runTurn,
      typingIndicator: "none",
      replyToMode: "first",
    });

    expect(observedPayloads).toHaveBeenCalledWith(
      { text: "first final", replyToId: "spaces/CLASSIFY/threads/Requested" },
      { text: "second final" },
    );
  });

  it("canonicalizes the durable final before the real inbound lifecycle falls back to direct delivery", async () => {
    const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/channel-inbound")>(
      "openclaw/plugin-sdk/channel-inbound",
    );
    const created = tempDirs.make("openclaw-googlechat-delivery-");
    const observedDurableOptions = vi.fn();
    const messageTarget = "spaces/CLASSIFY/messages/1";
    const runTurn = vi.fn((input: Parameters<typeof actual.runChannelInboundEvent>[0]) =>
      actual.runChannelInboundEvent({
        ...input,
        turnAdoptionLifecycle: undefined,
        adapter: {
          ...input.adapter,
          resolveTurn: async (...args) => {
            const turn = await input.adapter.resolveTurn(...args);
            if (!("delivery" in turn)) {
              throw new Error("Expected a Google Chat reply delivery turn");
            }
            const declaredDurable = "durable" in turn.delivery ? turn.delivery.durable : undefined;
            if (typeof declaredDurable !== "function") {
              throw new Error("Expected a Google Chat durable delivery resolver");
            }
            const durable = async (
              ...durableArgs: Parameters<typeof declaredDurable>
            ): Promise<false> => {
              observedDurableOptions(await declaredDurable(...durableArgs));
              return false;
            };
            return {
              ...turn,
              delivery: {
                ...turn.delivery,
                durable,
              },
              replyResolver: async () => ({
                text: "final reply",
                replyToId: messageTarget,
              }),
            };
          },
        },
      }),
    );

    const { account, requestedThread } = await processGoogleChatThreadReplyTest({
      runTurn,
      typingIndicator: "none",
      buildContext: actual.buildChannelInboundEventContext,
      config: { session: { store: path.join(created, "sessions.json") } },
    });

    expect(observedDurableOptions).toHaveBeenCalledWith({
      to: "spaces/CLASSIFY",
      replyToId: requestedThread,
      threadId: requestedThread,
    });
    expect(apiMocks.sendGoogleChatMessage).toHaveBeenCalledExactlyOnceWith({
      account,
      space: "spaces/CLASSIFY",
      text: "final reply",
      thread: requestedThread,
    });
  });

  it.each([
    {
      name: "message resource",
      replyToId: "spaces/CLASSIFY/messages/1",
      expectedThread: "spaces/CLASSIFY/threads/Requested",
      typingFails: false,
    },
    {
      name: "message resource after typing creation fails",
      replyToId: "spaces/CLASSIFY/messages/1",
      expectedThread: "spaces/CLASSIFY/threads/Requested",
      typingFails: true,
    },
    {
      name: "wrongly-cased inbound thread",
      replyToId: "spaces/classify/threads/requested",
      expectedThread: "spaces/CLASSIFY/threads/Requested",
      typingFails: false,
    },
    {
      name: "case-distinct same-space thread",
      replyToId: "spaces/CLASSIFY/threads/requested",
      expectedThread: "spaces/CLASSIFY/threads/requested",
      typingFails: false,
    },
    {
      name: "cross-space thread",
      replyToId: "spaces/OTHER/threads/other",
      expectedThread: "spaces/CLASSIFY/threads/Requested",
      typingFails: false,
    },
    {
      name: "missing target",
      replyToId: undefined,
      expectedThread: "spaces/CLASSIFY/threads/Requested",
      typingFails: false,
    },
  ])(
    "routes a $name durable final to the expected thread",
    async ({ replyToId, expectedThread, typingFails }) => {
      const observeDurableOptions = vi.fn();
      const runTurn = vi.fn(
        async (params: {
          adapter: {
            resolveTurn: () => {
              delivery: {
                preparePayload: (payload: { text: string; replyToId?: string }) => {
                  text: string;
                  replyToId?: string;
                };
                durable: (
                  payload: { text: string; replyToId?: string },
                  info: { kind: string },
                ) => unknown;
              };
            };
          };
        }) => {
          const turn = params.adapter.resolveTurn();
          const payload = turn.delivery.preparePayload({ text: "final reply", replyToId });
          observeDurableOptions(turn.delivery.durable(payload, { kind: "final" }));
        },
      );

      const { runtime } = await processGoogleChatThreadReplyTest({
        runTurn,
        typingIndicator: typingFails ? "message" : "none",
        typingFails,
      });

      if (typingFails) {
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining("Failed sending typing message"),
        );
      }
      expect(observeDurableOptions).toHaveBeenCalledWith({
        to: "spaces/CLASSIFY",
        replyToId: expectedThread,
        threadId: expectedThread,
      });
    },
  );
});
