import { html } from "lit";
import { icons } from "../../components/icons.ts";
import "../../components/tooltip.ts";
import { t } from "../../i18n/index.ts";

type NewSessionComposerOptions = {
  canSubmit: boolean;
  message: string;
  requiresModifier: boolean;
  submitting: boolean;
  onInput: (message: string) => void;
  onSubmit: () => void;
};

function handleComposerKeydown(event: KeyboardEvent, options: NewSessionComposerOptions) {
  if (
    options.submitting ||
    event.key !== "Enter" ||
    event.shiftKey ||
    event.isComposing ||
    event.keyCode === 229
  ) {
    return;
  }
  if (!options.requiresModifier || event.metaKey || event.ctrlKey) {
    event.preventDefault();
    options.onSubmit();
  }
}

/** Draft message box styled as the chat composer shell so both pickers match. */
export function renderNewSessionComposer(options: NewSessionComposerOptions) {
  const startLabel = options.submitting ? t("newSession.starting") : t("newSession.start");
  return html`
    <div class="agent-chat__input new-session-page__composer">
      <div class="agent-chat__composer-input-row">
        <div class="agent-chat__composer-combobox">
          <textarea
            class="new-session-page__message"
            rows="3"
            ?disabled=${options.submitting}
            placeholder=${t("newSession.messagePlaceholder")}
            .value=${options.message}
            @input=${(event: Event) => options.onInput((event.target as HTMLTextAreaElement).value)}
            @keydown=${(event: KeyboardEvent) => handleComposerKeydown(event, options)}
          ></textarea>
        </div>
        <div class="agent-chat__composer-actions">
          <openclaw-tooltip content=${t("newSession.start")}>
            <button
              type="button"
              class="chat-send-btn"
              ?disabled=${!options.canSubmit}
              aria-label=${startLabel}
              @click=${options.onSubmit}
            >
              ${options.submitting ? icons.loader : icons.arrowUp}
            </button>
          </openclaw-tooltip>
        </div>
      </div>
    </div>
  `;
}
