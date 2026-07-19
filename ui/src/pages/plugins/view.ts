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
import "../../styles/plugins.css";
import {
  CLAWHUB_BROWSE_URL,
  type PluginCatalogItem,
  type PluginInstallRequest,
  type PluginListResult,
  type PluginSearchResult,
} from "../../lib/plugins/index.ts";
import {
  CONNECTOR_GROUP_ORDER,
  CONNECTOR_SUGGESTIONS,
  PLUGIN_CATEGORY_ORDER,
  pluginArtPath,
  pluginCategoryLabel,
  pluginFallbackGradient,
  pluginMonogram,
  type ConnectorGroup,
  type ConnectorSuggestion,
} from "./presentation.ts";

export type PluginsTab = "installed" | "discover";

export type InstalledFilter = "all" | "enabled" | "disabled" | "issues";

export type PluginRowMessage = {
  kind: "success" | "error";
  text: string;
  acknowledge?: { packageName: string; version?: string };
};

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
  pendingRemoval: Readonly<Record<string, boolean>>;
  detailPluginId: string | null;
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
  onInstall: (rowKey: string, request: PluginInstallRequest) => void;
  onRequestUninstall: (rowKey: string) => void;
  onCancelUninstall: (rowKey: string) => void;
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

function renderArtTile(
  slug: string,
  name: string,
  iconUrl?: string,
  onIconError?: () => void,
): TemplateResult {
  const art = pluginArtPath(slug);
  if (art) {
    return html`<span class="plugins-tile">
      <img src=${art} alt="" loading="lazy" decoding="async" />
    </span>`;
  }
  if (iconUrl) {
    return html`<span class="plugins-tile">
      <img
        class="plugins-icon"
        src=${iconUrl}
        alt=""
        loading="lazy"
        decoding="async"
        @error=${onIconError}
      />
    </span>`;
  }
  const [from, to] = pluginFallbackGradient(slug);
  const monogram = pluginMonogram(name);
  return html`<span
    class="plugins-tile plugins-tile--fallback"
    style=${`--plugins-art-a:${from};--plugins-art-b:${to}`}
    aria-hidden="true"
  >
    ${monogram ? html`<span>${monogram}</span>` : icons.puzzle}
  </span>`;
}

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

