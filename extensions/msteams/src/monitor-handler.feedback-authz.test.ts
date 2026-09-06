import { resolveAgentRoute, resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
// Msteams tests cover monitor handler.feedback authz plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import { runMSTeamsFeedbackInvokeHandler } from "./feedback-invoke.js";
import { createMSTeamsMessageHandlerDeps } from "./monitor-handler.test-helpers.js";
import type { MSTeamsMessageHandlerDeps } from "./monitor-handler.types.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

const feedbackReflectionMockState = vi.hoisted(() => ({
  runFeedbackReflection: vi.fn(),
}));
const channelInboundMockState = vi.hoisted(() => ({
  recordChannelFeedbackEvent: vi.fn(async () => true),
}));

vi.mock("openclaw/plugin-sdk/channel-inbound", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/channel-inbound")>()),
  recordChannelFeedbackEvent: channelInboundMockState.recordChannelFeedbackEvent,
}));

vi.mock("./monitor-handler/message-handler.js", () => ({
  createMSTeamsMessageHandler: () => async () => {},
}));

vi.mock("./monitor-handler/reaction-handler.js", () => ({
  createMSTeamsReactionHandler: () => async () => {},
}));

vi.mock("./feedback-reflection.js", async () => {
  const actual = await vi.importActual<typeof import("./feedback-reflection.js")>(
    "./feedback-reflection.js",
  );
  return {
    ...actual,
    runFeedbackReflection: feedbackReflectionMockState.runFeedbackReflection,
  };
});

function createRuntimeStub(readAllowFromStore: ReturnType<typeof vi.fn>): PluginRuntime {
  return {
    logging: {
      shouldLogVerbose: () => false,
    },
    channel: {
      debounce: {
        resolveInboundDebounceMs: () => 0,
        createInboundDebouncer: () => ({
          enqueue: async () => {},
          flushKey: async () => {},
          cancelKey: () => false,
          drain: async () => {},
        }),
      },
      pairing: {
        readAllowFromStore,
        upsertPairingRequest: vi.fn(async () => null),
      },
      routing: {
        resolveAgentRoute: ({ peer }: { peer: { kind: string; id: string } }) => ({
          sessionKey: `msteams:${peer.kind}:${peer.id}`,
          agentId: "default",
          accountId: "default",
        }),
      },
      session: {
        resolveStorePath: (storePath?: string) => storePath ?? "/tmp",
      },
    },
  } as unknown as PluginRuntime;
}

function createDeps(params: {
  cfg: OpenClawConfig;
  readAllowFromStore?: ReturnType<typeof vi.fn>;
}): MSTeamsMessageHandlerDeps {
  const readAllowFromStore = params.readAllowFromStore ?? vi.fn(async () => []);
  setMSTeamsRuntime(createRuntimeStub(readAllowFromStore));
  return createMSTeamsMessageHandlerDeps({
    cfg: params.cfg,
    runtime: { error: vi.fn() } as unknown as RuntimeEnv,
  });
}

function createFeedbackInvokeContext(params: {
  reaction: "like" | "dislike";
  conversationId: string;
  conversationType: string;
  senderId: string;
  senderName?: string;
  teamId?: string;
  channelName?: string;
  comment?: string;
}): MSTeamsTurnContext {
  return {
    activity: {
      id: `invoke-${params.reaction}`,
      type: "invoke",
      name: "message/submitAction",
      channelId: "msteams",
      serviceUrl: "https://service.example.test",
      from: {
        id: `${params.senderId}-botframework`,
        aadObjectId: params.senderId,
        name: params.senderName ?? "Sender",
      },
      recipient: {
        id: "bot-id",
        name: "Bot",
      },
      conversation: {
        id: params.conversationId,
        conversationType: params.conversationType,
        tenantId: params.teamId ? "tenant-1" : undefined,
      },
      channelData: params.teamId
        ? {
            team: { id: params.teamId, name: "Team 1" },
            channel: params.channelName ? { name: params.channelName } : undefined,
          }
        : {},
      value: {
        actionName: "feedback",
        actionValue: {
          reaction: params.reaction,
          feedback: JSON.stringify({ feedbackText: params.comment ?? "feedback text" }),
        },
        replyToId: "bot-msg-1",
      },
    },
    sendActivity: vi.fn(async () => ({ id: "ignored" })),
    sendActivities: async () => [],
  } as unknown as MSTeamsTurnContext;
}

