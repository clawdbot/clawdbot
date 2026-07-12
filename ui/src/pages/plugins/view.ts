// Control UI plugins page: installed inventory, discover store with inline
// ClawHub search, plugin detail overlay, and MCP server management.
import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { repeat } from "lit/directives/repeat.js";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { EXTERNAL_LINK_TARGET, buildExternalLinkRel } from "../../lib/external-link.ts";
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

export type McpServerSummary = {
  name: string;
  enabled: boolean;
  transport: "stdio" | "http" | "invalid";
  target: string;
  auth: string | null;
};

export type McpServerForm = {
  name: string;
  target: string;
};

export type PluginsViewProps = {
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
  openMenuKey: string | null;
  detailPluginId: string | null;
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
  onToggleMenu: (key: string | null) => void;
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

export function clawHubRowKey(packageName: string): string {
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
  return [connector.id, connector.name, connector.description].some((value) =>
    value.toLocaleLowerCase().includes(needle),
  );
}

function sortCatalogPlugins(plugins: readonly PluginCatalogItem[]): PluginCatalogItem[] {
  return plugins.toSorted(
    (left, right) =>
      (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER) ||
      left.name.localeCompare(right.name),
  );
}

export function installedPlugins(
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

export type InstalledCategoryGroup = {
  category: string;
  label: string;
  plugins: PluginCatalogItem[];
};

export function groupInstalledByCategory(
  plugins: readonly PluginCatalogItem[],
): InstalledCategoryGroup[] {
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

export type DiscoverShelves = {
  featured: PluginCatalogItem[];
  official: PluginCatalogItem[];
  connectors: ConnectorSuggestion[];
};

export function discoverShelves(
  plugins: readonly PluginCatalogItem[],
  query = "",
): DiscoverShelves {
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

function renderArtTile(slug: string, name: string, variant: "tile" | "cover"): TemplateResult {
  const art = pluginArtPath(slug);
  if (art) {
    return html`<span class="plugins-${variant}">
      <img src=${art} alt="" loading="lazy" decoding="async" />
    </span>`;
  }
  const [from, to] = pluginFallbackGradient(slug);
  const monogram = pluginMonogram(name);
  return html`<span
    class="plugins-${variant} plugins-${variant}--fallback"
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

function stateChip(plugin: PluginCatalogItem) {
  return html`<span class="plugins-state plugins-state--${plugin.state}"
    >${stateLabel(plugin)}</span
  >`;
}

type PluginMenuItem = {
  key: string;
  label: string;
  icon: TemplateResult;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

function renderActionsMenu(
  menuKey: string,
  label: string,
  items: readonly PluginMenuItem[],
  props: PluginsViewProps,
) {
  const open = props.openMenuKey === menuKey;
  return html`
    <span class="plugins-actions-menu">
      <button
        type="button"
        class="btn btn--sm btn--icon plugins-kebab"
        aria-label=${label}
        aria-haspopup="menu"
        aria-expanded=${open ? "true" : "false"}
        @click=${(event: Event) => {
          event.stopPropagation();
          props.onToggleMenu(open ? null : menuKey);
        }}
      >
        ${icons.moreHorizontal}
      </button>
      ${open
        ? html`
            <div class="plugins-menu" role="menu" aria-label=${label}>
              ${items.map(
                (item) => html`
                  <button
                    type="button"
                    role="menuitem"
                    class="plugins-menu__item ${item.danger ? "plugins-menu__item--danger" : ""}"
                    ?disabled=${item.disabled}
                    @click=${(event: Event) => {
                      event.stopPropagation();
                      props.onToggleMenu(null);
                      item.onSelect();
                    }}
                  >
                    <span class="plugins-menu__icon" aria-hidden="true">${item.icon}</span>
                    ${item.label}
                  </button>
                `,
              )}
            </div>
          `
        : nothing}
    </span>
  `;
}

function pluginMenuItems(
  plugin: PluginCatalogItem,
  props: PluginsViewProps,
  rowKey: string,
  options: { details: boolean },
): PluginMenuItem[] {
  const blocked = !props.canMutate || props.busy[rowKey];
  const items: PluginMenuItem[] = [];
  if (options.details) {
    items.push({
      key: "details",
      label: t("pluginsPage.menuDetails"),
      icon: icons.eye,
      onSelect: () => props.onShowDetails(plugin.id),
    });
  }
  items.push({
    key: "toggle",
    label: plugin.enabled ? t("pluginsPage.disableAction") : t("pluginsPage.enableAction"),
    icon: plugin.enabled ? circleIcon() : icons.check,
    disabled: blocked,
    onSelect: () => props.onSetEnabled(plugin.id, !plugin.enabled, rowKey),
  });
  if (plugin.removable) {
    items.push({
      key: "remove",
      label: t("pluginsPage.remove"),
      icon: icons.trash,
      danger: true,
      disabled: blocked,
      onSelect: () => props.onRequestUninstall(rowKey),
    });
  }
  return items;
}

function circleIcon(): TemplateResult {
  return icons.circle;
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
      class="btn btn--sm primary plugins-install"
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
  options: { details: boolean },
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
    ${stateChip(plugin)}
    ${renderActionsMenu(
      rowKey,
      t("pluginsPage.menuLabel", { name: plugin.name }),
      pluginMenuItems(plugin, props, rowKey, options),
      props,
    )}
  `;
}

/* ---------------------------------- installed tab ---------------------------------- */

/**
 * One compact strip instead of stat cards: a segmented distribution meter and
 * filter chips that double as the legend and the counts.
 */
function renderInventoryPulse(props: PluginsViewProps) {
  const installed = (props.result?.plugins ?? []).filter((plugin) => plugin.installed);
  const issues = installed.filter((plugin) => plugin.state === "error").length;
  const enabled = installed.filter((plugin) => plugin.enabled && plugin.state !== "error").length;
  const disabled = installed.length - enabled - issues;
  const counts: Record<InstalledFilter, number> = {
    all: installed.length,
    enabled,
    disabled,
    issues,
  };
  const segments = (
    [
      ["enabled", enabled],
      ["disabled", disabled],
      ["issues", issues],
    ] as const
  ).filter(([, value]) => value > 0);
  return html`
    <div class="plugins-pulse">
      ${segments.length > 0
        ? html`
            <div
              class="plugins-pulse__meter"
              role="img"
              aria-label=${t("pluginsPage.pulseLabel", {
                enabled: String(enabled),
                disabled: String(disabled),
                issues: String(issues),
              })}
            >
              ${segments.map(
                ([key, value]) => html`
                  <span
                    class="plugins-pulse__segment plugins-pulse__segment--${key}"
                    style=${`flex-grow:${value}`}
                  ></span>
                `,
              )}
            </div>
          `
        : nothing}
      <div class="plugins-filters" role="group" aria-label=${t("pluginsPage.filterLabel")}>
        ${INSTALLED_FILTERS.map(
          (filter) => html`
            <button
              type="button"
              class=${props.installedFilter === filter ? "active" : ""}
              @click=${() => props.onFilterChange(filter)}
            >
              ${filter === "all"
                ? nothing
                : html`<span
                    class="plugins-filters__dot plugins-filters__dot--${filter}"
                    aria-hidden="true"
                  ></span>`}
              ${filterLabel(filter)}
              <span class="plugins-filters__count">${counts[filter]}</span>
            </button>
          `,
        )}
      </div>
    </div>
  `;
}

function renderInstalledRow(plugin: PluginCatalogItem, props: PluginsViewProps): TemplateResult {
  const key = pluginRowKey(plugin.id);
  const busy = props.busy[key];
  return html`
    <article
      class="plugins-row plugins-row--${plugin.state} plugins-row--clickable"
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
      ${renderArtTile(plugin.id, plugin.name, "tile")}
      <div class="plugins-row__copy">
        <div class="plugins-row__title">
          <h3>${plugin.name}</h3>
          ${plugin.version
            ? html`<span class="plugins-version">v${plugin.version}</span>`
            : nothing}
          ${plugin.state === "error"
            ? html`<span class="plugins-state plugins-state--error">${stateLabel(plugin)}</span>`
            : nothing}
        </div>
        <p>${plugin.description || t("pluginsPage.optionalCapability")}</p>
        <div class="plugins-row__meta">
          ${plugin.origin ? html`<span>${originLabel(plugin.origin)}</span>` : nothing}
          ${plugin.packageName
            ? html`<span class="plugins-row__package">${plugin.packageName}</span>`
            : nothing}
        </div>
      </div>
      <div class="plugins-row__actions">
        ${renderCatalogActions(plugin, props, busy, key, { details: true })}
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

function mcpMenuItems(server: McpServerSummary, props: PluginsViewProps): PluginMenuItem[] {
  const blocked = !props.canMutate || props.mcpBusy;
  return [
    {
      key: "toggle",
      label: server.enabled ? t("pluginsPage.disableAction") : t("pluginsPage.enableAction"),
      icon: server.enabled ? circleIcon() : icons.check,
      disabled: blocked,
      onSelect: () => props.onMcpToggle(server.name, !server.enabled),
    },
    {
      key: "remove",
      label: t("pluginsPage.remove"),
      icon: icons.trash,
      danger: true,
      disabled: blocked,
      onSelect: () => props.onMcpRemove(server.name),
    },
  ];
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
  return html`
    <section class="plugins-group" aria-labelledby="plugins-group-mcp">
      <div class="plugins-group__heading">
        <h2 id="plugins-group-mcp">${t("pluginsPage.mcpServersGroup")}</h2>
        ${servers ? html`<span>${servers.length}</span>` : nothing}
        <div class="plugins-group__actions">
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
            ${t("pluginsPage.mcpAdd")}
          </button>
        </div>
      </div>
      <p class="plugins-group__hint">${t("pluginsPage.mcpHint")}</p>
      ${props.mcpFormOpen ? renderMcpForm(props) : nothing}
      ${props.mcpMessage
        ? html`<div
            class="plugins-row-message plugins-row-message--${props.mcpMessage.kind}"
            role=${props.mcpMessage.kind === "error" ? "alert" : "status"}
          >
            <span>${props.mcpMessage.text}</span>
          </div>`
        : nothing}
      ${!servers
        ? html`<div class="plugins-search-state" role="status">${t("pluginsPage.loading")}</div>`
        : servers.length === 0
          ? html`<div class="plugins-mcp-empty">${t("pluginsPage.mcpEmpty")}</div>`
          : html`<div class="plugins-rows">
              ${repeat(
                servers,
                (server) => server.name,
                (server) => renderMcpRow(server, props),
              )}
            </div>`}
    </section>
  `;
}

function renderMcpRow(server: McpServerSummary, props: PluginsViewProps): TemplateResult {
  return html`
    <article class="plugins-row plugins-row--mcp" data-mcp-name=${server.name}>
      ${renderArtTile(server.name, server.name, "tile")}
      <div class="plugins-row__copy">
        <div class="plugins-row__title">
          <h3>${server.name}</h3>
          <span class="plugins-badge plugins-badge--mcp">MCP</span>
          ${server.auth === "oauth" ? html`<span class="plugins-badge">OAuth</span>` : nothing}
        </div>
        <p class="plugins-row__target">${server.target}</p>
        <div class="plugins-row__meta"><span>${server.transport}</span></div>
      </div>
      <div class="plugins-row__actions">
        <span class="plugins-state ${server.enabled ? "plugins-state--enabled" : ""}"
          >${server.enabled ? t("pluginsPage.enabled") : t("pluginsPage.disabled")}</span
        >
        ${renderActionsMenu(
          `mcp:${server.name}`,
          t("pluginsPage.menuLabel", { name: server.name }),
          mcpMenuItems(server, props),
          props,
        )}
      </div>
    </article>
  `;
}

function renderMcpForm(props: PluginsViewProps) {
  const submit = (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const data = new FormData(form);
    const name = data.get("mcp-name");
    const target = data.get("mcp-target");
    props.onMcpAdd({
      name: typeof name === "string" ? name.trim() : "",
      target: typeof target === "string" ? target.trim() : "",
    });
  };
  return html`
    <form class="plugins-mcp-form" @submit=${submit}>
      <label>
        <span>${t("pluginsPage.mcpNameLabel")}</span>
        <input name="mcp-name" type="text" required placeholder="context7" autocomplete="off" />
      </label>
      <label class="plugins-mcp-form__target">
        <span>${t("pluginsPage.mcpTargetLabel")}</span>
        <input
          name="mcp-target"
          type="text"
          required
          placeholder="https://mcp.example.com/mcp  ·  npx some-mcp-server"
          autocomplete="off"
        />
      </label>
      <div class="plugins-mcp-form__actions">
        <button type="submit" class="btn btn--sm primary" ?disabled=${props.mcpBusy}>
          ${props.mcpBusy ? t("pluginsPage.mcpAdding") : t("pluginsPage.mcpAdd")}
        </button>
        <button type="button" class="btn btn--sm" @click=${() => props.onMcpFormToggle(false)}>
          ${t("pluginsPage.cancel")}
        </button>
      </div>
    </form>
  `;
}

function renderInstalled(props: PluginsViewProps) {
  const plugins = installedPlugins(props.result?.plugins ?? [], props.query, props.installedFilter);
  const groups = groupInstalledByCategory(plugins);
  return html`
    ${renderInventoryPulse(props)}
    ${groups.length === 0
      ? renderEmpty(
          props.query || props.installedFilter !== "all"
            ? t("pluginsPage.noInstalledMatchTitle")
            : t("pluginsPage.noInstalledTitle"),
          props.query || props.installedFilter !== "all"
            ? t("pluginsPage.noMatchBody")
            : t("pluginsPage.noInstalledBody"),
        )
      : html`
          <div class="plugins-groups">
            ${groups.map(
              (group) => html`
                <section class="plugins-group" aria-labelledby=${`plugins-group-${group.category}`}>
                  <div class="plugins-group__heading">
                    <h2 id=${`plugins-group-${group.category}`}>${group.label}</h2>
                    <span>${group.plugins.length}</span>
                  </div>
                  <div class="plugins-rows">
                    ${repeat(
                      group.plugins,
                      (plugin) => plugin.id,
                      (plugin) => renderInstalledRow(plugin, props),
                    )}
                  </div>
                </section>
              `,
            )}
          </div>
        `}
    ${renderMcpSection(props)}
  `;
}

/* ---------------------------------- discover tab ---------------------------------- */

function renderCatalogCard(plugin: PluginCatalogItem, props: PluginsViewProps): TemplateResult {
  const key = pluginRowKey(plugin.id);
  const busy = props.busy[key];
  return html`
    <article
      class="plugins-card plugins-card--clickable"
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
      ${renderArtTile(plugin.id, plugin.name, "cover")}
      <div class="plugins-card__body">
        <div class="plugins-card__title-row">
          <h3>${plugin.name}</h3>
          ${plugin.version
            ? html`<span class="plugins-version">v${plugin.version}</span>`
            : nothing}
        </div>
        <p>${plugin.description || t("pluginsPage.optionalCapability")}</p>
        <div class="plugins-card__meta">
          ${plugin.origin ? html`<span>${originLabel(plugin.origin)}</span>` : nothing}
        </div>
      </div>
      <div class="plugins-card__footer">
        ${renderCatalogActions(plugin, props, busy, key, { details: true })}
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

function renderConnectorCard(
  connector: ConnectorSuggestion,
  props: PluginsViewProps,
): TemplateResult {
  const key = connectorRowKey(connector.id);
  const busy = props.busy[key];
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
      class="plugins-card plugins-card--connector"
      data-connector-id=${connector.id}
      aria-busy=${busy ? "true" : "false"}
    >
      ${renderArtTile(connector.id, connector.name, "cover")}
      <div class="plugins-card__body">
        <div class="plugins-card__title-row">
          <h3>${connector.name}</h3>
        </div>
        <p>${connector.description}</p>
        <div class="plugins-card__meta">
          ${isMcp
            ? html`<span class="plugins-badge plugins-badge--mcp">MCP</span>
                <span>${t("pluginsPage.connectorMcpNote")}</span>`
            : html`<span>${t("pluginsPage.connectorClawHubNote")}</span>`}
        </div>
      </div>
      <div class="plugins-card__footer">
        ${isMcp
          ? installed
            ? html`<span class="plugins-action-note plugins-action-note--ok">
                <span aria-hidden="true">${icons.check}</span> ${t("pluginsPage.connectorAdded")}
              </span>`
            : html`
                <button
                  type="button"
                  class="btn btn--sm primary"
                  title=${props.mutationBlockedReason ?? ""}
                  ?disabled=${!props.canMutate || busy}
                  @click=${() => props.onAddConnector(connector)}
                >
                  ${busy ? t("pluginsPage.mcpAdding") : t("pluginsPage.connectorAdd")}
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

function renderShelf(
  id: string,
  label: string,
  hint: string | null,
  cards: readonly TemplateResult[],
) {
  if (cards.length === 0) {
    return nothing;
  }
  return html`
    <section class="plugins-group" aria-labelledby=${`plugins-shelf-${id}`}>
      <div class="plugins-group__heading">
        <h2 id=${`plugins-shelf-${id}`}>${label}</h2>
        <span>${cards.length}</span>
      </div>
      ${hint ? html`<p class="plugins-group__hint">${hint}</p>` : nothing}
      <div class="plugins-grid ${id === "featured" ? "plugins-grid--featured" : ""}">${cards}</div>
    </section>
  `;
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
  const busy = props.busy[key];
  const artSlug = pkg.runtimeId ?? pkg.name;
  return html`
    <article
      class="plugins-row plugins-row--clawhub ${installed ? "plugins-row--clickable" : ""}"
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
      ${renderArtTile(artSlug, pkg.displayName, "tile")}
      <div class="plugins-row__copy">
        <div class="plugins-row__title">
          <h3>${pkg.displayName}</h3>
          ${pkg.latestVersion
            ? html`<span class="plugins-version">v${pkg.latestVersion}</span>`
            : nothing}
        </div>
        <p>${pkg.summary || pkg.name}</p>
        <div class="plugins-row__meta">
          ${pkg.isOfficial
            ? html`<span class="plugins-badge">${t("pluginsPage.official")}</span>`
            : nothing}
          ${pkg.verificationTier
            ? html`<span class="plugins-badge plugins-badge--verified">
                <span aria-hidden="true">${icons.check}</span>
                ${verificationLabel(pkg.verificationTier)}
              </span>`
            : nothing}
          ${typeof pkg.downloads === "number"
            ? html`<span class="plugins-downloads">
                <span aria-hidden="true">${icons.download}</span>
                ${compactNumber.format(pkg.downloads)}
              </span>`
            : nothing}
          <span
            >${pkg.family === "bundle-plugin"
              ? t("pluginsPage.bundlePlugin")
              : t("pluginsPage.codePlugin")}</span
          >
        </div>
      </div>
      <div class="plugins-row__actions">
        ${installed
          ? renderCatalogActions(installed, props, busy, key, { details: true })
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
    body = html`<div class="plugins-mcp-empty">
      ${t("pluginsPage.noClawHubResultsBody", { query })}
    </div>`;
  } else {
    body = html`
      <div class="plugins-rows">
        ${repeat(
          props.searchResults ?? [],
          (item) => item.package.name,
          (item) => renderClawHubResult(item, props),
        )}
      </div>
    `;
  }
  return html`
    <section class="plugins-group" aria-labelledby="plugins-shelf-clawhub">
      <div class="plugins-group__heading">
        <h2 id="plugins-shelf-clawhub">${t("pluginsPage.fromClawHub")}</h2>
        ${props.searchResults ? html`<span>${props.searchResults.length}</span>` : nothing}
        <div class="plugins-group__actions">
          <a
            class="plugins-group__link"
            href=${CLAWHUB_BROWSE_URL}
            target=${EXTERNAL_LINK_TARGET}
            rel=${buildExternalLinkRel()}
          >
            ${t("pluginsPage.browseClawHub")}
            <span class="plugins-group__link-icon" aria-hidden="true">${icons.externalLink}</span>
          </a>
        </div>
      </div>
      ${body}
    </section>
  `;
}

function renderDiscover(props: PluginsViewProps) {
  const shelves = discoverShelves(props.result?.plugins ?? [], props.query);
  const featuredCards = shelves.featured.map((plugin) => renderCatalogCard(plugin, props));
  const officialCards = shelves.official.map((plugin) => renderCatalogCard(plugin, props));
  const clawHub = renderClawHubGroup(props);
  if (!featuredCards.length && !officialCards.length && !shelves.connectors.length) {
    return html`
      ${clawHub === nothing
        ? renderEmpty(t("pluginsPage.noDiscoverMatchTitle"), t("pluginsPage.noMatchBody"))
        : nothing}
      ${clawHub}
    `;
  }
  return html`
    <div class="plugins-groups">
      ${renderShelf("featured", t("pluginsPage.featuredGroup"), null, featuredCards)}
      ${renderShelf("official", t("pluginsPage.officialGroup"), null, officialCards)}
      ${renderConnectorShelves(shelves.connectors, props)} ${clawHub}
    </div>
  `;
}

/** Connectors shelve by use case, mirroring how people group their tools. */
function renderConnectorShelves(
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
  return html`
    <section class="plugins-group" aria-labelledby="plugins-shelf-connectors">
      <div class="plugins-group__heading">
        <h2 id="plugins-shelf-connectors">${t("pluginsPage.connectorsGroup")}</h2>
        <span>${connectors.length}</span>
      </div>
      <p class="plugins-group__hint">${t("pluginsPage.connectorsHint")}</p>
      ${groups.map(
        (entry) => html`
          <div class="plugins-subgroup" data-connector-group=${entry.group}>
            <h3 class="plugins-subgroup__heading">${connectorGroupLabel(entry.group)}</h3>
            <div class="plugins-grid">
              ${entry.entries.map((connector) => renderConnectorCard(connector, props))}
            </div>
          </div>
        `,
      )}
    </section>
  `;
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
  const busy = props.busy[key];
  return html`
    <div
      class="plugins-detail-backdrop"
      @click=${(event: Event) => {
        if (event.target === event.currentTarget) {
          props.onShowDetails(null);
        }
      }}
    >
      <section
        class="plugins-detail"
        role="dialog"
        aria-modal="true"
        aria-label=${plugin.name}
        data-detail-plugin-id=${plugin.id}
      >
        <button
          type="button"
          class="btn btn--sm btn--icon plugins-detail__close"
          aria-label=${t("pluginsPage.detailClose")}
          @click=${() => props.onShowDetails(null)}
        >
          ${icons.x}
        </button>
        ${renderArtTile(plugin.id, plugin.name, "cover")}
        <div class="plugins-detail__body">
          <div class="plugins-detail__title">
            <h2>${plugin.name}</h2>
            ${plugin.version
              ? html`<span class="plugins-version">v${plugin.version}</span>`
              : nothing}
            ${stateChip(plugin)}
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
    </div>
  `;
}

/* ---------------------------------- page shell ---------------------------------- */

function renderEmpty(title: string, body: string) {
  return html`
    <div class="plugins-empty">
      <span class="plugins-empty__icon" aria-hidden="true">${icons.puzzle}</span>
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
  return html`
    <section class="plugins-workspace" aria-label=${t("tabs.plugins")}>
      <div class="plugins-toolbar">
        <label class="plugins-search" for="plugins-global-search">
          <span class="plugins-search__label">${t("pluginsPage.searchLabel")}</span>
          <span class="plugins-search__icon" aria-hidden="true">${icons.search}</span>
          <input
            id="plugins-global-search"
            name="plugins-search"
            type="search"
            autocomplete="off"
            .value=${live(props.query)}
            placeholder=${t("pluginsPage.searchPlaceholder")}
            @input=${(event: Event) =>
              props.onQueryChange((event.currentTarget as HTMLInputElement).value)}
          />
        </label>
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

      <div
        id="plugins-hub-panel"
        class="plugins-panel"
        role="tabpanel"
        aria-labelledby=${`plugins-tab-${props.activeTab}`}
      >
        ${props.loading && !canShowCatalog
          ? html`<div class="plugins-search-state" role="status">${t("pluginsPage.loading")}</div>`
          : props.error && !canShowCatalog
            ? nothing
            : !props.connected && !canShowCatalog
              ? renderEmpty(t("pluginsPage.offlineTitle"), t("pluginsPage.offlineBody"))
              : renderActivePanel(props)}
      </div>
      ${renderDetailOverlay(props)}
    </section>
  `;
}
