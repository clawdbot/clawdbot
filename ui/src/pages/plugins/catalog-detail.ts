import { html, nothing, type TemplateResult } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import { icons } from "../../components/icons.ts";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { renderReasonedDisabledControl } from "../../components/reasoned-disabled-control.ts";
import { renderSettingsPage } from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { formatDateMs } from "../../lib/format.ts";
import type { PluginDiscoveryDetailResult } from "../../lib/plugins/index.ts";
import "../../styles/sidebar-markdown.css";
import { clawHubPackageUrl } from "./catalog-links.ts";
import { formatCompactCount } from "./catalog-results.ts";
import { renderPluginAuthor, renderPluginOfficialBadge } from "./plugin-card.ts";

export type PluginCatalogDetailTab =
  | "readme"
  | "skills"
  | "configuration"
  | "compatibility"
  | "versions"
  | "advanced";

export type PluginCatalogDetailProps = {
  connected: boolean;
  result: PluginDiscoveryDetailResult | null;
  error: string | null;
  tab: PluginCatalogDetailTab;
  backHref: string;
  onBack: () => void;
  onRetry: () => void;
  onTabChange: (tab: PluginCatalogDetailTab) => void;
  canInstall: boolean;
  installBlockedReason: string | null;
  onInstall: () => void;
  iconUrls: Readonly<Record<string, string>>;
};

function tabLabel(tab: PluginCatalogDetailTab): string {
  return t(`pluginsPage.detailTabs.${tab}`);
}

function securityLabel(status: string): string {
  return /^(?:clean|pass|safe)$/iu.test(status) ? "Pass" : status;
}

function securityTone(status: string): "pass" | "warning" | "danger" | "unknown" {
  if (/^(?:clean|pass|safe)$/iu.test(status)) {
    return "pass";
  }
  if (/^(?:suspicious|warning|review)$/iu.test(status)) {
    return "warning";
  }
  if (/^(?:blocked|danger|fail|malicious)$/iu.test(status)) {
    return "danger";
  }
  return "unknown";
}

function renderReadme(result: PluginDiscoveryDetailResult): TemplateResult {
  const readmeHtml = result.detail.readme
    ? toSanitizedMarkdownHtml(result.detail.readme)
        .replaceAll("<h1", "<h2")
        .replaceAll("</h1>", "</h2>")
    : null;
  return result.detail.readme
    ? html`<article class="plugin-catalog-detail__readme sidebar-markdown">
        ${unsafeHTML(readmeHtml)}
      </article>`
    : html`<p class="plugin-catalog-detail__empty">${t("pluginsPage.detailNoReadme")}</p>`;
}

function renderSkills(result: PluginDiscoveryDetailResult): TemplateResult {
  return result.detail.skills.length
    ? html`<div class="plugin-catalog-detail__rows">
        ${result.detail.skills.map(
          (skill) => html`<article class="plugin-catalog-detail__row">
            <h3>${skill.name}</h3>
            ${skill.description ? html`<p>${skill.description}</p>` : nothing}
          </article>`,
        )}
      </div>`
    : html`<p class="plugin-catalog-detail__empty">${t("pluginsPage.detailNoSkills")}</p>`;
}

function renderConfiguration(result: PluginDiscoveryDetailResult): TemplateResult {
  return result.detail.configuration.length
    ? html`<div class="plugin-catalog-detail__rows">
        ${result.detail.configuration.map(
          (field) => html`<article class="plugin-catalog-detail__row">
            <div class="plugin-catalog-detail__row-title">
              <h3><code>${field.name}</code></h3>
              <span class="plugin-catalog-detail__tag">
                ${
                  field.required ? t("pluginsPage.detailRequired") : t("pluginsPage.detailOptional")
                }
              </span>
              ${
                field.sensitive
                  ? html`<span class="plugin-catalog-detail__tag">
                      ${t("pluginsPage.detailSensitive")}
                    </span>`
                  : nothing
              }
            </div>
            ${field.description ? html`<p>${field.description}</p>` : nothing}
          </article>`,
        )}
      </div>`
    : html`<p class="plugin-catalog-detail__empty">${t("pluginsPage.detailNoConfiguration")}</p>`;
}

function compatibilityRows(result: PluginDiscoveryDetailResult): Array<[string, string]> {
  const compatibility = result.detail.compatibility;
  if (!compatibility) {
    return [];
  }
  return [
    [t("pluginsPage.detailMinimumGateway"), compatibility.minGatewayVersion],
    [t("pluginsPage.detailPluginApi"), compatibility.pluginApiRange],
    [t("pluginsPage.detailBuiltWith"), compatibility.builtWithOpenClawVersion],
    [t("pluginsPage.detailSdkVersion"), compatibility.pluginSdkVersion],
  ].filter((row): row is [string, string] => Boolean(row[1]));
}

