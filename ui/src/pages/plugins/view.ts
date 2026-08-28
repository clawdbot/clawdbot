// Control UI plugins page: installed inventory, discover store with inline
// ClawHub search, plugin detail overlay, and MCP server management.
// Layout follows the settings design language (ui/docs/design-system/
// settings-design.md): section headings outside one group surface, rows with
// an action cluster in the control slot, and dot+text status instead of pills.
import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../components/icons.ts";
import { renderMcpServerForm, type McpServerForm } from "../../components/mcp-server-form.ts";
import "../../components/modal-dialog.ts";
import "../../components/openclaw-mascot.ts";
import {
  renderSettingsEmpty,
  renderSettingsPage,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsStatus,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import type { McpServerSummary } from "../../lib/config/mcp-servers.ts";
import { EXTERNAL_LINK_TARGET, buildExternalLinkRel } from "../../lib/external-link.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import "../../styles/plugins.css";
import {
  CLAWHUB_BROWSE_URL,
  resolvePluginInstallIdentity,
  type PluginCatalogItem,
  type PluginInstallRequest,
  type PluginListResult,
  type PluginSearchResult,
  type PluginsInspectResult,
} from "../../lib/plugins/index.ts";
import {
  pluginOriginLabel,
  pluginVerificationLabel,
  renderArtTile,
  renderPluginConsentDialog,
  renderPluginDeclaredCapabilities,
  renderPluginGrants,
  renderPluginMetaRow,
  type PluginConsentState,
} from "./consent-dialog.ts";
import type { PluginInstallPolicyWarningDetails } from "./install-policy-warning.ts";
import {
  CONNECTOR_GROUP_ORDER,
  CONNECTOR_SUGGESTIONS,
  PLUGIN_CATEGORY_ORDER,
  pluginCategoryLabel,
  type ConnectorGroup,
  type ConnectorSuggestion,
} from "./presentation.ts";

export type PluginsTab = "installed" | "discover";

export type InstalledFilter = "all" | "enabled" | "disabled" | "issues";

export type PluginRowMessage = {
  kind: "success" | "error" | "warning";
  text: string;
  installPolicyWarning?: {
    details: PluginInstallPolicyWarningDetails;
    request: PluginInstallRequest;
  };
};

type PluginInstallPolicyFinding = NonNullable<
  PluginInstallPolicyWarningDetails["findings"]
>[number];

function policyFindingSeverityLabel(severity: PluginInstallPolicyFinding["severity"]): string {
  switch (severity) {
    case "info":
      return t("pluginsPage.policyReviewSeverityInfo");
    case "warn":
      return t("pluginsPage.policyReviewSeverityWarn");
    case "critical":
      return t("pluginsPage.policyReviewSeverityCritical");
  }
  const unreachableSeverity: never = severity;
  return unreachableSeverity;
}

type PluginsViewProps = {
  connected: boolean;
  loading: boolean;
  result: PluginListResult | null;
  error: string | null;
  activeTab: PluginsTab;
  query: string;
  installedFilter: InstalledFilter;
  searchResults: PluginSearchResult[] | null;
  searchLoading: boolean;
  searchError: string | null;
  busy: Readonly<Record<string, boolean>>;
  messages: Readonly<Record<string, PluginRowMessage>>;
  detailPluginId: string | null;
  detailInspection: PluginsInspectResult | null;
  detailInspectionError: string | null;
  consent: PluginConsentState | null;
  consentInspection: PluginsInspectResult | null;
  consentInspectionLoading: boolean;
  consentInspectionError: string | null;
  iconUrls: Readonly<Record<string, string>>;
  canMutate: boolean;
  mutationBlockedReason: string | null;
  pageNotice: PluginRowMessage | null;
  mcpSettingsHref: string;
  mcpServers: McpServerSummary[] | null;
  mcpMessage: PluginRowMessage | null;
  mcpBusy: boolean;
  mcpFormOpen: boolean;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: InstalledFilter) => void;
  onRefresh: () => void;
  onIconError: (pluginId: string) => void;
  onShowDetails: (pluginId: string | null) => void;
  onSetEnabled: (pluginId: string, enabled: boolean, rowKey: string) => void;
  onInstall: (request: PluginInstallRequest, installIdentity: string) => void;
  onCancelConsent: () => void;
  onConfirmConsent: () => void;
  onRetryConsentInspection: () => void;
  onDismissMessage: (rowKey: string) => void;
  onUninstall: (pluginId: string, rowKey: string) => void;
  onAddConnector: (suggestion: ConnectorSuggestion) => void;
  onSearchClawHub: (query: string) => void;
  onMcpToggle: (name: string, enabled: boolean) => void;
  onMcpRemove: (name: string) => void;
  onMcpFormToggle: (open: boolean) => void;
  onMcpAdd: (form: McpServerForm) => void;
};

const INSTALLED_FILTERS: readonly InstalledFilter[] = ["all", "enabled", "disabled", "issues"];

function filterLabel(filter: InstalledFilter): string {
  switch (filter) {
    case "all":
      return t("pluginsPage.filterAll");
    case "enabled":
      return t("pluginsPage.enabled");
    case "disabled":
      return t("pluginsPage.disabled");
    case "issues":
      return t("pluginsPage.filterIssues");
    default:
      return filter satisfies never;
  }
}

function connectorGroupLabel(group: ConnectorGroup): string {
  switch (group) {
    case "work":
      return t("pluginsPage.connectorGroupWork");
    case "dev":
      return t("pluginsPage.connectorGroupDev");
    case "home":
      return t("pluginsPage.connectorGroupHome");
    case "life":
      return t("pluginsPage.connectorGroupLife");
    default:
      return group satisfies never;
  }
}

