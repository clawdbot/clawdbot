import { html, nothing } from "lit";
import type { SessionGoal } from "../../../api/types.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatGoalDraftMode } from "../../../lib/chat/chat-types.ts";
import type { SlashCommandDef } from "../../../lib/chat/commands.ts";
import { adjustTextareaHeight } from "./chat-composer-dom.ts";
import { resetSkillMenuState } from "./chat-composer-skill-menu.ts";
import { resetSlashMenuState } from "./chat-composer-slash-menu.ts";
import { commitComposerDraft, composerDraftKey } from "./chat-composer-state.ts";
import type { ChatComposerProps, ChatComposerState } from "./chat-composer-types.ts";

export function createGoalComposerController(
  props: ChatComposerProps,
  state: ChatComposerState,
  requestUpdate: () => void,
) {
  const key = composerDraftKey(props);
  const current = () =>
    state.composerDraftScopeKey === key && state.goalComposer?.key === key
      ? state.goalComposer
      : null;
  if (props.goalDraftMode !== undefined) {
    const restored = props.goalDraftMode;
    const mode = current();
    const unchanged =
      mode &&
      restored &&
      mode.action === restored.action &&
      mode.sessionId === restored.sessionId &&
      (mode.action !== "edit" ||
        (restored.action === "edit" &&
          mode.goalId === restored.goalId &&
          mode.previousDraft === restored.previousDraft));
    if (!unchanged) {
      state.goalComposer = restored ? { ...restored, key, pending: false } : null;
    }
  }
  const replaceDraft = (draft: string) => {
    commitComposerDraft(props, draft);
    const textarea = state.composerTextarea;
    if (textarea) {
      textarea.value = draft;
      adjustTextareaHeight(textarea);
    }
  };
  const focus = () => queueMicrotask(() => state.composerTextarea?.focus({ preventScroll: true }));
  const cancel = () => {
    const mode = current();
    if (!mode || mode.pending) {
      return;
    }
    state.goalComposer = null;
    props.onGoalDraftModeChange?.(null);
    // Editing borrows the composer; cancelling returns its original conversation draft.
    if (mode.action === "edit") {
      replaceDraft(mode.previousDraft);
    }
    requestUpdate();
    focus();
  };
  const begin = (goal?: SessionGoal) => {
    if (!props.onGoalSubmit || current()?.pending) {
      return;
    }
    const previousDraft = state.composerTextarea?.value ?? props.getDraft?.() ?? props.draft;
    const mode: ChatGoalDraftMode = {
      ...(props.currentSessionId ? { sessionId: props.currentSessionId } : {}),
      ...(goal ? { action: "edit", goalId: goal.id, previousDraft } : { action: "start" }),
    };
    state.goalComposer = { ...mode, key, pending: false };
    props.onGoalDraftModeChange?.(mode);
    resetSlashMenuState(state);
    resetSkillMenuState(state);
    replaceDraft(goal?.objective ?? "");
    requestUpdate();
    focus();
  };
  return {
    get active() {
      return current() !== null;
    },
    get pending() {
      return current()?.pending === true;
    },
    get submissionLabel() {
      const mode = current();
      return mode ? t(mode.action === "edit" ? "chat.goals.save" : "chat.goals.start") : undefined;
    },
    begin,
    activateCommand(command: SlashCommandDef) {
      if (
        command.key !== "goal" ||
        command.source !== "native" ||
        state.slashMenuCompletion?.inline ||
        !props.onGoalSubmit
      ) {
        return false;
      }
      begin();
      return true;
    },
    cancel,
    async submit(submissionAction?: Event) {
      const mode = current();
      const objective = state.composerTextarea?.value ?? props.getDraft?.() ?? props.draft;
      if (!mode || mode.pending || !props.onGoalSubmit || !objective.trim()) {
        return;
      }
      replaceDraft(objective);
      mode.pending = true;
      requestUpdate();
      try {
        const submitted = await props.onGoalSubmit(
          {
            ...(mode.sessionId ? { sessionId: mode.sessionId } : {}),
            ...(mode.action === "start"
              ? { action: "start", objective }
              : { action: "edit", goalId: mode.goalId, objective }),
          },
          submissionAction,
        );
        if (submitted && current() === mode) {
          state.goalComposer = null;
          props.onGoalDraftModeChange?.(null);
          if (mode.action === "edit") {
            replaceDraft(mode.previousDraft);
          }
        }
      } finally {
        mode.pending = false;
        requestUpdate();
      }
    },
    render() {
      const mode = current();
      return mode
        ? html`<div
            class="agent-chat__goal-mode"
            role="group"
            aria-label=${t("chat.goals.composerMode")}
          >
            <span class="agent-chat__goal-mode-label"
              >${icons.flag}${t(
                mode.action === "edit" ? "chat.goals.edit" : "chat.goals.composerMode",
              )}</span
            >
            <span class="agent-chat__goal-mode-hint"
              >${t(mode.action === "edit" ? "chat.goals.editHint" : "chat.goals.startHint")}</span
            >
            <button
              type="button"
              class="agent-chat__goal-action"
              aria-label=${t("chat.goals.cancel")}
              ?disabled=${mode.pending}
              @click=${cancel}
            >
              ${icons.x}
            </button>
          </div>`
        : nothing;
    },
  };
}

export type GoalComposerController = ReturnType<typeof createGoalComposerController>;
