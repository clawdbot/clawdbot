// Chat UI cards for model-proposed follow-up tasks.
import { html, nothing } from "lit";
import type { TaskSuggestion } from "../../../../../packages/gateway-protocol/src/index.js";
import { icons } from "../../../components/icons.ts";
import "../../../components/web-awesome.ts";
import { t } from "../../../i18n/index.ts";
import { repoName } from "../../../lib/session-display.ts";
import type { TaskSuggestionAcceptMode } from "../../../lib/task-suggestion-acceptance.ts";

type TaskSuggestionCloudProfile = { id: string };

export type ChatTaskSuggestionTrayProps = {
  taskSuggestions?: TaskSuggestion[];
  taskSuggestionBusyIds?: ReadonlySet<string>;
  taskSuggestionCloudProfiles?: TaskSuggestionCloudProfile[];
  taskSuggestionCopiedIds?: ReadonlySet<string>;
  onCopyTaskSuggestionPrompt?: (suggestion: TaskSuggestion) => void;
  canAcceptTaskSuggestions?: boolean;
  canAcceptTaskSuggestionModes?: boolean;
  canDismissTaskSuggestions?: boolean;
  onAcceptTaskSuggestion?: (
    suggestion: TaskSuggestion,
    mode: TaskSuggestionAcceptMode,
    cloudProfileId?: string,
  ) => void;
  onDismissTaskSuggestion?: (suggestion: TaskSuggestion) => void;
};

export function renderChatTaskSuggestionTray(props: ChatTaskSuggestionTrayProps) {
  return renderChatTaskSuggestions({
    suggestions: props.taskSuggestions ?? [],
    busyIds: props.taskSuggestionBusyIds ?? new Set(),
    cloudProfiles: props.taskSuggestionCloudProfiles ?? [],
    copiedIds: props.taskSuggestionCopiedIds ?? new Set(),
    onCopyPrompt: (suggestion) => props.onCopyTaskSuggestionPrompt?.(suggestion),
    canAccept: props.canAcceptTaskSuggestions === true,
    canAcceptModes: props.canAcceptTaskSuggestionModes === true,
    canDismiss: props.canDismissTaskSuggestions === true,
    onAccept: (suggestion, mode, cloudProfileId) =>
      props.onAcceptTaskSuggestion?.(suggestion, mode, cloudProfileId),
    onDismiss: (suggestion) => props.onDismissTaskSuggestion?.(suggestion),
  });
}

// Mirrors the TUI sanitizer to prevent directionality spoofing. This stays local
// because the Control UI cannot import core src/ modules.
function sanitizeTaskSuggestionText(text: string): string {
  return text.replace(/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "");
}

