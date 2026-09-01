import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { StoredChatOutboxScope } from "../../lib/chat/outbox-store.ts";
import { disposeSelectedSessionMessageSubscription } from "./chat-history-subscription.ts";
import { subscribeChatOutboxProjection } from "./chat-queue.ts";
import { stopChatRealtimeTalk } from "./chat-realtime.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import { invalidateImageLightbox } from "./chat-state-page.ts";
import { cancelChatStreamRenderFrame } from "./chat-state-render.ts";
import { ChatAttachmentReadLifecycle } from "./components/chat-attachments.ts";
import { releaseChatMediaResourceSubscriber } from "./components/chat-message-media.ts";
import { clearSessionWorkspaceTimers } from "./components/chat-session-workspace.ts";
import { ChatComposerPersistence, type ChatComposerPersistResult } from "./composer-persistence.ts";
import type { AfterCommitEffect, RenderLifecycle } from "./render-lifecycle.ts";
import { cancelChatScroll, scheduleCommittedChatScroll } from "./scroll.ts";

type ChatRenderLifecycleScope = {
  cancellations: Set<() => void>;
};

export class ChatStateController<TState extends ChatPageHost> implements ReactiveController {
  readonly attachmentReads: ChatAttachmentReadLifecycle;
  private readonly composerPersistence: ChatComposerPersistence;
  private stateValue: TState | undefined;
  private previousChatLoading = false;
  private previousChatMessages: unknown[] = [];
  private previousChatToolMessages: Record<string, unknown>[] = [];
  private previousGuardianNotices: ChatPageHost["guardianNotices"] = [];
  private previousChatStream: string | null = null;
  private previousRealtimeConversation: ChatPageHost["realtimeTalkConversation"] = [];
  private scrollAfterUpdate = false;
  private scrollContentChangedAfterUpdate = false;
  private forceScrollAfterUpdate = false;
  private readonly cleanups: Array<() => void> = [];
  private renderLifecycleConnected = false;
  private renderLifecycleScope: ChatRenderLifecycleScope | undefined;

  constructor(private readonly host: ReactiveControllerHost) {
    this.attachmentReads = new ChatAttachmentReadLifecycle(() =>
      this.stateValue?.requestUpdate?.(),
    );
    this.composerPersistence = new ChatComposerPersistence(() => this.stateValue);
    host.addController(this);
  }

  get state(): TState | undefined {
    return this.stateValue;
  }

  createRenderLifecycle(): RenderLifecycle {
    this.cancelRenderLifecycleScope();
    const scope: ChatRenderLifecycleScope = {
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
      disposeSelectedSessionMessageSubscription(this.stateValue);
      releaseChatMediaResourceSubscriber(this.stateValue.requestUpdate);
      this.attachmentReads.abortReads();
      this.composerPersistence.stop();
      cancelChatStreamRenderFrame(this.stateValue);
      cancelChatScroll(this.stateValue);
      stopChatRealtimeTalk(this.stateValue);
    }
    this.stateValue = state;
    this.previousChatLoading = state.chatLoading;
    this.previousChatMessages = state.chatMessages;
    this.previousChatToolMessages = state.chatToolMessages;
    this.previousGuardianNotices = state.guardianNotices;
    this.previousChatStream = state.chatStream;
    this.previousRealtimeConversation = state.realtimeTalkConversation;
    const renderLifecycle = state.renderLifecycle;
    state.requestUpdate = () => renderLifecycle.invalidate();
    this.cleanups.push(subscribeChatOutboxProjection(state));
    const sendChat = state.handleSendChat;
    state.handleSendChat = async (messageOverride, options, submissionAction) => {
      const pending = sendChat(messageOverride, options, submissionAction);
      renderLifecycle.invalidate();
      try {
        return await pending;
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
    return this.renderLifecycleConnected && this.renderLifecycleScope === scope;
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
      this.previousGuardianNotices !== state.guardianNotices ||
      this.previousRealtimeConversation !== state.realtimeTalkConversation;
    const streamChanged = this.previousChatStream !== state.chatStream;
    const loadingChanged = this.previousChatLoading !== state.chatLoading;
    const loadFinished = this.previousChatLoading && !state.chatLoading;
    const streamStarted = this.previousChatStream == null && typeof state.chatStream === "string";
    this.previousChatLoading = state.chatLoading;
    this.previousChatMessages = state.chatMessages;
    this.previousChatToolMessages = state.chatToolMessages;
    this.previousGuardianNotices = state.guardianNotices;
    this.previousChatStream = state.chatStream;
    this.previousRealtimeConversation = state.realtimeTalkConversation;
    if (!messagesChanged && !streamChanged && !loadingChanged) {
      return;
    }
    this.scrollAfterUpdate = true;
    this.scrollContentChangedAfterUpdate ||= messagesChanged || streamChanged;
    this.forceScrollAfterUpdate ||= loadFinished || streamStarted || !state.chatHasAutoScrolled;
  }

  handleTranscriptResize(): void {
    if (this.stateValue && this.renderLifecycleConnected) {
      scheduleCommittedChatScroll(this.stateValue, false, false, { source: "resize" });
    }
  }

  hostConnected() {
    this.renderLifecycleConnected = true;
    // A lifecycle created while detached must never become active on reconnect.
    this.cancelRenderLifecycleScope();
  }

  hostUpdated() {
    const state = this.stateValue;
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

  pauseComposerPersistence() {
    this.composerPersistence.stop();
  }

  persistComposerForEviction(): ChatComposerPersistResult {
    return this.composerPersistence.persistForRouteSwitchResult();
  }

  composerScopeForEviction(): StoredChatOutboxScope | null {
    return this.composerPersistence.scopeForRouteSwitch();
  }

  private stopChatEffects() {
    while (this.cleanups.length > 0) {
      this.cleanups.pop()?.();
    }
    const state = this.stateValue;
    if (state) {
      disposeSelectedSessionMessageSubscription(state);
      releaseChatMediaResourceSubscriber(state.requestUpdate);
      cancelChatStreamRenderFrame(state);
      cancelChatScroll(state);
      invalidateImageLightbox(state);
      clearSessionWorkspaceTimers(state);
      stopChatRealtimeTalk(state);
      state.resetToolStream?.();
    }
  }

  hostDisconnected() {
    this.renderLifecycleConnected = false;
    this.cancelRenderLifecycleScope();
    this.attachmentReads.abortReads();
    // Flush while stateValue still points at the active session. Composer
    // persistence is owned here so controller registration order cannot lose it.
    this.composerPersistence.stop();
    this.stopChatEffects();
    this.stateValue = undefined;
    this.scrollAfterUpdate = false;
    this.scrollContentChangedAfterUpdate = false;
    this.forceScrollAfterUpdate = false;
  }
}
