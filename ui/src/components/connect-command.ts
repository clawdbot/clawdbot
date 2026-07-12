// Control UI component renders a copyable gateway connection command.
import { html } from "lit";
import { t } from "../i18n/index.ts";
import { renderCopyButton } from "./copy-button.ts";
import "./tooltip.ts";

async function copyCommand(command: string) {
  try {
    await navigator.clipboard.writeText(command);
  } catch {
    // Best effort only; the explicit copy button provides visible feedback.
  }
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
        @click=${async (event: Event) => {
          if ((event.target as HTMLElement | null)?.closest(".chat-copy-btn")) {
            return;
          }
          await copyCommand(command);
        }}
        @keydown=${async (event: KeyboardEvent) => {
          if (event.key !== "Enter" && event.key !== " ") {
            return;
          }
          event.preventDefault();
          await copyCommand(command);
        }}
      >
        <code>${command}</code>
        ${renderCopyButton(command, copyLabel)}
      </div>
    </openclaw-tooltip>
  `;
}
