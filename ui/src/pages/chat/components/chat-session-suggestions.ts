import { html, nothing } from "lit";
import type {
  SessionSharingRole,
  SessionSuggestion,
  SessionSuggestionResolution,
} from "../../../../../packages/gateway-protocol/src/index.js";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";

function actionButton(params: {
  icon: unknown;
  label: string;
  busy: boolean;
  onClick: () => void;
}) {
  return html`
    <button
      class="btn btn--ghost btn--icon session-suggestion__action"
      type="button"
      ?disabled=${params.busy}
      aria-label=${params.label}
      title=${params.label}
      @click=${params.onClick}
    >
      ${params.icon}
    </button>
  `;
}

export function renderChatSessionSuggestions(props: {
  suggestions: readonly SessionSuggestion[];
  role?: SessionSharingRole;
  busyIds: ReadonlySet<string>;
  archived: boolean;
  canResolve: boolean;
  onResolve: (suggestion: SessionSuggestion, resolution: SessionSuggestionResolution) => void;
}) {
  if (props.suggestions.length === 0) {
    return nothing;
  }
  const canResolve = props.canResolve && (props.role === "owner" || props.role === "admin");
  return html`
    <div class="session-suggestions" aria-live="polite">
      ${props.suggestions.map((suggestion) => {
        const busy = props.busyIds.has(suggestion.id);
        const author = suggestion.author.label ?? suggestion.author.id;
        return html`
          <article class="session-suggestion" data-suggestion-id=${suggestion.id}>
            <span class="session-suggestion__author">${author}</span>
            <span class="session-suggestion__text">${suggestion.text}</span>
            ${canResolve && suggestion.state === "pending"
              ? html`
                  <div class="session-suggestion__actions">
                    ${props.archived
                      ? nothing
                      : html`
                          ${actionButton({
                            icon: icons.arrowUp,
                            label: t("chat.sessionSuggestions.sendNow", { author }),
                            busy,
                            onClick: () => props.onResolve(suggestion, "send"),
                          })}
                          ${actionButton({
                            icon: icons.check,
                            label: t("chat.sessionSuggestions.queue", { author }),
                            busy,
                            onClick: () => props.onResolve(suggestion, "queue"),
                          })}
                          ${actionButton({
                            icon: icons.edit,
                            label: t("chat.sessionSuggestions.edit", { author }),
                            busy,
                            onClick: () => props.onResolve(suggestion, "edit"),
                          })}
                        `}
                    ${actionButton({
                      icon: icons.trash,
                      label: t("chat.sessionSuggestions.dismiss", { author }),
                      busy,
                      onClick: () => props.onResolve(suggestion, "dismiss"),
                    })}
                  </div>
                `
              : html`<span class="session-suggestion__state"
                  >${t(`chat.sessionSuggestions.state.${suggestion.state}`)}</span
                >`}
          </article>
        `;
      })}
    </div>
  `;
}
