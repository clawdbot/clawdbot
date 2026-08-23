// Feishu tests cover comment handler plugin behavior.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawdbotConfig, PluginRuntime } from "../runtime-api.js";
import { handleFeishuCommentEvent } from "./comment-handler.js";
import { setFeishuRuntime } from "./runtime.js";

const resolveDriveCommentEventTurnMock = vi.hoisted(() => vi.fn());
const createFeishuCommentReplyDispatcherMock = vi.hoisted(() => vi.fn());
const maybeCreateDynamicAgentMock = vi.hoisted(() => vi.fn());
const createFeishuClientMock = vi.hoisted(() => vi.fn(() => ({ request: vi.fn() })));
const deliverCommentThreadTextMock = vi.hoisted(() => vi.fn());
const dispatchInboundMessageMock = vi.hoisted(() => vi.fn());

vi.mock("./monitor.comment.js", () => ({
  resolveDriveCommentEventTurn: resolveDriveCommentEventTurnMock,
}));

vi.mock("./comment-dispatcher.js", () => ({
  createFeishuCommentReplyDispatcher: createFeishuCommentReplyDispatcherMock,
}));

vi.mock("./dynamic-agent.js", () => ({
  maybeCreateDynamicAgent: maybeCreateDynamicAgentMock,
}));

vi.mock("./client.js", () => ({
  createFeishuClient: createFeishuClientMock,
}));

vi.mock("./drive.js", () => ({
  deliverCommentThreadText: deliverCommentThreadTextMock,
}));

vi.mock("openclaw/plugin-sdk/reply-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/reply-runtime")>()),
  dispatchInboundMessage: dispatchInboundMessageMock,
}));

async function raceWithNextMacrotask<T>(promise: Promise<T>): Promise<T | "pending"> {
  return await Promise.race([
    promise,
    new Promise<"pending">((resolve) => {
      setImmediate(() => resolve("pending"));
    }),
  ]);
}

function buildConfig(overrides?: Partial<ClawdbotConfig>): ClawdbotConfig {
  return {
    channels: {
      feishu: {
        enabled: true,
        dmPolicy: "open",
        allowFrom: ["*"],
      },
    },
    ...overrides,
  } as ClawdbotConfig;
}

let currentRuntimeConfig = buildConfig();

function buildResolvedRoute(matchedBy: "binding.channel" | "default" = "binding.channel") {
  return {
    agentId: "main",
    channel: "feishu",
    accountId: "default",
    sessionKey: "agent:main:feishu:direct:ou_sender",
    mainSessionKey: "agent:main:feishu",
    lastRoutePolicy: "session" as const,
    matchedBy,
  };
}

function mockCallArg(mockFn: ReturnType<typeof vi.fn>, label: string, callIndex = 0, argIndex = 0) {
  const call = mockFn.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`expected ${label} call ${callIndex}`);
  }
  if (!(argIndex in call)) {
    throw new Error(`expected ${label} call ${callIndex} argument ${argIndex}`);
  }
  return call[argIndex];
}