function originLabel(origin: string): string {
  switch (origin) {
    case "bundled":
      return t("pluginsPage.included");
    case "global":
      return t("pluginsPage.global");
    case "workspace":
      return t("pluginsPage.workspace");
    case "config":
      return t("pluginsPage.config");
    case "official":
      return t("pluginsPage.official");
    default:
      return origin;
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
) {
  if (!message) {
    return nothing;
  }
  const role = message.kind === "error" ? "alert" : "status";
  return html`
    <div class="plugins-row-message plugins-row-message--${message.kind}" role=${role}>
      <span>${message.text}</span>
      ${message.acknowledge
        ? html`
            <button
              type="button"
              class="btn btn--sm"
              title=${props.mutationBlockedReason ?? ""}
              ?disabled=${busy || !props.canMutate}
              @click=${() =>
                props.onInstall(key, {
                  source: "clawhub",
                  packageName: message.acknowledge?.packageName ?? "",
                  ...(message.acknowledge?.version ? { version: message.acknowledge.version } : {}),
                  acknowledgeClawHubRisk: true,
                })}
            >
              ${busy ? t("pluginsPage.installing") : t("pluginsPage.acknowledgeRisk")}
            </button>
          `
        : nothing}
    </div>
  `;
}

/** Ignore activations bubbling from interactive children so rows stay clickable. */
function fromInteractiveChild(event: Event): boolean {
  return Boolean(
    (event.target as HTMLElement | null)?.closest("button, a, input, label, form, [role='menu']"),
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
  key: string,
  name: string,
  request: PluginInstallRequest,
) {
  return html`
    <button
      type="button"
      class="btn btn--sm plugins-install"
      title=${props.mutationBlockedReason ?? ""}
      aria-label=${t("pluginsPage.installNamed", { name })}
      ?disabled=${!props.canMutate || busy}
      @click=${(event: Event) => {
        event.stopPropagation();
        props.onInstall(key, request);
      }}
    >
      ${busy ? t("pluginsPage.installing") : t("pluginsPage.install")}
    </button>
  `;
}

function renderRemoveConfirm(
  plugin: PluginCatalogItem,
  props: PluginsViewProps,
  busy: boolean,
  rowKey: string,
) {
  return html`
    <span
      class="plugins-remove-confirm"
      role="alertdialog"
      aria-label=${t("pluginsPage.removeNamed", { name: plugin.name })}
    >
      <span>${t("pluginsPage.removeConfirm")}</span>
      <button
        type="button"
        class="btn btn--sm danger"
        ?disabled=${busy || !props.canMutate}
        @click=${(event: Event) => {
          event.stopPropagation();
          props.onUninstall(plugin.id, rowKey);
        }}
      >
        ${busy ? t("pluginsPage.removing") : t("pluginsPage.remove")}
      </button>
      <button
        type="button"
        class="btn btn--sm"
        ?disabled=${busy}
        @click=${(event: Event) => {
          event.stopPropagation();
          props.onCancelUninstall(rowKey);
        }}
      >
        ${t("pluginsPage.cancel")}
      </button>
    </span>
  `;
}

function renderCatalogActions(
  plugin: PluginCatalogItem,
  props: PluginsViewProps,
  busy: boolean,
  rowKey: string,
) {
  if (props.pendingRemoval[rowKey]) {
    return renderRemoveConfirm(plugin, props, busy, rowKey);
  }
  if (!plugin.installed) {
    const install = plugin.install;
    return install
      ? renderInstallButton(props, busy, rowKey, plugin.name, install)
      : html`<span class="plugins-action-note">${t("pluginsPage.unavailable")}</span>`;
  }
  return html`
    ${renderToggleButton(props, busy, {
      enabled: plugin.enabled,
      onToggle: (enabled) => props.onSetEnabled(plugin.id, enabled, rowKey),
    })}
    ${plugin.removable
      ? renderRemoveButton(props, busy, plugin.name, () => props.onRequestUninstall(rowKey))
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

function renderInstalledRow(plugin: PluginCatalogItem, props: PluginsViewProps): TemplateResult {
  const key = pluginRowKey(plugin.id);
  const busy = props.busy[key] ?? false;
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
        <h3 class="settings-row__title">
          ${plugin.name}
          ${plugin.version
            ? html`<span class="plugins-version">v${plugin.version}</span>`
            : nothing}
        </h3>
        <span class="settings-row__desc">
          ${plugin.description || t("pluginsPage.optionalCapability")}
        </span>
        ${renderMetaLine([
          plugin.origin ? originLabel(plugin.origin) : nothing,
          plugin.packageName
            ? html`<span class="plugins-meta__mono">${plugin.packageName}</span>`
            : nothing,
        ])}
      </div>
      <div class="settings-row__control">
        ${rowStateStatus(plugin)} ${renderCatalogActions(plugin, props, busy, key)}
      </div>
      ${plugin.error
        ? html`<div class="plugins-row-message plugins-row-message--error" role="alert">
            ${plugin.error}
          </div>`
        : nothing}
      ${renderRowMessage(key, props.messages[key], busy, props)}
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
              (plugin) => renderInstalledRow(plugin, props),
            ),
          ),
        )}
    ${renderMcpSection(props)}
  `;
}

/* ---------------------------------- discover tab ---------------------------------- */

function renderCatalogRow(plugin: PluginCatalogItem, props: PluginsViewProps): TemplateResult {
  const key = pluginRowKey(plugin.id);
  const busy = props.busy[key] ?? false;
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
        <h3 class="settings-row__title">
          ${plugin.name}
          ${plugin.version
            ? html`<span class="plugins-version">v${plugin.version}</span>`
            : nothing}
        </h3>
        <span class="settings-row__desc">
          ${plugin.description || t("pluginsPage.optionalCapability")}
        </span>
        ${renderMetaLine([plugin.origin ? originLabel(plugin.origin) : nothing])}
      </div>
      <div class="settings-row__control">
        ${plugin.installed ? rowStateStatus(plugin) : nothing}
        ${renderCatalogActions(plugin, props, busy, key)}
      </div>
      ${plugin.error
        ? html`<div class="plugins-row-message plugins-row-message--error" role="alert">
            ${plugin.error}
          </div>`
        : nothing}
      ${renderRowMessage(key, props.messages[key], busy, props)}
    </article>
  `;
}

function renderConnectorRow(
  connector: ConnectorSuggestion,
  props: PluginsViewProps,
): TemplateResult {
  const key = connectorRowKey(connector.id);
  const busy = props.busy[key] ?? false;
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

function verificationLabel(tier: string): string {
  return tier === "source-linked" ? t("pluginsPage.verifiedSource") : tier;
}

function renderClawHubResult(item: PluginSearchResult, props: PluginsViewProps): TemplateResult {
  const pkg = item.package;
  const installed = findInstalledSearchPlugin(item, props.result?.plugins ?? []);
  const key = clawHubRowKey(pkg.name);
  const busy = props.busy[key] ?? false;
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
        <h3 class="settings-row__title">
          ${pkg.displayName}
          ${pkg.latestVersion
            ? html`<span class="plugins-version">v${pkg.latestVersion}</span>`
            : nothing}
        </h3>
        <span class="settings-row__desc">${pkg.summary || pkg.name}</span>
        ${renderMetaLine([
          pkg.isOfficial ? t("pluginsPage.official") : nothing,
          pkg.verificationTier ? verificationLabel(pkg.verificationTier) : nothing,
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
          : renderInstallButton(props, busy, key, pkg.displayName, {
              source: "clawhub",
              packageName: pkg.name,
            })}
      </div>
      ${renderRowMessage(key, props.messages[key], busy, props)}
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
  const featuredRows = shelves.featured.map((plugin) => renderCatalogRow(plugin, props));
  const officialRows = shelves.official.map((plugin) => renderCatalogRow(plugin, props));
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

function detailMetaRow(label: string, value: string | TemplateResult) {
  return html`
    <div class="plugins-detail__meta-row">
      <span class="plugins-detail__meta-label">${label}</span>
      <span class="plugins-detail__meta-value">${value}</span>
    </div>
  `;
}

function renderDetailOverlay(props: PluginsViewProps) {
  const plugin = props.detailPluginId
    ? props.result?.plugins.find((entry) => entry.id === props.detailPluginId)
    : undefined;
  if (!plugin) {
    return nothing;
  }
  const key = pluginRowKey(plugin.id);
  const busy = props.busy[key] ?? false;
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
        ${renderDetailCover(plugin.id, plugin.name, props.iconUrls[plugin.id], () =>
          props.onIconError(plugin.id),
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
            ${props.pendingRemoval[key]
              ? renderRemoveConfirm(plugin, props, busy, key)
              : html`
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
                      ? renderInstallButton(props, busy, key, plugin.name, plugin.install)
                      : nothing}
                  ${plugin.removable
                    ? html`
                        <button
                          type="button"
                          class="btn plugins-detail__remove"
                          title=${props.mutationBlockedReason ?? ""}
                          ?disabled=${!props.canMutate || busy}
                          @click=${() => props.onRequestUninstall(key)}
                        >
                          <span aria-hidden="true">${icons.trash}</span>
                          ${t("pluginsPage.remove")}
                        </button>
                      `
                    : nothing}
                `}
          </div>
          ${plugin.error
            ? html`<div class="plugins-row-message plugins-row-message--error" role="alert">
                ${plugin.error}
              </div>`
            : nothing}
          ${renderRowMessage(key, props.messages[key], busy, props)}
          <div class="plugins-detail__meta">
            ${plugin.origin
              ? detailMetaRow(t("pluginsPage.detailOrigin"), originLabel(plugin.origin))
              : nothing}
            ${plugin.category
              ? detailMetaRow(t("pluginsPage.detailCategory"), pluginCategoryLabel(plugin.category))
              : nothing}
            ${plugin.packageName
              ? detailMetaRow(
                  t("pluginsPage.detailPackage"),
                  html`<code>${plugin.packageName}</code>`,
                )
              : nothing}
            ${detailMetaRow(t("pluginsPage.detailPluginId"), html`<code>${plugin.id}</code>`)}
          </div>
        </div>
      </section>
    </openclaw-modal-dialog>
  `;
}

function renderDetailCover(
  slug: string,
  name: string,
  iconUrl?: string,
  onIconError?: () => void,
): TemplateResult {
  const art = pluginArtPath(slug);
  if (art) {
    return html`<span class="plugins-cover">
      <img src=${art} alt="" loading="lazy" decoding="async" />
    </span>`;
  }
  if (iconUrl) {
    return html`<span class="plugins-cover">
      <img
        class="plugins-icon"
        src=${iconUrl}
        alt=""
        loading="lazy"
        decoding="async"
        @error=${onIconError}
      />
    </span>`;
  }
  const [from, to] = pluginFallbackGradient(slug);
  const monogram = pluginMonogram(name);
  return html`<span
    class="plugins-cover plugins-cover--fallback"
    style=${`--plugins-art-a:${from};--plugins-art-b:${to}`}
    aria-hidden="true"
  >
    ${monogram ? html`<span>${monogram}</span>` : icons.puzzle}
  </span>`;
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
    `,
    { wide: true },
  );
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
