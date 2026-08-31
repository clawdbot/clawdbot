import type { ChatFollowUpMode, ChatSendShortcut } from "../../../app/settings.ts";
import { steerableQueuedMessage } from "../chat-queue.ts";
import { restoreHistoryCaret } from "./chat-composer-dom.ts";
import type { GoalComposerController } from "./chat-composer-goal-mode.ts";
import { handleSkillMenuKeydown, type SkillMenuHost } from "./chat-composer-skill-menu.ts";
import {
  handleInlineSlashArgKeydown,
  handleSlashMenuKeydown,
  type SlashMenuHost,
} from "./chat-composer-slash-menu.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

type ComposerKeyDownDeps = {
  state: ChatComposerState;
  props: ChatComposerProps;
  skillMenuHost: SkillMenuHost;
  slashMenuHost: SlashMenuHost;
  requestUpdate: () => void;
  sendShortcut: ChatSendShortcut;
  canSubmitDraft: (draft: string) => boolean;
  commitDraft: (draft: string) => void;
  syncDraftAfterSend: (target: HTMLTextAreaElement | null) => void;
  showAbortableUi: boolean;
  alternateFollowUpMode?: ChatFollowUpMode;
  goalComposer: GoalComposerController;
};

export function createComposerKeyDownHandler({
  state,
  props,
  skillMenuHost,
  slashMenuHost,
  requestUpdate,
  sendShortcut,
  canSubmitDraft,
  commitDraft,
  syncDraftAfterSend,
  showAbortableUi,
  alternateFollowUpMode,
  goalComposer,
}: ComposerKeyDownDeps): (event: KeyboardEvent) => void {
  return (event) => {
    // The handler only ever binds to the composer textarea; narrowing here
    // keeps the draft/selection reads below assertion-free.
    const target = event.target;
    if (!(target instanceof HTMLTextAreaElement)) {
      return;
    }
    if (state.composerComposing || event.isComposing || event.keyCode === 229) {
      return;
    }

    if (goalComposer.active) {
      if (event.key === "Escape") {
        event.preventDefault();
        goalComposer.cancel();
      } else if (
        event.key === "Enter" &&
        !event.shiftKey &&
        (sendShortcut === "enter" || event.metaKey || event.ctrlKey) &&
        canSubmitDraft(target.value)
      ) {
        event.preventDefault();
        commitDraft(target.value);
        void goalComposer.submit(event);
      }
      return;
    }

    if (props.connected && handleSkillMenuKeydown(event, state, skillMenuHost, requestUpdate)) {
      return;
    }

    if (
      props.connected &&
      handleInlineSlashArgKeydown(event, state, slashMenuHost, requestUpdate, sendShortcut)
    ) {
      return;
    }

    if (props.connected && handleSlashMenuKeydown(event, state, slashMenuHost, requestUpdate)) {
      return;
    }

    if ((event.key === "ArrowUp" || event.key === "ArrowDown") && props.onHistoryKeydown) {
      commitDraft(target.value);
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

    if (
      event.key === "Escape" &&
      !state.skillMenuOpen &&
      !state.slashMenuOpen &&
      !props.replyTarget &&
      !state.dictation?.active &&
      showAbortableUi &&
      props.onAbort
    ) {
      event.preventDefault();
      props.onAbort();
      return;
    }

    const sendShortcutMatches = sendShortcut === "enter" || event.metaKey || event.ctrlKey;
    if (event.key === "Enter" && !event.shiftKey && sendShortcutMatches) {
      // Holding send is one action, even after the draft clears into the queue.
      if (event.repeat) {
        event.preventDefault();
        return;
      }
      const attachments = props.getAttachments?.() ?? props.attachments ?? [];
      const hasComposedContent = Boolean(target.value.trim() || attachments.length);
      if (!hasComposedContent) {
        // Mirror the queue chip's Steer availability exactly (visible surface,
        // connected + composable gate), or offline Enter would swallow the key
        // and invoke a lifecycle that returns with no visible outcome.
        const queued =
          showAbortableUi && props.connected && props.canSend && props.onQueueSteer
            ? steerableQueuedMessage(props.queue)
            : undefined;
        if (queued) {
          event.preventDefault();
          props.onQueueSteer?.(queued.id);
          return;
        }
        if (canSubmitDraft(target.value)) {
          event.preventDefault();
        }
        return;
      }
      if (!canSubmitDraft(target.value)) {
        return;
      }
      event.preventDefault();
      commitDraft(target.value);
      const followUpModeOverride =
        (event.metaKey || event.ctrlKey) && !event.altKey ? alternateFollowUpMode : undefined;
      props.onSend(followUpModeOverride, event);
      syncDraftAfterSend(target);
    }
  };
}
