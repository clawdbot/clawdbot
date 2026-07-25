// Clickclack tests cover inbound plugin behavior.
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { buildAgentSessionKey, resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  recordPendingDiscussionOpen,
  reserveDiscussionBindingGeneration,
} from "./discussions/binding-generation.js";
import {
  getClickClackDiscussionBindingStore,
  type ClickClackDiscussionBinding,
} from "./discussions/binding-store.js";
import { markClickClackDiscussionChannelRevoked } from "./discussions/revoked-channel-store.js";
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
  const runtime = createPluginRuntimeMock({
    agent: {
      runEmbeddedAgent: vi.fn().mockResolvedValue({
        payloads: [{ text: "service bot online" }],
        meta: {},
      }),
      session: {
        getSessionEntry: vi.fn(() => ({ sessionId: "session-id", updatedAt: 1 })),
      },
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
  configureDiscussionStore(runtime);
  return runtime;
}

function configureDiscussionStore(runtime: PluginRuntime): void {
  const createStore = <T>(): PluginStateSyncKeyedStore<T> => {
    const values = new Map<string, { value: T; createdAt: number }>();
    return {
      register(key, value) {
        values.set(key, { value, createdAt: Date.now() });
      },
      registerIfAbsent(key, value) {
        if (values.has(key)) {
          return false;
        }
        values.set(key, { value, createdAt: Date.now() });
        return true;
      },
      lookup: (key) => values.get(key)?.value,
      consume(key) {
        const value = values.get(key)?.value;
        values.delete(key);
        return value;
      },
      delete: (key) => values.delete(key),
      entries: () =>
        Array.from(values, ([key, entry]) => ({
          key,
          value: entry.value,
          createdAt: entry.createdAt,
        })),
      clear: () => values.clear(),
    };
  };
  const stores = new Map<string, PluginStateSyncKeyedStore<unknown>>();
  runtime.state.openSyncKeyedStore = vi.fn((options: { namespace: string }) => {
    const existing = stores.get(options.namespace);
    if (existing) {
      return existing;
    }
    const created = createStore<unknown>();
    stores.set(options.namespace, created);
    return created;
  }) as unknown as PluginRuntime["state"]["openSyncKeyedStore"];
}

function createAgentAccount(
  overrides: Partial<ResolvedClickClackAccount> = {},
): ResolvedClickClackAccount {
  const base = {
    accountId: "default",
    enabled: true,
    configured: true,
    baseUrl: "http://127.0.0.1:8080",
    apiEndpoint: "http://127.0.0.1:8080",
    token: "test-token-placeholder",
    workspace: "wsp_1",
    replyMode: "agent",
    toolsAllow: [],
    defaultTo: "channel:general",
    allowFrom: ["*"],
    reconnectMs: 1_500,
    agentActivity: false,
    commandMenu: true,
    discussions: { enabled: false, workspace: "wsp_1", section: "Sessions" },
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
      apiEndpoint: "http://127.0.0.1:8080",
      token: "test-auth-token",
      workspace: "wsp_1",
      agentId: "service-bot",
      replyMode: "model",
      model: "openai/gpt-5.4-mini",
      toolsAllow: [],
      defaultTo: "channel:general",
      allowFrom: ["*"],
      reconnectMs: 1_500,
      agentActivity: false,
      commandMenu: true,
      discussions: { enabled: false, workspace: "wsp_1", section: "Sessions" },
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

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
    expect(runtime.agent.runEmbeddedAgent).not.toHaveBeenCalled();
    const completionRequest = (runtime.llm.complete as LlmCompleteMock).mock.calls[0]?.[0];
    expect(completionRequest?.agentId).toBe("service-bot");
    expect(completionRequest?.model).toBe("openai/gpt-5.4-mini");
    expect(completionRequest).not.toHaveProperty("maxTokens");
    expect(completionRequest?.purpose).toBe("clickclack bot reply");
    expect(completionRequest?.messages).toEqual([{ role: "user", content: "hello bot" }]);

    const sendRequest = sendClickClackTextMock.mock.calls[0]?.[0];
    expect(sendRequest?.accountId).toBe("service");
    expect(sendRequest?.to).toBe("channel:chn_1");
    expect(sendRequest?.text).toBe("service bot online");
    expect(sendRequest?.replyToId).toBe("msg_1");
    expect(sendRequest?.correlationId).toBe("fakeco.case_1");
  });

  it("uses the selected runtime model budget", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const account = createAgentAccount({
      accountId: "service",
      agentId: "service-bot",
      replyMode: "model",
    });

    await handleClickClackInbound({
      account,
      config: {} satisfies CoreConfig,
      message: createMessage({
        body: "hello without a clickclack cap",
        author_id: "usr_human",
      }),
    });

    const completionRequest = (runtime.llm.complete as LlmCompleteMock).mock.calls[0]?.[0];
    expect(completionRequest).not.toHaveProperty("maxTokens");
    expect(sendClickClackTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "service", text: "service bot online" }),
    );
  });

  it("logs and skips delivery when model mode produces no sendable text", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.llm.complete).mockResolvedValue({
      text: "   ",
      provider: "openai",
      model: "gpt-5.4-mini",
      agentId: "service-bot",
      usage: {},
      audit: { caller: { kind: "plugin", id: "clickclack" } },
    });
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount({
        accountId: "service",
        agentId: "service-bot",
        replyMode: "model",
      }),
      config: {} satisfies CoreConfig,
      message: createMessage({ body: "hello bot" }),
    });

    expect(sendClickClackTextMock).not.toHaveBeenCalled();
    expect(runtime.logging.getChildLogger).toHaveBeenCalledWith({
      plugin: "clickclack",
      feature: "model-reply",
    });
    const logger = vi.mocked(runtime.logging.getChildLogger).mock.results[0]?.value;
    expect(logger?.warn).toHaveBeenCalledWith(
      "[service] ClickClack model reply produced no sendable text",
    );
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

    const dispatchTurn = vi.mocked(runtime.channel.inbound.dispatch);
    expect(dispatchTurn).toHaveBeenCalledTimes(1);
    expect(dispatchTurn.mock.calls[0]?.[0].ctxPayload.CommandAuthorized).toBe(true);
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

    const dispatchTurn = vi.mocked(runtime.channel.inbound.dispatch);
    expect(dispatchTurn).toHaveBeenCalledTimes(1);
    const dispatchParams = dispatchTurn.mock.calls[0]?.[0] as
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

    const dispatchTurn = vi.mocked(runtime.channel.inbound.dispatch);
    expect(dispatchTurn).toHaveBeenCalledTimes(2);
    const withoutOptIn = dispatchTurn.mock.calls[0]?.[0] as {
      replyOptions?: { runId?: unknown; onItemEvent?: unknown; onModelSelected?: unknown };
    };
    const withOptIn = dispatchTurn.mock.calls[1]?.[0] as {
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

    const dispatchParams = vi.mocked(runtime.channel.inbound.dispatch).mock.calls[0]?.[0];
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

  it("routes media replies through required durable delivery", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount(),
      config: {} as CoreConfig,
      message: createMessage({
        id: VALID_MESSAGE_ID,
        thread_root_id: VALID_MESSAGE_ID,
      }),
    });

    const delivery = vi.mocked(runtime.channel.inbound.dispatch).mock.calls[0]?.[0].delivery;
    if (typeof delivery?.durable !== "function") {
      throw new Error("expected ClickClack media durable delivery resolver");
    }
    const payload = { text: "artifact", mediaUrl: "/workspace/artifact.txt" };
    expect(delivery.durable(payload, { kind: "final" } as never)).toEqual({
      to: "channel:chn_1",
      threadId: undefined,
      replyToId: VALID_MESSAGE_ID,
      requiredCapabilities: {
        text: true,
        media: true,
        replyTo: true,
        messageSendingHooks: true,
        reconcileUnknownSend: true,
      },
    });
    await expect(delivery?.deliver(payload, { kind: "final" } as never)).rejects.toThrow(
      "ClickClack media reply requires durable delivery",
    );
    expect(sendClickClackTextMock).not.toHaveBeenCalled();
  });

  it("does not derive a run id from a noncanonical message id", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount(),
      config: {} as CoreConfig,
      message: createMessage({ id: "msg_invalid" }),
    });

    expect(vi.mocked(runtime.channel.inbound.dispatch).mock.calls[0]?.[0].replyOptions).toBe(
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
        channel_id: "",
        direct_conversation_id: "dcn_1",
      }),
    });

    const dispatchTurn = vi.mocked(runtime.channel.inbound.dispatch);
    expect(dispatchTurn).toHaveBeenCalledTimes(1);
    expect(dispatchTurn.mock.calls[0]?.[0].ctxPayload.ChatType).toBe("direct");
    expect(dispatchTurn.mock.calls[0]?.[0].ctxPayload.CommandAuthorized).toBe(true);
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

    const dispatchTurn = vi.mocked(runtime.channel.inbound.dispatch);
    expect(dispatchTurn.mock.calls[0]?.[0].route.sessionKey).toBe(
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

  it("routes a bound channel to a stable same-agent discussion session with observer context", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const mainSessionKey = "agent:research:main";
    getClickClackDiscussionBindingStore(runtime).set(mainSessionKey, {
      accountId: "default",
      agentId: "research",
      sessionId: "session-id",
      serverBaseUrl: "http://127.0.0.1:8080",
      externalRef: "openclaw:test:research",
      externalUrl: "",
      workspaceRef: "wsp_1",
      workspaceId: "wsp_1",
      channelId: "chn_1",
      channelRouteId: "discussion-route",
      workspaceRouteId: "workspace-route",
      section: "Sessions",
      archived: false,
      label: "Research",
    });

    await handleClickClackInbound({
      account: createAgentAccount({
        replyMode: "model",
        agentId: "service-bot",
        discussions: { enabled: true, workspace: "wsp_1", section: "Sessions" },
      }),
      config: {
        channels: {
          clickclack: {
            enabled: true,
            baseUrl: "http://127.0.0.1:8080",
            token: "test-token-placeholder",
            workspace: "wsp_1",
            discussions: { enabled: true, workspace: "wsp_1" },
          },
        },
      } satisfies CoreConfig,
      message: createMessage({ channel_id: "chn_1", body: "What changed?" }),
    });

    const buildSessionKeyMock = vi.mocked(runtime.channel.routing.buildAgentSessionKey);
    const discussionCallIndex = buildSessionKeyMock.mock.calls.findIndex(
      ([call]) =>
        call.agentId === "research" &&
        call.peer != null &&
        call.peer.kind === "channel" &&
        call.peer.id.startsWith("disc-"),
    );
    expect(discussionCallIndex).toBeGreaterThanOrEqual(0);
    const discussionSessionKey = buildSessionKeyMock.mock.results[discussionCallIndex]?.value;
    expect(discussionSessionKey).toMatch(/^agent:research:clickclack:channel:disc-[0-9a-f]{32}$/u);
    expect(runtime.llm.complete).not.toHaveBeenCalled();
    expect(runtime.channel.routing.buildAgentSessionKey).toHaveBeenCalledWith({
      agentId: "research",
      channel: "clickclack",
      accountId: "default",
      peer: { kind: "channel", id: expect.stringMatching(/^disc-[0-9a-f]{32}$/u) },
    });
    const dispatch = vi.mocked(runtime.channel.inbound.dispatch);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        route: expect.objectContaining({
          agentId: "research",
          sessionKey: discussionSessionKey,
        }),
        ctxPayload: expect.objectContaining({
          SessionKey: discussionSessionKey,
          GroupSystemPrompt: expect.stringContaining(mainSessionKey),
        }),
      }),
    );
    expect(dispatch.mock.calls[0]?.[0].ctxPayload.GroupSystemPrompt).toContain("sessions_history");
    expect(dispatch.mock.calls[0]?.[0].ctxPayload.GroupSystemPrompt).toContain("sessions_send");
  });

  it("drops an old bound channel after the main session is replaced", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const mainSessionKey = "agent:research:main";
    getClickClackDiscussionBindingStore(runtime).set(mainSessionKey, {
      accountId: "default",
      agentId: "research",
      sessionId: "old-session-id",
      serverBaseUrl: "http://127.0.0.1:8080",
      externalRef: "openclaw:test:research",
      externalUrl: "",
      workspaceRef: "wsp_1",
      workspaceId: "wsp_1",
      channelId: "chn_1",
      channelRouteId: "discussion-route",
      workspaceRouteId: "workspace-route",
      section: "Sessions",
      archived: false,
      label: "Research",
    });

    await handleClickClackInbound({
      account: createAgentAccount({
        replyMode: "model",
        discussions: { enabled: true, workspace: "wsp_1", section: "Sessions" },
      }),
      config: {
        channels: {
          clickclack: {
            enabled: true,
            baseUrl: "http://127.0.0.1:8080",
            token: "test-token-placeholder",
            workspace: "wsp_1",
            discussions: { enabled: true, workspace: "wsp_1" },
          },
        },
      } satisfies CoreConfig,
      message: createMessage({ channel_id: "chn_1", body: "Old discussion" }),
    });

    expect(runtime.llm.complete).not.toHaveBeenCalled();
    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("drops inbound delivery for an archived managed discussion", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    getClickClackDiscussionBindingStore(runtime).set("agent:research:main", {
      accountId: "default",
      agentId: "research",
      sessionId: "session-id",
      serverBaseUrl: "http://127.0.0.1:8080",
      externalRef: "openclaw:test:research",
      externalUrl: "",
      workspaceRef: "wsp_1",
      workspaceId: "wsp_1",
      channelId: "chn_1",
      channelRouteId: "discussion-route",
      workspaceRouteId: "workspace-route",
      section: "Sessions",
      archived: true,
      label: "Research",
    });

    await handleClickClackInbound({
      account: createAgentAccount({
        replyMode: "model",
        discussions: { enabled: true, workspace: "wsp_1", section: "Sessions" },
      }),
      config: {
        channels: {
          clickclack: {
            enabled: true,
            baseUrl: "http://127.0.0.1:8080",
            token: "test-token-placeholder",
            workspace: "wsp_1",
            discussions: { enabled: true, workspace: "wsp_1" },
          },
        },
      } satisfies CoreConfig,
      message: createMessage({ channel_id: "chn_1", body: "Archived discussion" }),
    });

    expect(runtime.llm.complete).not.toHaveBeenCalled();
    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("drops inbound delivery as soon as the main session is archived", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    vi.mocked(runtime.agent.session.getSessionEntry).mockReturnValue({
      sessionId: "session-id",
      updatedAt: 2,
      archivedAt: 1,
    });
    getClickClackDiscussionBindingStore(runtime).set("agent:research:main", {
      accountId: "default",
      agentId: "research",
      sessionId: "session-id",
      serverBaseUrl: "http://127.0.0.1:8080",
      externalRef: "openclaw:test:research",
      externalUrl: "",
      workspaceRef: "wsp_1",
      workspaceId: "wsp_1",
      channelId: "chn_1",
      channelRouteId: "discussion-route",
      workspaceRouteId: "workspace-route",
      section: "Sessions",
      archived: false,
      label: "Research",
    });

    await handleClickClackInbound({
      account: createAgentAccount({
        replyMode: "model",
        discussions: { enabled: true, workspace: "wsp_1", section: "Sessions" },
      }),
      config: {
        channels: {
          clickclack: {
            enabled: true,
            baseUrl: "http://127.0.0.1:8080",
            token: "test-token-placeholder",
            workspace: "wsp_1",
            discussions: { enabled: true, workspace: "wsp_1" },
          },
        },
      } satisfies CoreConfig,
      message: createMessage({ channel_id: "chn_1", body: "Archived before sync" }),
    });

    expect(runtime.llm.complete).not.toHaveBeenCalled();
    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("drops a persisted managed channel after discussions are disabled", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    getClickClackDiscussionBindingStore(runtime).set("agent:research:main", {
      accountId: "default",
      agentId: "research",
      sessionId: "session-id",
      serverBaseUrl: "http://127.0.0.1:8080",
      externalRef: "openclaw:test:research",
      externalUrl: "",
      workspaceRef: "wsp_1",
      workspaceId: "wsp_1",
      channelId: "chn_1",
      channelRouteId: "discussion-route",
      workspaceRouteId: "workspace-route",
      section: "Sessions",
      archived: false,
      label: "Research",
    });

    await handleClickClackInbound({
      account: createAgentAccount({ replyMode: "model" }),
      config: {} satisfies CoreConfig,
      message: createMessage({ channel_id: "chn_1", body: "Use the normal route" }),
    });

    expect(runtime.llm.complete).not.toHaveBeenCalled();
    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("drops delayed inbound after the live binding has been released", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const mainSessionKey = "agent:research:released";
    const binding: ClickClackDiscussionBinding = {
      accountId: "default",
      agentId: "research",
      sessionId: "session-id",
      serverBaseUrl: "http://127.0.0.1:8080",
      externalRef: "openclaw:test:released",
      externalUrl: "",
      workspaceRef: "wsp_1",
      workspaceId: "wsp_1",
      channelId: "chn_1",
      channelRouteId: "discussion-route",
      workspaceRouteId: "workspace-route",
      section: "Sessions",
      archived: false,
      label: "Released",
    };
    const bindingStore = getClickClackDiscussionBindingStore(runtime);
    bindingStore.set(mainSessionKey, binding);
    markClickClackDiscussionChannelRevoked(runtime, binding);
    bindingStore.delete(mainSessionKey);

    await handleClickClackInbound({
      account: createAgentAccount({ replyMode: "model" }),
      config: {} satisfies CoreConfig,
      message: createMessage({ channel_id: "chn_1", body: "Delayed managed event" }),
    });

    expect(runtime.llm.complete).not.toHaveBeenCalled();
    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("does not lose managed ownership when the local account id changes", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    getClickClackDiscussionBindingStore(runtime).set("agent:research:main", {
      accountId: "default",
      agentId: "research",
      sessionId: "session-id",
      serverBaseUrl: "http://127.0.0.1:8080",
      externalRef: "openclaw:test:renamed-account",
      externalUrl: "",
      workspaceRef: "wsp_1",
      workspaceId: "wsp_1",
      channelId: "chn_1",
      channelRouteId: "discussion-route",
      workspaceRouteId: "workspace-route",
      section: "Sessions",
      archived: false,
      label: "Renamed account",
    });

    await handleClickClackInbound({
      account: createAgentAccount({ accountId: "replacement", replyMode: "model" }),
      config: {} satisfies CoreConfig,
      message: createMessage({ channel_id: "chn_1", body: "Old managed channel" }),
    });

    expect(runtime.llm.complete).not.toHaveBeenCalled();
    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("quarantines unbound channel events while a create outcome is ambiguous", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const sessionKey = "agent:research:pending";
    const generation = reserveDiscussionBindingGeneration({
      runtime,
      sessionKey,
      destinationIdentity: "http://127.0.0.1:8080\0wsp_1",
      createGeneration: () => "pending-generation",
    });
    recordPendingDiscussionOpen({
      runtime,
      sessionKey,
      generation,
      pending: {
        accountId: "default",
        serverBaseUrl: "http://127.0.0.1:8080",
        workspaceId: "wsp_1",
        sessionId: "session-id",
        externalRef: "openclaw:test:pending",
        credentialFingerprint: "test-fingerprint",
      },
    });

    await handleClickClackInbound({
      account: createAgentAccount({ replyMode: "model" }),
      config: {} satisfies CoreConfig,
      message: createMessage({ channel_id: "chn_unknown", body: "Maybe managed" }),
    });

    expect(runtime.llm.complete).not.toHaveBeenCalled();
    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("drops a managed channel after the discussion workspace changes", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    getClickClackDiscussionBindingStore(runtime).set("agent:research:main", {
      accountId: "default",
      agentId: "research",
      sessionId: "session-id",
      serverBaseUrl: "http://127.0.0.1:8080",
      externalRef: "openclaw:test:research",
      externalUrl: "",
      workspaceRef: "wsp_1",
      workspaceId: "wsp_1",
      channelId: "chn_1",
      channelRouteId: "discussion-route",
      workspaceRouteId: "workspace-route",
      section: "Sessions",
      archived: false,
      label: "Research",
    });
    const account = createAgentAccount({
      replyMode: "model",
      discussions: { enabled: true, workspace: "wsp_2", section: "Sessions" },
    });

    await handleClickClackInbound({
      account,
      config: {
        channels: {
          clickclack: {
            enabled: true,
            baseUrl: account.baseUrl,
            token: account.token,
            workspace: "wsp_2",
            replyMode: "model",
            discussions: { enabled: true, workspace: "wsp_2" },
          },
        },
      } satisfies CoreConfig,
      message: createMessage({ channel_id: "chn_1", body: "Use the normal route" }),
    });

    expect(runtime.llm.complete).not.toHaveBeenCalled();
    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
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

    const dispatchTurn = vi.mocked(runtime.channel.inbound.dispatch);
    expect(dispatchTurn.mock.calls[0]?.[0]).toMatchObject({
      route: {
        agentId: "service-bot",
        sessionKey: "agent:service-bot:clickclack:default:direct:dm:usr_owner",
      },
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

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
    expect(runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher).not.toHaveBeenCalled();
  });
});
