import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { buildAgentSessionKey, resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { describe, expect, it, vi } from "vitest";
import { getClickClackDiscussionBindingStore } from "./discussions/binding-store.js";
import { handleClickClackInbound } from "./inbound.js";
import { setClickClackRuntime } from "./runtime.js";
import type { ClickClackMessage, CoreConfig, ResolvedClickClackAccount } from "./types.js";

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

describe("ClickClack inbound mention gating", () => {
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
            entries: {
              research: { groupChat: { mentionPatterns: ["@research"] } },
              "service-bot": { groupChat: { mentionPatterns: ["@service"] } },
            },
          },
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
