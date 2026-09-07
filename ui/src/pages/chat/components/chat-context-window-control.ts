import { html, nothing } from "lit";
import type { GatewayContextWindowOption } from "../../../api/types.ts";
import { icons } from "../../../components/icons.ts";
import { renderSettingsSegmented } from "../../../components/settings-ui.ts";
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
    control = renderSettingsSegmented({
      mode: "buttons",
      variant: "compact",
      className: "chat-controls__context-window-options",
      value: selectedOption.id,
      ariaLabel,
      disabled: contextWindow.disabled,
      options: contextWindow.options.map((option) => ({ value: option.id, label: option.label })),
      onClick: (event, value) => {
        event.stopPropagation();
        if (contextWindow.disabled || value === selectedOption.id) {
          event.preventDefault();
        }
      },
      onChange: (value) => {
        void contextWindow.onSelect(value, sessionKey);
      },
    });
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
