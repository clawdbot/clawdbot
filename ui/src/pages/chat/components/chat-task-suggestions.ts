// Chat UI cards for model-proposed follow-up tasks.
import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import type { TaskSuggestion } from "../../../../../packages/gateway-protocol/src/index.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { repoName } from "../../../lib/session-display.ts";

export type ChatTaskSuggestionTrayProps = {
  taskSuggestions?: TaskSuggestion[];
  taskSuggestionBusyIds?: ReadonlySet<string>;
  taskSuggestionCopiedIds?: ReadonlySet<string>;
  activeTaskSuggestionId?: string;
  taskSuggestionSwapDirection?: "next" | "previous";
  taskSuggestionSwapGeneration?: number;
  onNavigateTaskSuggestion?: (taskId: string, direction: "next" | "previous") => void;
  onCopyTaskSuggestionPrompt?: (suggestion: TaskSuggestion) => void;
  canAcceptTaskSuggestions?: boolean;
  canDismissTaskSuggestions?: boolean;
  onAcceptTaskSuggestion?: (suggestion: TaskSuggestion) => void;
  onDismissTaskSuggestion?: (suggestion: TaskSuggestion) => void;
};

export function renderChatTaskSuggestionTray(props: ChatTaskSuggestionTrayProps) {
  return renderChatTaskSuggestions({
    suggestions: props.taskSuggestions ?? [],
    busyIds: props.taskSuggestionBusyIds ?? new Set(),
    copiedIds: props.taskSuggestionCopiedIds ?? new Set(),
    activeId: props.activeTaskSuggestionId,
    swapDirection: props.taskSuggestionSwapDirection,
    swapGeneration: props.taskSuggestionSwapGeneration ?? 0,
    onCopyPrompt: (suggestion) => props.onCopyTaskSuggestionPrompt?.(suggestion),
    canAccept: props.canAcceptTaskSuggestions === true,
    canDismiss: props.canDismissTaskSuggestions === true,
    onAccept: (suggestion) => props.onAcceptTaskSuggestion?.(suggestion),
    onDismiss: (suggestion) => props.onDismissTaskSuggestion?.(suggestion),
    onNavigate: (taskId, direction) => props.onNavigateTaskSuggestion?.(taskId, direction),
  });
}