export function pluginRowKey(pluginId: string): string {
  return `plugin:${pluginId}`;
}

function clawHubRowKey(packageName: string): string {
  return `clawhub:${packageName}`;
}

function resolveInstallIdentity(
  props: PluginsViewProps,
  request: PluginInstallRequest,
  runtimeId?: string,
): string {
  return resolvePluginInstallIdentity(request, props.result?.plugins ?? [], runtimeId);
}

function installOperationBusy(props: PluginsViewProps, identity: string | undefined): boolean {
  return identity ? Boolean(props.busy[identity]) : false;
}

export function connectorRowKey(connectorId: string): string {
  return `connector:${connectorId}`;
}

function normalizedQuery(query: string): string {
  return query.trim().toLocaleLowerCase();
}

function matchesPlugin(plugin: PluginCatalogItem, query: string): boolean {
  const needle = normalizedQuery(query);
  if (!needle) {
    return true;
  }
  return [
    plugin.name,
    plugin.id,
    plugin.packageName,
    plugin.description,
    plugin.origin,
    plugin.category,
    ...(plugin.kind ?? []),
  ].some((value) => value?.toLocaleLowerCase().includes(needle));
}

function matchesConnector(connector: ConnectorSuggestion, query: string): boolean {
  const needle = normalizedQuery(query);
  if (!needle) {
    return true;
  }
  return [connector.id, connector.name, t(connector.descriptionKey)].some((value) =>
    value.toLocaleLowerCase().includes(needle),
  );
}

function sortCatalogPlugins(plugins: readonly PluginCatalogItem[]): PluginCatalogItem[] {
  return plugins.toSorted((left, right) => {
    const featured = Number(Boolean(right.featured)) - Number(Boolean(left.featured));
    if (featured !== 0) {
      return featured;
    }
    if (left.featured && right.featured) {
      const leftFeaturedAt = left.featuredAt;
      const rightFeaturedAt = right.featuredAt;
      if (leftFeaturedAt !== undefined || rightFeaturedAt !== undefined) {
        if (leftFeaturedAt === undefined) {
          return 1;
        }
        if (rightFeaturedAt === undefined) {
          return -1;
        }
        if (leftFeaturedAt !== rightFeaturedAt) {
          return rightFeaturedAt - leftFeaturedAt;
        }
      }
    }
    return (
      (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) ||
      left.name.localeCompare(right.name)
    );
  });
}

function installedPlugins(
  plugins: readonly PluginCatalogItem[],
  query = "",
  filter: InstalledFilter = "all",
): PluginCatalogItem[] {
  return sortCatalogPlugins(
    plugins.filter((plugin) => {
      if (!plugin.installed || !matchesPlugin(plugin, query)) {
        return false;
      }
      switch (filter) {
        case "enabled":
          return plugin.enabled && plugin.state !== "error";
        case "disabled":
          return !plugin.enabled && plugin.state !== "error";
        case "issues":
          return plugin.state === "error";
        default:
          return true;
      }
    }),
  );
}

type InstalledCategoryGroup = {
  category: string;
  label: string;
  plugins: PluginCatalogItem[];
};

function groupInstalledByCategory(plugins: readonly PluginCatalogItem[]): InstalledCategoryGroup[] {
  const groups = new Map<string, PluginCatalogItem[]>();
  for (const plugin of plugins) {
    const category = plugin.category ?? "other";
    const group = groups.get(category) ?? [];
    group.push(plugin);
    groups.set(category, group);
  }
  const rank = (category: string) => {
    const index = PLUGIN_CATEGORY_ORDER.indexOf(category);
    return index === -1 ? PLUGIN_CATEGORY_ORDER.length : index;
  };
  return [...groups.entries()]
    .map(([category, entries]) => ({
      category,
      label: pluginCategoryLabel(category),
      plugins: entries,
    }))
    .toSorted((left, right) => rank(left.category) - rank(right.category));
}

type DiscoverShelves = {
  featured: PluginCatalogItem[];
  official: PluginCatalogItem[];
  connectors: ConnectorSuggestion[];
};

function discoverShelves(plugins: readonly PluginCatalogItem[], query = ""): DiscoverShelves {
  const featured = sortCatalogPlugins(
    plugins.filter((plugin) => plugin.featured && matchesPlugin(plugin, query)),
  );
  const featuredIds = new Set(featured.map((plugin) => plugin.id));
  const official = sortCatalogPlugins(
    plugins.filter(
      (plugin) =>
        !featuredIds.has(plugin.id) &&
        plugin.origin === "official" &&
        !plugin.installed &&
        matchesPlugin(plugin, query),
    ),
  );
  const connectors = CONNECTOR_SUGGESTIONS.filter((connector) =>
    matchesConnector(connector, query),
  );
  return { featured, official, connectors };
}

const compactNumber = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

function stateLabel(plugin: PluginCatalogItem): string {
  switch (plugin.state) {
    case "enabled":
      return t("pluginsPage.enabled");
    case "disabled":
      return t("pluginsPage.disabled");
    case "error":
      return t("pluginsPage.needsAttention");
    case "not-installed":
      return t("pluginsPage.available");
    default:
      return plugin.state satisfies never;
  }
}

function stateStatus(plugin: PluginCatalogItem) {
  const kind = plugin.state === "enabled" ? "ok" : plugin.state === "error" ? "danger" : "muted";
  return renderSettingsStatus({ kind, label: stateLabel(plugin) });
}

/** Rows pair the status with an Enable/Disable button that already implies the
 * healthy states, so only the error status earns a pill next to the actions. */
