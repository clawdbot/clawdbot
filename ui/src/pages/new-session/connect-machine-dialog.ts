import { html, nothing } from "lit";
import { quoteCliArg } from "../../../../src/cli/quote-cli-arg.js";
import { renderConnectCommand } from "../../components/connect-command.ts";
import { icons } from "../../components/icons.ts";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";
import type { DevicePairSetup } from "../../lib/device-pair-setup.ts";
import { formatTimeMs } from "../../lib/format.ts";

type ConnectMachineDialogProps = {
  open: boolean;
  loading: boolean;
  error: string | null;
  setup: DevicePairSetup | null;
  onRefresh: () => void;
  onClose: () => void;
  onManageDevices: () => void;
};

export function renderConnectMachineDialog(props: ConnectMachineDialogProps) {
  if (!props.open) {
    return nothing;
  }
  const title = t("newSession.connectMachineTitle");
  const joinUrl = props.setup?.joinUrl?.trim();
  const command = joinUrl ? `npx openclaw connect ${quoteCliArg(joinUrl)}` : null;
  const expiresAt = props.setup?.expiresAtMs
    ? formatTimeMs(props.setup.expiresAtMs, { hour: "numeric", minute: "2-digit" }, "")
    : "";

  return html`
    <openclaw-modal-dialog
      class="connect-machine-dialog"
      label=${title}
      description=${t("newSession.connectMachineDescription")}
      @modal-cancel=${props.onClose}
    >
      <section class="exec-approval-card connect-machine-dialog__card">
        <header class="exec-approval-header">
          <div>
            <h2 class="exec-approval-title">${title}</h2>
            <p class="exec-approval-sub">${t("newSession.connectMachineDescription")}</p>
          </div>
          <button
            class="btn btn--icon btn--ghost"
            type="button"
            aria-label=${t("common.dismiss")}
            @click=${props.onClose}
          >
            ${icons.x}
          </button>
        </header>

        <div class="connect-machine-dialog__body">
          ${props.loading && !command
            ? html`<p class="connect-machine-dialog__status" role="status">
                ${t("newSession.connectMachineGenerating")}
              </p>`
            : nothing}
          ${props.error
            ? html`<p class="exec-approval-error" role="alert">
                ${t("newSession.connectMachineFailed")} ${props.error}
              </p>`
            : nothing}
          ${command
            ? html`
                ${renderConnectCommand(command)}
                <p class="connect-machine-dialog__hint">
                  ${t("newSession.connectMachineTeamHint")}
                </p>
                <p class="connect-machine-dialog__hint">
                  ${expiresAt
                    ? t("newSession.connectMachineSingleUseExpires", { time: expiresAt })
                    : t("newSession.connectMachineSingleUse")}
                </p>
              `
            : nothing}
        </div>

        <footer class="exec-approval-actions connect-machine-dialog__actions">
          ${command || props.error
            ? html`<button
                class="btn"
                type="button"
                ?disabled=${props.loading}
                @click=${props.onRefresh}
              >
                ${icons.refresh}
                ${props.loading
                  ? t("newSession.connectMachineRefreshing")
                  : t("newSession.connectMachineFreshCode")}
              </button>`
            : nothing}
          <button class="btn btn--ghost" type="button" @click=${props.onManageDevices}>
            ${t("newSession.connectMachineManageDevices")}
          </button>
        </footer>
      </section>
    </openclaw-modal-dialog>
  `;
}
