import { consume } from "@lit/context";
import { html, nothing, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { hasOperatorAdminAccess } from "../app/operator-access.ts";
import { t } from "../i18n/index.ts";
import { resolveEditableSnapshotConfig } from "../lib/config/index.ts";
import {
  buildAddMcpServerPatch,
  buildRemoveMcpServerPatch,
  buildToggleMcpServerPatch,
  MCP_SERVER_NAME_PATTERN,
  parseMcpTarget,
  patchMcpServers,
  summarizeMcpServers,
  type McpServerSummary,
  type McpServersPatchBuildResult,
} from "../lib/config/mcp-servers.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { icons } from "./icons.ts";
import { renderMcpServerForm, type McpServerForm } from "./mcp-server-form.ts";
import { renderSettingsEmpty, renderSettingsSection, renderSettingsStatus } from "./settings-ui.ts";

type McpServerMessage = { kind: "error" | "success"; text: string };

function quoteShellArg(value: string): string {
  return /^[A-Za-z0-9._:/-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function tlsLabel(tls: McpServerSummary["tls"]): string | null {
  switch (tls) {
    case "verify-off":
      return t("mcpPage.tlsVerifyOff");
    case "mtls":
      return t("mcpPage.mtls");
    default:
      return null;
  }
}

class McpServersCard extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context?: ApplicationContext;

  @property() pluginsHref = "";

  @state() private rows: McpServerSummary[] | null = null;
  @state() private busy = false;
  @state() private message: McpServerMessage | null = null;
  @state() private formOpen = false;

  private readonly subscriptions = new SubscriptionsController(this)
    .effect(
      () => this.context?.runtimeConfig,
      (runtimeConfig) => {
        this.syncRows();
        void runtimeConfig
          .ensureLoaded()
          .then(() => this.syncRows())
          .catch((error: unknown) => {
            this.message = {
              kind: "error",
              text: error instanceof Error ? error.message : String(error),
            };
          });
        return runtimeConfig.subscribe(() => this.syncRows());
      },
    )
    .effect(
      () => this.context?.gateway,
      (gateway) => gateway.subscribe(() => this.requestUpdate()),
    );

  override disconnectedCallback() {
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  private syncRows() {
    const snapshot = this.context?.runtimeConfig.state.configSnapshot;
    this.rows = summarizeMcpServers(resolveEditableSnapshotConfig(snapshot));
  }

  private mutationBlockedReason(): string | null {
    const gateway = this.context?.gateway;
    if (gateway?.snapshot.phase !== "connected") {
      return t("mcpServers.connectRequired");
    }
    if (!hasOperatorAdminAccess(gateway.snapshot.hello?.auth ?? null)) {
      return t("mcpServers.adminRequired");
    }
    return null;
  }

  private canMutate(): boolean {
    return this.context !== undefined && this.mutationBlockedReason() === null;
  }

  private async mutate(options: {
    buildPatch: (servers: Readonly<Record<string, unknown>>) => McpServersPatchBuildResult;
    note: string;
    successText: string;
  }): Promise<boolean> {
    if (!this.context || !this.canMutate() || this.busy) {
      return false;
    }
    this.busy = true;
    this.message = null;
    const result = await patchMcpServers(this.context.runtimeConfig, options);
    this.busy = false;
    if (!result.ok) {
      this.message = { kind: "error", text: result.error };
      return false;
    }
    this.syncRows();
    this.message = { kind: "success", text: options.successText };
    return true;
  }

  private async addServer(form: McpServerForm) {
    const name = form.name.trim();
    if (!MCP_SERVER_NAME_PATTERN.test(name)) {
      this.message = { kind: "error", text: t("mcpServers.nameInvalid") };
      return;
    }
    const config = parseMcpTarget(form.target, form.transport);
    if (!config) {
      this.message = { kind: "error", text: t("mcpServers.targetInvalid") };
      return;
    }
    const added = await this.mutate({
      buildPatch: (servers) => buildAddMcpServerPatch(servers, name, config),
      note: `mcp settings: add server ${name}`,
      successText: t("mcpServers.addedSuccess", { name }),
    });
    if (added) {
      this.formOpen = false;
    }
  }

  private async toggleServer(name: string, enabled: boolean) {
    await this.mutate({
      buildPatch: (servers) => buildToggleMcpServerPatch(servers, name, enabled),
      note: `mcp settings: ${enabled ? "enable" : "disable"} server ${name}`,
      successText: t(enabled ? "mcpServers.enabledSuccess" : "mcpServers.disabledSuccess", {
        name,
      }),
    });
  }

  private async removeServer(name: string) {
    await this.mutate({
      buildPatch: (servers) => buildRemoveMcpServerPatch(servers, name),
      note: `mcp settings: remove server ${name}`,
      successText: t("mcpServers.removedSuccess", { name }),
    });
  }

  private renderRow(server: McpServerSummary): TemplateResult {
    const command = `openclaw mcp ${server.auth === "oauth" ? "login" : "probe"} ${quoteShellArg(
      server.name,
    )}`;
    const meta = [
      server.transport,
      server.auth,
      server.toolFilter ? t("mcpPage.toolFilter") : null,
      server.parallel ? t("mcpPage.parallel") : null,
      tlsLabel(server.tls),
    ].filter((part): part is string => Boolean(part));
    const blockedReason = this.mutationBlockedReason();
    const disabled = this.busy || !this.canMutate();
    return html`
      <div class="settings-row mcp-server-row" data-mcp-name=${server.name}>
        <div class="settings-row__text">
          <span class="settings-row__title">${server.name}</span>
          <span class="settings-row__desc mcp-server-row__launch">
            ${server.target || t("mcpServers.missingTransport")}
          </span>
          <span class="settings-row__desc">${meta.join(" · ")}</span>
        </div>
        <div class="settings-row__control">
          ${renderSettingsStatus({
            kind: server.enabled ? "ok" : "muted",
            label: server.enabled ? t("common.enabled") : t("common.disabled"),
          })}
          <code>${command}</code>
          <button
            type="button"
            class="btn btn--sm"
            title=${blockedReason ?? ""}
            ?disabled=${disabled}
            @click=${() => void this.toggleServer(server.name, !server.enabled)}
          >
            ${this.busy
              ? t("mcpServers.working")
              : server.enabled
                ? t("mcpServers.disable")
                : t("mcpServers.enable")}
          </button>
          <button
            type="button"
            class="btn btn--sm btn--icon mcp-server-remove"
            aria-label=${t("mcpServers.removeNamed", { name: server.name })}
            title=${blockedReason ?? t("mcpServers.removeNamed", { name: server.name })}
            ?disabled=${disabled}
            @click=${() => void this.removeServer(server.name)}
          >
            ${icons.trash}
          </button>
        </div>
      </div>
    `;
  }

  override render() {
    const blockedReason = this.mutationBlockedReason();
    const rows = this.rows;
    const body = !rows
      ? html`<div class="mcp-server-loading" role="status">${t("common.loading")}</div>`
      : rows.length === 0
        ? renderSettingsEmpty(t("mcpPage.noServers"))
        : rows.map((server) => this.renderRow(server));
    return html`
      <div class="mcp-server-list">
        ${renderSettingsSection(
          {
            title: t("mcpPage.configuredServers"),
            description: html`
              ${t("mcpPage.runtimeHint")}
              <a href=${this.pluginsHref}>${t("mcpPage.connectorsLink")}</a>
            `,
            actions: html`
              <button
                type="button"
                class="btn btn--sm"
                title=${blockedReason ?? ""}
                ?disabled=${this.busy || !this.canMutate()}
                @click=${() => {
                  this.formOpen = !this.formOpen;
                  if (this.formOpen) {
                    this.message = null;
                  }
                }}
              >
                <span aria-hidden="true">${icons.plus}</span>
                ${t("mcpServers.add")}
              </button>
            `,
          },
          html`
            ${this.formOpen
              ? renderMcpServerForm({
                  busy: this.busy,
                  disabled: !this.canMutate(),
                  blockedReason,
                  onSubmit: (form) => void this.addServer(form),
                  onCancel: () => {
                    this.formOpen = false;
                  },
                })
              : nothing}
            ${this.message
              ? html`<div
                  class="mcp-server-message mcp-server-message--${this.message.kind}"
                  role=${this.message.kind === "error" ? "alert" : "status"}
                >
                  ${this.message.text}
                </div>`
              : nothing}
            ${body}
          `,
        )}
      </div>
    `;
  }
}

if (!customElements.get("openclaw-mcp-servers-card")) {
  customElements.define("openclaw-mcp-servers-card", McpServersCard);
}

declare global {
  interface HTMLElementTagNameMap {
    "openclaw-mcp-servers-card": McpServersCard;
  }
}
