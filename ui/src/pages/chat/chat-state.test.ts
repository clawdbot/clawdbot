import type { ReactiveController, ReactiveControllerHost } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SLASH_COMMANDS } from "../../lib/chat/commands.ts";
import {
  applyRemoteSlashCommandsResult,
  resetChatSlashCommandMetadataForTest,
} from "./chat-commands.ts";
import {
  ChatStateController,
  handleChatManualRefresh,
  refreshChatMetadata,
  resolveChatAvatarUrl,
  type ChatPageHost,
} from "./chat-state.ts";
import { scheduleControlUiAfterPaint } from "./performance.ts";
import type { RenderLifecycle } from "./render-lifecycle.ts";

vi.mock("../../app/assistant-identity.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../app/assistant-identity.ts")>()),
  loadLocalAssistantIdentity: () => ({ avatar: "data:image/png;base64,bG9jYWw=" }),
}));

afterEach(() => {
  resetChatSlashCommandMetadataForTest();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ChatStateController render lifecycle", () => {
  it("requests a render before selecting the commit promise", async () => {
    let resolveCommit: (value: boolean) => void = () => {};
    const nextCommit = new Promise<boolean>((resolve) => {
      resolveCommit = resolve;
    });
    let completion = Promise.resolve(true);
    const controllers: ReactiveController[] = [];
    const requestUpdate = vi.fn(() => {
      completion = nextCommit;
    });
    const host = {
      addController: (controller: ReactiveController) => controllers.push(controller),
      removeController: () => undefined,
      requestUpdate,
      get updateComplete() {
        return completion;
      },
    } satisfies ReactiveControllerHost;
    const controller = new ChatStateController<ChatPageHost>(host);
    controller.hostConnected();
    const renderLifecycle = controller.createRenderLifecycle();
    const effect = vi.fn();

    renderLifecycle.afterCommit(effect);
    await Promise.resolve();

    expect(requestUpdate).toHaveBeenCalledOnce();
    expect(effect).not.toHaveBeenCalled();
    resolveCommit(true);
    await nextCommit;
    expect(effect).toHaveBeenCalledOnce();
    expect(controllers).toContain(controller);
  });

  it("cancels pending commit effects on disconnect", async () => {
    let resolveCommit: (value: boolean) => void = () => {};
    const completion = new Promise<boolean>((resolve) => {
      resolveCommit = resolve;
    });
    const host = {
      addController: () => undefined,
      removeController: () => undefined,
      requestUpdate: () => undefined,
      updateComplete: completion,
    } satisfies ReactiveControllerHost;
    const controller = new ChatStateController<ChatPageHost>(host);
    controller.hostConnected();
    const renderLifecycle = controller.createRenderLifecycle();
    const effect = vi.fn();

    renderLifecycle.afterCommit(effect);
    controller.hostDisconnected();
    resolveCommit(true);
    await completion;

    expect(effect).not.toHaveBeenCalled();
  });

  it("rejects lifecycle work from detached and replaced state epochs", async () => {
    const requestUpdate = vi.fn();
    const host = {
      addController: () => undefined,
      removeController: () => undefined,
      requestUpdate,
      updateComplete: Promise.resolve(true),
    } satisfies ReactiveControllerHost;
    const controller = new ChatStateController<ChatPageHost>(host);
    controller.hostConnected();
    const first = controller.createRenderLifecycle();
    const replacement = controller.createRenderLifecycle();
    const staleEffect = vi.fn();
    const staleCancel = vi.fn();

    first.invalidate();
    first.afterCommit(staleEffect, staleCancel);

    expect(requestUpdate).not.toHaveBeenCalled();
    expect(staleEffect).not.toHaveBeenCalled();
    expect(staleCancel).toHaveBeenCalledOnce();

    controller.hostDisconnected();
    replacement.invalidate();
    replacement.afterCommit(staleEffect, staleCancel);

    expect(requestUpdate).not.toHaveBeenCalled();
    expect(staleEffect).not.toHaveBeenCalled();
    expect(staleCancel).toHaveBeenCalledTimes(2);

    controller.hostConnected();
    const current = controller.createRenderLifecycle();
    const currentEffect = vi.fn();
    current.afterCommit(currentEffect);
    await Promise.resolve();

    expect(requestUpdate).toHaveBeenCalledOnce();
    expect(currentEffect).toHaveBeenCalledOnce();
  });

  it("cancels post-commit paint frames on disconnect", async () => {
    let nextFrame = 1;
    const frames = new Map<number, FrameRequestCallback>();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    });
    const cancelAnimationFrame = vi
      .spyOn(window, "cancelAnimationFrame")
      .mockImplementation((id) => {
        frames.delete(id);
      });
    const host = {
      addController: () => undefined,
      removeController: () => undefined,
      requestUpdate: vi.fn(),
      updateComplete: Promise.resolve(true),
    } satisfies ReactiveControllerHost;
    const controller = new ChatStateController<ChatPageHost>(host);
    controller.hostConnected();
    const renderLifecycle = controller.createRenderLifecycle();
    const painted = vi.fn();

    scheduleControlUiAfterPaint({ renderLifecycle }, painted);
    await Promise.resolve();

    const firstFrame = frames.get(1);
    expect(firstFrame).toBeDefined();
    frames.delete(1);
    firstFrame?.(0);
    const secondFrame = frames.get(2);
    expect(secondFrame).toBeDefined();

    controller.hostDisconnected();
    secondFrame?.(0);

    expect(cancelAnimationFrame).toHaveBeenCalledWith(2);
    expect(painted).not.toHaveBeenCalled();
  });

  it("resolves a canceled commit wait without starting manual refresh RPCs", async () => {
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
    let cancelCommit = () => {};
    const invalidate = vi.fn();
    const renderLifecycle: RenderLifecycle = {
      invalidate,
      afterCommit: (_effect, onCancel) => {
        cancelCommit = () => onCancel?.();
        return cancelCommit;
      },
    };
    const resetToolStream = vi.fn();
    const scrollToBottom = vi.fn();
    const state = {
      chatManualRefreshFrame: 40,
      chatManualRefreshGeneration: 0,
      chatManualRefreshInFlight: false,
      chatNewMessagesBelow: true,
      renderLifecycle,
      resetToolStream,
      scrollToBottom,
    } as unknown as ChatPageHost;

    const refresh = handleChatManualRefresh(state);
    cancelCommit();
    await refresh;

    expect(state.chatManualRefreshInFlight).toBe(false);
    expect(cancelAnimationFrame).toHaveBeenCalledWith(40);
    expect(resetToolStream).not.toHaveBeenCalled();
    expect(scrollToBottom).not.toHaveBeenCalled();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("cancels pending manual refresh frames when state is replaced or disconnected", () => {
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", cancelAnimationFrame);
    const host = {
      addController: () => undefined,
      removeController: () => undefined,
      requestUpdate: () => undefined,
      updateComplete: Promise.resolve(true),
    } satisfies ReactiveControllerHost;
    const controller = new ChatStateController<ChatPageHost>(host);
    controller.hostConnected();
    const createState = (frame: number, renderLifecycle: RenderLifecycle) =>
      ({
        chatLoading: false,
        chatMessages: [],
        chatToolMessages: [],
        chatStream: null,
        realtimeTalkConversation: [],
        handleSendChat: async () => undefined,
        handleChatDraftChange: () => undefined,
        handleChatInputHistoryKey: () => ({ handled: false }),
        chatManualRefreshFrame: frame,
        chatManualRefreshGeneration: 1,
        chatManualRefreshInFlight: true,
        renderLifecycle,
        chatScrollCommitCleanup: null,
        chatScrollFrame: null,
        chatScrollGuardFrame: null,
        chatScrollTimeout: null,
        chatScrollGeneration: 0,
        chatIsProgrammaticScroll: false,
        sessionWorkspaceState: undefined,
        realtimeTalkSession: null,
        resetToolStream: vi.fn(),
      }) as unknown as ChatPageHost;
    const first = createState(41, controller.createRenderLifecycle());

    controller.attach(first);
    const second = createState(42, controller.createRenderLifecycle());
    controller.attach(second);

    expect(cancelAnimationFrame).toHaveBeenCalledWith(41);
    expect(first.chatManualRefreshFrame).toBeNull();
    expect(first.chatManualRefreshInFlight).toBe(false);

    controller.hostDisconnected();

    expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
    expect(second.chatManualRefreshFrame).toBeNull();
    expect(second.chatManualRefreshInFlight).toBe(false);
  });
});