function createTestRuntime(overrides?: {
  currentCfg?: ClawdbotConfig;
  readAllowFromStore?: () => Promise<unknown[]>;
  upsertPairingRequest?: () => Promise<{ code: string; created: boolean }>;
  resolveAgentRoute?: () => ReturnType<typeof buildResolvedRoute>;
}) {
  const recordInboundSession = vi.fn(async (_params: unknown) => {});
  type CommentTurnPlan = Parameters<PluginRuntime["channel"]["inbound"]["dispatch"]>[0];
  const dispatchPlanForTest = vi.fn(async (turn: CommentTurnPlan) => {
    const storePath = "/tmp/feishu-session-store.json";
    await recordInboundSession({
      storePath,
      sessionKey: turn.ctxPayload.SessionKey ?? turn.route.sessionKey,
      ctx: turn.ctxPayload,
      groupResolution: turn.record?.groupResolution,
      createIfMissing: turn.record?.createIfMissing,
      updateLastRoute: turn.record?.updateLastRoute,
      onRecordError: turn.record?.onRecordError ?? (() => undefined),
    });
    const dispatchResult = await dispatchInboundMessageMock({
      ctx: turn.ctxPayload,
      cfg: turn.cfg,
      replyOptions: turn.replyOptions,
    });
    return {
      admission: { kind: "dispatch" as const },
      dispatched: true,
      ctxPayload: turn.ctxPayload,
      routeSessionKey: turn.route.sessionKey,
      dispatchResult,
    };
  });

  return {
    config: {
      current: vi.fn(() => overrides?.currentCfg ?? currentRuntimeConfig),
    },
    channel: {
      routing: {
        buildAgentSessionKey: vi.fn(
          ({
            agentId,
            channel,
            peer,
          }: {
            agentId: string;
            channel: string;
            peer?: { kind?: string; id?: string };
          }) => `agent:${agentId}:${channel}:${peer?.kind ?? "direct"}:${peer?.id ?? "peer"}`,
        ),
        resolveAgentRoute: vi.fn(overrides?.resolveAgentRoute ?? (() => buildResolvedRoute())),
      },
      reply: {
        settleReplyDispatcher: vi.fn(async ({ dispatcher, onSettled }) => {
          dispatcher.markComplete();
          await dispatcher.waitForIdle();
          await onSettled?.();
        }),
      },
      session: {
        resolveStorePath: vi.fn(() => "/tmp/feishu-session-store.json"),
        recordInboundSession,
      },
      inbound: {
        run: vi.fn(async (params: Parameters<PluginRuntime["channel"]["inbound"]["run"]>[0]) => {
          const input = await params.adapter.ingest(params.raw);
          if (!input) {
            return {
              admission: { kind: "drop" as const, reason: "ingest-null" },
              dispatched: false,
            };
          }
          const eventClass = {
            kind: "message" as const,
            canStartAgentTurn: true,
          };
          const turn = await params.adapter.resolveTurn(input, eventClass, {});
          if (!("route" in turn) || !("delivery" in turn)) {
            throw new Error("expected assembled Feishu comment turn plan");
          }
          return await dispatchPlanForTest(turn);
        }) as unknown as PluginRuntime["channel"]["inbound"]["run"],
      },
      pairing: {
        readAllowFromStore: vi.fn(overrides?.readAllowFromStore ?? (async () => [])),
        upsertPairingRequest: vi.fn(
          overrides?.upsertPairingRequest ??
            (async () => ({
              code: "TESTCODE",
              created: true,
            })),
        ),
        buildPairingReply: vi.fn((code: string) => `Pairing code: ${code}`),
      },
    },
  } as unknown as PluginRuntime;
}

