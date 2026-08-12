import { consume } from "@lit/context";
import { html, nothing, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  McpOAuthCancelResult,
  McpOAuthControlStatus,
  McpOAuthDisconnectResult,
  McpOAuthErrorCategory,
  McpOAuthStartResult,
  McpOAuthStatusResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { applicationContext, type ApplicationContext } from "../app/context.ts";
import { hasOperatorAdminAccess } from "../app/operator-access.ts";
import { t } from "../i18n/index.ts";
import { resolveEditableSnapshotConfig } from "../lib/config/config-state-model.ts";
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
import {
  openExternalUrlSafe,
  reserveExternalWindowForDeferredNavigation,
  resolveSafeExternalUrl,
} from "../lib/open-external-url.ts";
import { OpenClawLightDomElement } from "../lit/openclaw-element.ts";
import { SubscriptionsController } from "../lit/subscriptions-controller.ts";
import { icons } from "./icons.ts";
import { renderMcpServerForm, type McpServerForm } from "./mcp-server-form.ts";
import {
  renderDocsLink,
  renderSettingsEmpty,
  renderSettingsSection,
  renderSettingsStatus,
} from "./settings-ui.ts";

type McpServerMessage = { kind: "error" | "success"; text: string };
type McpOAuthUiErrorCategory = McpOAuthErrorCategory | "start-failed";
type McpOAuthUiStatus =
  | McpOAuthControlStatus
  | {
      state: "error";
      credentialPresent: boolean;
      category: McpOAuthUiErrorCategory;
    };

const MCP_OAUTH_LAUNCH_PATH_PREFIX = "/oauth/mcp/authorize/";

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

  @property() docsUrl = "https://docs.openclaw.ai/tools/mcp";

  @state() private rows: McpServerSummary[] | null = null;
  @state() private busy = false;
  @state() private message: McpServerMessage | null = null;
  @state() private formOpen = false;
  @state() private oauthStatuses: Record<string, McpOAuthUiStatus> = {};
  @state() private oauthBusy: Record<string, boolean> = {};
  private oauthRequestEpoch = 0;
  private oauthPollTimer: ReturnType<typeof setTimeout> | null = null;

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
      (gateway) =>
        gateway.subscribe(() => {
          this.requestUpdate();
          void this.refreshOauthStatuses();
        }),
    );

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.clearOauthPoll();
    this.oauthRequestEpoch += 1;
    super.disconnectedCallback();
  }

  private syncRows() {
    const snapshot = this.context?.runtimeConfig.state.configSnapshot;
    this.rows = summarizeMcpServers(resolveEditableSnapshotConfig(snapshot));
    void this.refreshOauthStatuses();
  }

  private isSharedOauthServer(server: McpServerSummary): boolean {
    return (
      server.enabled &&
      server.auth === "oauth" &&
      server.transport !== "stdio" &&
      server.transport !== "invalid" &&
      server.oauthIdentity !== "per-requester"
    );
  }

  private clearOauthPoll() {
    if (this.oauthPollTimer !== null) {
      clearTimeout(this.oauthPollTimer);
      this.oauthPollTimer = null;
    }
  }

  private scheduleOauthPoll() {
    this.clearOauthPoll();
    if (!Object.values(this.oauthStatuses).some((status) => status.state === "authorizing")) {
      return;
    }
    this.oauthPollTimer = setTimeout(() => void this.refreshOauthStatuses(), 1_000);
  }

  private async refreshOauthStatuses() {
    const gateway = this.context?.gateway;
    const client = gateway?.snapshot.client;
    const servers = (this.rows ?? []).filter((server) => this.isSharedOauthServer(server));
    const epoch = ++this.oauthRequestEpoch;
    if (
      !gateway ||
      gateway.snapshot.phase !== "connected" ||
      !hasOperatorAdminAccess(gateway.snapshot.hello?.auth ?? null) ||
      !client ||
      servers.length === 0
    ) {
      this.oauthStatuses = {};
      this.clearOauthPoll();
      return;
    }
    const entries = await Promise.all(
      servers.map(async (server): Promise<[string, McpOAuthUiStatus]> => {
        try {
          const result = await client.request<McpOAuthStatusResult>("mcp.oauth.status", {
            serverName: server.name,
          });
          return [server.name, result.status];
        } catch {
          return [
            server.name,
            { state: "error", credentialPresent: false, category: "start-failed" },
          ];
        }
      }),
    );
    if (epoch !== this.oauthRequestEpoch || gateway.snapshot.client !== client) {
      return;
    }
    this.oauthStatuses = Object.fromEntries(entries);
    this.scheduleOauthPoll();
  }

  private setOauthBusy(serverName: string, busy: boolean) {
    const next = { ...this.oauthBusy };
    if (busy) {
      next[serverName] = true;
    } else {
      delete next[serverName];
    }
    this.oauthBusy = next;
  }

  private setOauthStatus(serverName: string, status: McpOAuthUiStatus) {
    this.oauthStatuses = { ...this.oauthStatuses, [serverName]: status };
    this.scheduleOauthPoll();
  }

  private async startOauth(serverName: string, reauthorize: boolean) {
    const client = this.context?.gateway.snapshot.client;
    if (!client || !this.canMutate() || this.oauthBusy[serverName]) {
      return;
    }
    const browserWindow = reserveExternalWindowForDeferredNavigation();
    this.setOauthBusy(serverName, true);
    try {
      const result = await client.request<McpOAuthStartResult>("mcp.oauth.start", {
        serverName,
        ...(reauthorize ? { reauthorize: true } : {}),
      });
      this.setOauthStatus(serverName, result.status);
      if (result.authorizationPath?.startsWith(MCP_OAUTH_LAUNCH_PATH_PREFIX)) {
        const authorizationUrl = resolveSafeExternalUrl(
          result.authorizationPath,
          window.location.href,
        );
        if (authorizationUrl && browserWindow) {
          browserWindow.location.replace(authorizationUrl);
        } else if (authorizationUrl) {
          openExternalUrlSafe(authorizationUrl);
        } else {
          browserWindow?.close();
        }
      } else {
        browserWindow?.close();
      }
    } catch {
      browserWindow?.close();
      const credentialPresent = this.oauthStatuses[serverName]?.credentialPresent === true;
      this.setOauthStatus(serverName, {
        state: "error",
        credentialPresent,
        category: "start-failed",
      });
    } finally {
      this.setOauthBusy(serverName, false);
    }
  }

  private async cancelOauth(serverName: string, authorizationId: string) {
    const client = this.context?.gateway.snapshot.client;
    if (!client || !this.canMutate() || this.oauthBusy[serverName]) {
      return;
    }
    this.setOauthBusy(serverName, true);
    try {
      const result = await client.request<McpOAuthCancelResult>("mcp.oauth.cancel", {
        serverName,
        authorizationId,
      });
      this.setOauthStatus(serverName, result.status);
    } catch {
      const credentialPresent = this.oauthStatuses[serverName]?.credentialPresent === true;
      this.setOauthStatus(serverName, {
        state: "error",
        credentialPresent,
        category: "start-failed",
      });
    } finally {
      this.setOauthBusy(serverName, false);
    }
  }

  private async disconnectOauth(serverName: string) {
    const client = this.context?.gateway.snapshot.client;
    if (!client || !this.canMutate() || this.oauthBusy[serverName]) {
      return;
    }
    this.setOauthBusy(serverName, true);
    try {
      const result = await client.request<McpOAuthDisconnectResult>("mcp.oauth.disconnect", {
        serverName,
      });
      this.setOauthStatus(serverName, result.status);
    } catch {
      this.setOauthStatus(serverName, {
        state: "error",
        credentialPresent: true,
        category: "start-failed",
      });
    } finally {
      this.setOauthBusy(serverName, false);
    }
  }

  private oauthErrorDiagnostic(category: McpOAuthUiErrorCategory): string {
    return t(`mcpServers.oauth.error.${category}`);
  }

  private renderOauthControls(server: McpServerSummary): TemplateResult | typeof nothing {
    if (!this.isSharedOauthServer(server)) {
      return nothing;
    }
    const status = this.oauthStatuses[server.name];
    if (!status) {
      return renderSettingsStatus({ kind: "muted", label: t("common.loading") });
    }
    const blockedReason = this.mutationBlockedReason();
    const disabled = Boolean(blockedReason) || this.oauthBusy[server.name] === true;
    if (status.state === "authorization-required") {
      return html`
        ${renderSettingsStatus({ kind: "warn", label: t("mcpServers.oauth.required") })}
        <button
          type="button"
          class="btn btn--sm mcp-oauth-authorize"
          title=${blockedReason ?? ""}
          ?disabled=${disabled}
          @click=${() => void this.startOauth(server.name, false)}
        >
          ${t("mcpServers.oauth.authorize")}
        </button>
      `;
    }
    if (status.state === "authorizing") {
      return html`
        ${renderSettingsStatus({ kind: "accent", label: t("mcpServers.oauth.waiting") })}
        <button
          type="button"
          class="btn btn--sm mcp-oauth-cancel"
          title=${blockedReason ?? ""}
          ?disabled=${disabled}
          @click=${() => void this.cancelOauth(server.name, status.authorizationId)}
        >
          ${t("common.cancel")}
        </button>
      `;
    }
    if (status.state === "ready") {
      return html`
        ${renderSettingsStatus({ kind: "ok", label: t("mcpServers.oauth.ready") })}
        <button
          type="button"
          class="btn btn--sm mcp-oauth-reauthorize"
          title=${blockedReason ?? ""}
          ?disabled=${disabled}
          @click=${() => void this.startOauth(server.name, true)}
        >
          ${t("mcpServers.oauth.reauthorize")}
        </button>
        <button
          type="button"
          class="btn btn--sm mcp-oauth-disconnect"
          title=${blockedReason ?? ""}
          ?disabled=${disabled}
          @click=${() => void this.disconnectOauth(server.name)}
        >
          ${t("mcpServers.oauth.disconnect")}
        </button>
      `;
    }
    return html`
      ${renderSettingsStatus({ kind: "danger", label: t("mcpServers.oauth.errorLabel") })}
      <span class="settings-row__desc mcp-oauth-diagnostic"
        >${this.oauthErrorDiagnostic(status.category)}</span
      >
      <button
        type="button"
        class="btn btn--sm mcp-oauth-retry"
        title=${blockedReason ?? ""}
        ?disabled=${disabled}
        @click=${() => void this.startOauth(server.name, status.credentialPresent)}
      >
        ${t("common.retry")}
      </button>
    `;
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
    const command = `openclaw mcp probe ${quoteShellArg(server.name)}`;
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
          ${server.auth === "oauth"
            ? this.renderOauthControls(server)
            : html`<code>${command}</code>`}
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
        ? renderSettingsEmpty(html`
            ${t("mcpPage.noServers")} ${renderDocsLink(this.docsUrl, t("mcpPage.setUpFirstServer"))}
          `)
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
