// Chat UI cards for model-proposed follow-up tasks.
import { html, nothing } from "lit";
import type { TaskSuggestion } from "../../../../../packages/gateway-protocol/src/index.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";

export function renderChatTaskSuggestions(props: {
  suggestions: TaskSuggestion[];
  busyIds: ReadonlySet<string>;
  canAccept: boolean;
  canDismiss: boolean;
  onAccept: (suggestion: TaskSuggestion) => void;
  onDismiss: (suggestion: TaskSuggestion) => void;
}) {
  if (props.suggestions.length === 0) {
    return nothing;
  }
  return html`
    <div class="task-suggestions" aria-live="polite">
      ${props.suggestions.map((suggestion) => {
        const busy = props.busyIds.has(suggestion.id);
        return html`
          <article class="task-suggestion" data-task-id=${suggestion.id}>
            <div class="task-suggestion__icon" aria-hidden="true">${icons.spark}</div>
            <div class="task-suggestion__body">
              <div class="task-suggestion__eyebrow">${t("chat.taskSuggestions.eyebrow")}</div>
              <div class="task-suggestion__title">${suggestion.title}</div>
              <div class="task-suggestion__summary">${suggestion.tldr}</div>
              <div class="task-suggestion__details">
                <div class="task-suggestion__detail">
                  <span>${t("chat.taskSuggestions.project")}</span>
                  <code>${suggestion.cwd}</code>
                </div>
                <div class="task-suggestion__detail task-suggestion__detail--instructions">
                  <span>${t("chat.taskSuggestions.instructions")}</span>
                  <pre>${suggestion.prompt}</pre>
                </div>
              </div>
            </div>
            <div class="task-suggestion__actions">
              <button
                class="btn btn--primary task-suggestion__start"
                type="button"
                ?disabled=${busy || !props.canAccept}
                title=${props.canAccept ? "" : t("chat.taskSuggestions.adminRequired")}
                @click=${() => props.onAccept(suggestion)}
              >
                ${icons.play}
                ${busy ? t("chat.taskSuggestions.starting") : t("chat.taskSuggestions.start")}
              </button>
              ${props.canDismiss
                ? html`
                    <button
                      class="btn btn--ghost btn--icon task-suggestion__dismiss"
                      type="button"
                      ?disabled=${busy}
                      aria-label=${t("chat.taskSuggestions.dismiss", {
                        title: suggestion.title,
                      })}
                      @click=${() => props.onDismiss(suggestion)}
                    >
                      ${icons.x}
                    </button>
                  `
                : nothing}
            </div>
          </article>
        `;
      })}
    </div>
  `;
}
