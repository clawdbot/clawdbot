import { html, nothing } from "lit";
import type { GatewayContextWindowOption } from "../../../api/types.ts";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";

export type ChatContextWindowControlParams = {
  options: readonly GatewayContextWindowOption[];
  selected: string;
  defaultId?: string;
  disabled: boolean;
  onSelect: (next: string, sessionKey: string) => Promise<void>;
};

export function renderContextWindowControl(
  contextWindow: ChatContextWindowControlParams,
  sessionKey: string,
) {
  const selectedOption = contextWindow.options.find(
    (option) => option.id === contextWindow.selected,
  );
  if (!selectedOption) {
    return nothing;
  }
  const ariaLabel = t("chat.modelControls.contextWindowAria", {
    state: selectedOption.label,
  });
  let control: ReturnType<typeof html>;
  if (contextWindow.options.length === 2) {
    const [smaller, larger] = [...contextWindow.options].toSorted(
      (left, right) => left.contextWindow - right.contextWindow,
    );
    if (!smaller || !larger) {
      return nothing;
    }
    const active = selectedOption.id === larger.id;
    const nextOption = active ? smaller : larger;
    control = html`
      <button
        class="chat-controls__speed-toggle ${active ? "chat-controls__speed-toggle--active" : ""}"
        data-chat-context-window-toggle=${nextOption.id}
        type="button"
        role="switch"
        aria-checked=${active ? "true" : "false"}
        aria-label=${ariaLabel}
        ?disabled=${contextWindow.disabled}
        @click=${(event: MouseEvent) => {
          event.stopPropagation();
          if (contextWindow.disabled) {
            event.preventDefault();
            return;
          }
          void contextWindow.onSelect(nextOption.id, sessionKey);
        }}
      >
        <span class="chat-controls__speed-toggle-thumb"></span>
      </button>
    `;
  } else {
    control = html`
      <div
        class="settings-segmented chat-controls__context-window-options"
        role="group"
        aria-label=${ariaLabel}
      >
        ${contextWindow.options.map(
          (option) => html`
            <button
              class="settings-segmented__btn ${
                option.id === selectedOption.id ? "settings-segmented__btn--active" : ""
              }"
              data-chat-context-window-option=${option.id}
              type="button"
              aria-pressed=${option.id === selectedOption.id ? "true" : "false"}
              ?disabled=${contextWindow.disabled}
              @click=${(event: MouseEvent) => {
                event.stopPropagation();
                if (contextWindow.disabled || option.id === selectedOption.id) {
                  event.preventDefault();
                  return;
                }
                void contextWindow.onSelect(option.id, sessionKey);
              }}
            >
              ${option.label}
            </button>
          `,
        )}
      </div>
    `;
  }
  return html`
    <div class="chat-controls__fast-mode-row chat-controls__context-window-row">
      <span
        class="chat-controls__fast-mode-icon chat-controls__context-window-icon"
        aria-hidden="true"
        >${icons.scrollText}</span
      >
      <span class="chat-controls__fast-mode-copy">
        <span class="chat-controls__fast-mode-title">
          ${t("chat.modelControls.contextWindow")}
        </span>
        <span class="chat-controls__fast-mode-description">${selectedOption.label}</span>
      </span>
      ${control}
    </div>
  `;
}