describe("handleFeishuCommentEvent", () => {
  afterAll(() => {
    vi.doUnmock("./monitor.comment.js");
    vi.doUnmock("./comment-dispatcher.js");
    vi.doUnmock("./dynamic-agent.js");
    vi.doUnmock("./client.js");
    vi.doUnmock("./drive.js");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    dispatchInboundMessageMock.mockResolvedValue({
      queuedFinal: true,
      counts: { tool: 0, block: 0, final: 1 },
    });
    currentRuntimeConfig = buildConfig();
    maybeCreateDynamicAgentMock.mockImplementation(async ({ cfg }) => ({
      created: false,
      updatedCfg: cfg,
    }));
    resolveDriveCommentEventTurnMock.mockResolvedValue({
      eventId: "evt_1",
      messageId: "drive-comment:evt_1",
      commentId: "comment_1",
      replyId: "reply_1",
      noticeType: "add_comment",
      fileToken: "doc_token_1",
      fileType: "docx",
      isWholeComment: false,
      senderId: "ou_sender",
      senderUserId: "on_sender_user",
      timestamp: "1774951528000",
      isMentioned: true,
      documentTitle: "Project review",
      prompt: "prompt body",
      preview: "prompt body",
      rootCommentText: "root comment",
      targetReplyText: "latest reply",
    });
    deliverCommentThreadTextMock.mockResolvedValue({
      delivery_mode: "reply_comment",
      reply_id: "r1",
    });

    const runtime = createTestRuntime();
    setFeishuRuntime(runtime);

    createFeishuCommentReplyDispatcherMock.mockReturnValue({
      dispatcherOptions: {},
      delivery: { deliver: vi.fn(async () => undefined) },
      startTypingReaction: vi.fn(async () => {}),
      cleanupTypingReaction: vi.fn(async () => {}),
    });
  });

  it("records a comment-thread inbound context with a routable Feishu origin", async () => {
    const abortController = new AbortController();
    await handleFeishuCommentEvent({
      cfg: buildConfig(),
      accountId: "default",
      event: { event_id: "evt_1" },
      botOpenId: "ou_bot",
      abortSignal: abortController.signal,
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    expect(resolveDriveCommentEventTurnMock).toHaveBeenCalledWith(
      expect.objectContaining({ abortSignal: abortController.signal }),
    );

    const runtime = (await import("./runtime.js")).getFeishuRuntime();
    const recordInboundSession = runtime.channel.session.recordInboundSession as ReturnType<
      typeof vi.fn
    >;

    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    const finalizedContext = (
      mockCallArg(dispatchInboundMessageMock, "dispatchInboundMessage") as {
        ctx?: Record<string, unknown>;
      }
    ).ctx;
    expect({
      from: finalizedContext?.From,
      to: finalizedContext?.To,
      surface: finalizedContext?.Surface,
      originatingChannel: finalizedContext?.OriginatingChannel,
      originatingTo: finalizedContext?.OriginatingTo,
      messageSid: finalizedContext?.MessageSid,
      messageThreadId: finalizedContext?.MessageThreadId,
    }).toEqual({
      from: "feishu:ou_sender",
      to: "comment:docx:doc_token_1:comment_1",
      surface: "feishu-comment",
      originatingChannel: "feishu",
      originatingTo: "comment:docx:doc_token_1:comment_1",
      messageSid: "drive-comment:evt_1",
      messageThreadId: "reply_1",
    });
    expect(recordInboundSession).toHaveBeenCalledTimes(1);
    const recordArgs = mockCallArg(recordInboundSession, "recordInboundSession") as
      | { sessionKey?: string }
      | undefined;
    expect(recordArgs?.sessionKey).toBe("agent:main:feishu:direct:comment-doc:docx:doc_token_1");
  });

  it("allows comment senders matched by user_id allowlist entries", async () => {
    const runtime = createTestRuntime();
    setFeishuRuntime(runtime);

    await handleFeishuCommentEvent({
      cfg: buildConfig({
        channels: {
          feishu: {
            enabled: true,
            dmPolicy: "allowlist",
            allowFrom: ["on_sender_user"],
          },
        },
      }),
      accountId: "default",
      event: { event_id: "evt_1" },
      botOpenId: "ou_bot",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
    expect(deliverCommentThreadTextMock).not.toHaveBeenCalled();
  });

  it("passes the resolved account to dynamic agent resolution", async () => {
    const cfg = buildConfig({
      channels: {
        feishu: {
          enabled: true,
          dmPolicy: "open",
          allowFrom: ["*"],
          configWrites: false,
          dynamicAgentCreation: {
            enabled: true,
          },
        },
      },
    });
    const runtime = createTestRuntime({
      currentCfg: cfg,
      resolveAgentRoute: () => buildResolvedRoute("default"),
    });
    setFeishuRuntime(runtime);

    await handleFeishuCommentEvent({
      cfg,
      accountId: "default",
      event: { event_id: "evt_1" },
      botOpenId: "ou_bot",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    expect(maybeCreateDynamicAgentMock).toHaveBeenCalledTimes(1);
    const dynamicAgentArgs = mockCallArg(maybeCreateDynamicAgentMock, "maybeCreateDynamicAgent") as
      | { accountId?: string; senderOpenId?: string }
      | undefined;
    expect(dynamicAgentArgs?.senderOpenId).toBe("ou_sender");
    expect(dynamicAgentArgs?.accountId).toBe("default");
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
  });

  it("drops a comment denied by refreshed dynamic-agent policy", async () => {
    const refreshedCfg = buildConfig({
      channels: {
        feishu: {
          enabled: true,
          dmPolicy: "allowlist",
          allowFrom: ["ou_admin"],
        },
      },
    });
    const runtime = createTestRuntime({
      currentCfg: refreshedCfg,
      resolveAgentRoute: () => buildResolvedRoute("default"),
    });
    setFeishuRuntime(runtime);
    const cfg = buildConfig();

    await handleFeishuCommentEvent({
      cfg,
      accountId: "default",
      event: { event_id: "evt_1" },
      botOpenId: "ou_bot",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    expect(maybeCreateDynamicAgentMock).not.toHaveBeenCalled();
    expect(deliverCommentThreadTextMock).not.toHaveBeenCalled();
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });

  it("issues a pairing challenge before dynamic comment-agent creation", async () => {
    const currentCfg = buildConfig({
      channels: {
        feishu: {
          enabled: true,
          dmPolicy: "pairing",
          allowFrom: [],
          dynamicAgentCreation: { enabled: true },
        },
      },
    });
    const runtime = createTestRuntime({
      currentCfg,
      resolveAgentRoute: () => buildResolvedRoute("default"),
    });
    setFeishuRuntime(runtime);

    await handleFeishuCommentEvent({
      cfg: buildConfig(),
      accountId: "default",
      event: { event_id: "evt_1" },
      botOpenId: "ou_bot",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    expect(maybeCreateDynamicAgentMock).not.toHaveBeenCalled();
    expect(deliverCommentThreadTextMock).toHaveBeenCalledTimes(1);
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });

  it("issues a pairing challenge in the comment thread when dmPolicy=pairing", async () => {
    const runtime = createTestRuntime();
    setFeishuRuntime(runtime);

    await handleFeishuCommentEvent({
      cfg: buildConfig({
        channels: {
          feishu: {
            enabled: true,
            dmPolicy: "pairing",
            allowFrom: [],
          },
        },
      }),
      accountId: "default",
      event: { event_id: "evt_1" },
      botOpenId: "ou_bot",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    expect(deliverCommentThreadTextMock).toHaveBeenCalledTimes(1);
    const pairingClient = mockCallArg(deliverCommentThreadTextMock, "deliverCommentThreadText");
    const pairingReply = mockCallArg(
      deliverCommentThreadTextMock,
      "deliverCommentThreadText",
      0,
      1,
    );
    expect(pairingClient).toBe(createFeishuClientMock.mock.results[0]?.value);
    expect(pairingReply).toEqual({
      file_token: "doc_token_1",
      file_type: "docx",
      comment_id: "comment_1",
      content: [
        "OpenClaw: access not configured.",
        "",
        "Your Feishu user id: ou_sender",
        "Pairing code:",
        "```",
        "TESTCODE",
        "```",
        "",
        "Ask the bot owner to approve with:",
        "```",
        "openclaw pairing approve feishu TESTCODE",
        "```",
      ].join("\n"),
      is_whole_comment: false,
    });
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  });

  it("passes whole-comment metadata to the comment reply dispatcher", async () => {
    resolveDriveCommentEventTurnMock.mockResolvedValueOnce({
      eventId: "evt_whole",
      messageId: "drive-comment:evt_whole",
      commentId: "comment_whole",
      replyId: "reply_whole",
      noticeType: "add_reply",
      fileToken: "doc_token_1",
      fileType: "docx",
      isWholeComment: true,
      senderId: "ou_sender",
      senderUserId: "on_sender_user",
      timestamp: "1774951528000",
      isMentioned: false,
      documentTitle: "Project review",
      prompt: "prompt body",
      preview: "prompt body",
      rootCommentText: "root comment",
      targetReplyText: "reply text",
    });

    await handleFeishuCommentEvent({
      cfg: buildConfig(),
      accountId: "default",
      event: { event_id: "evt_whole" },
      botOpenId: "ou_bot",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    expect(createFeishuCommentReplyDispatcherMock).toHaveBeenCalledTimes(1);
    const dispatcherArgs = mockCallArg(
      createFeishuCommentReplyDispatcherMock,
      "createFeishuCommentReplyDispatcher",
    ) as
      | {
          commentId?: string;
          fileToken?: string;
          fileType?: string;
          isWholeComment?: boolean;
          replyId?: string;
        }
      | undefined;
    expect(dispatcherArgs?.commentId).toBe("comment_whole");
    expect(dispatcherArgs?.fileToken).toBe("doc_token_1");
    expect(dispatcherArgs?.fileType).toBe("docx");
    expect(dispatcherArgs?.replyId).toBe("reply_whole");
    expect(dispatcherArgs?.isWholeComment).toBe(true);
  });

  it("always finalizes comment typing cleanup even when dispatch fails", async () => {
    dispatchInboundMessageMock.mockRejectedValueOnce(new Error("dispatch failed"));
    const runtime = createTestRuntime();
    setFeishuRuntime(runtime);
    const cleanupTypingReaction = vi.fn(async () => {});
    createFeishuCommentReplyDispatcherMock.mockReturnValue({
      dispatcherOptions: {},
      delivery: { deliver: vi.fn(async () => undefined) },
      startTypingReaction: vi.fn(async () => {}),
      cleanupTypingReaction,
    });

    await expect(
      handleFeishuCommentEvent({
        cfg: buildConfig(),
        accountId: "default",
        event: { event_id: "evt_1" },
        botOpenId: "ou_bot",
        runtime: {
          log: vi.fn(),
          error: vi.fn(),
        } as never,
      }),
    ).rejects.toThrow("dispatch failed");

    expect(cleanupTypingReaction).toHaveBeenCalledTimes(1);
  });

  it("does not wait for comment typing cleanup before returning", async () => {
    let resolveCleanup: (() => void) | undefined;
    const cleanupTypingReaction = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveCleanup = resolve;
        }),
    );
    createFeishuCommentReplyDispatcherMock.mockReturnValue({
      dispatcherOptions: {},
      delivery: { deliver: vi.fn(async () => undefined) },
      startTypingReaction: vi.fn(async () => {}),
      cleanupTypingReaction,
    });

    const eventPromise = handleFeishuCommentEvent({
      cfg: buildConfig(),
      accountId: "default",
      event: { event_id: "evt_1" },
      botOpenId: "ou_bot",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    const status = await raceWithNextMacrotask(eventPromise.then(() => "done"));

    expect(status).toBe("done");
    expect(cleanupTypingReaction).toHaveBeenCalledTimes(1);

    resolveCleanup?.();
    await eventPromise;
  });

  it("does not start comment typing reaction before dispatch begins", async () => {
    const startTypingReaction = vi.fn(async () => {});
    createFeishuCommentReplyDispatcherMock.mockReturnValue({
      dispatcherOptions: {},
      delivery: { deliver: vi.fn(async () => undefined) },
      startTypingReaction,
      cleanupTypingReaction: vi.fn(async () => {}),
    });

    await handleFeishuCommentEvent({
      cfg: buildConfig(),
      accountId: "default",
      event: { event_id: "evt_1" },
      botOpenId: "ou_bot",
      runtime: {
        log: vi.fn(),
        error: vi.fn(),
      } as never,
    });

    expect(startTypingReaction).not.toHaveBeenCalled();
    expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
  });
});