function renderCompatibility(result: PluginDiscoveryDetailResult): TemplateResult {
  const rows = compatibilityRows(result);
  return rows.length
    ? html`<dl class="plugin-catalog-detail__definition-list">
        ${rows.map(
          (row) =>
            html`<div>
              <dt>${row[0]}</dt>
              <dd>${row[1]}</dd>
            </div>`,
        )}
      </dl>`
    : html`<p class="plugin-catalog-detail__empty">${t("pluginsPage.detailNoCompatibility")}</p>`;
}

function renderVersions(result: PluginDiscoveryDetailResult): TemplateResult {
  return result.detail.versions.length
    ? html`<div class="plugin-catalog-detail__rows">
        ${result.detail.versions.map(
          (version) => html`<article class="plugin-catalog-detail__row">
            <div class="plugin-catalog-detail__row-title">
              <h3>${version.version}</h3>
              ${version.tags.map(
                (tag) => html`<span class="plugin-catalog-detail__tag">${tag}</span>`,
              )}
              <time datetime=${new Date(version.createdAt).toISOString()}>
                ${formatDateMs(version.createdAt, { dateStyle: "medium" })}
              </time>
            </div>
            ${version.changelog ? html`<p>${version.changelog}</p>` : nothing}
          </article>`,
        )}
      </div>`
    : html`<p class="plugin-catalog-detail__empty">${t("pluginsPage.detailNoVersions")}</p>`;
}

function renderAdvanced(result: PluginDiscoveryDetailResult): TemplateResult {
  const detail = result.detail;
  const verification = detail.verification;
  const rows: Array<[string, string | undefined]> = [
    [t("pluginsPage.detailOrigin"), detail.origin],
    [t("pluginsPage.detailPackage"), detail.packageName],
    [t("pluginsPage.detailSourceCommit"), verification?.sourceCommit],
    [t("pluginsPage.detailSourcePath"), verification?.sourcePath],
    [t("pluginsPage.detailMcpServers"), detail.mcpServers.join(", ") || undefined],
  ];
  return html`<dl class="plugin-catalog-detail__definition-list">
    ${rows
      .filter((row): row is [string, string] => Boolean(row[1]))
      .map(
        (row) =>
          html`<div>
            <dt>${row[0]}</dt>
            <dd><code>${row[1]}</code></dd>
          </div>`,
      )}
  </dl>`;
}

function renderTabPanel(
  result: PluginDiscoveryDetailResult,
  tab: PluginCatalogDetailTab,
): TemplateResult {
  if (tab === "skills") {
    return renderSkills(result);
  }
  if (tab === "configuration") {
    return renderConfiguration(result);
  }
  if (tab === "compatibility") {
    return renderCompatibility(result);
  }
  if (tab === "versions") {
    return renderVersions(result);
  }
  if (tab === "advanced") {
    return renderAdvanced(result);
  }
  return renderReadme(result);
}

