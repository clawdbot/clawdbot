import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { ChatAttachment } from "../../lib/chat/chat-types.ts";
import { subscribeChatOutboxProjection } from "./chat-queue.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { invalidateImageLightbox } from "./chat-state-page.ts";
import { cancelChatStreamRenderFrame } from "./chat-state-render.ts";
import { clearSessionWorkspaceTimers } from "./components/chat-session-workspace.ts";
import {
  ChatComposerPersistence,
  type ChatComposerPersistResult,
  type StoredChatOutboxScope,
} from "./composer-persistence.ts";
import type { AfterCommitEffect, RenderLifecycle } from "./render-lifecycle.ts";
import { cancelChatScroll, scheduleCommittedChatScroll } from "./scroll.ts";

type PendingCreatedSessionComposer = {
  sessionKey: string;
  chatMessage: string;
  chatAttachments: ChatAttachment[];
};

type ChatRenderLifecycleScope = {
  connectionEpoch: number;
  cancellations: Set<() => void>;
};

export class ChatStateController<TState extends ChatPageHost> implements ReactiveController {
  private readonly composerPersistence: ChatComposerPersistence;
  private stateValue: TState | undefined;
  private previousChatLoading = false;
  private previousChatMessages: unknown[] = [];
  private previousChatToolMessages: Record<string, unknown>[] = [];
  private previousChatStream: string | null = null;
  private previousRealtimeConversation: ChatPageHost["realtimeTalkConversation"] = [];
  private scrollAfterUpdate = false;
  private scrollContentChangedAfterUpdate = false;
  private forceScrollAfterUpdate = false;
  private chatThreadResizeObserver: ResizeObserver | null = null;
  private chatThreadResizeTarget: Element | null = null;
  private pendingCreatedSessionComposer: PendingCreatedSessionComposer | null = null;
  private readonly cleanups: Array<() => void> = [];
  private renderLifecycleConnected = false;
  private renderLifecycleConnectionEpoch = 0;
  private renderLifecycleScope: ChatRenderLifecycleScope | undefined;

  constructor(private readonly host: ReactiveControllerHost) {
    this.composerPersistence = new ChatComposerPersistence(() => this.stateValue);
    host.addController(this);
  }

  get state(): TState | undefined {
    return this.stateValue;
  }

  createRenderLifecycle(): RenderLifecycle {
    this.cancelRenderLifecycleScope();
    const scope: ChatRenderLifecycleScope = {
      connectionEpoch: this.renderLifecycleConnectionEpoch,
      cancellations: new Set(),
    };
    this.renderLifecycleScope = scope;
    return {
      invalidate: () => {
        this.requestUpdateForScope(scope);
      },
      afterCommit: (effect, onCancel) => this.afterCommit(scope, effect, onCancel),
    };
  }

  attach(state: TState) {
    if (this.stateValue && this.stateValue !== state) {
      this.composerPersistence.stop();
      cancelChatStreamRenderFrame(this.stateValue);
      cancelChatScroll(this.stateValue);
    }
    this.stateValue = state;
    this.previousChatLoading = state.chatLoading;
    this.previousChatMessages = state.chatMessages;
    this.previousChatToolMessages = state.chatToolMessages;
    this.previousChatStream = state.chatStream;
    this.previousRealtimeConversation = state.realtimeTalkConversation;
    const renderLifecycle = state.renderLifecycle;
    state.requestUpdate = () => renderLifecycle.invalidate();
    this.cleanups.push(subscribeChatOutboxProjection(state));
    const sendChat = state.handleSendChat;
    state.handleSendChat = async (messageOverride, options) => {
      const pending = sendChat(messageOverride, options);
      renderLifecycle.invalidate();
      try {
        await pending;
      } finally {
        renderLifecycle.invalidate();
      }
    };
    const commitDraftChange = state.handleChatDraftChange;
    state.handleChatDraftChange = (next) => {
      commitDraftChange(next);
      this.composerPersistence.schedule();
    };
    const navigateInputHistory = state.handleChatInputHistoryKey;
    state.handleChatInputHistoryKey = (input) => {
      const result = navigateInputHistory(input);
      if (result.handled) {
        this.composerPersistence.schedule();
        // A history recall mutates chatMessage directly; without invalidating,
        // the composer textarea stays empty until an unrelated event re-renders.
        state.renderLifecycle.invalidate();
      }
      return result;
    };
  }

