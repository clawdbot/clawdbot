// Chat-owned composer orchestration.
import { nothing } from "lit";
import { loadSettings, normalizeChatSendShortcut, patchSettings } from "../../../app/settings.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";
import { ComposerDictationController, insertComposerDictation } from "../composer-dictation.ts";
import { discoverRealtimeTalkInputs } from "../realtime-talk-input.ts";
import { isLargePastedTextAttachment } from "./chat-attachments.ts";
import { renderContextNotice } from "./chat-composer-context.ts";
import { renderMicrophonePicker, type ChatRunControlsProps } from "./chat-composer-controls.ts";
import {
  adjustTextareaHeight,
  disconnectTextareaOverflowObserver,
  observeTextareaOverflow,
  restoreHistoryCaret,
  scheduleTextareaHeightAdjustment,
} from "./chat-composer-dom.ts";
import {
  exportMarkdown,
  getActiveSlashMenuOptionId,
  getActiveSlashMenuOptionLabel,
  isSlashMenuVisible,
  paneDomId,
  resetSlashMenuState,
  scrollActiveSlashMenuOptionIntoView,
  selectSlashArg,
  selectSlashCommand,
  tabCompleteSlashCommand,
  tokenEstimate,
  updateSlashMenu,
} from "./chat-composer-slash-menu.ts";
import {
  clearPendingClearedSubmittedDraft,
  commitComposerDraft,
  composerDraftKey,
  consumeComposerInputIntent,
  getChatComposerState,
  hasTerminalRunStatus,
  isCurrentSessionSubmittedProgress,
  markComposerInputIntent,
  suppressStaleSubmittedDraftReplay,
} from "./chat-composer-state.ts";
import type { ChatComposerProps } from "./chat-composer-types.ts";
import { renderChatComposerView } from "./chat-composer-view.ts";
import { createGatewayQuestionPanelProps } from "./chat-question-card.ts";

export { isChatRunWorking, resetChatComposerState } from "./chat-composer-state.ts";

