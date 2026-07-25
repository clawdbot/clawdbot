import { html, type TemplateResult } from "lit";
import "../../components/mcp-servers-card.ts";
import { renderSettingsRow, renderSettingsValue } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { summarizeMcpServers } from "../../lib/config/mcp-servers.ts";

type McpViewProps = {
  configObject: Record<string, unknown>;
  pluginsHref: string;
  /** Embedded schema editor; it owns autosave status and the restart banner. */
  editor: TemplateResult;
};

export function renderMcp(props: McpViewProps) {
  const rows = summarizeMcpServers(props.configObject) ?? [];
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

        <openclaw-mcp-servers-card .pluginsHref=${props.pluginsHref}></openclaw-mcp-servers-card>
      </div>

      ${props.editor}
    </section>
  `;
}
