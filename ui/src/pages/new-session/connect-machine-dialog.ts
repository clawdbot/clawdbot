import { html, nothing } from "lit";
import { quoteCliArg } from "../../../../src/cli/quote-cli-arg.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { renderConnectCommand } from "../../components/connect-command.ts";
import { icons } from "../../components/icons.ts";
import "../../components/modal-dialog.ts";
import { t } from "../../i18n/index.ts";
import { requestDevicePairJoinSetup, type DevicePairSetup } from "../../lib/device-pair-setup.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatTimeMs } from "../../lib/format.ts";

/**
 * The join setup behind the connect-machine dialog.
 *
 * The request token and the open flag travel together on purpose: a setup that
 * arrives after the dialog closed, after the gateway changed, or after a newer
 * request started must be dropped rather than shown, and closing has to retire
 * whatever is still in flight.
 */
export class ConnectMachineSetupState {
  private openValue = false;
  private loadingValue = false;
  private errorValue: string | null = null;
  private setupValue: DevicePairSetup | null = null;
  private requestId = 0;

  constructor(
    private readonly gateway: () => { client: GatewayBrowserClient | null; connected: boolean },
    private readonly requestUpdate: () => void,
  ) {}

  get open(): boolean {
    return this.openValue;
  }

  get loading(): boolean {
    return this.loadingValue;
  }

  get error(): string | null {
    return this.errorValue;
  }

  get setup(): DevicePairSetup | null {
    return this.setupValue;
  }

  start(): void {
    this.openValue = true;
    this.errorValue = null;
    this.setupValue = null;
    this.requestUpdate();
    void this.refresh();
  }

  close(): void {
    this.requestId += 1;
    this.openValue = false;
    this.loadingValue = false;
    this.errorValue = null;
    this.setupValue = null;
  }

  async refresh(): Promise<void> {
    if (!this.openValue || this.loadingValue) {
      return;
    }
    const { client, connected } = this.gateway();
    if (!connected || !client) {
      this.errorValue = t("newSession.connectMachineUnavailable");
      this.requestUpdate();
      return;
    }
    const requestId = ++this.requestId;
    this.loadingValue = true;
    this.errorValue = null;
    this.requestUpdate();
    try {
      const setup = await requestDevicePairJoinSetup(client);
      if (!this.stillCurrent(requestId, client)) {
        return;
      }
      if (!setup.joinUrl?.trim()) {
        this.setupValue = null;
        this.errorValue = t("newSession.connectMachineMissingUrl");
        return;
      }
      this.setupValue = setup;
    } catch (error) {
      if (this.stillCurrent(requestId, client)) {
        this.errorValue = formatUiError(error);
      }
    } finally {
      if (requestId === this.requestId) {
        this.loadingValue = false;
        this.requestUpdate();
      }
    }
  }

  private stillCurrent(requestId: number, client: GatewayBrowserClient): boolean {
    const gateway = this.gateway();
    return (
      requestId === this.requestId &&
      client === gateway.client &&
      gateway.connected &&
      this.openValue
    );
  }
}

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
