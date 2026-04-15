import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import type { MSTeamsConversationStore } from "./conversation-store.js";
import {
  type MSTeamsActivityHandler,
  type MSTeamsMessageHandlerDeps,
  registerMSTeamsHandlers,
} from "./monitor-handler.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const runtimeApiMockState = vi.hoisted(() => ({
  dispatchReplyFromConfigWithSettledDispatcher: vi.fn(async (params: { ctxPayload: unknown }) => ({
    queuedFinal: false,
    counts: {},
    capturedCtxPayload: params.ctxPayload,
  })),
}));

vi.mock("../runtime-api.js", async () => {
  const actual = await vi.importActual<typeof import("../runtime-api.js")>("../runtime-api.js");
  return {
    ...actual,
    dispatchReplyFromConfigWithSettledDispatcher:
      runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher,
  };
});

vi.mock("./reply-dispatcher.js", () => ({
  createMSTeamsReplyDispatcher: () => ({
    dispatcher: {},
    replyOptions: {},
    markDispatchIdle: vi.fn(),
  }),
}));

function createDeps(): MSTeamsMessageHandlerDeps {
  setMSTeamsRuntime({
    logging: { shouldLogVerbose: () => false },
    system: { enqueueSystemEvent: vi.fn() },
    channel: {
      debounce: {
        resolveInboundDebounceMs: () => 0,
        createInboundDebouncer: <T>(params: {
          onFlush: (entries: T[]) => Promise<void>;
        }): { enqueue: (entry: T) => Promise<void> } => ({
          enqueue: async (entry: T) => {
            await params.onFlush([entry]);
          },
        }),
      },
      pairing: {
        readAllowFromStore: vi.fn(async () => []),
        upsertPairingRequest: vi.fn(async () => null),
      },
      text: {
        hasControlCommand: () => false,
      },
      routing: {
        resolveAgentRoute: ({ peer }: { peer: { kind: string; id: string } }) => ({
          sessionKey: `msteams:${peer.kind}:${peer.id}`,
          agentId: "default",
          accountId: "default",
        }),
      },
      reply: {
        formatAgentEnvelope: ({ body }: { body: string }) => body,
        finalizeInboundContext: <T extends Record<string, unknown>>(ctx: T) => ctx,
      },
      session: {
        recordInboundSession: vi.fn(async () => undefined),
      },
    },
  } as unknown as PluginRuntime);

  return {
    cfg: {} as OpenClawConfig,
    runtime: { error: vi.fn() } as unknown as RuntimeEnv,
    appId: "test-app",
    adapter: {} as MSTeamsMessageHandlerDeps["adapter"],
    tokenProvider: {
      getAccessToken: vi.fn(async () => "token"),
    },
    textLimit: 4000,
    mediaMaxBytes: 1024 * 1024,
    conversationStore: {
      get: vi.fn(async () => null),
      upsert: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
      remove: vi.fn(async () => false),
      findPreferredDmByUserId: vi.fn(async () => null),
      findByUserId: vi.fn(async () => null),
    } satisfies MSTeamsConversationStore,
    pollStore: {
      recordVote: vi.fn(async () => null),
    } as unknown as MSTeamsMessageHandlerDeps["pollStore"],
    log: {
      info: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    } as unknown as MSTeamsMessageHandlerDeps["log"],
  };
}

function createActivityHandler() {
  const messageHandlers: Array<(context: unknown, next: () => Promise<void>) => Promise<void>> = [];
  const run = vi.fn(async (context: unknown) => {
    const activityType = (context as MSTeamsTurnContext).activity?.type;
    if (activityType !== "message") {
      return;
    }
    for (const handler of messageHandlers) {
      await handler(context, async () => {});
    }
  });

  let handler: MSTeamsActivityHandler & {
    run: NonNullable<MSTeamsActivityHandler["run"]>;
  };
  handler = {
    onMessage: (nextHandler) => {
      messageHandlers.push(nextHandler);
      return handler;
    },
    onMembersAdded: () => handler,
    onReactionsAdded: () => handler,
    onReactionsRemoved: () => handler,
    run,
  };

  return { handler, run };
}

describe("msteams adaptive card action invoke", () => {
  beforeEach(() => {
    runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mockClear();
  });

  it("forwards adaptive card invoke values to the agent as message text", async () => {
    const deps = createDeps();
    const { handler, run } = createActivityHandler();
    const registered = registerMSTeamsHandlers(handler, deps) as MSTeamsActivityHandler & {
      run: NonNullable<MSTeamsActivityHandler["run"]>;
    };
    const payload = {
      action: {
        type: "Action.Submit",
        data: {
          intent: "deploy",
          environment: "prod",
        },
      },
      trigger: "button-click",
    };

    await registered.run({
      activity: {
        id: "invoke-1",
        type: "invoke",
        name: "adaptiveCard/action",
        channelId: "msteams",
        serviceUrl: "https://service.example.test",
        from: {
          id: "user-bf",
          aadObjectId: "user-aad",
          name: "User",
        },
        recipient: {
          id: "bot-id",
          name: "Bot",
        },
        conversation: {
          id: "19:personal-chat;messageid=abc123",
          conversationType: "personal",
        },
        channelData: {},
        attachments: [],
        value: payload,
      },
      sendActivity: vi.fn(async () => ({ id: "activity-id" })),
      sendActivities: async () => [],
    } as unknown as MSTeamsTurnContext);

    expect(run).not.toHaveBeenCalled();
    expect(runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher).toHaveBeenCalledTimes(
      1,
    );
    expect(
      runtimeApiMockState.dispatchReplyFromConfigWithSettledDispatcher.mock.calls[0]?.[0],
    ).toMatchObject({
      ctxPayload: {
        RawBody: JSON.stringify(payload),
        BodyForAgent: JSON.stringify(payload),
        CommandBody: JSON.stringify(payload),
        SessionKey: "msteams:direct:user-aad",
        SenderId: "user-aad",
      },
    });
  });
});
