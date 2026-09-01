// Chat-owned composer orchestration.
import { nothing } from "lit";
import {
  loadSettings,
  normalizeChatSendShortcut,
  patchSettings,
  type ChatFollowUpMode,
} from "../../../app/settings.ts";
import "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import type { SlashCommandDef } from "../../../lib/chat/commands.ts";
import { resolveThinkingCommandArgOptionsForSession } from "../../../lib/chat/thinking.ts";
import { areUiSessionKeysEquivalent } from "../../../lib/sessions/session-key.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import { ComposerDictationController, insertComposerDictation } from "../composer-dictation.ts";
import { normalizeChatComposerDraft } from "../composer-draft.ts";
import { ComposerMicrophonePicker } from "../composer-microphone-picker.ts";
import { isLargePastedTextAttachment } from "./chat-attachments.ts";
import { renderContextNotice } from "./chat-composer-context.ts";
import { renderMicrophonePicker, type ChatRunControlsProps } from "./chat-composer-controls.ts";
import {
  adjustTextareaHeight,
  disconnectTextareaOverflowObserver,
  observeTextareaOverflow,
  paneDomId,
  preserveComposerFocusOnPrimaryAction,
  replaceComposerPopoverAnchor,
  scheduleTextareaHeightAdjustment,
} from "./chat-composer-dom.ts";
import { createGoalComposerController } from "./chat-composer-goal-mode.ts";
import { createComposerKeyDownHandler } from "./chat-composer-keydown.ts";
import {
  getActiveSkillMenuOptionId,
  getActiveSkillMenuOptionLabel,
  isSkillMenuVisible,
  resetSkillMenuState,
  type SkillMenuHost,
  updateSkillMenu,
} from "./chat-composer-skill-menu.ts";
import {
  getActiveSlashMenuOptionId,
  getActiveSlashMenuOptionLabel,
  isSlashMenuVisible,
  resetSlashMenuState,
  type SlashMenuHost,
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
import { renderChatPermissionPicker } from "./chat-permission-picker.ts";
import { createGatewayQuestionPanelProps } from "./chat-question-card.ts";

export { isChatRunWorking, resetChatComposerState } from "./chat-composer-state.ts";

function resolveChatSlashCommandArgOptions(
  command: SlashCommandDef,
  props: ChatComposerProps,
): string[] {
  if (command.key !== "think") {
    return command.argOptions ?? [];
  }
  if (props.modelSwitching) {
    return [];
  }
  return resolveThinkingCommandArgOptionsForSession(
    props.selectedSession,
    props.sessions?.defaults,
    props.modelCatalog,
  );
}

export function renderChatComposer(props: ChatComposerProps) {
  const state = getChatComposerState(props.paneId);
  state.slashCommandDispatchConnected = props.connected;
  const canCompose = props.canSend;
  const isBusy = props.sending || props.stream !== null;
  const canAbort = Boolean(props.canAbort && props.onAbort);
  const hasTerminalStatus = hasTerminalRunStatus(props.runStatus);
  const showAbortableUi = canAbort && !hasTerminalStatus;
  const submittedProgress = props.queue.find((item) =>
    isCurrentSessionSubmittedProgress(item, props.sessionKey, props.runStatus),
  );
  const hasSubmittedProgress = props.queue.some(
    (item) =>
      !item.pendingRunId && (item.sendState === "sending" || item.sendState === "waiting-model"),
  );
  const sendingForCurrentSession =
    props.sending && (!hasSubmittedProgress || submittedProgress !== undefined);
  const composerRunStatus =
    sendingForCurrentSession || showAbortableUi || Boolean(submittedProgress)
      ? { phase: "in-progress" as const }
      : props.runStatus;
  const draftKey = composerDraftKey(props);
  if (state.composerDraftScopeKey !== null && state.composerDraftScopeKey !== draftKey) {
    state.dictation?.dispose();
    state.dictation = null;
    state.dictationSelection = null;
  }
  state.composerDraftScopeKey = draftKey;
  const visibleDraft =
    state.composingDraft?.key === draftKey ? state.composingDraft.value : props.draft;
  state.composerInputRef ??= (element?: Element) => {
    state.composerInput = replaceComposerPopoverAnchor(state.composerInput, element);
  };
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
  const contextNotice = renderContextNotice(
    props.selectedSession,
    props.sessions?.defaults?.contextTokens ?? null,
    {
      messages: props.messages,
      providerUsage: props.providerUsage,
    },
  );
  const composerControls = props.composerControls ?? nothing;
  const composerLeadControl = props.permissionPicker
    ? renderChatPermissionPicker(props.permissionPicker)
    : nothing;
  const assistantName = props.assistantName || "OpenClaw";
  const inProgressLabel = props.waitingApproval
    ? t("chat.waitingForApproval")
    : submittedProgress?.sendState === "waiting-model"
      ? t("chat.composer.preparingModel")
      : props.stream !== null
        ? t("chat.composer.responding", { name: assistantName })
        : sendingForCurrentSession || submittedProgress
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
  const goalComposer = createGoalComposerController(props, state, requestUpdate);
  const commitMenuDraft = (next: string) => {
    commitComposerDraft(props, next);
    props.onTypingChange?.(Boolean(next.trim()), next);
  };
  const skillMenuHost: SkillMenuHost = {
    paneId: props.paneId,
    getDraft: () => state.composerTextarea?.value ?? props.getDraft?.() ?? props.draft,
    commitDraft: commitMenuDraft,
    getTextarea: () => state.composerTextarea,
    refreshCommands: props.onSlashIntent,
  };
  const slashMenuHost: SlashMenuHost = {
    paneId: props.paneId,
    getDraft: skillMenuHost.getDraft,
    commitDraft: skillMenuHost.commitDraft,
    getTextarea: () => state.composerTextarea,
    resolveArgOptions: (command) => resolveChatSlashCommandArgOptions(command, props),
    runCommand: () => props.onSend(),
    canRunInlineCommand: () => state.slashCommandDispatchConnected && Boolean(props.onSlashCommand),
    runInlineCommand: props.connected ? props.onSlashCommand : undefined,
    refreshCommands: props.onSlashIntent,
    activateComposerMode: (command) => goalComposer.activateCommand(command),
  };
  const sendShortcut = normalizeChatSendShortcut(props.sendShortcut);
  // Keyboard and tooltip share the opposite action, including inherited queue modes.
  const alternateFollowUpMode: ChatFollowUpMode | undefined =
    props.connected &&
    sendShortcut === "enter" &&
    showAbortableUi &&
    !props.suggestionComposer &&
    props.followUpMode !== undefined &&
    props.followUpMode !== "interrupt"
      ? props.followUpMode === "steer"
        ? "queue"
        : "steer"
      : undefined;
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

  const placeholder = goalComposer.active
    ? t("chat.goals.objectivePlaceholder")
    : hasVisualAttachments
      ? t("chat.composer.placeholderWithAttachments")
      : t("chat.composer.placeholder", { name: props.assistantName || "agent" });

  // Offline text and attachments may enter the persisted reconnect queue, but
  // slash commands are live controls and must not execute against stale state.
  const canSubmitDraft = (draft: string) =>
    canCompose &&
    !goalComposer.pending &&
    state.dictation?.locksComposer !== true &&
    !(state.skillMenuOpen && state.skillCommandRefreshPending) &&
    (props.getPendingAttachmentReads?.() ?? props.pendingAttachmentReads ?? 0) === 0 &&
    (props.connected || !draft.trimStart().startsWith("/"));
  const renderedDraftCanSubmit = canSubmitDraft(visibleDraft);

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

  const handleKeyDown = createComposerKeyDownHandler({
    state,
    props,
    skillMenuHost,
    slashMenuHost,
    requestUpdate,
    sendShortcut,
    canSubmitDraft,
    commitDraft: (draft) => commitComposerDraft(props, draft),
    syncDraftAfterSend: syncComposerDraftAfterSend,
    showAbortableUi,
    alternateFollowUpMode,
    goalComposer,
  });

  const syncComposerValue = (target: HTMLTextAreaElement) => {
    adjustTextareaHeight(target);
    target.dir = detectTextDirection(target.value);
    commitComposerDraft(props, target.value);
    if (!goalComposer.active) {
      updateSlashMenu(target.value, state, slashMenuHost, requestUpdate);
      updateSkillMenu(target.value, target.selectionStart, state, skillMenuHost, requestUpdate);
    }
    // The textarea owns ordinary edits; only redraw the pane when surrounding
    // controls change. Slash and skill menus invalidate their own presentation.
    if (
      Boolean(target.value.trim()) !== Boolean(visibleDraft.trim()) ||
      canSubmitDraft(target.value) !== renderedDraftCanSubmit
    ) {
      requestUpdate();
    }
  };
  const handleBeforeInput = (event: InputEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) {
      return;
    }
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
    props.onTypingChange?.(Boolean(target.value.trim()), target.value);
  };
  const handleSelect = (event: Event) => {
    const target = event.target as HTMLTextAreaElement;
    if (goalComposer.active) {
      return;
    }
    updateSlashMenu(target.value, state, slashMenuHost, requestUpdate);
    updateSkillMenu(target.value, target.selectionStart, state, skillMenuHost, requestUpdate);
  };
  const handleCompositionEnd = (event: CompositionEvent) => {
    state.composerComposing = false;
    if (state.composingDraft?.key === draftKey) {
      state.composingDraft = null;
    }
    syncComposerValue(event.target as HTMLTextAreaElement);
    const value = (event.target as HTMLTextAreaElement).value;
    props.onTypingChange?.(Boolean(value.trim()), value);
  };
  const handleBlur = (event: FocusEvent) => {
    const target = event.target as HTMLTextAreaElement;
    // A dropped compositionend (detach/blur mid-IME) must not wedge the
    // composing flag: it persists across renders and kills Enter-send,
    // history keys, and command menus until the Send button resets it.
    state.composerComposing = false;
    if (state.composingDraft?.key === draftKey) {
      state.composingDraft = null;
    }
    // Dictation owns the read-only preview; blur must not commit discarded speech.
    if (!state.dictation?.locksComposer) {
      const normalizedDraft = normalizeChatComposerDraft(target.value);
      if (target.value !== normalizedDraft) {
        target.value = normalizedDraft;
        adjustTextareaHeight(target);
      }
      commitComposerDraft(props, normalizedDraft);
    }
    props.onTypingChange?.(false);
  };
  const handleSend = (submissionAction?: Event) => {
    const draft = state.composerTextarea?.value ?? props.draft;
    if (!canSubmitDraft(draft)) {
      return;
    }
    state.composerComposing = false;
    state.composingDraft = null;
    commitComposerDraft(props, draft);
    props.onTypingChange?.(false);
    if (goalComposer.active) {
      void goalComposer.submit(submissionAction);
      return;
    }
    props.onSend(undefined, submissionAction);
    syncComposerDraftAfterSend(state.composerTextarea);
  };
  state.microphonePicker ??= new ComposerMicrophonePicker(requestUpdate);
  const devicePicker = state.microphonePicker;
  devicePicker.syncCatalog(props.gatewayClient ?? null, props.connected);
  const startRealtimeTalk = () => {
    if (devicePicker.realtimeStatus !== "ready") {
      devicePicker.handleOpen();
      return;
    }
    props.onToggleRealtimeTalk?.();
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
    startRealtimeTalk();
  };
  const selectedMicrophoneId = loadSettings().realtimeTalkInputDeviceId?.trim() ?? "";
  const microphonePicker = props.onToggleRealtimeTalk
    ? renderMicrophonePicker({
        devices: devicePicker.devices,
        loading: devicePicker.loading,
        open: devicePicker.open,
        selectedDeviceId: selectedMicrophoneId,
        voiceActive: Boolean(props.realtimeTalkActive),
        issue: devicePicker.issue,
        holdToDictate: props.composerHoldToRecord !== false,
        realtimeStatus: devicePicker.realtimeStatus,
        dictationStatus: devicePicker.dictationStatus,
        onOpen: devicePicker.handleOpen,
        onClose: devicePicker.handleClose,
        onSelect: (deviceId: string) => {
          patchSettings({ realtimeTalkInputDeviceId: deviceId.trim() || undefined });
          devicePicker.handleClose();
        },
        onHoldToDictateChange: (enabled: boolean) => {
          if (props.onComposerHoldToRecordChange) {
            props.onComposerHoldToRecordChange(enabled);
          } else {
            patchSettings({ composerHoldToRecord: enabled });
          }
          requestUpdate();
        },
        onOpenTalkSettings: props.onOpenTalkSettings,
        onOpenDictationSettings: props.onOpenDictationSettings,
      })
    : nothing;
  const dictationOptions = {
    client: props.gatewayClient ?? null,
    connected: props.connected,
    enabled: props.composerHoldToRecord !== false,
    dictationAvailable: devicePicker.dictationStatus === "ready",
    realtimeTalkActive: props.realtimeTalkActive === true,
    onCommit: (transcript: string) => {
      const target = state.composerTextarea;
      const selection = state.dictationSelection ?? {
        start: target?.selectionStart ?? visibleDraft.length,
        end: target?.selectionEnd ?? visibleDraft.length,
        value: props.getDraft?.() ?? props.draft,
      };
      const insertion = insertComposerDictation(
        selection.value,
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
    onError: (
      message: string,
      failure: { kind: "interrupted" | "start"; preservesText: boolean },
    ) => {
      const recovery =
        failure.kind === "interrupted" && failure.preservesText
          ? t("chat.composer.dictationInterruptedRecovery")
          : t("chat.composer.dictationStartRecovery");
      state.dictationError = `${message} ${recovery}`;
      requestUpdate();
    },
    onStateChange: requestUpdate,
    onDictationUnavailable: devicePicker.handleOpen,
    // With an initial empty composer, this button retains the existing
    // send-after-typing behavior until the host rerenders the primary actions.
    // Once a draft is rendered, the separate voice control starts Talk directly.
    onTap:
      visibleDraft.trim() || props.attachments?.length
        ? startRealtimeTalk
        : handleVoicePrimaryAction,
  };
  state.dictation ??= new ComposerDictationController(dictationOptions);
  state.dictation.update(dictationOptions);
  const dictation =
    props.onToggleRealtimeTalk && props.composerHoldToRecord !== false
      ? state.dictation
      : undefined;
  const handleDictationPointerDown = (event: PointerEvent) => {
    if (state.dictationError) {
      state.dictationError = null;
      requestUpdate();
    }
    const target = state.composerTextarea;
    const selection = {
      start: target?.selectionStart ?? visibleDraft.length,
      end: target?.selectionEnd ?? visibleDraft.length,
      value: target?.value ?? visibleDraft,
    };
    if (dictation?.handlePointerDown(event)) {
      // Stop also emits pointerdown; only a new gesture owns a draft snapshot.
      state.dictationSelection = selection;
      if (target) {
        target.readOnly = true;
      }
    }
  };
  const runControlsProps: ChatRunControlsProps = {
    canAbort: showAbortableUi,
    canSend: canSubmitDraft(visibleDraft),
    connected: props.connected,
    draft: visibleDraft,
    hasAttachments: !props.suggestionComposer && Boolean(props.attachments?.length),
    isBusy,
    followUpMode: props.followUpMode,
    alternateFollowUpMode,
    suggestionComposer: props.suggestionComposer,
    submissionLabel: goalComposer.submissionLabel,
    sending: props.sending,
    voiceActive: props.realtimeTalkActive,
    voiceStatus: props.realtimeTalkStatus,
    voiceDetail: props.realtimeTalkDetail,
    voiceInputLevel: props.realtimeTalkInputLevel,
    voiceVideoCapable: props.realtimeTalkVideoCapable,
    voiceVideoEnabled: Boolean(props.realtimeTalkVideoStream),
    voiceVideoPending: props.realtimeTalkVideoPending,
    onAbort: props.onAbort,
    onSend: handleSend,
    onToggleVoice: props.onToggleRealtimeTalk ? handleVoicePrimaryAction : undefined,
    onToggleCamera: props.onToggleRealtimeCamera,
    microphonePicker,
    dictation,
    onDictationPointerDown: handleDictationPointerDown,
    onPrimaryActionPointerDown: (event) =>
      preserveComposerFocusOnPrimaryAction(event, state.composerTextarea),
  };
  const cameraFacingMode = props.realtimeTalkVideoStream
    ?.getVideoTracks?.()[0]
    ?.getSettings?.().facingMode;
  const mirrorCameraPreview = cameraFacingMode !== "environment";
  if (props.modelSwitching && state.slashMenuCommand?.key === "think") {
    resetSlashMenuState(state);
  }
  const slashMenuVisible = props.connected && canCompose && isSlashMenuVisible(state);
  const skillMenuVisible = props.connected && canCompose && isSkillMenuVisible(state);
  if (!skillMenuVisible && state.skillMenuOpen && !state.skillCommandRefreshPending) {
    resetSkillMenuState(state);
  }
  const activeSlashMenuOptionId = skillMenuVisible
    ? getActiveSkillMenuOptionId(state, props.paneId)
    : getActiveSlashMenuOptionId(state, props.paneId);
  const activeSlashMenuOptionLabel = skillMenuVisible
    ? getActiveSkillMenuOptionLabel(state)
    : getActiveSlashMenuOptionLabel(state);
  const slashMenuListboxId = paneDomId(
    props.paneId,
    skillMenuVisible ? "skill-menu-listbox" : "slash-menu-listbox",
  );
  const slashMenuAnnouncementId = paneDomId(props.paneId, "slash-active-announcement");

  return renderChatComposerView({
    props,
    state,
    canCompose,
    showAbortableUi,
    activeSession: props.selectedSession,
    visibleDraft,
    contextNotice,
    composerControls,
    composerLeadControl,
    runStatusAnnouncement,
    composerRunStatus,
    requestUpdate,
    sendShortcut,
    questionPanelProps,
    showComposer,
    placeholder,
    handleKeyDown,
    handleBeforeInput,
    handleInput,
    handleSelect,
    draftKey,
    handleCompositionEnd,
    handleBlur,
    dictation,
    runControlsProps,
    mirrorCameraPreview,
    slashMenuVisible,
    skillMenuVisible,
    skillMenuHost,
    slashMenuHost,
    activeSlashMenuOptionId,
    activeSlashMenuOptionLabel,
    slashMenuListboxId,
    slashMenuAnnouncementId,
    goalComposer,
  });
}