function rowStateStatus(plugin: PluginCatalogItem) {
  return plugin.state === "error" ? stateStatus(plugin) : nothing;
}

function requestInstall(
  props: PluginsViewProps,
  request: PluginInstallRequest,
  installIdentity?: string,
) {
  if (installIdentity) {
    props.onInstall(request, installIdentity);
  }
}

/** Dot-separated plain-text meta line under a row description. */
function renderMetaLine(parts: ReadonlyArray<TemplateResult | string | typeof nothing>) {
  const visible = parts.filter((part) => part !== nothing && part !== "");
  if (visible.length === 0) {
    return nothing;
  }
  return html`<span class="settings-row__desc plugins-meta">
    ${visible.map(
      (part, index) =>
        html`${index > 0 ? html`<span aria-hidden="true"> · </span>` : nothing}${part}`,
    )}
  </span>`;
}

function renderRowMessage(
  key: string,
  message: PluginRowMessage | undefined,
  busy: boolean,
  props: PluginsViewProps,
  installIdentity?: string,
) {
  const messageKey = message ? key : (installIdentity ?? key);
  const resolvedMessage =
    message ?? (installIdentity ? props.messages[installIdentity] : undefined);
  if (!resolvedMessage) {
    return nothing;
  }
  if (resolvedMessage.installPolicyWarning) {
    const { details, request } = resolvedMessage.installPolicyWarning;
    const findings = details.findings ?? [];
    const reviewBody =
      findings.length === 0
        ? t("pluginsPage.policyReviewBodyReason", {
            reason: formatUiExternalText(details.reason),
          })
        : t("pluginsPage.policyReviewBodyKnown", { count: String(findings.length) });
    return html`
      <div
        class="plugins-row-message plugins-row-message--warning plugins-policy-review"
        role="alert"
      >
        <div class="plugins-policy-review__header">
          <span class="plugins-policy-review__icon" aria-hidden="true">
            ${icons.alertTriangle}
          </span>
          <div>
            <strong>${t("pluginsPage.policyReviewTitle")}</strong>
            ${findings.length > 0
              ? html`<span class="plugins-policy-review__reason"
                  >${formatUiExternalText(details.reason)}</span
                >`
              : nothing}
            <span>${reviewBody}</span>
          </div>
        </div>
        ${findings.length > 0
          ? html`
              <section class="plugins-policy-review__findings-panel">
                <strong class="plugins-policy-review__findings-heading"
                  >${t("pluginsPage.policyReviewFindings")}</strong
                >
                <ul class="plugins-policy-review__findings">
                  ${findings.map(
                    (finding) => html`
                      <li>
                        <span class="plugins-policy-review__finding-content">
                          <span
                            class="plugins-policy-review__severity plugins-policy-review__severity--${finding.severity}"
                            >${policyFindingSeverityLabel(finding.severity)}</span
                          >
                          <span>${formatUiExternalText(finding.message)}</span>
                        </span>
                      </li>
                    `,
                  )}
                </ul>
              </section>
            `
          : nothing}
        ${findings.length > 0
          ? html`
              <details class="plugins-policy-review__details">
                <summary>
                  <span class="plugins-policy-review__details-chevron" aria-hidden="true"
                    >${icons.chevronRight}</span
                  >
                  <span>${t("pluginsPage.policyReviewTechnicalDetails")}</span>
                </summary>
                <div class="plugins-policy-review__details-body">
                  <ul>
                    ${findings.map(
                      (finding) => html`
                        <li>
                          <code>${finding.ruleId}</code>
                          ${finding.file
                            ? html`<code
                                >${finding.file}${finding.line ? `:${finding.line}` : ""}</code
                              >`
                            : nothing}
                          ${finding.evidence ? html`<span>${finding.evidence}</span>` : nothing}
                        </li>
                      `,
                    )}
                  </ul>
                </div>
              </details>
            `
          : nothing}
        <p class="plugins-policy-review__scope">${t("pluginsPage.policyReviewScope")}</p>
        <div class="plugins-policy-review__actions">
          <button
            type="button"
            class="btn btn--sm"
            ?disabled=${busy}
            @click=${() => props.onDismissMessage(messageKey)}
          >
            ${t("pluginsPage.cancel")}
          </button>
          <button
            type="button"
            class="btn btn--sm danger"
            title=${props.mutationBlockedReason ?? ""}
            ?disabled=${busy || !props.canMutate}
            @click=${() =>
              requestInstall(
                props,
                {
                  ...request,
                  acknowledgeInstallPolicyWarning: true,
                },
                installIdentity,
              )}
          >
            ${busy ? t("pluginsPage.installing") : t("pluginsPage.installAnyway")}
          </button>
        </div>
      </div>
    `;
  }
  const role = resolvedMessage.kind === "error" ? "alert" : "status";
  return html`
    <div class="plugins-row-message plugins-row-message--${resolvedMessage.kind}" role=${role}>
      <span>${resolvedMessage.text}</span>
    </div>
  `;
}

/** Ignore activations bubbling from interactive children so rows stay clickable. */
function fromInteractiveChild(event: Event): boolean {
  return Boolean(
    (event.target as HTMLElement | null)?.closest(
      "button, a, input, label, form, summary, .plugins-policy-review, [role='menu']",
    ),
  );
}

function renderToggleButton(
  props: PluginsViewProps,
  busy: boolean,
  options: { enabled: boolean; onToggle: (enabled: boolean) => void },
) {
  const enable = !options.enabled;
  return html`
    <button
      type="button"
      class="btn btn--sm"
      title=${props.mutationBlockedReason ?? ""}
      ?disabled=${!props.canMutate || busy}
      @click=${(event: Event) => {
        event.stopPropagation();
        options.onToggle(enable);
      }}
    >
      ${busy
        ? t("pluginsPage.working")
        : enable
          ? t("pluginsPage.enableAction")
          : t("pluginsPage.disableAction")}
    </button>
  `;
}

