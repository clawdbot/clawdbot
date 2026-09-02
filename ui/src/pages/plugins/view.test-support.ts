import { render } from "lit";
import { t } from "../../i18n/index.ts";
import type { PluginCatalogItem, PluginListResult } from "../../lib/plugins/index.ts";
import { renderPlugins } from "./view.ts";

export type PluginsViewProps = Parameters<typeof renderPlugins>[0];

export function createPlugin(overrides: Partial<PluginCatalogItem> = {}): PluginCatalogItem {
  return {
    id: "workboard",
    name: "Workboard",
    description: t("pluginsPage.optionalCapability"),
    version: "1.0.0",
    kind: ["productivity"],
    origin: "bundled",
    installed: true,
    enabled: false,
    state: "disabled",
    featured: true,
    order: 10,
    category: "tool",
    removable: false,
    ...overrides,
  };
}

export function createResult(plugins: PluginCatalogItem[]): PluginListResult {
  return { plugins, diagnostics: [], mutationAllowed: true };
}

export function createProps(overrides: Partial<PluginsViewProps> = {}): PluginsViewProps {
  return {
    connected: true,
    loading: false,
    result: createResult([createPlugin()]),
    error: null,
    activeTab: "installed",
    query: "",
    installedFilter: "all",
    searchResults: null,
    searchLoading: false,
    searchError: null,
    busy: {},
    messages: {},
    detailPluginId: null,
    detailInspection: null,
    detailInspectionError: null,
    consent: null,
    consentInspection: null,
    consentInspectionLoading: false,
    consentInspectionError: null,
    iconUrls: {},
    canMutate: true,
    mutationBlockedReason: null,
    pageNotice: null,
    mcpSettingsHref: "/settings/mcp",
    mcpServers: [],
    mcpMessage: null,
    mcpBusy: false,
    mcpFormOpen: false,
    onQueryChange: () => undefined,
    onFilterChange: () => undefined,
    onRefresh: () => undefined,
    onIconError: () => undefined,
    onShowDetails: () => undefined,
    onSetEnabled: () => undefined,
    onInstall: () => undefined,
    onCancelConsent: () => undefined,
    onConfirmConsent: () => undefined,
    onRetryConsentInspection: () => undefined,
    onDismissMessage: () => undefined,
    onUninstall: () => undefined,
    onAddConnector: () => undefined,
    onSearchClawHub: () => undefined,
    onMcpToggle: () => undefined,
    onMcpRemove: () => undefined,
    onMcpFormToggle: () => undefined,
    onMcpAdd: () => undefined,
    ...overrides,
  };
}

export function mount(props: PluginsViewProps): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderPlugins(props), container);
  return container;
}