async function withFeedbackHandler(params: {
  cfg: OpenClawConfig;
  context: Parameters<typeof createFeedbackInvokeContext>[0];
  assertResult: () => Promise<void>;
}) {
  const deps = createDeps({ cfg: params.cfg });
  await runMSTeamsFeedbackInvokeHandler(createFeedbackInvokeContext(params.context), deps);
  await params.assertResult();
}

describe("msteams feedback invoke authz", () => {
  beforeEach(() => {
    feedbackReflectionMockState.runFeedbackReflection.mockReset();
    feedbackReflectionMockState.runFeedbackReflection.mockResolvedValue(undefined);
    channelInboundMockState.recordChannelFeedbackEvent.mockClear();
  });

  it("records feedback for an allowlisted DM sender", async () => {
    await withFeedbackHandler({
      cfg: {
        channels: {
          msteams: {
            dmPolicy: "allowlist",
            allowFrom: ["owner-aad"],
          },
        },
      } as OpenClawConfig,
      context: {
        reaction: "like",
        conversationId: "a:personal-chat;messageid=bot-msg-1",
        conversationType: "personal",
        senderId: "owner-aad",
        senderName: "Owner",
        comment: "allowed feedback",
      },
      assertResult: async () => {
        expect(channelInboundMockState.recordChannelFeedbackEvent).toHaveBeenCalledWith({
          cfg: expect.any(Object),
          agentId: "default",
          sessionKey: "msteams:direct:owner-aad",
          context: { channelId: "msteams", accountId: "default" },
          event: {
            type: "custom",
            event: "feedback",
            ts: expect.any(Number),
            messageId: "bot-msg-1",
            value: "positive",
            comment: "allowed feedback",
            sessionKey: "msteams:direct:owner-aad",
            agentId: "default",
            conversationId: "a:personal-chat",
            senderId: "owner-aad",
            senderName: "Owner",
            providerUpdate: { id: "invoke-like", kind: "message/submitAction" },
          },
        });
      },
    });
  });

  it("keeps DM feedback allowed when team route allowlists exist", async () => {
    await withFeedbackHandler({
      cfg: {
        channels: {
          msteams: {
            dmPolicy: "allowlist",
            allowFrom: ["owner-aad"],
            teams: {
              team123: {
                channels: {
                  "19:group@thread.tacv2": { requireMention: false },
                },
              },
            },
          },
        },
      } as OpenClawConfig,
      context: {
        reaction: "like",
        conversationId: "a:personal-chat;messageid=bot-msg-1",
        conversationType: "personal",
        senderId: "owner-aad",
        senderName: "Owner",
        comment: "allowed dm feedback",
      },
      assertResult: async () => {
        expect(channelInboundMockState.recordChannelFeedbackEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: "default",
            sessionKey: "msteams:direct:owner-aad",
            event: expect.objectContaining({ comment: "allowed dm feedback" }),
          }),
        );
      },
    });
  });

  it("does not record feedback for a DM sender outside allowFrom", async () => {
    await withFeedbackHandler({
      cfg: {
        channels: {
          msteams: {
            dmPolicy: "allowlist",
            allowFrom: ["owner-aad"],
          },
        },
      } as OpenClawConfig,
      context: {
        reaction: "like",
        conversationId: "a:personal-chat;messageid=bot-msg-1",
        conversationType: "personal",
        senderId: "attacker-aad",
        senderName: "Attacker",
        comment: "blocked feedback",
      },
      assertResult: async () => {
        expect(channelInboundMockState.recordChannelFeedbackEvent).not.toHaveBeenCalled();
        expect(feedbackReflectionMockState.runFeedbackReflection).not.toHaveBeenCalled();
      },
    });
  });

  it("does not trigger reflection for a group sender outside groupAllowFrom", async () => {
    const deps = createDeps({
      cfg: {
        channels: {
          msteams: {
            groupPolicy: "allowlist",
            groupAllowFrom: ["owner-aad"],
            feedbackReflection: true,
          },
        },
      } as OpenClawConfig,
    });

    await runMSTeamsFeedbackInvokeHandler(
      createFeedbackInvokeContext({
        reaction: "dislike",
        conversationId: "19:group@thread.tacv2;messageid=bot-msg-1",
        conversationType: "groupChat",
        senderId: "attacker-aad",
        senderName: "Attacker",
        teamId: "team-1",
        channelName: "General",
        comment: "blocked reflection",
      }),
      deps,
    );

    expect(channelInboundMockState.recordChannelFeedbackEvent).not.toHaveBeenCalled();
    expect(feedbackReflectionMockState.runFeedbackReflection).not.toHaveBeenCalled();
  });

  it("keeps feedback without an exact response target transcript-only", async () => {
    const deps = createDeps({
      cfg: { channels: { msteams: { dmPolicy: "allowlist", allowFrom: ["owner-aad"] } } },
    });
    const context = createFeedbackInvokeContext({
      reaction: "like",
      conversationId: "personal-chat",
      conversationType: "personal",
      senderId: "owner-aad",
    });
    delete (context.activity.value as { replyToId?: string }).replyToId;
    await runMSTeamsFeedbackInvokeHandler(context, deps);
    expect(channelInboundMockState.recordChannelFeedbackEvent).toHaveBeenCalledExactlyOnceWith({
      cfg: deps.cfg,
      agentId: "default",
      sessionKey: "msteams:direct:owner-aad",
      event: expect.objectContaining({ messageId: "unknown" }),
    });
  });

  it("records team-bound feedback with the answering route", async () => {
    const cfg = {
      bindings: [{ agentId: "team-seat", match: { channel: "msteams", teamId: "team-1" } }],
      channels: {
        msteams: {
          groupPolicy: "allowlist",
          groupAllowFrom: ["owner-aad"],
          teams: { "team-1": { channels: { "19:channel@thread.tacv2": { enabled: true } } } },
        },
      },
    } as OpenClawConfig;
    const deps = createDeps({ cfg });
    const runtime = createRuntimeStub(vi.fn(async () => []));
    runtime.channel.routing.resolveAgentRoute = resolveAgentRoute;
    setMSTeamsRuntime(runtime);
    const normalRoute = resolveAgentRoute({
      cfg,
      channel: "msteams",
      teamId: "team-1",
      peer: { kind: "channel", id: "19:channel@thread.tacv2" },
    });
    expect(normalRoute.agentId).toBe("team-seat");
    const { sessionKey } = resolveThreadSessionKeys({
      baseSessionKey: normalRoute.sessionKey,
      parentSessionKey: normalRoute.sessionKey,
      threadId: "thread-root",
    });
    await runMSTeamsFeedbackInvokeHandler(
      createFeedbackInvokeContext({
        reaction: "like",
        conversationId: "19:channel@thread.tacv2;messageid=thread-root",
        conversationType: "channel",
        senderId: "owner-aad",
        teamId: "team-1",
      }),
      deps,
    );
    expect(channelInboundMockState.recordChannelFeedbackEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sessionKey,
        agentId: normalRoute.agentId,
        context: { channelId: "msteams", accountId: normalRoute.accountId },
        event: expect.objectContaining({
          conversationId: "19:channel@thread.tacv2",
          messageId: "bot-msg-1",
          value: "positive",
          providerUpdate: { id: "invoke-like", kind: "message/submitAction" },
        }),
      }),
    );
  });
});