function renderRemoveButton(
  props: PluginsViewProps,
  busy: boolean,
  name: string,
  onRemove: () => void,
) {
  return html`
    <button
      type="button"
      class="btn btn--sm btn--icon plugins-remove"
      aria-label=${t("pluginsPage.removeNamed", { name })}
      title=${props.mutationBlockedReason ?? t("pluginsPage.removeNamed", { name })}
      ?disabled=${!props.canMutate || busy}
      @click=${(event: Event) => {
        event.stopPropagation();
        onRemove();
      }}
    >
      ${icons.trash}
    </button>
  `;
}

function renderInstallButton(
  props: PluginsViewProps,
  busy: boolean,
  name: string,
  request: PluginInstallRequest,
  installIdentity: string,
) {
  const installMessage = props.messages[installIdentity];
  if (installMessage?.installPolicyWarning) {
    return nothing;
  }
  return html`
    <button
      type="button"
      class="btn btn--sm plugins-install"
      title=${props.mutationBlockedReason ?? ""}
      aria-label=${t("pluginsPage.installNamed", { name })}
      ?disabled=${!props.canMutate || busy}
      @click=${(event: Event) => {
        event.stopPropagation();
        props.onInstall(request, installIdentity);
      }}
    >
      ${busy ? t("pluginsPage.installing") : t("pluginsPage.install")}
    </button>
  `;
}

function renderCatalogActions(
  plugin: PluginCatalogItem,
  props: PluginsViewProps,
  busy: boolean,
  rowKey: string,
) {
  if (!plugin.installed) {
    const install = plugin.install;
    return install
      ? renderInstallButton(
          props,
          busy,
          plugin.name,
          install,
          resolveInstallIdentity(props, install),
        )
      : html`<span class="plugins-action-note">${t("pluginsPage.unavailable")}</span>`;
  }
  return html`
    ${renderToggleButton(props, busy, {
      enabled: plugin.enabled,
      onToggle: (enabled) => props.onSetEnabled(plugin.id, enabled, rowKey),
    })}
    ${plugin.removable
      ? renderRemoveButton(props, busy, plugin.name, () => props.onUninstall(plugin.id, rowKey))
      : nothing}
  `;
}

/* ---------------------------------- installed tab ---------------------------------- */

/** Segmented filter doubling as the inventory overview: label + live count per state. */
function renderInstalledFilter(props: PluginsViewProps) {
  const installed = (props.result?.plugins ?? []).filter((plugin) => plugin.installed);
  const issues = installed.filter((plugin) => plugin.state === "error").length;
  const enabled = installed.filter((plugin) => plugin.enabled && plugin.state !== "error").length;
  const counts: Record<InstalledFilter, number> = {
    all: installed.length,
    enabled,
    disabled: installed.length - enabled - issues,
    issues,
  };
  return renderSettingsSegmented<InstalledFilter>({
    value: props.installedFilter,
    ariaLabel: t("pluginsPage.filterLabel"),
    options: INSTALLED_FILTERS.map((filter) => ({
      value: filter,
      label: html`${filterLabel(filter)} <span class="settings-count">${counts[filter]}</span>`,
    })),
    onChange: (value) => props.onFilterChange(value),
  });
}

function renderPluginHeading(params: {
  name: string;
  content: TemplateResult;
  onShowDetails?: () => void;
}): TemplateResult {
  return html`
    <h3 class="settings-row__title">
      ${params.onShowDetails
        ? html`
            <button
              type="button"
              class="plugins-item__detail-button"
              aria-label=${params.name}
              @click=${(event: Event) => {
                event.stopPropagation();
                params.onShowDetails?.();
              }}
            >
              ${params.content}
            </button>
          `
        : params.content}
    </h3>
  `;
}

function renderPluginRow(
  plugin: PluginCatalogItem,
  props: PluginsViewProps,
  includePackageName = false,
): TemplateResult {
  const key = pluginRowKey(plugin.id);
  const installIdentity = plugin.install
    ? resolveInstallIdentity(props, plugin.install)
    : undefined;
  const busy = props.busy[key] || installOperationBusy(props, installIdentity);
  return html`
    <article
      class="settings-row plugins-item plugins-item--clickable"
      data-plugin-id=${plugin.id}
      data-plugin-source=${plugin.origin ?? "unknown"}
      data-plugin-status=${plugin.state}
      aria-busy=${busy ? "true" : "false"}
      @click=${(event: Event) => {
        if (!fromInteractiveChild(event)) {
          props.onShowDetails(plugin.id);
        }
      }}
    >
      ${renderArtTile(plugin.id, plugin.name, props.iconUrls[plugin.id], () =>
        props.onIconError(plugin.id),
      )}
      <div class="settings-row__text">
        ${renderPluginHeading({
          name: plugin.name,
          content: html`
            ${plugin.name}
            ${plugin.version
              ? includePackageName
                ? html`<span class="plugins-version">v${plugin.version}</span>`
                : html`<span class="plugins-version">v${plugin.version}</span>`
              : nothing}
          `,
          onShowDetails: () => props.onShowDetails(plugin.id),
        })}
        <span class="settings-row__desc">
          ${plugin.description || t("pluginsPage.optionalCapability")}
        </span>
        ${renderMetaLine([
          plugin.origin ? pluginOriginLabel(plugin.origin) : nothing,
          includePackageName && plugin.packageName
            ? html`<span class="plugins-meta__mono">${plugin.packageName}</span>`
            : nothing,
        ])}
      </div>
      <div class="settings-row__control">
        ${plugin.installed ? rowStateStatus(plugin) : nothing}
        ${renderCatalogActions(plugin, props, busy, key)}
      </div>
      ${plugin.error
        ? html`<div class="plugins-row-message plugins-row-message--error" role="alert">
            ${formatUiExternalText(plugin.error)}
          </div>`
        : nothing}
      ${renderRowMessage(key, props.messages[key], busy, props, installIdentity)}
    </article>
  `;
}

