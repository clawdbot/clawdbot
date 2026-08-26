// Control UI component renders a copyable gateway connection command.
import { html } from "lit";
import { t } from "../i18n/index.ts";
import { renderCopyButton } from "./copy-button.ts";
import "./tooltip.ts";

function copyCommand(event: Event) {
  (event.currentTarget as HTMLElement).querySelector<HTMLButtonElement>(".chat-copy-btn")?.click();
}

export function renderConnectCommand(command: string) {
  const copyLabel = t("connection.help.copyCommand");
  return html`
    <openclaw-tooltip .content=${copyLabel}>
      <div
        class="login-gate__command"
        role="button"
        tabindex="0"
        aria-label=${t("connection.help.copyCommandAria", { command })}
        @click=${(event: Event) => {
          if ((event.target as HTMLElement | null)?.closest(".chat-copy-btn")) {
            return;
          }
          copyCommand(event);
        }}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key !== "Enter" && event.key !== " ") {
            return;
          }
          event.preventDefault();
          copyCommand(event);
        }}
      >
        <code translate="no">${command}</code>
        ${renderCopyButton(command, copyLabel)}
      </div>
    </openclaw-tooltip>
  `;
}