  addCleanup(cleanup: () => void) {
    this.cleanups.push(cleanup);
  }

  private isRenderLifecycleScopeActive(scope: ChatRenderLifecycleScope): boolean {
    return (
      this.renderLifecycleConnected &&
      this.renderLifecycleScope === scope &&
      scope.connectionEpoch === this.renderLifecycleConnectionEpoch
    );
  }

  private requestUpdateForScope(scope: ChatRenderLifecycleScope): boolean {
    if (!this.isRenderLifecycleScopeActive(scope)) {
      return false;
    }
    this.composerPersistence.persistChangedState();
    this.captureRenderLifecycleChanges();
    this.host.requestUpdate();
    return true;
  }

  private cancelRenderLifecycleScope(): void {
    const scope = this.renderLifecycleScope;
    if (!scope) {
      return;
    }
    this.renderLifecycleScope = undefined;
    for (const cancel of scope.cancellations) {
      cancel();
    }
  }

  private afterCommit(
    scope: ChatRenderLifecycleScope,
    effect: AfterCommitEffect,
    onCancel?: () => void,
  ): () => void {
    if (!this.isRenderLifecycleScopeActive(scope)) {
      onCancel?.();
      return () => undefined;
    }
    let active = true;
    let committed = false;
    let cleanup: (() => void) | undefined;
    const complete = () => {
      if (!active) {
        return;
      }
      active = false;
      cleanup = undefined;
      scope.cancellations.delete(cancel);
    };
    const cancel = () => {
      if (!active) {
        return;
      }
      active = false;
      scope.cancellations.delete(cancel);
      try {
        cleanup?.();
      } finally {
        cleanup = undefined;
        if (!committed) {
          onCancel?.();
        }
      }
    };
    scope.cancellations.add(cancel);
    // Request first so updateComplete represents the render this effect needs.
    if (!this.requestUpdateForScope(scope)) {
      cancel();
      return cancel;
    }
    const completion = this.host.updateComplete;
    void completion.then(() => {
      if (!active) {
        return;
      }
      if (!this.isRenderLifecycleScopeActive(scope)) {
        cancel();
        return;
      }
      committed = true;
      try {
        const nextCleanup = effect(complete);
        if (typeof nextCleanup === "function") {
          if (active && this.isRenderLifecycleScopeActive(scope)) {
            cleanup = nextCleanup;
          } else {
            nextCleanup();
          }
        } else {
          complete();
        }
      } catch (error) {
        complete();
        throw error;
      }
    }, cancel);
    return cancel;
  }

  private captureRenderLifecycleChanges() {
    const state = this.stateValue;
    if (!state) {
      return;
    }
    const messagesChanged =
      this.previousChatMessages !== state.chatMessages ||
      this.previousChatToolMessages !== state.chatToolMessages ||
      this.previousRealtimeConversation !== state.realtimeTalkConversation;
    const streamChanged = this.previousChatStream !== state.chatStream;
    const loadingChanged = this.previousChatLoading !== state.chatLoading;
    const loadFinished = this.previousChatLoading && !state.chatLoading;
    const streamStarted = this.previousChatStream == null && typeof state.chatStream === "string";
    this.previousChatLoading = state.chatLoading;
    this.previousChatMessages = state.chatMessages;
    this.previousChatToolMessages = state.chatToolMessages;
    this.previousChatStream = state.chatStream;
    this.previousRealtimeConversation = state.realtimeTalkConversation;
    if (!messagesChanged && !streamChanged && !loadingChanged) {
      return;
    }
    this.scrollAfterUpdate = true;
    this.scrollContentChangedAfterUpdate ||= messagesChanged || streamChanged;
    this.forceScrollAfterUpdate ||= loadFinished || streamStarted || !state.chatHasAutoScrolled;
  }