function renderMcpSection(props: PluginsViewProps) {
  const needle = normalizedQuery(props.query);
  const servers = props.mcpServers?.filter(
    (server) =>
      !needle ||
      server.name.toLocaleLowerCase().includes(needle) ||
      server.target.toLocaleLowerCase().includes(needle),
  );
  if (needle && servers && servers.length === 0) {
    return nothing;
  }
  const body = !servers
    ? html`<div class="plugins-search-state" role="status">${t("pluginsPage.loading")}</div>`
    : servers.length === 0
      ? renderSettingsEmpty(t("pluginsPage.mcpEmpty"))
      : repeat(
          servers,
          (server) => server.name,
          (server) => renderMcpRow(server, props),
        );
  return renderSettingsSection(
    {
      title: t("pluginsPage.mcpServersGroup"),
      ...(servers ? { count: servers.length } : {}),
      description: t("pluginsPage.mcpHint"),
      actions: html`
        <a class="plugins-group__link" href=${props.mcpSettingsHref}
          >${t("pluginsPage.mcpSettingsLink")}</a
        >
        <button
          type="button"
          class="btn btn--sm"
          title=${props.mutationBlockedReason ?? ""}
          ?disabled=${!props.canMutate || props.mcpBusy}
          @click=${() => props.onMcpFormToggle(!props.mcpFormOpen)}
        >
          <span aria-hidden="true">${icons.plus}</span>
          ${t("mcpServers.add")}
        </button>
      `,
    },
    html`
      ${props.mcpFormOpen
        ? renderMcpServerForm({
            busy: props.mcpBusy,
            disabled: !props.canMutate,
            blockedReason: props.mutationBlockedReason,
            onSubmit: props.onMcpAdd,
            onCancel: () => props.onMcpFormToggle(false),
          })
        : nothing}
      ${props.mcpMessage
        ? html`<div
            class="plugins-row-message plugins-row-message--${props.mcpMessage
              .kind} plugins-group-message"
            role=${props.mcpMessage.kind === "error" ? "alert" : "status"}
          >
            <span>${props.mcpMessage.text}</span>
          </div>`
        : nothing}
      ${body}
    `,
  );
}

function renderMcpRow(server: McpServerSummary, props: PluginsViewProps): TemplateResult {
  return html`
    <article class="settings-row plugins-item" data-mcp-name=${server.name}>
      ${renderArtTile(server.name, server.name)}
      <div class="settings-row__text">
        <h3 class="settings-row__title">${server.name}</h3>
        <span class="settings-row__desc plugins-meta__mono">
          ${server.target || t("mcpServers.missingTransport")}
        </span>
        ${renderMetaLine([
          t("pluginsPage.mcp"),
          server.transport,
          server.auth === "oauth" ? t("pluginsPage.oauth") : nothing,
        ])}
      </div>
      <div class="settings-row__control">
        ${renderToggleButton(props, props.mcpBusy, {
          enabled: server.enabled,
          onToggle: (enabled) => props.onMcpToggle(server.name, enabled),
        })}
        ${renderRemoveButton(props, props.mcpBusy, server.name, () =>
          props.onMcpRemove(server.name),
        )}
      </div>
    </article>
  `;
}

function renderInstalled(props: PluginsViewProps) {
  const plugins = installedPlugins(props.result?.plugins ?? [], props.query, props.installedFilter);
  const groups = groupInstalledByCategory(plugins);
  const filtered = Boolean(props.query || props.installedFilter !== "all");
  return html`
    ${groups.length === 0
      ? renderEmpty(
          filtered ? t("pluginsPage.noInstalledMatchTitle") : t("pluginsPage.noInstalledTitle"),
          filtered ? t("pluginsPage.noMatchBody") : t("pluginsPage.noInstalledBody"),
          filtered ? "curious" : "sleepy",
        )
      : groups.map((group) =>
          renderSettingsSection(
            { title: group.label, count: group.plugins.length },
            repeat(
              group.plugins,
              (plugin) => plugin.id,
              (plugin) => renderPluginRow(plugin, props, true),
            ),
          ),
        )}
    ${renderMcpSection(props)}
  `;
}

/* ---------------------------------- discover tab ---------------------------------- */

