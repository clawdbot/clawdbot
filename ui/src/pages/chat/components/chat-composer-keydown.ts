import type { ChatSendShortcut } from "../../../app/settings.ts";
import { restoreHistoryCaret, scrollActiveMenuOptionIntoView } from "./chat-composer-dom.ts";
import { steerableQueuedMessage } from "./chat-composer-queue.ts";
import {
  getActiveSkillMenuOptionId,
  resetSkillMenuState,
  selectSkillMention,
} from "./chat-composer-skill-menu.ts";
import {
  getActiveSlashMenuOptionId,
  resetSlashMenuState,
  selectSlashArg,
  selectSlashCommand,
  tabCompleteSlashCommand,
} from "./chat-composer-slash-menu.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

type ComposerKeyDownDeps = {
  state: ChatComposerState;
  props: ChatComposerProps;
  requestUpdate: () => void;
  sendShortcut: ChatSendShortcut;
  canSubmitDraft: (draft: string) => boolean;
  commitDraft: (draft: string) => void;
  syncDraftAfterSend: (target: HTMLTextAreaElement | null) => void;
  showAbortableUi: boolean;
};

function handleComposerMenuKeyDown<T>(
  event: KeyboardEvent,
  state: ChatComposerState,
  items: readonly T[],
  paneId: string,
  requestUpdate: () => void,
  onSelect: (item: T, submit: boolean) => void,
  scrollActive: (state: ChatComposerState, paneId: string) => void,
  menu: "slash" | "skill" = "slash",
): boolean {
  if (event.key === "Escape") {
    event.preventDefault();
    if (menu === "skill") {
      resetSkillMenuState(state);
    } else {
      state.slashMenuOpen = false;
      resetSlashMenuState(state);
    }
    requestUpdate();
    return true;
  }
  if (items.length === 0) {
    if (
      menu === "skill" &&
      state.skillCommandRefreshPending &&
      ["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(event.key)
    ) {
      event.preventDefault();
      return true;
    }
    return false;
  }
  const indexKey = menu === "skill" ? "skillMenuIndex" : "slashMenuIndex";
  switch (event.key) {
    case "ArrowDown":
    case "ArrowUp": {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : items.length - 1;
      state[indexKey] = (state[indexKey] + offset) % items.length;
      requestUpdate();
      scrollActive(state, paneId);
      return true;
    }
    case "Tab":
    case "Enter": {
      event.preventDefault();
      const item = items[state[indexKey]];
      if (item !== undefined) {
        onSelect(item, event.key === "Enter");
      }
      return true;
    }
    default:
      return false;
  }
}

export function createComposerKeyDownHandler({
  state,
  props,
  requestUpdate,
  sendShortcut,
  canSubmitDraft,
  commitDraft,
  syncDraftAfterSend,
  showAbortableUi,
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

    if (props.connected && state.skillMenuOpen) {
      if (
        handleComposerMenuKeyDown(
          event,
          state,
          state.skillCommandRefreshPending ? [] : state.skillMenuItems,
          props.paneId,
          requestUpdate,
          (command) => selectSkillMention(command, props, requestUpdate),
          (menuState, paneId) =>
            scrollActiveMenuOptionIntoView(getActiveSkillMenuOptionId(menuState, paneId)),
          "skill",
        )
      ) {
        return;
      }
    }

    if (
      props.connected &&
      state.slashMenuOpen &&
      state.slashMenuMode === "args" &&
      state.slashMenuArgItems.length > 0
    ) {
      if (
        handleComposerMenuKeyDown(
          event,
          state,
          state.slashMenuArgItems,
          props.paneId,
          requestUpdate,
          (arg, submit) => selectSlashArg(arg, props, requestUpdate, submit),
          (menuState, paneId) =>
            scrollActiveMenuOptionIntoView(getActiveSlashMenuOptionId(menuState, paneId)),
        )
      ) {
        return;
      }
    }

    if (props.connected && state.slashMenuOpen && state.slashMenuItems.length > 0) {
      if (
        handleComposerMenuKeyDown(
          event,
          state,
          state.slashMenuItems,
          props.paneId,
          requestUpdate,
          (command, submit) =>
            submit
              ? selectSlashCommand(command, props, requestUpdate)
              : tabCompleteSlashCommand(command, props, requestUpdate),
          (menuState, paneId) =>
            scrollActiveMenuOptionIntoView(getActiveSlashMenuOptionId(menuState, paneId)),
        )
      ) {
        return;
      }
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
      const steerImmediately =
        sendShortcut === "enter" &&
        showAbortableUi &&
        props.followUpMode === "queue" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        hasComposedContent;
      if (steerImmediately) {
        props.onSend({ followUpMode: "steer" });
      } else {
        props.onSend();
      }
      syncDraftAfterSend(target);
    }
  };
}