function renderDetail(result: PluginDiscoveryDetailResult, props: PluginCatalogDetailProps) {
  const { plugin, detail } = result;
  const authorHandle = detail.author?.handle ?? plugin.catalog.author;
  const packageUrl = clawHubPackageUrl(detail.packageName, authorHandle);
  const packageIcon = plugin.catalog.imageUrl ? props.iconUrls[plugin.catalog.imageUrl] : undefined;
  const publisherIcon = detail.author?.imageUrl
    ? props.iconUrls[detail.author.imageUrl]
    : undefined;
  const publisherName = detail.author?.displayName ?? authorHandle ?? plugin.catalog.name;
  const tabs: PluginCatalogDetailTab[] = ["readme"];
  if (detail.skills.length) {
    tabs.push("skills");
  }
  if (detail.configuration.length) {
    tabs.push("configuration");
  }
  if (compatibilityRows(result).length) {
    tabs.push("compatibility");
  }
  tabs.push("versions", "advanced");

  return html`<section class="plugin-catalog-detail" aria-labelledby="plugin-catalog-detail-title">
    <nav class="plugins-settings-breadcrumb" aria-label=${t("pluginsPage.breadcrumb")}>
      <a
        class="plugins-settings-breadcrumb__parent"
        href=${props.backHref}
        @click=${(event: MouseEvent) => {
          event.preventDefault();
          props.onBack();
        }}
        >${t("tabs.plugins")}</a
      >
      <span class="plugins-settings-breadcrumb__chevron" aria-hidden="true"
        >${icons.chevronRight}</span
      >
      <span class="plugins-settings-breadcrumb__current" aria-current="page"
        >${plugin.catalog.name}</span
      >
    </nav>
    <div class="plugin-catalog-detail__hero">
      <main>
        <div class="plugin-catalog-detail__title-row">
          <h1 id="plugin-catalog-detail-title">${plugin.catalog.name}</h1>
          ${
            plugin.local.action === "install"
              ? renderReasonedDisabledControl(
                  props.installBlockedReason,
                  html`<button
                    type="button"
                    class="btn primary oc-action oc-action-primary plugin-catalog-detail__install"
                    ?disabled=${!props.installBlockedReason && !props.canInstall}
                    aria-disabled=${!props.canInstall ? "true" : nothing}
                    @click=${() => {
                      if (props.canInstall) {
                        props.onInstall();
                      }
                    }}
                  >
                    ${t("pluginsPage.install")}
                  </button>`,
                )
              : nothing
          }
        </div>
        ${
          plugin.catalog.summary
            ? html`<p class="plugin-catalog-detail__summary">${plugin.catalog.summary}</p>`
            : nothing
        }
        <div class="plugin-catalog-detail__publisher">
          <span class="plugin-catalog-detail__publisher-icon" aria-hidden="true">
            ${
              publisherIcon || packageIcon
                ? html`<img src=${publisherIcon ?? packageIcon} alt="" />`
                : icons.box
            }
          </span>
          <div>
            <div class="plugin-catalog-detail__publisher-name">
              <strong>${publisherName}</strong>
              ${plugin.catalog.official ? renderPluginOfficialBadge() : nothing}
            </div>
            ${renderPluginAuthor(authorHandle, { linked: true })}
          </div>
        </div>
      </main>
      <aside class="plugin-catalog-detail__sidebar">
        <dl>
          ${
            plugin.catalog.downloads === undefined
              ? nothing
              : html`<div>
                  <dt>${t("pluginsPage.catalogDownloadsColumn")}</dt>
                  <dd>${icons.download} ${formatCompactCount(plugin.catalog.downloads)}</dd>
                </div>`
          }
          ${
            plugin.catalog.latestVersion
              ? html`<div>
                  <dt>${t("pluginsPage.version")}</dt>
                  <dd>${plugin.catalog.latestVersion}</dd>
                </div>`
              : nothing
          }
          ${
            detail.updatedAt
              ? html`<div>
                  <dt>${t("pluginsPage.detailUpdated")}</dt>
                  <dd>${formatDateMs(detail.updatedAt, { dateStyle: "medium" })}</dd>
                </div>`
              : nothing
          }
        </dl>
        ${
          detail.security
            ? html`<a
                class="plugin-catalog-detail__security plugin-catalog-detail__security--${securityTone(
                  detail.security.status,
                )}"
                href=${packageUrl ? `${packageUrl}/security-audit` : nothing}
                target="_blank"
                rel="noopener noreferrer"
              >
                <h2>${t("pluginsPage.detailSecurity")} ${icons.info}</h2>
                <div class="plugin-catalog-detail__security-score">
                  <strong>${securityLabel(detail.security.status)}</strong>
                  <span aria-hidden="true"></span><span aria-hidden="true"></span
                  ><span aria-hidden="true"></span>
                </div>
              </a>`
            : nothing
        }
        ${
          packageUrl
            ? html`<a
                class="btn plugin-catalog-detail__clawhub"
                href=${packageUrl}
                target="_blank"
                rel="noopener noreferrer"
                >${t("pluginsPage.detailViewOnClawHub")}</a
              >`
            : nothing
        }
      </aside>
    </div>
    ${renderHubTabs({
      id: "plugin-catalog-detail",
      active: props.tab,
      tabs: tabs.map((tab) => ({ value: tab, label: tabLabel(tab) })),
      ariaLabel: t("pluginsPage.detailSections"),
      panelId: "plugin-catalog-detail-panel",
      className: "plugin-catalog-detail__tabs",
      onSelect: props.onTabChange,
    })}
    <section
      id="plugin-catalog-detail-panel"
      class="plugin-catalog-detail__panel"
      role="tabpanel"
      aria-labelledby=${`plugin-catalog-detail-tab-${props.tab}`}
    >
      ${renderTabPanel(result, props.tab)}
    </section>
  </section>`;
}

export function renderPluginCatalogDetail(props: PluginCatalogDetailProps): TemplateResult {
  return renderSettingsPage(
    props.error
      ? html`<div class="callout danger oc-banner oc-banner-error" role="alert">
          <span>${formatUiExternalText(props.error)}</span>
          <button type="button" class="btn btn--sm" @click=${props.onRetry}>
            ${t("pluginsPage.tryAgain")}
          </button>
        </div>`
      : !props.connected
        ? html`<p class="plugin-catalog-detail__empty">${t("pluginsPage.discoveryOffline")}</p>`
        : props.result
          ? renderDetail(props.result, props)
          : html`<section
              class="plugin-catalog-detail plugin-catalog-detail--loading"
              aria-label=${t("pluginsPage.detailLoading")}
            >
              <div class="plugin-catalog-detail__back skeleton"></div>
              <div class="plugin-catalog-detail__hero">
                <main>
                  <div class="plugin-catalog-detail__loading-title skeleton"></div>
                  <div class="plugin-catalog-detail__loading-summary skeleton"></div>
                  <div class="plugin-catalog-detail__loading-publisher skeleton"></div>
                </main>
                <aside class="plugin-catalog-detail__sidebar">
                  <div class="plugin-catalog-detail__loading-card skeleton"></div>
                  <div class="plugin-catalog-detail__loading-card skeleton"></div>
                </aside>
              </div>
              <div class="plugin-catalog-detail__loading-tabs skeleton"></div>
              <div class="plugin-catalog-detail__loading-readme skeleton"></div>
            </section>`,
    { wide: true, carapace: true },
  );
}