function renderConnectorRow(
  connector: ConnectorSuggestion,
  props: PluginsViewProps,
): TemplateResult {
  const key = connectorRowKey(connector.id);
  const busy = Boolean(props.busy[key]);
  const isMcp = connector.action.kind === "mcp";
  const installed =
    isMcp &&
    Boolean(
      props.mcpServers?.some(
        (server) =>
          connector.action.kind === "mcp" && server.name === connector.action.mcp.serverName,
      ),
    );
  return html`
    <article
      class="settings-row plugins-item"
      data-connector-id=${connector.id}
      aria-busy=${busy ? "true" : "false"}
    >
      ${renderArtTile(connector.id, connector.name)}
      <div class="settings-row__text">
        <h3 class="settings-row__title">${connector.name}</h3>
        <span class="settings-row__desc">${t(connector.descriptionKey)}</span>
        ${renderMetaLine(
          isMcp
            ? [t("pluginsPage.mcp"), t("pluginsPage.connectorMcpNote")]
            : [t("pluginsPage.connectorClawHubNote")],
        )}
      </div>
      <div class="settings-row__control">
        ${isMcp
          ? installed
            ? renderSettingsStatus({ kind: "ok", label: t("pluginsPage.connectorAdded") })
            : html`
                <button
                  type="button"
                  class="btn btn--sm"
                  title=${props.mutationBlockedReason ?? ""}
                  ?disabled=${!props.canMutate || busy}
                  @click=${() => props.onAddConnector(connector)}
                >
                  ${busy ? t("mcpServers.adding") : t("pluginsPage.connectorAdd")}
                </button>
              `
          : html`
              <button
                type="button"
                class="btn btn--sm"
                @click=${() =>
                  connector.action.kind === "clawhub" &&
                  props.onSearchClawHub(connector.action.query)}
              >
                <span aria-hidden="true">${icons.search}</span>
                ${t("pluginsPage.connectorSearch")}
              </button>
            `}
      </div>
      ${renderRowMessage(key, props.messages[key], busy, props)}
    </article>
  `;
}

function renderShelf(label: string, rows: readonly TemplateResult[]) {
  if (rows.length === 0) {
    return nothing;
  }
  return renderSettingsSection({ title: label, count: rows.length }, rows);
}

function findInstalledSearchPlugin(
  item: PluginSearchResult,
  plugins: readonly PluginCatalogItem[],
): PluginCatalogItem | undefined {
  return plugins.find(
    (plugin) =>
      plugin.installed &&
      (plugin.id === item.package.runtimeId ||
        plugin.packageName === item.package.name ||
        (plugin.install?.source === "clawhub" && plugin.install.packageName === item.package.name)),
  );
}

function renderClawHubResult(item: PluginSearchResult, props: PluginsViewProps): TemplateResult {
  const pkg = item.package;
  const installed = findInstalledSearchPlugin(item, props.result?.plugins ?? []);
  const key = clawHubRowKey(pkg.name);
  const installRequest = { source: "clawhub", packageName: pkg.name } as const;
  const installIdentity = resolveInstallIdentity(props, installRequest, pkg.runtimeId);
  const busy = props.busy[key] || installOperationBusy(props, installIdentity);
  const artSlug = pkg.runtimeId ?? pkg.name;
  return html`
    <article
      class="settings-row plugins-item ${installed ? "plugins-item--clickable" : ""}"
      data-package-name=${pkg.name}
      data-plugin-source="clawhub"
      data-plugin-status=${installed?.state ?? "not-installed"}
      aria-busy=${busy ? "true" : "false"}
      @click=${(event: Event) => {
        if (installed && !fromInteractiveChild(event)) {
          props.onShowDetails(installed.id);
        }
      }}
    >
      ${renderArtTile(artSlug, pkg.displayName)}
      <div class="settings-row__text">
        ${renderPluginHeading({
          name: pkg.displayName,
          content: html`
            ${pkg.displayName}
            ${pkg.latestVersion
              ? html`<span class="plugins-version">v${pkg.latestVersion}</span>`
              : nothing}
          `,
          onShowDetails: installed ? () => props.onShowDetails(installed.id) : undefined,
        })}
        <span class="settings-row__desc">${pkg.summary || pkg.name}</span>
        ${renderMetaLine([
          pkg.isOfficial ? t("pluginsPage.official") : nothing,
          pkg.verificationTier ? pluginVerificationLabel(pkg.verificationTier) : nothing,
          typeof pkg.downloads === "number"
            ? html`<span class="plugins-downloads">
                <span aria-hidden="true">${icons.download}</span>
                ${compactNumber.format(pkg.downloads)}
              </span>`
            : nothing,
          pkg.family === "bundle-plugin"
            ? t("pluginsPage.bundlePlugin")
            : t("pluginsPage.codePlugin"),
        ])}
      </div>
      <div class="settings-row__control">
        ${installed
          ? html`${rowStateStatus(installed)}${renderCatalogActions(installed, props, busy, key)}`
          : renderInstallButton(props, busy, pkg.displayName, installRequest, installIdentity)}
      </div>
      ${renderRowMessage(key, props.messages[key], busy, props, installIdentity)}
    </article>
  `;
}

/** Live registry results appended below the curated shelves while searching. */
function renderClawHubGroup(props: PluginsViewProps) {
  const query = props.query.trim();
  if (query.length < 2) {
    return nothing;
  }
  let body: TemplateResult;
  if (props.searchLoading || (!props.searchResults && !props.searchError)) {
    body = html`<div class="plugins-search-state" role="status">
      ${t("pluginsPage.searching")}
    </div>`;
  } else if (props.searchError) {
    body = html`<div class="plugins-search-state plugins-search-state--error" role="alert">
      ${props.searchError}
    </div>`;
  } else if (props.searchResults && props.searchResults.length === 0) {
    body = html`${renderSettingsEmpty(t("pluginsPage.noClawHubResultsBody", { query }))}`;
  } else {
    body = html`
      ${repeat(
        props.searchResults ?? [],
        (item) => item.package.name,
        (item) => renderClawHubResult(item, props),
      )}
    `;
  }
  return renderSettingsSection(
    {
      title: t("pluginsPage.fromClawHub"),
      ...(props.searchResults ? { count: props.searchResults.length } : {}),
      actions: html`
        <a
          class="plugins-group__link"
          href=${CLAWHUB_BROWSE_URL}
          target=${EXTERNAL_LINK_TARGET}
          rel=${buildExternalLinkRel()}
        >
          ${t("pluginsPage.browseClawHub")}
          <span class="plugins-group__link-icon" aria-hidden="true">${icons.externalLink}</span>
        </a>
      `,
    },
    body,
  );
}

