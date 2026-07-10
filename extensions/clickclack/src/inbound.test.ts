// Clickclack tests cover inbound plugin behavior.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { buildAgentSessionKey, resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleClickClackInbound } from "./inbound.js";
import { setClickClackRuntime } from "./runtime.js";
import type { ClickClackMessage, CoreConfig, ResolvedClickClackAccount } from "./types.js";

const sendClickClackTextMock = vi.hoisted(() => vi.fn());
const VALID_MESSAGE_ID = "msg_01arz3ndektsv4rrffq69g5fav";
const SECOND_VALID_MESSAGE_ID = "msg_01arz3ndektsv4rrffq69g5faw";

type LlmCompleteMock = ReturnType<
  typeof vi.fn<
    (params: {
      agentId?: string;
      model?: string;
      maxTokens?: number;
      purpose?: string;
      messages?: unknown[];
    }) => Promise<unknown>
  >
>;

vi.mock("./outbound.js", () => ({
  sendClickClackText: sendClickClackTextMock,
}));

function createRuntime(): PluginRuntime {
  return createPluginRuntimeMock({
    agent: {
      runEmbeddedAgent: vi.fn().mockResolvedValue({
        payloads: [{ text: "service bot online" }],
        meta: {},
      }),
    },
    channel: {
      routing: {
        resolveAgentRoute: vi.fn(
          (params: Parameters<PluginRuntime["channel"]["routing"]["resolveAgentRoute"]>[0]) =>
            resolveAgentRoute(params),
        ),
        buildAgentSessionKey: vi.fn(
          (params: Parameters<PluginRuntime["channel"]["routing"]["buildAgentSessionKey"]>[0]) =>
            buildAgentSessionKey(params),
        ),
      },
    },
    llm: {
      complete: vi.fn().mockResolvedValue({
        text: "service bot online",
        provider: "openai",
        model: "gpt-5.4-mini",
        agentId: "service-bot",
        usage: {},
        audit: {
          caller: { kind: "plugin", id: "clickclack" },
        },
      }),
    },
  } as unknown as PluginRuntime);
}

function createAgentAccount(
  overrides: Partial<ResolvedClickClackAccount> = {},
): ResolvedClickClackAccount {
  const base = {
    accountId: "default",
    enabled: true,
    configured: true,
    baseUrl: "http://127.0.0.1:8080",
    token: "ccb_default",
    workspace: "wsp_1",
    replyMode: "agent",
    toolsAllow: [],
    defaultTo: "channel:general",
    allowFrom: ["*"],
    reconnectMs: 1_500,
    agentActivity: false,
    config: {
      allowFrom: ["*"],
    },
  } satisfies ResolvedClickClackAccount;

  return {
    ...base,
    ...overrides,
    config: {
      ...base.config,
      ...overrides.config,
    },
  };
}

function createMessage(overrides: Partial<ClickClackMessage> = {}): ClickClackMessage {
  return {
    id: "msg_1",
    workspace_id: "wsp_1",
    channel_id: "chn_1",
    author_id: "usr_owner",
    thread_root_id: "msg_1",
    body: "/fast on",
    body_format: "markdown",
    created_at: "2026-05-09T12:00:00.000Z",
    author: {
      id: "usr_owner",
      kind: "human",
      display_name: "Peter",
      handle: "steipete",
      avatar_url: "",
      created_at: "2026-05-09T12:00:00.000Z",
    },
    ...overrides,
  };
}