  private syncChatThreadResizeObserver(state: TState) {
    if (typeof ResizeObserver !== "function") {
      return;
    }
    const thread = state.querySelector(".chat-thread");
    if (thread && this.chatThreadResizeTarget === thread) {
      return;
    }

    this.chatThreadResizeObserver?.disconnect();
    this.chatThreadResizeObserver = null;
    this.chatThreadResizeTarget = null;
    if (!thread) {
      return;
    }

    // The transcript virtualizer owns row measurement and content-height
    // correction. This observer only follows viewport-size changes.
    this.chatThreadResizeObserver = new ResizeObserver(() => {
      const currentState = this.stateValue;
      if (!currentState) {
        return;
      }
      scheduleCommittedChatScroll(currentState, false, false, { source: "resize" });
    });
    this.chatThreadResizeObserver.observe(thread);
    this.chatThreadResizeTarget = thread;
  }

  hostConnected() {
    this.renderLifecycleConnectionEpoch += 1;
    this.renderLifecycleConnected = true;
    // A lifecycle created while detached must never become active on reconnect.
    this.cancelRenderLifecycleScope();
  }

  hostUpdated() {
    const state = this.stateValue;
    if (state) {
      this.syncChatThreadResizeObserver(state);
    }
    if (!this.scrollAfterUpdate) {
      return;
    }
    const force = this.forceScrollAfterUpdate;
    const contentChanged = this.scrollContentChangedAfterUpdate;
    this.scrollAfterUpdate = false;
    this.scrollContentChangedAfterUpdate = false;
    this.forceScrollAfterUpdate = false;
    if (!state) {
      return;
    }
    scheduleCommittedChatScroll(state, force, false, { contentChanged });
  }

  restoreComposer(options: { preserveCurrent?: boolean } = {}) {
    this.composerPersistence.restore(options);
  }

  startComposerPersistence() {
    this.composerPersistence.start();
  }

  persistComposerForRouteSwitch(): ChatComposerPersistResult {
    return this.composerPersistence.persistForRouteSwitchResult();
  }

  composerScopeForRouteSwitch(): StoredChatOutboxScope | null {
    return this.composerPersistence.scopeForRouteSwitch();
  }

  adoptComposerRoute() {
    this.composerPersistence.adoptCurrentRoute();
  }

  captureCreatedSessionComposer(sessionKey: string) {
    const state = this.stateValue;
    if (!state) {
      return;
    }
    this.pendingCreatedSessionComposer = {
      sessionKey,
      chatMessage: state.chatMessage,
      chatAttachments: state.chatAttachments,
    };
  }

  restoreCreatedSessionComposer(sessionKey: string | null | undefined): boolean {
    const state = this.stateValue;
    const pending = this.pendingCreatedSessionComposer;
    if (!state || !pending || pending.sessionKey !== sessionKey) {
      return false;
    }
    this.pendingCreatedSessionComposer = null;
    state.chatMessage = pending.chatMessage;
    state.chatAttachments = pending.chatAttachments;
    this.composerPersistence.persistNow();
    return true;
  }

  private stopChatEffects() {
    this.chatThreadResizeObserver?.disconnect();
    this.chatThreadResizeObserver = null;
    this.chatThreadResizeTarget = null;
    while (this.cleanups.length > 0) {
      this.cleanups.pop()?.();
    }
    const state = this.stateValue;
    if (state) {
      cancelChatStreamRenderFrame(state);
      cancelChatScroll(state);
      invalidateImageLightbox(state);
      clearSessionWorkspaceTimers(state);
    }
    state?.realtimeTalkSession?.stop();
    if (state) {
      state.realtimeTalkSession = null;
      state.realtimeTalkVideoStream = null;
      state.realtimeTalkCameraDevices = [];
      state.realtimeTalkVideoCapable = false;
      state.realtimeTalkVideoPending = false;
      state.realtimeTalkCameraError = false;
      state.resetToolStream?.();
    }
  }

  hostDisconnected() {
    this.renderLifecycleConnected = false;
    this.cancelRenderLifecycleScope();
    // Flush while stateValue still points at the active session. Composer
    // persistence is owned here so controller registration order cannot lose it.
    this.composerPersistence.stop();
    this.stopChatEffects();
    this.stateValue = undefined;
    this.scrollAfterUpdate = false;
    this.scrollContentChangedAfterUpdate = false;
    this.forceScrollAfterUpdate = false;
    this.pendingCreatedSessionComposer = null;
  }
}