function renderDiscover(props: PluginsViewProps) {
  const shelves = discoverShelves(props.result?.plugins ?? [], props.query);
  const featuredRows = shelves.featured.map((plugin) => renderPluginRow(plugin, props));
  const officialRows = shelves.official.map((plugin) => renderPluginRow(plugin, props));
  const clawHub = renderClawHubGroup(props);
  if (!featuredRows.length && !officialRows.length && !shelves.connectors.length) {
    return html`
      ${clawHub === nothing
        ? renderEmpty(
            t("pluginsPage.noDiscoverMatchTitle"),
            t("pluginsPage.noMatchBody"),
            "curious",
          )
        : nothing}
      ${clawHub}
    `;
  }
  return html`
    ${renderShelf(t("pluginsPage.featuredGroup"), featuredRows)}
    ${renderShelf(t("pluginsPage.officialGroup"), officialRows)}
    ${renderConnectorSection(shelves.connectors, props)} ${clawHub}
  `;
}

/** Connectors shelve by use case inside one group, mirroring how people group their tools. */
function renderConnectorSection(
  connectors: readonly ConnectorSuggestion[],
  props: PluginsViewProps,
) {
  if (connectors.length === 0) {
    return nothing;
  }
  const groups = CONNECTOR_GROUP_ORDER.map((group) => ({
    group,
    entries: connectors.filter((connector) => connector.group === group),
  })).filter((entry) => entry.entries.length > 0);
  return renderSettingsSection(
    {
      title: t("pluginsPage.connectorsGroup"),
      count: connectors.length,
      description: t("pluginsPage.connectorsHint"),
    },
    groups.map(
      (entry) => html`
        <h3 class="plugins-subheader" data-connector-group=${entry.group}>
          ${connectorGroupLabel(entry.group)}
        </h3>
        ${entry.entries.map((connector) => renderConnectorRow(connector, props))}
      `,
    ),
  );
}

/* ---------------------------------- detail overlay ---------------------------------- */

function renderDetailOverlay(props: PluginsViewProps) {
  const plugin = props.detailPluginId
    ? props.result?.plugins.find((entry) => entry.id === props.detailPluginId)
    : undefined;
  if (!plugin) {
    return nothing;
  }
  const key = pluginRowKey(plugin.id);
  const installIdentity = plugin.install
    ? resolveInstallIdentity(props, plugin.install)
    : undefined;
  const busy = props.busy[key] || installOperationBusy(props, installIdentity);
  return html`
    <openclaw-modal-dialog
      label=${plugin.name}
      style="--openclaw-modal-width: min(580px, calc(100vw - 32px));"
      @modal-cancel=${() => props.onShowDetails(null)}
    >
      <section class="plugins-detail" data-detail-plugin-id=${plugin.id}>
        <button
          type="button"
          class="btn btn--sm btn--icon plugins-detail__close"
          aria-label=${t("pluginsPage.detailClose")}
          @click=${() => props.onShowDetails(null)}
        >
          ${icons.x}
        </button>
        ${renderArtTile(
          plugin.id,
          plugin.name,
          props.iconUrls[plugin.id],
          () => props.onIconError(plugin.id),
          "plugins-cover",
        )}
        <div class="plugins-detail__body">
          <div class="plugins-detail__title">
            <h2>${plugin.name}</h2>
            ${plugin.version
              ? html`<span class="plugins-version">v${plugin.version}</span>`
              : nothing}
            ${stateStatus(plugin)}
          </div>
          <p class="plugins-detail__description">
            ${plugin.description || t("pluginsPage.optionalCapability")}
          </p>
          <div class="plugins-detail__actions">
            ${plugin.installed
              ? html`
                  <button
                    type="button"
                    class="btn ${plugin.enabled ? "" : "primary"}"
                    title=${props.mutationBlockedReason ?? ""}
                    ?disabled=${!props.canMutate || busy}
                    @click=${() => props.onSetEnabled(plugin.id, !plugin.enabled, key)}
                  >
                    ${busy
                      ? t("pluginsPage.working")
                      : plugin.enabled
                        ? t("pluginsPage.disableAction")
                        : t("pluginsPage.enableAction")}
                  </button>
                `
              : plugin.install
                ? renderInstallButton(
                    props,
                    busy,
                    plugin.name,
                    plugin.install,
                    resolveInstallIdentity(props, plugin.install),
                  )
                : nothing}
            ${plugin.removable
              ? html`
                  <button
                    type="button"
                    class="btn plugins-detail__remove"
                    title=${props.mutationBlockedReason ?? ""}
                    ?disabled=${!props.canMutate || busy}
                    @click=${() => props.onUninstall(plugin.id, key)}
                  >
                    <span aria-hidden="true">${icons.trash}</span>
                    ${t("pluginsPage.remove")}
                  </button>
                `
              : nothing}
          </div>
          ${plugin.error
            ? html`<div class="plugins-row-message plugins-row-message--error" role="alert">
                ${formatUiExternalText(plugin.error)}
              </div>`
            : nothing}
          ${renderRowMessage(key, props.messages[key], busy, props, installIdentity)}
          <div class="plugins-detail__meta">
            ${plugin.origin
              ? renderPluginMetaRow(t("pluginsPage.detailOrigin"), pluginOriginLabel(plugin.origin))
              : nothing}
            ${plugin.category
              ? renderPluginMetaRow(
                  t("pluginsPage.detailCategory"),
                  pluginCategoryLabel(plugin.category),
                )
              : nothing}
            ${plugin.packageName
              ? renderPluginMetaRow(
                  t("pluginsPage.detailPackage"),
                  html`<code>${plugin.packageName}</code>`,
                )
              : nothing}
            ${renderPluginMetaRow(t("pluginsPage.detailPluginId"), html`<code>${plugin.id}</code>`)}
          </div>
          ${plugin.installed
            ? html`<section class="plugins-detail__capabilities">
                <h3>${t("pluginsPage.capabilities")}</h3>
                ${props.detailInspectionError
                  ? html`<div class="plugins-consent__error" role="alert">
                      <span>${props.detailInspectionError}</span>
                      <button
                        type="button"
                        class="btn btn--sm"
                        @click=${() => props.onShowDetails(plugin.id)}
                      >
                        ${t("pluginsPage.tryAgain")}
                      </button>
                    </div>`
                  : props.detailInspection
                    ? html`
                        ${renderPluginDeclaredCapabilities(props.detailInspection.declared)}
                        ${renderPluginGrants(
                          props.detailInspection.grants,
                          props.detailInspection.plugin.origin,
                        )}
                      `
                    : html`<p class="plugins-consent__hint">${t("pluginConsent.loading")}</p>`}
              </section>`
            : nothing}
        </div>
      </section>
    </openclaw-modal-dialog>
  `;
}

