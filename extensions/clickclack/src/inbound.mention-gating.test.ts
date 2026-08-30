import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { buildAgentSessionKey, resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { describe, expect, it, vi } from "vitest";
import { resolveClickClackInboundAccess } from "./access.js";
import {
  getClickClackDiscussionBindingStore,
  type ClickClackDiscussionBinding,
} from "./discussions/binding-store.js";
import { handleClickClackInbound } from "./inbound.js";
import { setClickClackRuntime } from "./runtime.js";
import type {
  ClickClackMessage,
  ClickClackUser,
  CoreConfig,
  ResolvedClickClackAccount,
} from "./types.js";

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
    botUserId: "usr_receiver",
    botHandle: "blackbird",
    allowBots: false,
    reconnectMs: 1_500,
    agentActivity: false,
    commandMenu: true,
    discussions: { enabled: false, workspace: "wsp_1", section: "Sessions" },
    requireMention: false,
    mentionPatterns: [],
    groups: {},
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

function createAuthor(overrides: Partial<ClickClackUser> = {}): ClickClackUser {
  return {
    id: "usr_owner",
    kind: "human",
    display_name: "Peter",
    handle: "steipete",
    avatar_url: "",
    created_at: "2026-05-09T12:00:00.000Z",
    ...overrides,
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
    author: createAuthor(),
    ...overrides,
  };
}

describe("ClickClack inbound mention gating", () => {
  it("records attachment persistence failures before dropping inbound delivery", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const mainSessionKey = "agent:research:main";
    const bindingStore = getClickClackDiscussionBindingStore(runtime);
    bindingStore.set(mainSessionKey, {
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
    const persisted = runtime.state.openSyncKeyedStore<ClickClackDiscussionBinding>({
      namespace: "discussion-bindings",
      maxEntries: 10_000,
      overflowPolicy: "reject-new",
    });
    persisted.register = vi.fn(() => {
      throw new Error("SQLITE_FULL");
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

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
    expect(bindingStore.get(mainSessionKey)).toMatchObject({ sessionId: "old-session-id" });
    expect(runtime.logging.getChildLogger).toHaveBeenCalledWith({
      plugin: "clickclack",
      feature: "discussions",
    });
    const loggerCall = vi
      .mocked(runtime.logging.getChildLogger)
      .mock.calls.findIndex(
        ([context]) => context?.plugin === "clickclack" && context.feature === "discussions",
      );
    const logger = vi.mocked(runtime.logging.getChildLogger).mock.results[loggerCall]?.value;
    expect(logger?.warn).toHaveBeenCalledWith(
      "discussion attachment refresh failed for channel chn_1: Error: SQLITE_FULL",
    );
  });

  it("ignores bot-authored messages by default", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount({ allowFrom: ["usr_sender"] }),
      config: {} satisfies CoreConfig,
      message: createMessage({
        author_id: "usr_sender",
        author: createAuthor({ id: "usr_sender", kind: "bot", handle: "sender" }),
      }),
    });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("preserves legacy inbound delivery when the message omits author kind", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount({ allowFrom: ["*"] }),
      config: {} satisfies CoreConfig,
      message: createMessage({
        author: undefined,
      }),
    });

    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(1);
  });

  it.each(["agent_commentary", "agent_tool"] as const)(
    "does not dispatch ClickClack %s activity rows as bot prompts",
    async (kind) => {
      const runtime = createRuntime();
      setClickClackRuntime(runtime);

      await handleClickClackInbound({
        account: createAgentAccount({ allowFrom: ["usr_sender"], allowBots: true }),
        config: {} satisfies CoreConfig,
        message: createMessage({
          author_id: "usr_sender",
          kind,
          author: createAuthor({ id: "usr_sender", kind: "bot", handle: "sender" }),
        }),
      });

      expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
      expect(runtime.llm.complete).not.toHaveBeenCalled();
    },
  );

  it("dispatches an allowed bot-authored message through the shared loop guard", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount({ allowFrom: ["usr_sender"], allowBots: true }),
      config: {
        channels: { defaults: { botLoopProtection: { maxEventsPerWindow: 7 } } },
      } satisfies CoreConfig,
      message: createMessage({
        author_id: "usr_sender",
        author: createAuthor({ id: "usr_sender", kind: "bot", handle: "sender" }),
      }),
    });

    const dispatch = vi.mocked(runtime.channel.inbound.dispatch);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0].botLoopProtection).toMatchObject({
      scopeId: "wsp_1",
      conversationId: "chn_1",
      senderId: "usr_sender",
      receiverId: "usr_receiver",
      eventId: "msg_1",
      defaultsConfig: { maxEventsPerWindow: 7 },
      defaultEnabled: true,
    });
  });

  it("isolates bot loop budgets by ClickClack thread root", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const account = createAgentAccount({ allowFrom: ["usr_sender"], allowBots: true });
    const author = createAuthor({ id: "usr_sender", kind: "bot", handle: "sender" });

    const threadA = await resolveClickClackInboundAccess({
      account,
      config: {} satisfies CoreConfig,
      message: createMessage({
        id: "msg_thread_a_reply",
        author_id: "usr_sender",
        parent_message_id: "msg_thread_a",
        thread_root_id: "msg_thread_a",
        author,
      }),
    });
    const threadB = await resolveClickClackInboundAccess({
      account,
      config: {} satisfies CoreConfig,
      message: createMessage({
        id: "msg_thread_b_reply",
        author_id: "usr_sender",
        parent_message_id: "msg_thread_b",
        thread_root_id: "msg_thread_b",
        author,
      }),
    });

    expect(threadA.botLoopProtection?.conversationId).toBe("msg_thread_a");
    expect(threadB.botLoopProtection?.conversationId).toBe("msg_thread_b");
  });

  it("does not let bot opt-in bypass the wildcard human allowFrom default", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount({ allowFrom: ["*"], allowBots: true }),
      config: {} satisfies CoreConfig,
      message: createMessage({
        author_id: "usr_sender",
        author: createAuthor({ id: "usr_sender", kind: "bot", handle: "sender" }),
      }),
    });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("shares bot-loop scope across accounts and preserves ClickClack event time", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);
    const firstMessage = createMessage({
      author_id: "usr_sender",
      author: createAuthor({ id: "usr_sender", kind: "bot", handle: "sender" }),
      created_at: "2026-05-09T12:00:00.000Z",
    });

    const accountA = await resolveClickClackInboundAccess({
      account: createAgentAccount({
        accountId: "account-a",
        allowFrom: ["usr_sender"],
        allowBots: true,
      }),
      config: {} satisfies CoreConfig,
      message: firstMessage,
    });
    const accountB = await resolveClickClackInboundAccess({
      account: createAgentAccount({
        accountId: "account-b",
        allowFrom: ["usr_sender"],
        allowBots: true,
      }),
      config: {} satisfies CoreConfig,
      message: firstMessage,
    });
    const delayedReplay = await resolveClickClackInboundAccess({
      account: createAgentAccount({
        accountId: "account-a",
        allowFrom: ["usr_sender"],
        allowBots: true,
      }),
      config: {} satisfies CoreConfig,
      message: { ...firstMessage, created_at: "2026-05-09T12:02:00.000Z" },
    });

    expect(accountA.botLoopProtection).toMatchObject({
      scopeId: "wsp_1",
      nowMs: Date.parse("2026-05-09T12:00:00.000Z"),
    });
    expect(accountB.botLoopProtection?.scopeId).toBe(accountA.botLoopProtection?.scopeId);
    expect(delayedReplay.botLoopProtection?.nowMs).toBe(Date.parse("2026-05-09T12:02:00.000Z"));
  });

  it("requires a mention for bot-authored group messages in mention mode", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount({ allowFrom: ["usr_sender"], allowBots: "mentions" }),
      config: {} satisfies CoreConfig,
      message: createMessage({
        author_id: "usr_sender",
        body: "hello from another agent",
        author: createAuthor({ id: "usr_sender", kind: "bot", handle: "sender" }),
      }),
    });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("allows mentioned bot-authored group messages in mention mode", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount({ allowFrom: ["usr_sender"], allowBots: "mentions" }),
      config: {} satisfies CoreConfig,
      message: createMessage({
        author_id: "usr_sender",
        body: "@blackbird please coordinate",
        author: createAuthor({ id: "usr_sender", kind: "bot", handle: "sender" }),
      }),
    });

    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(1);
  });

  it("allows bot-authored direct messages in mention mode without a mention", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount({ allowFrom: ["usr_sender"], allowBots: "mentions" }),
      config: {} satisfies CoreConfig,
      message: createMessage({
        author_id: "usr_sender",
        channel_id: undefined,
        direct_conversation_id: "dm_1",
        body: "hello directly",
        author: createAuthor({ id: "usr_sender", kind: "bot", handle: "sender" }),
      }),
    });

    expect(runtime.channel.inbound.dispatch).toHaveBeenCalledTimes(1);
  });

  it("does not let wildcard group bot policy authorize direct messages", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount({
        allowFrom: ["usr_sender"],
        allowBots: false,
        groups: { "*": { allowBots: "mentions" } },
      }),
      config: {} satisfies CoreConfig,
      message: createMessage({
        author_id: "usr_sender",
        channel_id: undefined,
        direct_conversation_id: "dm_1",
        body: "hello directly",
        author: createAuthor({ id: "usr_sender", kind: "bot", handle: "sender" }),
      }),
    });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
  });

  it("rejects an unmentioned group message when mention gating is enabled", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount({
        requireMention: true,
        botHandle: "blackbird",
      }),
      config: {} satisfies CoreConfig,
      message: createMessage({ body: "hello everyone" }),
    });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
    expect(runtime.agent.runEmbeddedAgent).not.toHaveBeenCalled();
    expect(runtime.llm.complete).not.toHaveBeenCalled();
  });

  it("dispatches a group message when its ClickClack bot handle is mentioned", async () => {
    const runtime = createRuntime();
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount({
        requireMention: true,
        botHandle: "blackbird",
      }),
      config: {} satisfies CoreConfig,
      message: createMessage({ body: "@blackbird please help" }),
    });

    const dispatchTurn = vi.mocked(runtime.channel.inbound.dispatch);
    expect(dispatchTurn).toHaveBeenCalledTimes(1);
    expect(dispatchTurn.mock.calls[0]?.[0].ctxPayload.WasMentioned).toBe(true);
  });

  it("does not bypass mention gating for a command mentioning another user", async () => {
    const runtime = createRuntime();
    vi.mocked(runtime.channel.commands.shouldComputeCommandAuthorized).mockReturnValue(true);
    vi.mocked(runtime.channel.commands.shouldHandleTextCommands).mockReturnValue(true);
    vi.mocked(runtime.channel.text.hasControlCommand).mockReturnValue(true);
    setClickClackRuntime(runtime);

    await handleClickClackInbound({
      account: createAgentAccount({
        requireMention: true,
        botHandle: "blackbird",
      }),
      config: {} satisfies CoreConfig,
      message: createMessage({ body: "/status @alice" }),
    });

    expect(runtime.channel.inbound.dispatch).not.toHaveBeenCalled();
    expect(runtime.agent.runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it.each([
    { body: "@research investigate this", shouldDispatch: true },
    { body: "@service investigate this", shouldDispatch: false },
  ])(
    "evaluates $body against the managed discussion agent before dispatch",
    async ({ body, shouldDispatch }) => {
      const runtime = createRuntime();
      setClickClackRuntime(runtime);
      getClickClackDiscussionBindingStore(runtime).set("agent:research:main", {
        accountId: "default",
        agentId: "research",
        sessionId: "session-id",
        serverBaseUrl: "http://127.0.0.1:8080",
        externalRef: "openclaw:test:research-mentions",
        externalUrl: "",
        workspaceRef: "wsp_1",
        workspaceId: "wsp_1",
        channelId: "chn_1",
        channelRouteId: "discussion-route",
        workspaceRouteId: "workspace-route",
        section: "Sessions",
        archived: false,
        label: "Research mentions",
      });

      await handleClickClackInbound({
        account: createAgentAccount({
          agentId: "service-bot",
          requireMention: true,
          discussions: { enabled: true, workspace: "wsp_1", section: "Sessions" },
        }),
        config: {
          agents: {
            ownership: "explicit",
            entries: {
              research: { groupChat: { mentionPatterns: ["@research"] } },
              "service-bot": { groupChat: { mentionPatterns: ["@service"] } },
            },
          },
          bindings: [
            {
              agentId: "service-bot",
              match: { channel: "clickclack", accountId: "default" },
            },
          ],
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
        message: createMessage({ body }),
      });

      const dispatch = vi.mocked(runtime.channel.inbound.dispatch);
      expect(dispatch).toHaveBeenCalledTimes(shouldDispatch ? 1 : 0);
      if (shouldDispatch) {
        expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
          route: { agentId: "research" },
          ctxPayload: { WasMentioned: true },
        });
      }
    },
  );
});