describe("handleClickClackInbound", () => {
  beforeEach(() => {
    sendClickClackTextMock.mockReset();
  });

  it("runs model-mode bot accounts without tools and posts the bot reply", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const cfg = {
      agents: {
        defaults: {
          model: "openai/gpt-5.4-mini",
        },
      },
    } satisfies CoreConfig;
    const account = {
      accountId: "service",
      enabled: true,
      configured: true,
      baseUrl: "http://127.0.0.1:8080",
      token: "ccb_service",
      workspace: "wsp_1",
      agentId: "service-bot",
      replyMode: "model",
      model: "openai/gpt-5.4-mini",
      toolsAllow: [],
      defaultTo: "channel:general",
      allowFrom: ["*"],
      reconnectMs: 1_500,
      agentActivity: false,
      config: {},
    } satisfies ResolvedClickClackAccount;

    await handleClickClackInbound({
      account,
      config: cfg,
      message: {
        id: "msg_1",
        workspace_id: "wsp_1",
        channel_id: "chn_1",
        author_id: "usr_human",
        thread_root_id: "msg_1",
        body: "hello bot",
        body_format: "markdown",
        created_at: "2026-05-09T12:00:00.000Z",
        author: {
          id: "usr_human",
          kind: "human",
          display_name: "Peter",
          handle: "steipete",
          avatar_url: "",
          created_at: "2026-05-09T12:00:00.000Z",
        },
      },
      correlationId: "fakeco.case_1",
    });

    expect(runtime.channel.inbound.dispatchReply).not.toHaveBeenCalled();
    expect(runtime.agent.runEmbeddedAgent).not.toHaveBeenCalled();
    const completionRequest = (runtime.llm.complete as LlmCompleteMock).mock.calls[0]?.[0];
    expect(completionRequest?.agentId).toBe("service-bot");
    expect(completionRequest?.model).toBe("openai/gpt-5.4-mini");
    expect(completionRequest?.maxTokens).toBe(96);
    expect(completionRequest?.purpose).toBe("clickclack bot reply");
    expect(completionRequest?.messages).toEqual([{ role: "user", content: "hello bot" }]);

    const sendRequest = sendClickClackTextMock.mock.calls[0]?.[0];
    expect(sendRequest?.accountId).toBe("service");
    expect(sendRequest?.to).toBe("channel:chn_1");
    expect(sendRequest?.text).toBe("service bot online");
    expect(sendRequest?.replyToId).toBe("msg_1");
    expect(sendRequest?.correlationId).toBe("fakeco.case_1");
  });

  it("marks agent turns command-authorized for allowlisted senders", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.channel.commands.shouldComputeCommandAuthorized).mockReturnValue(true);
    setClickClackRuntime(runtime);
    const cfg = {
      agents: {
        defaults: {
          model: "openai/gpt-5.4-mini",
        },
      },
    } satisfies CoreConfig;

    await handleClickClackInbound({
      account: createAgentAccount({
        allowFrom: ["usr_owner"],
        config: { allowFrom: ["usr_owner"] },
      }),
      config: cfg,
      message: createMessage(),
    });

    const dispatchReply = vi.mocked(runtime.channel.inbound.dispatchReply);
    expect(dispatchReply).toHaveBeenCalledTimes(1);
    expect(dispatchReply.mock.calls[0]?.[0].ctxPayload.CommandAuthorized).toBe(true);
  });

  it("propagates account toolsAllow into agent reply dispatch", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const cfg = {
      agents: {
        defaults: {
          model: "openai/gpt-5.4-mini",
        },
      },
      tools: {
        allow: ["*"],
      },
    } satisfies CoreConfig;

    await handleClickClackInbound({
      account: createAgentAccount({
        toolsAllow: ["message"],
      }),
      config: cfg,
      message: createMessage(),
    });

    const dispatchReply = vi.mocked(runtime.channel.inbound.dispatchReply);
    expect(dispatchReply).toHaveBeenCalledTimes(1);
    const dispatchParams = dispatchReply.mock.calls[0]?.[0] as
      | (Record<string, unknown> & {
          toolsAllow?: unknown;
        })
      | undefined;
    expect(dispatchParams?.toolsAllow).toEqual(["message"]);
  });

  it("wires durable activity reply options only when the account opts in", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const cfg = {
      agents: {
        defaults: {
          model: "openai/gpt-5.4-mini",
        },
      },
    } satisfies CoreConfig;

    await handleClickClackInbound({
      account: createAgentAccount(),
      config: cfg,
      message: createMessage({
        id: VALID_MESSAGE_ID,
        thread_root_id: VALID_MESSAGE_ID,
      }),
    });
    await handleClickClackInbound({
      account: createAgentAccount({ agentActivity: true }),
      config: cfg,
      message: createMessage({
        id: SECOND_VALID_MESSAGE_ID,
        thread_root_id: SECOND_VALID_MESSAGE_ID,
      }),
    });

    const dispatchReply = vi.mocked(runtime.channel.inbound.dispatchReply);
    expect(dispatchReply).toHaveBeenCalledTimes(2);
    const withoutOptIn = dispatchReply.mock.calls[0]?.[0] as {
      replyOptions?: { runId?: unknown; onItemEvent?: unknown; onModelSelected?: unknown };
    };
    const withOptIn = dispatchReply.mock.calls[1]?.[0] as {
      replyOptions?: {
        onItemEvent?: unknown;
        onModelSelected?: unknown;
        runId?: unknown;
        commentaryProgressEnabled?: unknown;
        suppressDefaultToolProgressMessages?: unknown;
        allowProgressCallbacksWhenSourceDeliverySuppressed?: unknown;
      };
    };
    expect(withoutOptIn.replyOptions).toEqual({
      runId: `clickclack:${VALID_MESSAGE_ID}`,
    });
    expect(withOptIn.replyOptions?.runId).toBe(`clickclack:${SECOND_VALID_MESSAGE_ID}`);
    expect(typeof withOptIn.replyOptions?.onModelSelected).toBe("function");
    expect(withOptIn.replyOptions?.commentaryProgressEnabled).toBe(true);
    // Channel-owned progress rendering: item events must flow even when
    // session verbose mode is off and source delivery is handled by ClickClack.
    expect(withOptIn.replyOptions?.suppressDefaultToolProgressMessages).toBe(true);
    expect(withOptIn.replyOptions?.allowProgressCallbacksWhenSourceDeliverySuppressed).toBe(true);
    expect(typeof withOptIn.replyOptions?.onItemEvent).toBe("function");
  });

  it("maps the authoritative message id to the agent run and correlates the final reply", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount(),
      config: {} as CoreConfig,
      message: createMessage({
        id: VALID_MESSAGE_ID,
        thread_root_id: VALID_MESSAGE_ID,
      }),
      correlationId: "fakeco.case_2",
    });

    const dispatchParams = vi.mocked(runtime.channel.inbound.dispatchReply).mock.calls[0]?.[0];
    expect(dispatchParams?.replyOptions?.runId).toBe(`clickclack:${VALID_MESSAGE_ID}`);

    await dispatchParams?.delivery.deliver({ text: "correlated reply" }, {} as never);

    expect(sendClickClackTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        correlationId: "fakeco.case_2",
        replyToId: VALID_MESSAGE_ID,
        text: "correlated reply",
      }),
    );
  });

  it("does not derive a run id from a noncanonical message id", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount(),
      config: {} as CoreConfig,
      message: createMessage({ id: "msg_invalid" }),
    });

    expect(vi.mocked(runtime.channel.inbound.dispatchReply).mock.calls[0]?.[0].replyOptions).toBe(
      undefined,
    );
  });

  it("accepts ClickClack DM target syntax in allowFrom", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.channel.commands.shouldComputeCommandAuthorized).mockReturnValue(true);
    setClickClackRuntime(runtime);
    const cfg = {
      agents: {
        defaults: {
          model: "openai/gpt-5.4-mini",
        },
      },
    } satisfies CoreConfig;

    await handleClickClackInbound({
      account: createAgentAccount({
        allowFrom: ["dm:usr_owner"],
        config: { allowFrom: ["dm:usr_owner"] },
      }),
      config: cfg,
      message: createMessage({
        channel_id: undefined,
        direct_conversation_id: "dcn_1",
      }),
    });

    const dispatchReply = vi.mocked(runtime.channel.inbound.dispatchReply);
    expect(dispatchReply).toHaveBeenCalledTimes(1);
    expect(dispatchReply.mock.calls[0]?.[0].ctxPayload.ChatType).toBe("direct");
    expect(dispatchReply.mock.calls[0]?.[0].ctxPayload.CommandAuthorized).toBe(true);
  });

  it("preserves session policy when an account overrides the routed agent", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const cfg = {
      session: {
        dmScope: "per-channel-peer",
        mainKey: "work",
        identityLinks: { alice: ["clickclack:dm:usr_owner"] },
      },
      bindings: [
        {
          agentId: "binding-agent",
          match: {
            channel: "clickclack",
            accountId: "default",
            peer: { kind: "direct", id: "dm:usr_owner" },
          },
          session: { dmScope: "per-account-channel-peer" },
        },
      ],
    } satisfies CoreConfig;

    await handleClickClackInbound({
      account: createAgentAccount({ agentId: "service-bot" }),
      config: cfg,
      message: createMessage({
        channel_id: undefined,
        direct_conversation_id: "dcn_1",
      }),
    });

    const dispatchReply = vi.mocked(runtime.channel.inbound.dispatchReply);
    expect(dispatchReply.mock.calls[0]?.[0].routeSessionKey).toBe(
      "agent:service-bot:clickclack:direct:alice",
    );
    expect(runtime.channel.routing.buildAgentSessionKey).toHaveBeenCalledWith({
      agentId: "service-bot",
      mainKey: "work",
      channel: "clickclack",
      accountId: "default",
      peer: { kind: "direct", id: "dm:usr_owner" },
      dmScope: "per-channel-peer",
      identityLinks: { alice: ["clickclack:dm:usr_owner"] },
    });
  });

  it("preserves binding scope for a canonically equivalent account agent", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const cfg = {
      agents: { list: [{ id: "service-bot" }] },
      session: { dmScope: "main" },
      bindings: [
        {
          agentId: "service-bot",
          match: {
            channel: "clickclack",
            accountId: "default",
            peer: { kind: "direct", id: "dm:usr_owner" },
          },
          session: { dmScope: "per-account-channel-peer" },
        },
      ],
    } satisfies CoreConfig;

    await handleClickClackInbound({
      account: createAgentAccount({ agentId: "SERVICE-BOT" }),
      config: cfg,
      message: createMessage({
        channel_id: undefined,
        direct_conversation_id: "dcn_1",
      }),
    });

    const dispatchReply = vi.mocked(runtime.channel.inbound.dispatchReply);
    expect(dispatchReply.mock.calls[0]?.[0]).toMatchObject({
      agentId: "service-bot",
      routeSessionKey: "agent:service-bot:clickclack:default:direct:dm:usr_owner",
    });
  });

  it("does not dispatch agent turns from senders outside allowFrom", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.channel.commands.shouldComputeCommandAuthorized).mockReturnValue(true);
    setClickClackRuntime(runtime);
    const cfg = {
      agents: {
        defaults: {
          model: "openai/gpt-5.4-mini",
        },
      },
    } satisfies CoreConfig;

    await handleClickClackInbound({
      account: createAgentAccount({
        allowFrom: ["usr_owner"],
        config: { allowFrom: ["usr_owner"] },
      }),
      config: cfg,
      message: createMessage({
        author_id: "usr_attacker",
        author: {
          id: "usr_attacker",
          kind: "human",
          display_name: "Attacker",
          handle: "attacker",
          avatar_url: "",
          created_at: "2026-05-09T12:00:00.000Z",
        },
      }),
    });

    expect(runtime.channel.inbound.dispatchReply).not.toHaveBeenCalled();
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });
});