/* ---------------------------------- page shell ---------------------------------- */

function renderEmpty(title: string, body: string, mood?: "sleepy" | "curious") {
  return html`
    <div class="plugins-empty">
      <!-- Sleepy marks truly empty inventory; curious marks a filter/search miss. -->
      ${mood
        ? html`<openclaw-mascot
            class="plugins-empty__mascot"
            .mood=${mood}
            .size=${84}
          ></openclaw-mascot>`
        : html`<span class="plugins-empty__icon" aria-hidden="true">${icons.puzzle}</span>`}
      <h2>${title}</h2>
      <p>${body}</p>
    </div>
  `;
}

function renderActivePanel(props: PluginsViewProps) {
  switch (props.activeTab) {
    case "installed":
      return renderInstalled(props);
    case "discover":
      return renderDiscover(props);
    default:
      return props.activeTab satisfies never;
  }
}

export function renderPlugins(props: PluginsViewProps) {
  const canShowCatalog = Boolean(props.result);
  const panelState =
    props.loading && !canShowCatalog
      ? "loading"
      : props.error && !canShowCatalog
        ? "error"
        : !props.connected && !canShowCatalog
          ? "offline"
          : "content";
  return renderSettingsPage(
    html`
      <div class="plugins-toolbar">
        <input
          id="plugins-global-search"
          class="settings-input plugins-toolbar__search"
          name="plugins-search"
          type="search"
          autocomplete="off"
          aria-label=${t("pluginsPage.searchLabel")}
          .value=${live(props.query)}
          placeholder=${t("pluginsPage.searchPlaceholder")}
          @input=${(event: Event) =>
            props.onQueryChange((event.currentTarget as HTMLInputElement).value)}
        />
        ${props.activeTab === "installed" && panelState === "content"
          ? renderInstalledFilter(props)
          : nothing}
        <button
          type="button"
          class="btn btn--sm btn--icon plugins-refresh"
          aria-label=${t("pluginsPage.refresh")}
          title=${t("pluginsPage.refresh")}
          ?disabled=${props.loading || !props.connected}
          @click=${props.onRefresh}
        >
          <span aria-hidden="true">${icons.refresh}</span>
        </button>
      </div>

      ${props.mutationBlockedReason
        ? html`<div class="plugins-readonly" role="note">
            <span aria-hidden="true">${icons.alertTriangle}</span>
            <span>${props.mutationBlockedReason}</span>
          </div>`
        : nothing}
      ${props.error
        ? html`<div class="plugins-page-error" role="alert">
            <span>${props.error}</span>
            <button type="button" class="btn btn--sm" @click=${props.onRefresh}>
              ${t("pluginsPage.tryAgain")}
            </button>
          </div>`
        : nothing}
      ${props.pageNotice
        ? html`<div
            class="plugins-row-message plugins-row-message--${props.pageNotice
              .kind} plugins-page-notice"
            role=${props.pageNotice.kind === "error" ? "alert" : "status"}
          >
            <span>${props.pageNotice.text}</span>
          </div>`
        : nothing}

      <wa-tab-panel
        id="plugins-hub-panel"
        class="plugins-panel"
        name=${props.activeTab}
        active
        aria-labelledby=${`plugins-tab-${props.activeTab}`}
      >
        ${panelState === "loading"
          ? html`<div class="plugins-search-state" role="status">${t("pluginsPage.loading")}</div>`
          : panelState === "error"
            ? nothing
            : panelState === "offline"
              ? renderEmpty(t("pluginsPage.offlineTitle"), t("pluginsPage.offlineBody"))
              : renderActivePanel(props)}
      </wa-tab-panel>
      ${renderDetailOverlay(props)}
      ${props.consent
        ? renderPluginConsentDialog({
            consent: props.consent,
            inspection: props.consentInspection,
            loading: props.consentInspectionLoading,
            error: props.consentInspectionError,
            iconUrl: props.consent.pluginId ? props.iconUrls[props.consent.pluginId] : undefined,
            canMutate: props.canMutate,
            mutationBlockedReason: props.mutationBlockedReason,
            busy: Boolean(
              props.busy[
                props.consent.intent.kind === "install"
                  ? props.consent.intent.installIdentity
                  : props.consent.intent.rowKey
              ],
            ),
            onCancel: props.onCancelConsent,
            onConfirm: props.onConfirmConsent,
            onRetry: props.onRetryConsentInspection,
          })
        : nothing}
    `,
    { wide: true },
  );
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