function renderChatTaskSuggestions(props: {
  suggestions: TaskSuggestion[];
  busyIds: ReadonlySet<string>;
  canAccept: boolean;
  canDismiss: boolean;
  cloudProfiles: TaskSuggestionCloudProfile[];
  onAccept: (
    suggestion: TaskSuggestion,
    mode: TaskSuggestionAcceptMode,
    cloudProfileId?: string,
  ) => void;
  onDismiss: (suggestion: TaskSuggestion) => void;
  onCopyPrompt: (suggestion: TaskSuggestion) => void;
  copiedIds: ReadonlySet<string>;
  canAcceptModes: boolean;
}) {
  if (props.suggestions.length === 0) {
    return nothing;
  }
  return html`
    <div class="task-suggestions" aria-live="polite">
      ${props.suggestions.map((suggestion) => {
        const busy = props.busyIds.has(suggestion.id);
        const title = sanitizeTaskSuggestionText(suggestion.title);
        const tldr = sanitizeTaskSuggestionText(suggestion.tldr);
        const cwd = sanitizeTaskSuggestionText(suggestion.cwd);
        const prompt = sanitizeTaskSuggestionText(suggestion.prompt);
        const repo = sanitizeTaskSuggestionText(repoName(cwd));
        const cloudProfiles = props.cloudProfiles.map((profile) => ({
          id: profile.id,
          label: sanitizeTaskSuggestionText(profile.id),
        }));
        const accept = (mode: TaskSuggestionAcceptMode, cloudProfileId?: string) => {
          if (!busy && props.canAccept) {
            props.onAccept(suggestion, mode, cloudProfileId);
          }
        };
        return html`
          <article class="task-suggestion" data-task-id=${suggestion.id}>
            <div class="task-suggestion__body">
              <div class="task-suggestion__eyebrow" title=${cwd}>
                ${t("chat.taskSuggestions.eyebrow", { repo })}
              </div>
              <div class="task-suggestion__title">${title}</div>
              <div class="task-suggestion__summary">${tldr}</div>
              <details class="chat-json-collapse task-suggestion__instructions">
                <summary class="chat-json-summary">
                  ${t("chat.taskSuggestions.showInstructions")}
                </summary>
                <div class="task-suggestion__instruction-body">
                  <code>${cwd}</code>
                  <pre>${prompt}</pre>
                </div>
              </details>
            </div>
            ${props.canDismiss
              ? html`
                  <button
                    class="btn btn--ghost btn--icon task-suggestion__dismiss"
                    type="button"
                    ?disabled=${busy}
                    aria-label=${t("chat.taskSuggestions.dismiss", { title })}
                    @click=${() => props.onDismiss(suggestion)}
                  >
                    ${icons.x}
                  </button>
                `
              : nothing}
            <div class="task-suggestion__actions">
              <div class="task-suggestion__split">
                <button
                  class="btn task-suggestion__start"
                  type="button"
                  ?disabled=${busy || !props.canAccept}
                  title=${props.canAccept ? "" : t("chat.taskSuggestions.adminRequired")}
                  @click=${() => accept("worktree")}
                >
                  ${icons.play}
                  ${busy
                    ? t("chat.taskSuggestions.starting")
                    : t("chat.taskSuggestions.startWorktree")}
                </button>
                ${html`
                  <wa-dropdown
                    class="task-suggestion__menu"
                    placement="bottom-end"
                    @wa-select=${(
                      event: CustomEvent<{ item: HTMLElement & { value?: string } }>,
                    ) => {
                      const item = event.detail.item;
                      if (item.value === "local") {
                        accept("local");
                      } else if (item.value === "session") {
                        accept("session");
                      } else if (item.value === "cloud") {
                        const profileId = item.dataset.cloudProfile;
                        if (profileId) {
                          accept("cloud", profileId);
                        }
                      } else if (item.value === "copy-prompt") {
                        props.onCopyPrompt(suggestion);
                      }
                    }}
                  >
                    <button
                      slot="trigger"
                      class="btn task-suggestion__menu-trigger"
                      type="button"
                      ?disabled=${busy}
                      aria-label=${t("chat.taskSuggestions.moreActions")}
                      aria-haspopup="menu"
                      aria-expanded="false"
                    >
                      ${icons.chevronDown}
                    </button>
                    ${props.canAcceptModes
                      ? html`
                          <wa-dropdown-item value="local" ?disabled=${busy || !props.canAccept}>
                            ${t("chat.taskSuggestions.startLocal")}
                          </wa-dropdown-item>
                          ${cloudProfiles.length === 0
                            ? html`
                                <wa-dropdown-item
                                  value="cloud"
                                  disabled
                                  title=${t("chat.taskSuggestions.noCloudConfigured")}
                                >
                                  ${t("chat.taskSuggestions.startCloudGeneric")}
                                </wa-dropdown-item>
                              `
                            : cloudProfiles.map(
                                (profile) => html`
                                  <wa-dropdown-item
                                    value="cloud"
                                    data-cloud-profile=${profile.id}
                                    ?disabled=${busy || !props.canAccept}
                                  >
                                    ${cloudProfiles.length > 1
                                      ? t("chat.taskSuggestions.startCloud", {
                                          profile: profile.label,
                                        })
                                      : t("chat.taskSuggestions.startCloudGeneric")}
                                  </wa-dropdown-item>
                                `,
                              )}
                          <wa-dropdown-item value="session" ?disabled=${busy || !props.canAccept}>
                            ${t("chat.taskSuggestions.fixInSession")}
                          </wa-dropdown-item>
                        `
                      : nothing}
                    <wa-dropdown-item value="copy-prompt">
                      ${props.copiedIds.has(suggestion.id)
                        ? t("chat.taskSuggestions.promptCopied")
                        : t("chat.taskSuggestions.copyPrompt")}
                    </wa-dropdown-item>
                  </wa-dropdown>
                `}
              </div>
            </div>
          </article>
        `;
      })}
    </div>
  `;
}