// Mirrors the TUI sanitizer to prevent directionality spoofing. This stays local
// because the Control UI cannot import core src/ modules.
function sanitizeTaskSuggestionText(text: string): string {
  return text.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

function updateTaskSuggestionPathFade(element: Element): void {
  if (!(element instanceof HTMLElement)) {
    return;
  }
  const hasContentToRight = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
  element.toggleAttribute("data-overflow-right", hasContentToRight);
}

function renderChatTaskSuggestions(props: {
  suggestions: TaskSuggestion[];
  busyIds: ReadonlySet<string>;
  canAccept: boolean;
  canDismiss: boolean;
  onAccept: (suggestion: TaskSuggestion) => void;
  onDismiss: (suggestion: TaskSuggestion) => void;
  onCopyPrompt: (suggestion: TaskSuggestion) => void;
  copiedIds: ReadonlySet<string>;
  activeId?: string;
  swapDirection?: "next" | "previous";
  swapGeneration: number;
  onNavigate: (taskId: string, direction: "next" | "previous") => void;
}) {
  if (props.suggestions.length === 0) {
    return nothing;
  }
  const multiple = props.suggestions.length > 1;
  const activeId = props.suggestions.some((suggestion) => suggestion.id === props.activeId)
    ? props.activeId
    : props.suggestions[0]?.id;
  return html`
    <div class="task-suggestions ${multiple ? "task-suggestions--stack" : ""}" aria-live="polite">
      ${props.suggestions.map((suggestion, index) => {
        const busy = props.busyIds.has(suggestion.id);
        const title = sanitizeTaskSuggestionText(suggestion.title);
        const tldr = sanitizeTaskSuggestionText(suggestion.tldr);
        const cwd = sanitizeTaskSuggestionText(suggestion.cwd);
        const prompt = sanitizeTaskSuggestionText(suggestion.prompt);
        const repo = sanitizeTaskSuggestionText(repoName(cwd));
        const copied = props.copiedIds.has(suggestion.id);
        const copyLabel = copied
          ? t("chat.taskSuggestions.promptCopied")
          : t("chat.taskSuggestions.copyPrompt");
        const accept = () => {
          if (!busy && props.canAccept) {
            props.onAccept(suggestion);
          }
        };
        const active = suggestion.id === activeId;
        const card = html`
          <article
            class="task-suggestion"
            data-task-id=${suggestion.id}
            data-swap-direction=${active && props.swapDirection ? props.swapDirection : nothing}
            ?hidden=${!active}
          >
            <header class="task-suggestion__header">
              <div class="task-suggestion__eyebrow" title=${cwd}>
                ${t("chat.taskSuggestions.eyebrow", { repo })}
                ${
                  multiple
                    ? html`<span class="task-suggestion__position"
                        >${index + 1} / ${props.suggestions.length}</span
                      >`
                    : nothing
                }
              </div>
              <div class="task-suggestion__header-actions">
                <button
                  class="task-suggestion__header-action task-suggestion__copy"
                  type="button"
                  aria-label=${copyLabel}
                  title=${copyLabel}
                  @click=${() => props.onCopyPrompt(suggestion)}
                >
                  ${copied ? icons.check : icons.copy}
                </button>
                ${
                  multiple
                    ? html`
                        <button
                          class="task-suggestion__header-action"
                          type="button"
                          aria-label=${t("chat.taskSuggestions.previous")}
                          data-task-prev
                          @click=${() => props.onNavigate(suggestion.id, "previous")}
                        >
                          ${icons.chevronLeft}
                        </button>
                        <button
                          class="task-suggestion__header-action"
                          type="button"
                          aria-label=${t("chat.taskSuggestions.next")}
                          data-task-next
                          @click=${() => props.onNavigate(suggestion.id, "next")}
                        >
                          ${icons.chevronRight}
                        </button>
                      `
                    : nothing
                }
                ${
                  props.canDismiss
                    ? html`
                        <button
                          class="task-suggestion__header-action task-suggestion__dismiss"
                          type="button"
                          ?disabled=${busy}
                          aria-label=${t("chat.taskSuggestions.dismiss", { title })}
                          @click=${() => props.onDismiss(suggestion)}
                        >
                          ${icons.x}
                        </button>
                      `
                    : nothing
                }
              </div>
            </header>
            <div class="task-suggestion__body">
              <div class="task-suggestion__title">${title}</div>
              <div class="task-suggestion__summary">${tldr}</div>
              <details class="task-suggestion__instructions">
                <summary>
                  <span class="task-suggestion__instructions-chevron" aria-hidden="true"
                    >${icons.chevronRight}</span
                  >
                  <span class="task-suggestion__show"
                    >${t("chat.taskSuggestions.showInstructions")}</span
                  >
                  <span class="task-suggestion__hide"
                    >${t("chat.taskSuggestions.hideInstructions")}</span
                  >
                </summary>
                <div class="task-suggestion__instruction-body">
                  <code
                    ${ref((element) => {
                      if (element) {
                        requestAnimationFrame(() => updateTaskSuggestionPathFade(element));
                      }
                    })}
                    @scroll=${(event: Event) =>
                      updateTaskSuggestionPathFade(event.currentTarget as Element)}
                    >${cwd}</code
                  >
                  <pre>${prompt}</pre>
                </div>
              </details>
            </div>
            <div class="task-suggestion__actions">
              <button
                class="btn task-suggestion__start"
                type="button"
                ?disabled=${busy || !props.canAccept}
                title=${props.canAccept ? "" : t("chat.taskSuggestions.adminRequired")}
                @click=${accept}
              >
                ${icons.play}
                ${
                  busy ? t("chat.taskSuggestions.starting") : t("chat.taskSuggestions.startSession")
                }
              </button>
            </div>
          </article>
        `;
        // A fresh keyed card restarts the directional entrance even when this
        // task and direction were used before; ordinary rerenders retain it.
        return active
          ? keyed(`${suggestion.id}:${props.swapGeneration}`, card)
          : keyed(`${suggestion.id}:inactive`, card);
      })}
    </div>
  `;
}