describe("resolveChatAvatarUrl", () => {
  it("prefers the authenticated avatar blob over persisted and protected URLs", () => {
    const state = {
      sessionKey: "agent:main:main",
      chatAvatarUrl: "blob:authenticated-avatar",
      assistantAvatar: "/avatar/main",
      assistantAgentId: "main",
    } as unknown as ChatPageHost;

    expect(resolveChatAvatarUrl(state)).toBe("blob:authenticated-avatar");
  });
});

describe("refreshChatMetadata", () => {
  it("applies agent-scoped metadata after a same-agent session switch", async () => {
    let resolveMetadata:
      | ((value: {
          commands: never[];
          models: Array<{
            id: string;
            name: string;
            provider: string;
            available: boolean;
          }>;
        }) => void)
      | undefined;
    const metadata = new Promise<{
      commands: never[];
      models: Array<{ id: string; name: string; provider: string; available: boolean }>;
    }>((resolve) => {
      resolveMetadata = resolve;
    });
    const request = vi.fn(async (method: string, params?: unknown) => {
      expect(method).toBe("chat.metadata");
      expect(params).toEqual({ agentId: "work" });
      return await metadata;
    });
    const state = {
      agentsList: null,
      assistantAgentId: "main",
      chatModelCatalog: [],
      chatMetadataRequestVersion: 0,
      chatModelsLoading: false,
      client: { request },
      connected: true,
      hello: { features: { methods: ["chat.metadata"] } },
      sessionKey: "agent:work:main",
    } as unknown as ChatPageHost;

    const refresh = refreshChatMetadata(state);
    state.sessionKey = "agent:work:another";
    resolveMetadata?.({
      commands: [],
      models: [{ id: "work-model", name: "Work Model", provider: "openai", available: true }],
    });
    await refresh;

    expect(state.chatModelCatalog).toEqual([
      { id: "work-model", name: "Work Model", provider: "openai", available: true },
    ]);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("ignores metadata after switching to a different agent", async () => {
    let resolveMetadata:
      | ((value: {
          commands: never[];
          models: Array<{ id: string; name: string; provider: string }>;
        }) => void)
      | undefined;
    const metadata = new Promise<{
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }>((resolve) => {
      resolveMetadata = resolve;
    });
    const request = vi.fn(async () => await metadata);
    const existingCatalog = [
      { id: "work-model", name: "Work Model", provider: "openai", available: true },
    ];
    const state = {
      agentsList: null,
      assistantAgentId: "main",
      chatModelCatalog: existingCatalog,
      chatMetadataRequestVersion: 0,
      chatModelsLoading: false,
      client: { request },
      connected: true,
      hello: { features: { methods: ["chat.metadata"] } },
      sessionKey: "agent:work:main",
    } as unknown as ChatPageHost;

    const refresh = refreshChatMetadata(state);
    state.sessionKey = "agent:other:main";
    resolveMetadata?.({
      commands: [],
      models: [{ id: "other-model", name: "Other Model", provider: "openai" }],
    });
    await refresh;

    expect(state.chatModelCatalog).toBe(existingCatalog);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("keeps loading owned by the newest agent metadata request", async () => {
    let resolveWork: (value: {
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }) => void = () => {};
    let resolveOther: (value: {
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }) => void = () => {};
    const workMetadata = new Promise<{
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }>((resolve) => {
      resolveWork = resolve;
    });
    const otherMetadata = new Promise<{
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }>((resolve) => {
      resolveOther = resolve;
    });
    const request = vi.fn(
      async (_method: string, params?: { agentId?: string }) =>
        await (params?.agentId === "work" ? workMetadata : otherMetadata),
    );
    const state = {
      agentsList: null,
      assistantAgentId: "main",
      chatMetadataRequestVersion: 0,
      chatModelCatalog: [],
      chatModelsLoading: false,
      client: { request },
      connected: true,
      hello: { features: { methods: ["chat.metadata"] } },
      sessionKey: "agent:work:main",
    } as unknown as ChatPageHost;

    const workRefresh = refreshChatMetadata(state);
    state.sessionKey = "agent:other:main";
    const otherRefresh = refreshChatMetadata(state);
    resolveWork({
      commands: [],
      models: [{ id: "work-model", name: "Work Model", provider: "openai" }],
    });
    await workRefresh;

    expect(state.chatModelsLoading).toBe(true);
    resolveOther({
      commands: [],
      models: [{ id: "other-model", name: "Other Model", provider: "openai" }],
    });
    await otherRefresh;

    expect(state.chatModelsLoading).toBe(false);
    expect(state.chatModelCatalog).toEqual([
      { id: "other-model", name: "Other Model", provider: "openai" },
    ]);
  });

  it("does not let an older same-agent response overwrite the newest catalog", async () => {
    let resolveFirst: (value: {
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }) => void = () => {};
    let resolveSecond: (value: {
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }) => void = () => {};
    const firstMetadata = new Promise<{
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }>((resolve) => {
      resolveFirst = resolve;
    });
    const secondMetadata = new Promise<{
      commands: never[];
      models: Array<{ id: string; name: string; provider: string }>;
    }>((resolve) => {
      resolveSecond = resolve;
    });
    let requestCount = 0;
    const request = vi.fn(async () => {
      requestCount += 1;
      return await (requestCount === 1 ? firstMetadata : secondMetadata);
    });
    const state = {
      agentsList: null,
      assistantAgentId: "main",
      chatMetadataRequestVersion: 0,
      chatModelCatalog: [],
      chatModelsLoading: false,
      client: { request },
      connected: true,
      hello: { features: { methods: ["chat.metadata"] } },
      sessionKey: "agent:work:main",
    } as unknown as ChatPageHost;

    const firstRefresh = refreshChatMetadata(state);
    const secondRefresh = refreshChatMetadata(state);
    resolveSecond({
      commands: [],
      models: [{ id: "new-model", name: "New Model", provider: "openai" }],
    });
    await secondRefresh;
    resolveFirst({
      commands: [],
      models: [{ id: "old-model", name: "Old Model", provider: "openai" }],
    });
    await firstRefresh;

    expect(state.chatModelCatalog).toEqual([
      { id: "new-model", name: "New Model", provider: "openai" },
    ]);
  });

  it("loads compatibility models when the gateway does not advertise chat metadata", async () => {
    const request = vi.fn(async (method: string, params?: unknown) => {
      if (method === "models.list") {
        expect(params).toEqual({ view: "configured" });
        return {
          models: [{ id: "compat-model", name: "Compat Model", provider: "openai" }],
        };
      }
      expect(method).toBe("commands.list");
      return { commands: [] };
    });
    const state = {
      agentsList: null,
      assistantAgentId: "main",
      chatMetadataRequestVersion: 2,
      chatModelCatalog: [{ id: "stale-model", name: "Stale Model", provider: "openai" }],
      chatModelsLoading: true,
      client: { request },
      connected: true,
      hello: { features: { methods: [] } },
      sessionKey: "agent:main:main",
    } as unknown as ChatPageHost;

    await refreshChatMetadata(state);

    expect(state.chatMetadataRequestVersion).toBe(3);
    expect(state.chatModelCatalog).toEqual([
      { id: "compat-model", name: "Compat Model", provider: "openai" },
    ]);
    expect(state.chatModelsLoading).toBe(false);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("preserves startup models when the gateway does not advertise chat metadata", async () => {
    const request = vi.fn(async (method: string) => {
      expect(method).toBe("commands.list");
      return { commands: [] };
    });
    const startupCatalog = [
      { id: "startup-model", name: "Startup Model", provider: "openai", available: true },
    ];
    const state = {
      agentsList: null,
      assistantAgentId: "main",
      chatMetadataRequestVersion: 4,
      chatModelCatalog: startupCatalog,
      chatModelsLoading: true,
      client: { request },
      connected: true,
      hello: { features: { methods: ["chat.startup"] } },
      sessionKey: "agent:work:main",
    } as unknown as ChatPageHost;

    await refreshChatMetadata(state, { preserveModelCatalogOnFallback: true });

    expect(state.chatMetadataRequestVersion).toBe(5);
    expect(state.chatModelCatalog).toBe(startupCatalog);
    expect(state.chatModelsLoading).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not load unscoped compatibility models for a non-default agent", async () => {
    const request = vi.fn(async (method: string) => {
      expect(method).toBe("commands.list");
      return { commands: [] };
    });
    const state = {
      agentsList: { defaultId: "main" },
      assistantAgentId: "main",
      chatMetadataRequestVersion: 0,
      chatModelCatalog: [{ id: "stale-model", name: "Stale Model", provider: "openai" }],
      chatModelsLoading: false,
      client: { request },
      connected: true,
      hello: { features: { methods: [] } },
      sessionKey: "agent:work:main",
    } as unknown as ChatPageHost;

    await refreshChatMetadata(state);

    expect(state.chatModelCatalog).toEqual([]);
    expect(state.chatModelsLoading).toBe(false);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not apply compatibility commands after switching agents", async () => {
    let resolveCommands: (value: {
      commands: Array<{
        name: string;
        textAliases: string[];
        description: string;
        source: string;
        scope: string;
        acceptsArgs: boolean;
      }>;
    }) => void = () => {};
    const commands = new Promise<{
      commands: Array<{
        name: string;
        textAliases: string[];
        description: string;
        source: string;
        scope: string;
        acceptsArgs: boolean;
      }>;
    }>((resolve) => {
      resolveCommands = resolve;
    });
    const request = vi.fn(async (method: string) => {
      expect(method).toBe("commands.list");
      return await commands;
    });
    applyRemoteSlashCommandsResult({
      client: null,
      agentId: "other",
      result: {
        commands: [
          {
            name: "other-command",
            textAliases: ["/other-command"],
            description: "Command for the newly selected agent.",
            source: "plugin",
            scope: "text",
            acceptsArgs: false,
          },
        ],
      },
    });
    const state = {
      agentsList: { defaultId: "main" },
      assistantAgentId: "main",
      chatMetadataRequestVersion: 0,
      chatModelCatalog: [],
      chatModelsLoading: false,
      client: { request },
      connected: true,
      hello: { features: { methods: [] } },
      sessionKey: "agent:work:main",
    } as unknown as ChatPageHost;

    const refresh = refreshChatMetadata(state);
    state.sessionKey = "agent:other:main";
    resolveCommands({
      commands: [
        {
          name: "work-command",
          textAliases: ["/work-command"],
          description: "Stale command for the previous agent.",
          source: "plugin",
          scope: "text",
          acceptsArgs: false,
        },
      ],
    });
    await refresh;

    expect(SLASH_COMMANDS.some((command) => command.name === "other-command")).toBe(true);
    expect(SLASH_COMMANDS.some((command) => command.name === "work-command")).toBe(false);
  });
});
