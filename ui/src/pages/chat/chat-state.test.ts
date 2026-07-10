import type { ReactiveController, ReactiveControllerHost } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SLASH_COMMANDS } from "../../lib/chat/commands.ts";
import { createStorageMock } from "../../test-helpers/storage.ts";
import {
  applyRemoteSlashCommandsResult,
  resetChatSlashCommandMetadataForTest,
} from "./chat-commands.ts";
import {
  admitQueuedMessageForSession,
  removeQueuedMessage,
  subscribeChatOutboxProjection,
  updateQueuedMessageForSession,
} from "./chat-queue.ts";
import {
  ChatStateController,
  handleChatManualRefresh,
  refreshChatMetadata,
  resetChatStateForRouteSession,
  retryChatComposerMemoryFallback,
  resolveChatAvatarUrl,
  type ChatPageHost,
} from "./chat-state.ts";
import {
  admitStoredChatComposerQueueItem,
  ChatComposerPersistence,
  loadChatComposerCommittedDraftRevision,
  loadChatComposerDraftRevision,
  loadChatComposerSnapshot,
  persistChatComposerState,
  removeStoredChatComposerQueueItem,
  resolveStoredChatOutboxScope,
  storedChatOutboxScopeKey,
} from "./composer-persistence.ts";
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

