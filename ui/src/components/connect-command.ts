// Control UI component renders a copyable gateway connection command.
import { html } from "lit";
import { t } from "../i18n/index.ts";
import { copyToClipboard } from "../lib/clipboard.ts";
import { renderCopyButton } from "./copy-button.ts";
import "./tooltip.ts";

export function renderConnectCommand(command: string) {
  const copyLabel = t("connection.help.copyCommand");
  return html`
    <openclaw-tooltip .content=${copyLabel}>
      <div
        class="login-gate__command"
        @click=${(event: MouseEvent) => {
          if ((event.target as Element | null)?.closest("button")) {
            return;
          }
          void copyToClipboard(command);
        }}
      >
        <button
          class="login-gate__command-action"
          type="button"
          aria-label=${t("connection.help.copyCommandAria", { command })}
          @click=${() => copyToClipboard(command)}
        >
          <code>${command}</code>
        </button>
        ${renderCopyButton(command, copyLabel)}
      </div>
    </openclaw-tooltip>
  `;
}
