// Control UI MCP Settings page presentation.
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { html, type TemplateResult } from "lit";
import {
  renderSettingsEmpty,
  renderSettingsRow,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";

type McpServerRow = {
  name: string;
  enabled: boolean;
  transport: "stdio" | "http" | "invalid";
  auth: string | null;
  launch: string;
  toolFilter: boolean;
  parallel: boolean;
  tls: string | null;
};

type McpViewProps = {
  configObject: Record<string, unknown>;
  pluginsHref: string;
  /** Embedded schema editor; it owns autosave status and the restart banner. */
  editor: TemplateResult;
};

function getMcpServers(configObject: Record<string, unknown>): Record<string, unknown> {
  return asRecord(asRecord(configObject.mcp)?.servers) ?? {};
}

function summarizeServer(name: string, value: unknown): McpServerRow {
  const server = asRecord(value) ?? {};
  const url = typeof server.url === "string" ? server.url : "";
  const command = typeof server.command === "string" ? server.command : "";
  const transport = url ? "http" : command ? "stdio" : "invalid";
  const auth = typeof server.auth === "string" ? server.auth : null;
  const launch = url || command || t("mcpPage.missingTransport");
  const tls =
    server.sslVerify === false
      ? t("mcpPage.tlsVerifyOff")
      : server.clientCert || server.clientKey
        ? t("mcpPage.mtls")
        : null;
  return {
    name,
    enabled: server.enabled !== false,
    transport,
    auth,
    launch: url ? redactSensitiveUrlLikeString(launch) : launch,
    toolFilter: Boolean(server.toolFilter),
    parallel: server.supportsParallelToolCalls === true,
    tls,
  };
}

function quoteShellArg(value: string): string {
  return /^[A-Za-z0-9._:/-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function renderServerRow(server: McpServerRow) {
  const quotedName = quoteShellArg(server.name);
  const probeCommand = `openclaw mcp probe ${quotedName}`;
  const loginCommand = `openclaw mcp login ${quotedName}`;
  const meta = [
    server.transport,
    server.auth,
    server.toolFilter ? t("mcpPage.toolFilter") : null,
    server.parallel ? t("mcpPage.parallel") : null,
    server.tls,
  ].filter((part): part is string => Boolean(part));
  return html`
    <div class="settings-row mcp-server-row">
      <div class="settings-row__text">
        <span class="settings-row__title">${server.name}</span>
        <span class="settings-row__desc mcp-server-row__launch">${server.launch}</span>
        <span class="settings-row__desc">${meta.join(" · ")}</span>
      </div>
      <div class="settings-row__control">
        ${renderSettingsStatus({
          kind: server.enabled ? "ok" : "muted",
          label: server.enabled ? t("common.enabled") : t("common.disabled"),
        })}
        <code>${server.auth === "oauth" ? loginCommand : probeCommand}</code>
      </div>
    </div>
  `;
}

export function renderMcp(props: McpViewProps) {
  const rows = Object.entries(getMcpServers(props.configObject))
    .map(([name, server]) => summarizeServer(name, server))
    .toSorted((a, b) => a.name.localeCompare(b.name));
  const enabledCount = rows.filter((row) => row.enabled).length;
  const oauthCount = rows.filter((row) => row.auth === "oauth").length;
  const filteredCount = rows.filter((row) => row.toolFilter).length;
  return html`
    <section class="mcp-page">
      <div class="settings-page">
        <section class="settings-section mcp-page__summary">
          <div class="settings-section__header">
            <h2 class="settings-section__heading">${t("mcpPage.servers")}</h2>
          </div>
          <div class="settings-group">
            ${renderSettingsRow({
              title: t("mcpPage.servers"),
              control: renderSettingsValue(rows.length),
            })}
            ${renderSettingsRow({
              title: t("common.enabled"),
              control: renderSettingsValue(enabledCount),
            })}
            ${renderSettingsRow({
              title: t("mcpPage.oauth"),
              control: renderSettingsValue(oauthCount),
            })}
            ${renderSettingsRow({
              title: t("mcpPage.filtered"),
              control: renderSettingsValue(filteredCount),
            })}
          </div>
        </section>

        <section class="settings-section">
          <div class="settings-section__header">
            <h2 class="settings-section__heading">${t("mcpPage.operatorCommands")}</h2>
          </div>
          <p class="settings-section__desc">${t("mcpPage.operatorCommandsHint")}</p>
          <div class="settings-group">
            <div class="settings-row settings-row--stacked">
              <div class="mcp-command-card__grid">
                <code>openclaw mcp status --verbose</code>
                <code>openclaw mcp doctor --probe</code>
                <code>openclaw mcp login &lt;name&gt;</code>
                <code>openclaw mcp reload</code>
              </div>
            </div>
          </div>
        </section>

        <section class="settings-section mcp-server-list">
          <div class="settings-section__header">
            <h2 class="settings-section__heading">${t("mcpPage.configuredServers")}</h2>
          </div>
          <p class="settings-section__desc">
            ${t("mcpPage.runtimeHint")}
            <a href=${props.pluginsHref}>${t("mcpPage.manageServersLink")}</a>
          </p>
          <div class="settings-group">
            ${rows.length
              ? rows.map((row) => renderServerRow(row))
              : renderSettingsEmpty(t("mcpPage.noServers"))}
          </div>
        </section>
      </div>

      ${props.editor}
    </section>
  `;
}
