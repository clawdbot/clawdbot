import { html } from "lit";
import { renderConnectCommand } from "../../../components/connect-command.ts";
import "../../../components/modal-dialog.ts";
import { t } from "../../../i18n/index.ts";

export function renderContinueInTerminalDialog(params: { command: string; onClose: () => void }) {
  const title = t("chat.sessionHeader.continueInTerminal.title");
  const description = t("chat.sessionHeader.continueInTerminal.description");
  return html`
    <openclaw-modal-dialog
      class="continue-in-terminal-dialog"
      label=${title}
      description=${description}
      @modal-cancel=${params.onClose}
    >
      <section class="exec-approval-card continue-in-terminal-dialog__card">
        <header class="continue-in-terminal-dialog__header">
          <h2>${title}</h2>
          <p>${description}</p>
        </header>
        ${renderConnectCommand(params.command)}
        <p class="continue-in-terminal-dialog__note">
          ${t("chat.sessionHeader.continueInTerminal.authNote")}
        </p>
        <footer class="exec-approval-actions">
          <button type="button" class="btn primary" @click=${params.onClose}>
            ${t("common.close")}
          </button>
        </footer>
      </section>
    </openclaw-modal-dialog>
  `;
}