describe("route composer fallback", () => {
  function createRouteState(chatMessage: string) {
    const resetChatInputHistoryNavigation = vi.fn();
    const resetChatScroll = vi.fn();
    const state = {
      settings: { gatewayUrl: "ws://gateway.test/control" },
      assistantAgentId: "main",
      agentsList: { defaultId: "main", mainKey: "main" },
      hello: null,
      sessionKey: "agent:main:first",
      chatMessage,
      chatComposerFallbackByScope: {},
      chatQueue: [],
      chatQueueByScope: {},
      chatMessages: [],
      chatMessagesBySession: new Map(),
      chatAttachments: [
        {
          id: "staged-image",
          mimeType: "image/png",
          dataUrl: "data:image/png;base64,AAA",
        },
      ],
      chatSideResultTerminalRuns: new Set(),
      chatToolMessages: [],
      chatStreamSegments: [],
      toolStreamById: new Map(),
      toolStreamOrder: [],
      sessionsResult: null,
      realtimeTalkConversation: [],
      realtimeTalkConversationState: { phase: "idle" },
      resetChatInputHistoryNavigation,
      resetChatScroll,
      requestUpdate: vi.fn(),
    } as unknown as ChatPageHost;
    return { resetChatInputHistoryNavigation, resetChatScroll, state };
  }

  it("reapplies a live send projection when a subscribed pane switches into its scope", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state: owner } = createRouteState("");
    const { state: switchingPane } = createRouteState("");
    switchingPane.sessionKey = "agent:main:second";
    const item = {
      id: "route-switch-live-send",
      text: "send remains owned by the first pane",
      createdAt: 1,
      sessionKey: owner.sessionKey,
    };
    owner.chatQueue = [item];
    const stopSwitchingPane = subscribeChatOutboxProjection(switchingPane);

    try {
      expect(admitQueuedMessageForSession(owner, owner.sessionKey, item)).toBe(true);
      expect(
        updateQueuedMessageForSession(owner, owner.sessionKey, item.id, (entry) => ({
          ...entry,
          sendAttempts: 1,
          sendRunId: "route-switch-live-run",
          sendState: "sending",
        })),
      ).toMatchObject({ sendState: "sending" });
      expect(loadChatComposerSnapshot(owner, owner.sessionKey)?.queue[0]?.sendState).toBe(
        "waiting-reconnect",
      );
      expect(switchingPane.chatQueue).toStrictEqual([]);

      resetChatStateForRouteSession(switchingPane, owner.sessionKey);

      expect(switchingPane.chatQueue).toEqual([
        expect.objectContaining({ id: item.id, sendState: "sending" }),
      ]);
    } finally {
      removeQueuedMessage(owner, item.id);
      stopSwitchingPane();
    }
  });

  it("hydrates a live target without persisting through the previous route owner", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state: owner } = createRouteState("stored target draft");
    owner.chatAttachments = [];
    const item = {
      id: "route-switch-persistence-owner",
      text: "keep target projection live",
      createdAt: 1,
      sessionKey: owner.sessionKey,
    };
    expect(persistChatComposerState(owner)).toBe(true);
    owner.chatQueue = [item];
    expect(admitQueuedMessageForSession(owner, owner.sessionKey, item)).toBe(true);
    expect(
      updateQueuedMessageForSession(owner, owner.sessionKey, item.id, (entry) => ({
        ...entry,
        sendAttempts: 1,
        sendRunId: "route-switch-persistence-run",
        sendState: "sending",
      })),
    ).toMatchObject({ sendState: "sending" });

    const { state: peer } = createRouteState("stored target draft");
    peer.chatAttachments = [];
    const peerPersistence = new ChatComposerPersistence(() => peer);
    peerPersistence.start();
    peer.chatMessage = "newer pending peer draft";
    peerPersistence.schedule();

    const { state: switchingPane } = createRouteState("");
    switchingPane.chatAttachments = [];
    switchingPane.sessionKey = "agent:main:second";
    const previousRoutePersistence = new ChatComposerPersistence(() => switchingPane);
    previousRoutePersistence.start();
    const requestUpdate = vi.fn(() => previousRoutePersistence.persistChangedState());
    switchingPane.requestUpdate = requestUpdate;
    const stopSwitchingPane = subscribeChatOutboxProjection(switchingPane);

    try {
      resetChatStateForRouteSession(switchingPane, owner.sessionKey);

      expect(requestUpdate).not.toHaveBeenCalled();
      expect(switchingPane.chatQueue[0]?.sendState).toBe("sending");
      peerPersistence.persistChangedState();
      expect(loadChatComposerSnapshot(owner, owner.sessionKey)?.draft).toBe(
        "newer pending peer draft",
      );
    } finally {
      removeQueuedMessage(owner, item.id);
      stopSwitchingPane();
    }
  });

  it("reapplies a running command projection when a subscribed pane switches into its scope", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state: owner } = createRouteState("");
    const { state: switchingPane } = createRouteState("");
    switchingPane.sessionKey = "agent:main:second";
    const item = {
      id: "route-switch-live-command",
      text: "/compact",
      createdAt: 1,
      localCommandArgs: "",
      localCommandName: "compact",
      sessionKey: owner.sessionKey,
    };
    owner.chatQueue = [item];
    const stopSwitchingPane = subscribeChatOutboxProjection(switchingPane);

    try {
      expect(admitQueuedMessageForSession(owner, owner.sessionKey, item)).toBe(true);
      expect(
        updateQueuedMessageForSession(owner, owner.sessionKey, item.id, (entry) => ({
          ...entry,
          sendState: "executing-command",
        })),
      ).toMatchObject({ sendState: "executing-command" });
      expect(loadChatComposerSnapshot(owner, owner.sessionKey)?.queue[0]?.sendState).toBe(
        "unconfirmed",
      );
      expect(switchingPane.chatQueue).toStrictEqual([]);

      resetChatStateForRouteSession(switchingPane, owner.sessionKey);

      expect(switchingPane.chatQueue).toEqual([
        expect.objectContaining({ id: item.id, sendState: "executing-command" }),
      ]);
    } finally {
      removeQueuedMessage(owner, item.id);
      stopSwitchingPane();
    }
  });

  it("keeps a draft in its pane when browser persistence fails across a route switch", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { resetChatInputHistoryNavigation, resetChatScroll, state } =
      createRouteState("memory-only draft");

    expect(
      resetChatStateForRouteSession(state, "agent:main:second", {
        retainPreviousComposerInMemory: true,
        previousDraftRetry: { expectedDraftRevision: 0, draftRevision: 1 },
      }),
    ).toEqual({ restoredFallback: false, restoredStorageFailure: false });
    expect(state.chatMessage).toBe("");
    expect(state.chatAttachments).toEqual([]);

    expect(resetChatStateForRouteSession(state, "agent:main:first")).toEqual({
      restoredFallback: true,
      restoredStorageFailure: true,
    });
    expect(state.chatMessage).toBe("memory-only draft");
    expect(state.chatAttachments).toEqual([
      {
        id: "staged-image",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,AAA",
      },
    ]);
    expect(state.chatError).toContain("remains available in this tab");
    expect(resetChatInputHistoryNavigation).toHaveBeenCalledTimes(2);
    expect(resetChatScroll).toHaveBeenCalledTimes(2);
  });

  it("adopts an unresolved bare-main fallback when the default agent becomes known", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state } = createRouteState("unresolved memory draft");
    state.assistantAgentId = null;
    state.agentsList = null;
    state.sessionKey = "main";

    resetChatStateForRouteSession(state, "agent:work:other", {
      retainPreviousComposerInMemory: true,
      previousDraftRetry: { expectedDraftRevision: 0, draftRevision: 1 },
    });
    const unresolvedScopeKey = storedChatOutboxScopeKey({ sessionKey: "main" });
    expect(state.chatComposerFallbackByScope[unresolvedScopeKey]?.message).toBe(
      "unresolved memory draft",
    );

    state.assistantAgentId = "work";
    state.agentsList = { agents: [], defaultId: "work", mainKey: "main", scope: "global" };
    expect(resetChatStateForRouteSession(state, "main")).toEqual({
      restoredFallback: true,
      restoredStorageFailure: true,
    });

    const resolvedScopeKey = storedChatOutboxScopeKey(resolveStoredChatOutboxScope(state, "main"));
    expect(state.chatMessage).toBe("unresolved memory draft");
    expect(state.chatAttachments).toHaveLength(1);
    expect(state.chatComposerFallbackByScope[resolvedScopeKey]?.message).toBe(
      "unresolved memory draft",
    );
    expect(state.chatComposerFallbackByScope[unresolvedScopeKey]).toBeUndefined();
  });

  it("keeps unresolved bare-main and raw-global fallbacks with their resolved owners", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state } = createRouteState("");
    const unresolvedMainScopeKey = storedChatOutboxScopeKey({ sessionKey: "main" });
    const unresolvedGlobalScopeKey = storedChatOutboxScopeKey({ sessionKey: "global" });
    state.chatComposerFallbackByScope = {
      [unresolvedMainScopeKey]: {
        message: "default-agent fallback",
        attachments: [],
        storageFailed: false,
        sequence: 1,
      },
      [unresolvedGlobalScopeKey]: {
        message: "selected-agent fallback",
        attachments: [],
        storageFailed: false,
        sequence: 2,
      },
    };
    state.assistantAgentId = "alpha";
    state.agentsList = {
      agents: [],
      defaultId: "work",
      mainKey: "main",
      scope: "global",
    };

    resetChatStateForRouteSession(state, "main");
    expect(state.chatMessage).toBe("default-agent fallback");
    expect(state.chatComposerFallbackByScope[unresolvedGlobalScopeKey]?.message).toBe(
      "selected-agent fallback",
    );

    resetChatStateForRouteSession(state, "agent:work:other");
    resetChatStateForRouteSession(state, "global");
    expect(state.chatMessage).toBe("selected-agent fallback");
  });

  it("adopts a failed custom-main fallback when defaults identify the alias", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state } = createRouteState("custom alias memory draft");
    state.assistantAgentId = null;
    state.agentsList = null;
    state.sessionKey = "workspace";

    resetChatStateForRouteSession(state, "agent:work:other", {
      retainPreviousComposerInMemory: true,
      previousDraftRetry: { expectedDraftRevision: 0, draftRevision: 1 },
    });
    const customAliasScopeKey = storedChatOutboxScopeKey({ sessionKey: "workspace" });
    expect(state.chatComposerFallbackByScope[customAliasScopeKey]?.message).toBe(
      "custom alias memory draft",
    );

    state.assistantAgentId = "alpha";
    state.agentsList = {
      agents: [],
      defaultId: "work",
      mainKey: "workspace",
      scope: "global",
    };
    expect(resetChatStateForRouteSession(state, "agent:work:workspace")).toEqual({
      restoredFallback: true,
      restoredStorageFailure: true,
    });

    const resolvedScopeKey = storedChatOutboxScopeKey({ agentId: "work", sessionKey: "global" });
    expect(state.chatMessage).toBe("custom alias memory draft");
    expect(state.chatAttachments).toHaveLength(1);
    expect(state.chatComposerFallbackByScope[customAliasScopeKey]).toBeUndefined();
    expect(state.chatComposerFallbackByScope[resolvedScopeKey]?.message).toBe(
      "custom alias memory draft",
    );
    expect(retryChatComposerMemoryFallback(state, "agent:work:workspace")).toBe(true);
    expect(loadChatComposerSnapshot(state, "agent:work:workspace")?.draft).toBe(
      "custom alias memory draft",
    );
  });

  it("adopts a qualified custom-main fallback when defaults identify the alias", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state } = createRouteState("qualified alias memory draft");
    state.assistantAgentId = null;
    state.agentsList = null;
    state.sessionKey = "agent:work:workspace";

    resetChatStateForRouteSession(state, "agent:alpha:other", {
      retainPreviousComposerInMemory: true,
      previousDraftRetry: { expectedDraftRevision: 0, draftRevision: 1 },
    });
    const qualifiedScopeKey = storedChatOutboxScopeKey({
      agentId: "work",
      sessionKey: "agent:work:workspace",
    });
    expect(state.chatComposerFallbackByScope[qualifiedScopeKey]?.message).toBe(
      "qualified alias memory draft",
    );

    state.assistantAgentId = "alpha";
    state.agentsList = {
      agents: [],
      defaultId: "work",
      mainKey: "workspace",
      scope: "global",
    };
    expect(resetChatStateForRouteSession(state, "agent:work:workspace")).toEqual({
      restoredFallback: true,
      restoredStorageFailure: true,
    });

    const resolvedScopeKey = storedChatOutboxScopeKey({ agentId: "work", sessionKey: "global" });
    expect(state.chatMessage).toBe("qualified alias memory draft");
    expect(state.chatAttachments).toHaveLength(1);
    expect(state.chatComposerFallbackByScope[qualifiedScopeKey]).toBeUndefined();
    expect(state.chatComposerFallbackByScope[resolvedScopeKey]?.message).toBe(
      "qualified alias memory draft",
    );
    expect(retryChatComposerMemoryFallback(state, "agent:work:workspace")).toBe(true);
    expect(loadChatComposerSnapshot(state, "agent:work:workspace")?.draft).toBe(
      "qualified alias memory draft",
    );
  });

  it("keeps custom and unresolved fallbacks with their distinct agents", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state } = createRouteState("");
    const customAliasScopeKey = storedChatOutboxScopeKey({ sessionKey: "workspace" });
    const unresolvedScopeKey = storedChatOutboxScopeKey({ sessionKey: "global" });
    state.chatComposerFallbackByScope = {
      [customAliasScopeKey]: {
        message: "default-agent fallback",
        attachments: [],
        storageFailed: false,
        sequence: 1,
      },
      [unresolvedScopeKey]: {
        message: "selected-agent fallback",
        attachments: [],
        storageFailed: false,
        sequence: 2,
      },
    };
    state.assistantAgentId = "alpha";
    state.agentsList = {
      agents: [],
      defaultId: "work",
      mainKey: "workspace",
      scope: "global",
    };

    resetChatStateForRouteSession(state, "agent:work:workspace");
    expect(state.chatMessage).toBe("default-agent fallback");
    expect(state.chatComposerFallbackByScope[unresolvedScopeKey]?.message).toBe(
      "selected-agent fallback",
    );

    resetChatStateForRouteSession(state, "agent:work:other");
    resetChatStateForRouteSession(state, "global");
    expect(state.chatMessage).toBe("selected-agent fallback");
  });

  it("keeps only the newest failed fallback when aliases converge", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state } = createRouteState("older unresolved draft");
    state.assistantAgentId = null;
    state.agentsList = null;
    state.chatAttachments = [];
    state.sessionKey = "main";
    resetChatStateForRouteSession(state, "workspace", {
      retainPreviousComposerInMemory: true,
      previousDraftRetry: { expectedDraftRevision: 0, draftRevision: 1 },
    });

    state.chatMessage = "newer custom-alias draft";
    resetChatStateForRouteSession(state, "agent:work:other", {
      retainPreviousComposerInMemory: true,
      previousDraftRetry: { expectedDraftRevision: 0, draftRevision: 2 },
    });
    state.assistantAgentId = "work";
    state.agentsList = {
      agents: [],
      defaultId: "work",
      mainKey: "workspace",
      scope: "global",
    };

    expect(resetChatStateForRouteSession(state, "global")).toEqual({
      restoredFallback: true,
      restoredStorageFailure: true,
    });
    expect(state.chatMessage).toBe("newer custom-alias draft");
    expect(retryChatComposerMemoryFallback(state, "global")).toBe(true);
    expect(state.chatComposerFallbackByScope).toEqual({});

    resetChatStateForRouteSession(state, "agent:work:other");
    resetChatStateForRouteSession(state, "global");
    expect(state.chatMessage).toBe("newer custom-alias draft");
  });

  it("keeps only the newest attachment fallback when aliases converge", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state } = createRouteState("");
    state.assistantAgentId = null;
    state.agentsList = null;
    state.sessionKey = "main";
    resetChatStateForRouteSession(state, "workspace", {
      retainPreviousComposerInMemory: true,
    });

    state.chatAttachments = [
      {
        id: "newer-custom-attachment",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,BBB",
      },
    ];
    resetChatStateForRouteSession(state, "agent:work:other", {
      retainPreviousComposerInMemory: true,
    });
    state.assistantAgentId = "work";
    state.agentsList = {
      agents: [],
      defaultId: "work",
      mainKey: "workspace",
      scope: "global",
    };

    expect(resetChatStateForRouteSession(state, "global")).toEqual({
      restoredFallback: true,
      restoredStorageFailure: false,
    });
    expect(state.chatAttachments).toEqual([
      {
        id: "newer-custom-attachment",
        mimeType: "image/png",
        dataUrl: "data:image/png;base64,BBB",
      },
    ]);
    const resolvedScopeKey = storedChatOutboxScopeKey({ agentId: "work", sessionKey: "global" });
    expect(Object.keys(state.chatComposerFallbackByScope)).toEqual([resolvedScopeKey]);
  });

  it("rebases a newer unresolved draft retry onto the selected agent revision", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state: resolved } = createRouteState("prior work draft");
    resolved.assistantAgentId = "work";
    resolved.agentsList = { agents: [], defaultId: "work", mainKey: "main", scope: "global" };
    resolved.sessionKey = "main";
    resolved.chatAttachments = [];
    expect(persistChatComposerState(resolved)).toBe(true);
    const committedRevision = loadChatComposerCommittedDraftRevision(resolved, "main");

    const { state } = createRouteState("new unresolved draft");
    state.assistantAgentId = null;
    state.agentsList = null;
    state.sessionKey = "main";
    state.chatAttachments = [];
    resetChatStateForRouteSession(state, "agent:work:other", {
      retainPreviousComposerInMemory: true,
      previousDraftRetry: {
        expectedDraftRevision: 0,
        draftRevision: committedRevision + 1,
      },
    });

    state.assistantAgentId = "work";
    state.agentsList = { agents: [], defaultId: "work", mainKey: "main", scope: "global" };
    resetChatStateForRouteSession(state, "main");

    expect(retryChatComposerMemoryFallback(state, "main")).toBe(true);
    expect(loadChatComposerSnapshot(state, "main")?.draft).toBe("new unresolved draft");
    expect(state.chatComposerFallbackByScope).toEqual({});
  });

  it("keeps staged attachments in the pane without reporting a storage failure", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state } = createRouteState("");

    expect(
      resetChatStateForRouteSession(state, "agent:main:second", {
        retainPreviousComposerInMemory: true,
      }),
    ).toEqual({ restoredFallback: false, restoredStorageFailure: false });
    expect(state.chatError).toBeNull();

    expect(resetChatStateForRouteSession(state, "agent:main:first")).toEqual({
      restoredFallback: true,
      restoredStorageFailure: false,
    });
    expect(state.chatMessage).toBe("");
    expect(state.chatAttachments).toHaveLength(1);
    expect(state.chatError).toBeNull();
  });

  it("retries a failed draft after storage recovers", () => {
    const storage = createStorageMock();
    const write = storage.setItem.bind(storage);
    let storageAvailable = false;
    vi.spyOn(storage, "setItem").mockImplementation((key, value) => {
      if (!storageAvailable) {
        throw new DOMException("quota exceeded", "QuotaExceededError");
      }
      write(key, value);
    });
    vi.stubGlobal("sessionStorage", storage);
    const { state } = createRouteState("retry this draft");
    state.chatAttachments = [];
    expect(
      persistChatComposerState(state, "agent:main:first", {
        draft: state.chatMessage,
        expectedDraftRevision: 0,
        draftRevision: 1,
      }),
    ).toBe(false);

    resetChatStateForRouteSession(state, "agent:main:second", {
      retainPreviousComposerInMemory: true,
      previousDraftRetry: { expectedDraftRevision: 0, draftRevision: 1 },
    });
    resetChatStateForRouteSession(state, "agent:main:first");
    storageAvailable = true;

    expect(retryChatComposerMemoryFallback(state, "agent:main:first")).toBe(true);
    expect(loadChatComposerSnapshot(state, "agent:main:first")?.draft).toBe("retry this draft");
    expect(state.chatComposerFallbackByScope).toEqual({});
    expect(state.chatError).toBeNull();
  });

  it("does not overwrite a newer split-pane draft while retrying", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state } = createRouteState("pane A draft");
    state.chatAttachments = [];
    resetChatStateForRouteSession(state, "agent:main:second", {
      retainPreviousComposerInMemory: true,
      previousDraftRetry: { expectedDraftRevision: 0, draftRevision: 1 },
    });

    const { state: peer } = createRouteState("newer pane B draft");
    peer.chatAttachments = [];
    expect(persistChatComposerState(peer, "agent:main:first")).toBe(true);

    resetChatStateForRouteSession(state, "agent:main:first");
    expect(retryChatComposerMemoryFallback(state, "agent:main:first")).toBe(false);
    expect(loadChatComposerSnapshot(state, "agent:main:first")?.draft).toBe("newer pane B draft");
    expect(state.chatMessage).toBe("pane A draft");
    expect(state.chatError).toContain("remains available in this tab");
  });

  it("keeps a stale-revision conflict pane-local instead of retrying it as storage failure", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state } = createRouteState("older pane A draft");
    state.chatAttachments = [];
    resetChatStateForRouteSession(state, "agent:main:second", {
      retainPreviousComposerInMemory: true,
    });

    const { state: peer } = createRouteState("newer pane B draft");
    peer.chatAttachments = [];
    expect(persistChatComposerState(peer, "agent:main:first")).toBe(true);

    resetChatStateForRouteSession(state, "agent:main:first");
    expect(retryChatComposerMemoryFallback(state, "agent:main:first")).toBe(false);
    expect(loadChatComposerSnapshot(state, "agent:main:first")?.draft).toBe("newer pane B draft");
    expect(state.chatMessage).toBe("older pane A draft");
    expect(state.chatError).toBeNull();
  });

  it("does not resurrect a stale fallback after a newer pane clears the draft", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    const { state } = createRouteState("stale pane A draft");
    state.chatAttachments = [];
    resetChatStateForRouteSession(state, "agent:main:second", {
      retainPreviousComposerInMemory: true,
      previousDraftRetry: { expectedDraftRevision: 0, draftRevision: 1 },
    });

    const { state: peer } = createRouteState("newer pane B draft");
    peer.chatAttachments = [];
    expect(persistChatComposerState(peer, "agent:main:first")).toBe(true);
    peer.chatMessage = "";
    expect(persistChatComposerState(peer, "agent:main:first")).toBe(true);
    expect(loadChatComposerSnapshot(peer, "agent:main:first")).toBeNull();

    resetChatStateForRouteSession(state, "agent:main:first");
    expect(retryChatComposerMemoryFallback(state, "agent:main:first")).toBe(false);
    expect(loadChatComposerSnapshot(state, "agent:main:first")).toBeNull();
    expect(state.chatMessage).toBe("stale pane A draft");
  });

  it("does not resurrect a stale fallback after its clear tombstone is pruned", () => {
    vi.stubGlobal("sessionStorage", createStorageMock());
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => ++now);
    const { state } = createRouteState("stale pane A draft");
    state.chatAttachments = [];
    resetChatStateForRouteSession(state, "agent:main:second", {
      retainPreviousComposerInMemory: true,
      previousDraftRetry: { expectedDraftRevision: 0, draftRevision: 1 },
    });

    const { state: peer } = createRouteState("newer pane B draft");
    peer.chatAttachments = [];
    expect(persistChatComposerState(peer, "agent:main:first")).toBe(true);
    peer.chatMessage = "";
    expect(persistChatComposerState(peer, "agent:main:first")).toBe(true);
    const clearRevision = loadChatComposerDraftRevision(peer, "agent:main:first");

    const queued = Array.from({ length: 20 }, (_, index) => {
      const sessionKey = `agent:main:queued-${index}`;
      const item = {
        id: `queued-${index}`,
        text: `queued message ${index}`,
        createdAt: index,
        sendAttempts: 0,
        sendRunId: `queued-run-${index}`,
        sendState: "waiting-reconnect" as const,
        sessionKey,
        agentId: "main",
      };
      const { state: queueState } = createRouteState("");
      queueState.chatAttachments = [];
      queueState.sessionKey = sessionKey;
      expect(admitStoredChatComposerQueueItem(queueState, sessionKey, item)).toBe(true);
      return { item, queueState, sessionKey };
    });

    expect(loadChatComposerSnapshot(peer, "agent:main:first")).toBeNull();
    expect(loadChatComposerDraftRevision(peer, "agent:main:first")).toBe(clearRevision);

    for (let index = 0; index < 20; index += 1) {
      const { state: clearState } = createRouteState("");
      clearState.chatAttachments = [];
      clearState.sessionKey = `agent:main:clear-fence-${index}`;
      expect(persistChatComposerState(clearState)).toBe(true);
    }
    const storageKey = sessionStorage.key(0);
    expect(storageKey).not.toBeNull();
    expect(sessionStorage.getItem(storageKey!)).not.toContain("agent:main:first");

    for (const { item, queueState, sessionKey } of queued) {
      expect(removeStoredChatComposerQueueItem(queueState, sessionKey, item.id, item)).toBe(true);
    }

    expect(loadChatComposerSnapshot(peer, "agent:main:first")).toBeNull();
    expect(loadChatComposerDraftRevision(peer, "agent:main:first")).toBe(clearRevision);
    resetChatStateForRouteSession(state, "agent:main:first");
    expect(retryChatComposerMemoryFallback(state, "agent:main:first")).toBe(false);
    expect(loadChatComposerSnapshot(state, "agent:main:first")).toBeNull();
    expect(state.chatMessage).toBe("stale pane A draft");
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