export function renderChatComposer(props: ChatComposerProps) {
  const state = getChatComposerState(props.paneId);
  const canCompose = props.canSend;
  const isBusy = props.sending || props.stream !== null;
  const canAbort = Boolean(props.canAbort && props.onAbort);
  const hasTerminalStatus = hasTerminalRunStatus(props.runStatus);
  const showAbortableUi = canAbort && !hasTerminalStatus;
  const submittedProgress = props.queue.find((item) =>
    isCurrentSessionSubmittedProgress(item, props.sessionKey, props.runStatus),
  );
  const showSubmittedProgressUi = Boolean(submittedProgress);
  const composerRunStatus =
    showAbortableUi || showSubmittedProgressUi
      ? { phase: "in-progress" as const }
      : props.runStatus;
  const compactBusy =
    props.compactionStatus?.phase === "active" || props.compactionStatus?.phase === "retrying";
  const activeSession = props.sessions?.sessions?.find((row) => row.key === props.sessionKey);
  const draftKey = composerDraftKey(props);
  if (state.dictationDraftKey !== null && state.dictationDraftKey !== draftKey) {
    state.dictation?.dispose();
    state.dictation = null;
    state.dictationSelection = null;
  }
  state.dictationDraftKey = draftKey;
  const visibleDraft =
    state.composingDraft?.key === draftKey ? state.composingDraft.value : props.draft;
  const actionDraft = visibleDraft;
  state.textareaRef ??= (element?: Element) => {
    const nextTextarea = element instanceof HTMLTextAreaElement ? element : null;
    const prevTextarea = state.composerTextarea;
    if (prevTextarea && prevTextarea !== nextTextarea) {
      disconnectTextareaOverflowObserver(prevTextarea);
    }
    state.composerTextarea = nextTextarea;
    if (nextTextarea) {
      observeTextareaOverflow(nextTextarea);
      scheduleTextareaHeightAdjustment(nextTextarea);
      if (state.restoreComposerFocus) {
        state.restoreComposerFocus = false;
        queueMicrotask(() => state.composerTextarea?.focus({ preventScroll: true }));
      }
    }
  };
  // The stable ref only measures on attach, so programmatic draft swaps (send
  // clear, session switch, history restore) must re-measure explicitly.
  if (state.composerTextarea?.isConnected && state.composerTextarea.value !== visibleDraft) {
    scheduleTextareaHeightAdjustment(state.composerTextarea);
  }
  const hasVisualAttachments = (props.attachments ?? []).some(
    (attachment) => !isLargePastedTextAttachment(attachment),
  );
  const tokens = tokenEstimate(visibleDraft);
  const contextNotice = renderContextNotice(
    activeSession,
    props.sessions?.defaults?.contextTokens ?? null,
    {
      compactBusy,
      compactDisabled: !props.connected || !canCompose || isBusy || showAbortableUi,
      messages: props.messages,
      onCompact: props.onCompact,
      providerUsage: props.providerUsage,
    },
  );
  const composerControls = props.composerControls ?? nothing;
  const assistantName = props.assistantName || "OpenClaw";
  const inProgressLabel = props.waitingApproval
    ? t("chat.waitingForApproval")
    : submittedProgress?.sendState === "waiting-model"
      ? t("chat.composer.preparingModel")
      : props.stream !== null
        ? t("chat.composer.responding", { name: assistantName })
        : props.sending || submittedProgress
          ? t("chat.composer.sendingMessage")
          : t("chat.composer.working", { name: assistantName });
  // Persistent sr-only live region: run phases are otherwise conveyed only
  // visually (thread spark, content arriving, interrupted toast).
  const runStatusAnnouncement =
    composerRunStatus == null
      ? ""
      : composerRunStatus.phase === "in-progress"
        ? inProgressLabel
        : composerRunStatus.phase === "done"
          ? t("chat.composer.runDone")
          : t("chat.composer.runInterrupted");
  const requestUpdate = props.onRequestUpdate ?? (() => {});
  const sendShortcut = normalizeChatSendShortcut(props.sendShortcut);
  const gatewayQuestionPrompts =
    props.gatewayQuestionPrompts?.filter(
      (prompt) =>
        prompt.status === "pending" &&
        prompt.sessionKey !== undefined &&
        areUiSessionKeysEquivalent(prompt.sessionKey, props.sessionKey),
    ) ?? [];
  let gatewayQuestionIndex = gatewayQuestionPrompts.findIndex(
    (prompt) => prompt.id === state.activeGatewayQuestionId,
  );
  if (gatewayQuestionIndex < 0 && gatewayQuestionPrompts.length > 0) {
    gatewayQuestionIndex = 0;
    state.activeGatewayQuestionId = gatewayQuestionPrompts[0]?.id ?? null;
    state.gatewayQuestionCollapsed = false;
  } else if (gatewayQuestionPrompts.length === 0) {
    state.activeGatewayQuestionId = null;
    state.gatewayQuestionCollapsed = false;
  }
  const gatewayQuestionPrompt = gatewayQuestionPrompts[gatewayQuestionIndex];
  const selectGatewayQuestion = (index: number) => {
    const prompt = gatewayQuestionPrompts[index];
    if (!prompt) {
      return;
    }
    state.activeGatewayQuestionId = prompt.id;
    state.gatewayQuestionCollapsed = false;
    requestUpdate();
  };
  const questionPanelProps = gatewayQuestionPrompt
    ? createGatewayQuestionPanelProps(gatewayQuestionPrompt, {
        nowMs: Date.now(),
        collapsed: state.gatewayQuestionCollapsed,
        onCollapsedChange: (collapsed) => {
          state.gatewayQuestionCollapsed = collapsed;
          state.restoreComposerFocus = collapsed;
          requestUpdate();
        },
        onChange: props.onGatewayQuestionChange,
        onSubmit: props.onGatewayQuestionSubmit
          ? (answers) => props.onGatewayQuestionSubmit?.(gatewayQuestionPrompt.id, answers)
          : undefined,
        onSkip: props.onGatewayQuestionSkip
          ? () => props.onGatewayQuestionSkip?.(gatewayQuestionPrompt.id)
          : undefined,
        requestPosition:
          gatewayQuestionPrompts.length > 1
            ? { current: gatewayQuestionIndex + 1, total: gatewayQuestionPrompts.length }
            : undefined,
        onPreviousRequest: () =>
          selectGatewayQuestion(
            (gatewayQuestionIndex - 1 + gatewayQuestionPrompts.length) %
              gatewayQuestionPrompts.length,
          ),
        onNextRequest: () =>
          selectGatewayQuestion((gatewayQuestionIndex + 1) % gatewayQuestionPrompts.length),
      })
    : null;
  const questionTakeoverActive = Boolean(questionPanelProps && !state.gatewayQuestionCollapsed);
  if (!state.questionTakeoverActive && questionTakeoverActive) {
    // A question can arrive mid-IME composition before compositionend commits the host draft.
    // Commit before unmounting so the detached input cannot leave a stale shadow behind.
    if (state.composingDraft?.key === draftKey) {
      commitComposerDraft(props, state.composingDraft.value);
      state.composingDraft = null;
    }
    state.composerComposing = false;
  }
  if (state.questionTakeoverActive && !questionTakeoverActive) {
    state.restoreComposerFocus = true;
  }
  state.questionTakeoverActive = questionTakeoverActive;
  const showComposer = !questionTakeoverActive;

  const placeholder =
    !canCompose && props.disabledReason
      ? props.disabledReason
      : hasVisualAttachments
        ? t("chat.composer.placeholderWithAttachments")
        : t("chat.composer.placeholder", { name: props.assistantName || "agent" });

  // Offline text and attachments may enter the persisted reconnect queue, but
  // slash commands are live controls and must not execute against stale state.
  const canSubmitDraft = (draft: string) =>
    canCompose && (props.connected || !draft.trimStart().startsWith("/"));

  const syncComposerDraftAfterSend = (target: HTMLTextAreaElement | null) => {
    const submittedDraft = target?.value ?? props.getDraft?.() ?? props.draft;
    const hostDraft = props.getDraft?.() ?? props.draft;
    const clearedSubmittedDraft =
      hostDraft === "" && submittedDraft !== "" && target?.value === submittedDraft;
    if (clearedSubmittedDraft) {
      state.pendingClearedSubmittedDraft = {
        key: draftKey,
        value: submittedDraft,
      };
    } else {
      clearPendingClearedSubmittedDraft(state, draftKey);
    }
    if (target && target.value !== hostDraft) {
      target.value = hostDraft;
      adjustTextareaHeight(target);
    }
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (state.composerComposing || event.isComposing || event.keyCode === 229) {
      return;
    }

    if (
      props.connected &&
      state.slashMenuOpen &&
      state.slashMenuMode === "args" &&
      state.slashMenuArgItems.length > 0
    ) {
      const len = state.slashMenuArgItems.length;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          state.slashMenuIndex = (state.slashMenuIndex + 1) % len;
          requestUpdate();
          scrollActiveSlashMenuOptionIntoView(state, props.paneId);
          return;
        case "ArrowUp":
          event.preventDefault();
          state.slashMenuIndex = (state.slashMenuIndex - 1 + len) % len;
          requestUpdate();
          scrollActiveSlashMenuOptionIntoView(state, props.paneId);
          return;
        case "Tab":
          event.preventDefault();
          {
            const arg = state.slashMenuArgItems[state.slashMenuIndex];
            if (arg !== undefined) {
              selectSlashArg(arg, props, requestUpdate, false);
            }
          }
          return;
        case "Enter":
          event.preventDefault();
          {
            const arg = state.slashMenuArgItems[state.slashMenuIndex];
            if (arg !== undefined) {
              selectSlashArg(arg, props, requestUpdate, true);
            }
          }
          return;
        case "Escape":
          event.preventDefault();
          state.slashMenuOpen = false;
          resetSlashMenuState(state);
          requestUpdate();
          return;
      }
    }

    if (props.connected && state.slashMenuOpen && state.slashMenuItems.length > 0) {
      const len = state.slashMenuItems.length;
      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          state.slashMenuIndex = (state.slashMenuIndex + 1) % len;
          requestUpdate();
          scrollActiveSlashMenuOptionIntoView(state, props.paneId);
          return;
        case "ArrowUp":
          event.preventDefault();
          state.slashMenuIndex = (state.slashMenuIndex - 1 + len) % len;
          requestUpdate();
          scrollActiveSlashMenuOptionIntoView(state, props.paneId);
          return;
        case "Tab":
          event.preventDefault();
          {
            const command = state.slashMenuItems[state.slashMenuIndex];
            if (command) {
              tabCompleteSlashCommand(command, props, requestUpdate);
            }
          }
          return;
        case "Enter":
          event.preventDefault();
          {
            const command = state.slashMenuItems[state.slashMenuIndex];
            if (command) {
              selectSlashCommand(command, props, requestUpdate);
            }
          }
          return;
        case "Escape":
          event.preventDefault();
          state.slashMenuOpen = false;
          resetSlashMenuState(state);
          requestUpdate();
          return;
      }
    }

    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && props.onHistoryKeydown) {
      const target = event.target as HTMLTextAreaElement;
      commitComposerDraft(props, target.value);
      const result = props.onHistoryKeydown({
        key: event.key,
        selectionStart: target.selectionStart,
        selectionEnd: target.selectionEnd,
        valueLength: target.value.length,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        isComposing: event.isComposing,
        keyCode: event.keyCode,
      });
      if (result.handled) {
        if (result.preventDefault) {
          event.preventDefault();
        }
        // History navigation updates the renderer-owned draft outside a
        // reactive property; commit it before placing the caret in the DOM.
        requestUpdate();
        if (result.restoreCaret) {
          restoreHistoryCaret(target, result.restoreCaret);
        }
        return;
      }
    }

    const sendShortcutMatches = sendShortcut === "enter" || event.metaKey || event.ctrlKey;
    if (event.key === "Enter" && !event.shiftKey && sendShortcutMatches) {
      if (!canSubmitDraft((event.target as HTMLTextAreaElement).value)) {
        return;
      }
      event.preventDefault();
      const target = event.target as HTMLTextAreaElement;
      commitComposerDraft(props, target.value);
      props.onSend();
      syncComposerDraftAfterSend(target);
    }
  };

  const syncComposerValue = (target: HTMLTextAreaElement) => {
    adjustTextareaHeight(target);
    commitComposerDraft(props, target.value);
    updateSlashMenu(target.value, requestUpdate, props, {}, () => target.value);
    requestUpdate();
  };
  const handleBeforeInput = (event: InputEvent) => {
    if (!state.composerComposing && !event.isComposing) {
      markComposerInputIntent(state, composerDraftKey(props));
    }
  };
  const handleInput = (event: InputEvent) => {
    const target = event.target as HTMLTextAreaElement;
    const hasInputIntent = consumeComposerInputIntent(state, draftKey);
    if (state.composerComposing || event.isComposing) {
      state.composingDraft = { key: draftKey, value: target.value };
      requestUpdate();
      return;
    }
    if (state.composingDraft?.key === draftKey) {
      state.composingDraft = null;
    }
    if (
      suppressStaleSubmittedDraftReplay(
        target,
        event,
        props.getDraft?.() ?? props.draft,
        hasInputIntent,
        state,
      )
    ) {
      return;
    }
    syncComposerValue(target);
    props.onTypingChange?.(Boolean(target.value.trim()));
  };
  const handleCompositionEnd = (event: CompositionEvent) => {
    state.composerComposing = false;
    if (state.composingDraft?.key === draftKey) {
      state.composingDraft = null;
    }
    syncComposerValue(event.target as HTMLTextAreaElement);
    props.onTypingChange?.(Boolean((event.target as HTMLTextAreaElement).value.trim()));
  };
  const handleBlur = (event: FocusEvent) => {
    const target = event.target as HTMLTextAreaElement;
    if (state.composingDraft?.key === draftKey) {
      state.composingDraft = null;
    }
    commitComposerDraft(props, target.value);
    props.onTypingChange?.(false);
  };
  const handleSend = () => {
    const draft = state.composerTextarea?.value ?? props.draft;
    if (!canSubmitDraft(draft)) {
      return;
    }
    commitComposerDraft(props, draft);
    props.onTypingChange?.(false);
    props.onSend();
    syncComposerDraftAfterSend(state.composerTextarea);
  };
  const handleVoicePrimaryAction = () => {
    if (props.realtimeTalkActive) {
      props.onToggleRealtimeTalk?.();
      return;
    }
    const liveDraft = state.composerTextarea?.value ?? visibleDraft;
    if (liveDraft.trim() || props.attachments?.length) {
      handleSend();
      return;
    }
    props.onToggleRealtimeTalk?.();
  };
  const openMicrophonePicker = () => {
    if (state.microphonePickerOpen) {
      return;
    }
    state.microphonePickerOpen = true;
    state.microphonePickerLoading = true;
    state.microphoneWarning = null;
    const request = ++state.microphoneDiscoveryRequest;
    requestUpdate();
    void discoverRealtimeTalkInputs(true)
      .then((result) => {
        if (request !== state.microphoneDiscoveryRequest) {
          return;
        }
        state.microphoneDevices = result.devices;
        state.microphoneWarning = result.warning;
      })
      .catch((error: unknown) => {
        if (request !== state.microphoneDiscoveryRequest) {
          return;
        }
        state.microphoneDevices = [];
        state.microphoneWarning =
          error instanceof Error ? error.message : t("chat.composer.microphoneAccessFailed");
      })
      .finally(() => {
        if (request !== state.microphoneDiscoveryRequest) {
          return;
        }
        state.microphonePickerLoading = false;
        requestUpdate();
      });
  };
  const closeMicrophonePicker = () => {
    if (!state.microphonePickerOpen) {
      return;
    }
    state.microphonePickerOpen = false;
    requestUpdate();
  };
  const selectMicrophone = (deviceId: string) => {
    patchSettings({ realtimeTalkInputDeviceId: deviceId.trim() || undefined });
    state.microphonePickerOpen = false;
    requestUpdate();
  };
  const selectedMicrophoneId = loadSettings().realtimeTalkInputDeviceId?.trim() ?? "";
  const microphonePicker = props.onToggleRealtimeTalk
    ? renderMicrophonePicker({
        devices: state.microphoneDevices,
        loading: state.microphonePickerLoading,
        open: state.microphonePickerOpen,
        selectedDeviceId: selectedMicrophoneId,
        voiceActive: Boolean(props.realtimeTalkActive),
        warning: state.microphoneWarning,
        onOpen: openMicrophonePicker,
        onClose: closeMicrophonePicker,
        onSelect: selectMicrophone,
      })
    : nothing;
  const dictationOptions = {
    client: props.gatewayClient ?? null,
    connected: props.connected,
    enabled: props.composerHoldToRecord !== false,
    realtimeTalkActive: props.realtimeTalkActive === true,
    onCommit: (transcript: string) => {
      const target = state.composerTextarea;
      const selection = state.dictationSelection ?? {
        start: target?.selectionStart ?? visibleDraft.length,
        end: target?.selectionEnd ?? visibleDraft.length,
      };
      const currentDraft = target?.value ?? props.getDraft?.() ?? props.draft;
      const insertion = insertComposerDictation(
        currentDraft,
        transcript,
        selection.start,
        selection.end,
      );
      if (target) {
        target.value = insertion.value;
        adjustTextareaHeight(target);
      }
      commitComposerDraft(props, insertion.value);
      state.dictationSelection = null;
      requestUpdate();
      queueMicrotask(() => {
        const textarea = state.composerTextarea;
        if (!textarea) {
          return;
        }
        textarea.focus({ preventScroll: true });
        textarea.selectionStart = insertion.caret;
        textarea.selectionEnd = insertion.caret;
      });
    },
    onError: (message: string) => props.onDictationError?.(message),
    onStateChange: requestUpdate,
    // With an initial empty composer, this button retains the existing
    // send-after-typing behavior until the host rerenders the primary actions.
    // Once a draft is rendered, the separate voice control starts Talk directly.
    onTap:
      actionDraft.trim() || props.attachments?.length
        ? () => props.onToggleRealtimeTalk?.()
        : handleVoicePrimaryAction,
  };
  state.dictation ??= new ComposerDictationController(dictationOptions);
  state.dictation.update(dictationOptions);
  const dictation =
    props.onToggleRealtimeTalk && props.composerHoldToRecord !== false
      ? state.dictation
      : undefined;
  const handleDictationPointerDown = (event: PointerEvent) => {
    const target = state.composerTextarea;
    state.dictationSelection = {
      start: target?.selectionStart ?? visibleDraft.length,
      end: target?.selectionEnd ?? visibleDraft.length,
    };
    if (dictation?.handlePointerDown(event) && target) {
      target.readOnly = true;
    }
  };
  const runControlsProps: ChatRunControlsProps = {
    canAbort: showAbortableUi,
    canSend: canSubmitDraft(actionDraft),
    connected: props.connected,
    draft: actionDraft,
    hasAttachments: !props.suggestionComposer && Boolean(props.attachments?.length),
    hasMessages: props.messages.length > 0,
    isBusy,
    followUpMode: props.followUpMode,
    suggestionComposer: props.suggestionComposer,
    sending: props.sending,
    voiceActive: props.realtimeTalkActive,
    voiceStatus: props.realtimeTalkStatus,
    voiceDetail: props.realtimeTalkDetail,
    voiceInputLevel: props.realtimeTalkInputLevel,
    voiceVideoCapable: props.realtimeTalkVideoCapable,
    voiceVideoEnabled: Boolean(props.realtimeTalkVideoStream),
    voiceVideoPending: props.realtimeTalkVideoPending,
    onAbort: props.onAbort,
    onExport: () => exportMarkdown(props),
    onNewSession: props.onNewSession,
    onSend: handleSend,
    onStoreDraft: () => {},
    onToggleVoice: props.onToggleRealtimeTalk ? handleVoicePrimaryAction : undefined,
    onToggleCamera: props.onToggleRealtimeCamera,
    microphonePicker,
    dictation,
    onDictationPointerDown: handleDictationPointerDown,
  };
  const cameraFacingMode = props.realtimeTalkVideoStream
    ?.getVideoTracks?.()[0]
    ?.getSettings?.().facingMode;
  const mirrorCameraPreview = cameraFacingMode !== "environment";
  const slashMenuVisible = props.connected && canCompose && isSlashMenuVisible(state);
  const activeSlashMenuOptionId = getActiveSlashMenuOptionId(state, props.paneId);
  const activeSlashMenuOptionLabel = getActiveSlashMenuOptionLabel(state);
  const slashMenuListboxId = paneDomId(props.paneId, "slash-menu-listbox");
  const slashMenuAnnouncementId = paneDomId(props.paneId, "slash-active-announcement");

  return renderChatComposerView({
    props,
    state,
    canCompose,
    showAbortableUi,
    activeSession,
    visibleDraft,
    tokens,
    contextNotice,
    composerControls,
    runStatusAnnouncement,
    requestUpdate,
    sendShortcut,
    questionPanelProps,
    showComposer,
    placeholder,
    handleKeyDown,
    handleBeforeInput,
    handleInput,
    draftKey,
    handleCompositionEnd,
    handleBlur,
    dictation,
    runControlsProps,
    mirrorCameraPreview,
    slashMenuVisible,
    activeSlashMenuOptionId,
    activeSlashMenuOptionLabel,
    slashMenuListboxId,
    slashMenuAnnouncementId,
    composerRunStatus,
  });
}
