import { html, nothing, type TemplateResult } from "lit";
import { repeat } from "lit/directives/repeat.js";
import type { ConfigUiHints } from "../../api/types.ts";
import { renderNode } from "../../components/config-form.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import { icons } from "../../components/icons.ts";
import { renderReasonedDisabledControl } from "../../components/reasoned-disabled-control.ts";
import {
  renderSettingsEmpty,
  renderSettingsLoadingSkeleton,
  renderSettingsPage,
  renderSettingsPageHeader,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsStatus,
  renderSettingsToggle,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import type { JsonSchema } from "../../lib/config-form-utils.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import type {
  PluginCatalogItem,
  PluginListResult,
  PluginsInspectResult,
} from "../../lib/plugins/index.ts";
import {
  pluginOriginLabel,
  renderArtTile,
  renderPluginDeclaredCapabilities,
  renderPluginGrants,
} from "./consent-dialog.ts";
import { pluginRowKey, type PluginRowMessage } from "./plugin-row-message.ts";
import { pluginEntryValue } from "./settings-model.ts";

export type PluginSettingsTab = "installed" | "advanced";

type SharedProps = {
  connected: boolean;
  loading: boolean;
  result: PluginListResult | null;
  error: string | null;
  busy: Readonly<Record<string, boolean>>;
  messages: Readonly<Record<string, PluginRowMessage>>;
  pageNotice: PluginRowMessage | null;
  iconUrls: Readonly<Record<string, string>>;
  canMutate: boolean;
  mutationBlockedReason: string | null;
  configBusy: boolean;
  configSchemaLoading: boolean;
  configError: string | null;
  canEditConfig: boolean;
  configValue: Record<string, unknown> | null;
  configHints: ConfigUiHints;
  configUnsupportedPaths: readonly string[];
  onIconError: (pluginId: string) => void;
  onSetEnabled: (pluginId: string, enabled: boolean, rowKey: string) => void;
  onUninstall: (pluginId: string, rowKey: string) => void;
  onConfigPatch: (path: Array<string | number>, value: unknown) => void;
  onConfigRemove: (path: Array<string | number>) => void;
  onConfigReload: () => void;
  onRefresh: () => void;
};

type InventoryProps = SharedProps & {
  tab: PluginSettingsTab;
  query: string;
  advancedSchema: JsonSchema | null;
  onTabChange: (tab: PluginSettingsTab) => void;
  onQueryChange: (query: string) => void;
  pluginHref: (pluginId: string) => string;
  onOpenPlugin: (pluginId: string) => void;
};

type DetailProps = SharedProps & {
  pluginId: string;
  inspection: PluginsInspectResult | null;
  inspectionError: string | null;
  configSchema: JsonSchema | null;
  backHref: string;
  backLabel: string;
  onBack: () => void;
  onRetryInspection: () => void;
};

function pluginStatePresentation(plugin: PluginCatalogItem): {
  kind: "ok" | "warn" | "danger" | "muted";
  label: string;
} {
  switch (plugin.state) {
    case "enabled":
      return { kind: "ok", label: t("pluginsPage.enabled") };
    case "disabled":
      return { kind: "muted", label: t("pluginsPage.disabled") };
    case "needs-setup":
      return { kind: "warn", label: t("pluginsPage.setupRequired") };
    case "error":
      return { kind: "danger", label: t("pluginsPage.needsAttention") };
    case "not-installed":
      return { kind: "muted", label: t("pluginsPage.available") };
  }
  return plugin.state satisfies never;
}

function matchesQuery(plugin: PluginCatalogItem, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return (
    !needle ||
    [plugin.name, plugin.id, plugin.description, plugin.packageName].some((value) =>
      value?.toLocaleLowerCase().includes(needle),
    )
  );
}

function renderMessage(message: PluginRowMessage | undefined) {
  if (!message) {
    return nothing;
  }
  return html`<div
    class="plugins-row-message plugins-row-message--${message.kind} oc-banner ${
      message.kind === "error"
        ? "oc-banner-error"
        : message.kind === "warning"
          ? "oc-banner-warning"
          : "oc-banner-success"
    }"
    role=${message.kind === "error" ? "alert" : "status"}
  >
    ${message.text}
  </div>`;
}

function renderRetryError(error: string, onRetry: () => void): TemplateResult {
  return html`<div
    class="callout danger plugins-settings-error oc-banner oc-banner-error"
    role="alert"
  >
    <span>${error}</span>
    <button type="button" class="btn btn--sm oc-action oc-action-secondary" @click=${onRetry}>
      ${t("pluginsPage.tryAgain")}
    </button>
  </div>`;
}

function renderConfigActions(props: SharedProps) {
  return html`<button
    type="button"
    class="btn btn--xs btn--icon oc-action oc-action-icon oc-action-secondary"
    aria-label=${t("common.reload")}
    ?disabled=${props.configBusy || props.configSchemaLoading}
    @click=${props.onConfigReload}
  >
    ${icons.refresh}
  </button>`;
}

function renderSettingsTabs(props: InventoryProps): TemplateResult {
  return renderHubTabs({
    id: "plugin-settings",
    active: props.tab,
    tabs: [
      { value: "installed", label: t("pluginsPage.settingsInstalled") },
      { value: "advanced", label: t("pluginsPage.advanced") },
    ],
    ariaLabel: t("pluginsPage.settingsTabs"),
    panelId: "plugin-settings-panel",
    variant: "sub",
    className: "plugins-settings-tabs",
    carapace: true,
    onSelect: props.onTabChange,
  });
}

function renderInstalledInventory(props: InventoryProps): TemplateResult {
  if (!props.connected) {
    return renderSettingsEmpty(t("pluginsPage.connectToManage"), { carapace: true });
  }
  if (props.loading) {
    return renderSettingsLoadingSkeleton({ rows: 4, carapace: true });
  }
  if (props.error && !props.result) {
    return renderRetryError(props.error, props.onRefresh);
  }
  const refreshError = props.error ? renderRetryError(props.error, props.onRefresh) : nothing;
  const plugins = (props.result?.plugins ?? [])
    .filter((plugin) => plugin.installed && matchesQuery(plugin, props.query))
    .toSorted((left, right) => left.name.localeCompare(right.name));
  if (plugins.length === 0) {
    return html`${refreshError}${renderSettingsEmpty(
      props.query ? t("pluginsPage.noSettingsMatches") : t("pluginsPage.noInstalled"),
      { carapace: true },
    )}`;
  }
  return html`${refreshError}${repeat(
    plugins,
    (plugin) => plugin.id,
    (plugin) => {
      const key = pluginRowKey(plugin.id);
      const busy = Boolean(props.busy[key]);
      const toggle = renderSettingsToggle({
        checked: plugin.enabled,
        disabled: !props.mutationBlockedReason && (!props.canMutate || busy),
        ariaDisabled: !props.canMutate,
        ariaLabel: t("pluginsPage.toggleNamed", { name: plugin.name }),
        onChange: (enabled) => {
          if (!props.canMutate || busy) {
            return false;
          }
          props.onSetEnabled(plugin.id, enabled, key);
          return true;
        },
      });
      return html`
        <article
          class="settings-row settings-row--nav plugins-settings-row oc-settings-row"
          data-plugin-id=${plugin.id}
          @click=${(event: Event) => {
            const target = event.target;
            if (!(target instanceof Element) || !target.closest("wa-switch, button, a")) {
              props.onOpenPlugin(plugin.id);
            }
          }}
        >
          ${renderArtTile(plugin.id, plugin.name, props.iconUrls[plugin.id], () =>
            props.onIconError(plugin.id),
          )}
          <a
            class="settings-row__text plugins-settings-row__link oc-settings-row-content"
            href=${props.pluginHref(plugin.id)}
            @click=${(event: MouseEvent) => {
              if (!shouldHandleNavigationClick(event)) {
                return;
              }
              event.preventDefault();
              props.onOpenPlugin(plugin.id);
            }}
          >
            <span class="settings-row__title oc-settings-row-title">${plugin.name}</span>
            <span class="settings-row__desc oc-settings-row-description"
              >${plugin.description || t("pluginsPage.optionalCapability")}</span
            >
          </a>
          <div class="settings-row__control oc-settings-row-control">
            ${renderReasonedDisabledControl(props.mutationBlockedReason, toggle)}
            <span class="settings-row__chevron" aria-hidden="true">${icons.chevronRight}</span>
          </div>
          ${renderMessage(props.messages[key])}
        </article>
      `;
    },
  )}`;
}

function renderAdvanced(props: InventoryProps): TemplateResult {
  if (!props.connected) {
    return renderSettingsEmpty(t("pluginsPage.connectToManage"), { carapace: true });
  }
  if (!props.advancedSchema || !props.configValue) {
    return props.configError
      ? renderRetryError(props.configError, props.onConfigReload)
      : props.configSchemaLoading || !props.configValue
        ? renderSettingsLoadingSkeleton({ rows: 4, carapace: true })
        : renderSettingsEmpty(t("pluginsPage.schemaUnavailable"), { carapace: true });
  }
  return html`
    ${renderNode({
      schema: props.advancedSchema,
      value: props.configValue.plugins ?? {},
      path: ["plugins"],
      hints: props.configHints,
      unsupported: new Set(props.configUnsupportedPaths),
      disabled: !props.canEditConfig || props.configBusy,
      showLabel: false,
      onPatch: props.onConfigPatch,
      onRemove: props.onConfigRemove,
    })}
    ${props.configError ? renderRetryError(props.configError, props.onConfigReload) : nothing}
  `;
}

export function renderPluginSettingsInventory(props: InventoryProps): TemplateResult {
  const body =
    props.tab === "installed"
      ? html`
          <label class="plugins-settings-search">
            <span class="settings-control__sr-label">${t("pluginsPage.searchInstalled")}</span>
            <span aria-hidden="true">${icons.search}</span>
            <input
              class="settings-input oc-input"
              type="search"
              aria-label=${t("pluginsPage.searchInstalled")}
              placeholder=${t("pluginsPage.searchInstalled")}
              .value=${props.query}
              @input=${(event: Event) => {
                // SAFETY: Lit attaches this handler directly to the input declared above.
                props.onQueryChange((event.currentTarget as HTMLInputElement).value);
              }}
            />
          </label>
          ${renderSettingsSection(
            {
              title: t("pluginsPage.settingsInstalled"),
              description: t("pluginsPage.settingsInstalledDescription"),
              count: (props.result?.plugins ?? []).filter((plugin) => plugin.installed).length,
              carapace: true,
            },
            renderInstalledInventory(props),
          )}
        `
      : html`<div id="plugin-settings-advanced">
          ${renderSettingsSection(
            {
              title: t("pluginsPage.advanced"),
              description: t("pluginsPage.advancedDescription"),
              actions: renderConfigActions(props),
              carapace: true,
            },
            renderAdvanced(props),
          )}
        </div>`;
  return renderSettingsPage(
    html`
      ${renderSettingsPageHeader({
        title: html`<h1 class="plugins-settings-title">${t("tabs.plugins")}</h1>`,
        subtitle: t("pluginsPage.settingsDescription"),
      })}
      ${props.pageNotice ? renderMessage(props.pageNotice) : nothing}
      <div class="plugins-settings-content">
        ${renderSettingsTabs(props)}
        <wa-tab-panel
          id="plugin-settings-panel"
          name=${props.tab}
          active
          aria-labelledby=${`plugin-settings-tab-${props.tab}`}
        >
          ${body}
        </wa-tab-panel>
      </div>
    `,
    { carapace: true },
  );
}

function renderConfiguration(props: DetailProps, plugin: PluginCatalogItem): TemplateResult {
  if (!props.configValue || !props.configSchema) {
    if (props.configError) {
      return renderRetryError(props.configError, props.onConfigReload);
    }
    return renderSettingsLoadingSkeleton({ rows: 3, carapace: true });
  }
  const pluginEntry = pluginEntryValue(props.configValue, plugin.id);
  return html`
    ${renderNode({
      schema: props.configSchema,
      value: pluginEntry.config ?? {},
      path: ["plugins", "entries", plugin.id, "config"],
      hints: props.configHints,
      unsupported: new Set(props.configUnsupportedPaths),
      disabled: !props.canEditConfig || props.configBusy,
      showLabel: false,
      onPatch: props.onConfigPatch,
      onRemove: props.onConfigRemove,
    })}
    ${props.configError ? renderRetryError(props.configError, props.onConfigReload) : nothing}
  `;
}

function renderAccess(props: DetailProps): TemplateResult {
  if (props.inspectionError) {
    return renderRetryError(props.inspectionError, props.onRetryInspection);
  }
  if (!props.inspection) {
    return renderSettingsLoadingSkeleton({ rows: 3, carapace: true });
  }
  const grants = props.inspection.grants;
  const modelOverride = Boolean(
    grants.llm?.allowModelOverride ||
    grants.llm?.allowAuthProfileOverride ||
    grants.llm?.allowAgentIdOverride ||
    grants.subagent?.allowModelOverride,
  );
  return html`
    ${renderSettingsRow({
      title: t("pluginsPage.promptContextAccess"),
      description: t("pluginsPage.promptContextAccessDescription"),
      control: renderSettingsStatus({
        kind: grants.hooks.allowPromptInjection.effective ? "warn" : "muted",
        label: grants.hooks.allowPromptInjection.effective
          ? t("pluginsPage.accessAllowed")
          : t("pluginsPage.accessBlocked"),
        carapace: true,
      }),
      carapace: true,
    })}
    ${renderSettingsRow({
      title: t("pluginsPage.conversationAccess"),
      description: t("pluginsPage.conversationAccessDescription"),
      control: renderSettingsStatus({
        kind: grants.hooks.allowConversationAccess.effective ? "warn" : "muted",
        label: grants.hooks.allowConversationAccess.effective
          ? t("pluginsPage.accessAllowed")
          : t("pluginsPage.accessBlocked"),
        carapace: true,
      }),
      carapace: true,
    })}
    ${renderSettingsRow({
      title: t("pluginsPage.modelOverrideAccess"),
      description: t("pluginsPage.modelOverrideAccessDescription"),
      control: renderSettingsStatus({
        kind: modelOverride ? "warn" : "muted",
        label: modelOverride ? t("pluginsPage.accessAllowed") : t("pluginsPage.accessBlocked"),
        carapace: true,
      }),
      carapace: true,
    })}
    <details class="plugins-settings-advanced-access">
      <summary>${t("pluginsPage.advanced")}</summary>
      ${renderPluginDeclaredCapabilities(props.inspection.declared)}
      ${renderPluginGrants(props.inspection.grants, props.inspection.plugin.origin)}
    </details>
  `;
}

function renderLifecycle(props: DetailProps, plugin: PluginCatalogItem): TemplateResult {
  const key = pluginRowKey(plugin.id);
  const source = props.inspection?.source;
  const trust = props.inspection?.trust;
  const rows = html`
    ${renderSettingsRow({
      title: t("pluginsPage.detailPluginId"),
      control: html`<code>${plugin.id}</code>`,
      carapace: true,
    })}
    ${
      plugin.version
        ? renderSettingsRow({
            title: t("pluginsPage.version"),
            control: html`<span>${`v${plugin.version}`}</span>`,
            carapace: true,
          })
        : nothing
    }
    ${
      plugin.packageName
        ? renderSettingsRow({
            title: t("pluginsPage.detailPackage"),
            control: html`<code>${plugin.packageName}</code>`,
            carapace: true,
          })
        : nothing
    }
    ${
      plugin.origin
        ? renderSettingsRow({
            title: t("pluginsPage.detailOrigin"),
            control: html`<span>${pluginOriginLabel(plugin.origin)}</span>`,
            carapace: true,
          })
        : nothing
    }
    ${
      source
        ? renderSettingsRow({
            title: t("pluginsPage.installedSource"),
            control: html`<span>${source.spec ?? source.packageName ?? source.kind}</span>`,
            carapace: true,
          })
        : nothing
    }
    ${
      source?.integrity
        ? renderSettingsRow({
            title: t("pluginsPage.integrity"),
            control: html`<code title=${source.integrity}>${source.integrity.slice(0, 20)}…</code>`,
            carapace: true,
          })
        : nothing
    }
    ${
      trust
        ? renderSettingsRow({
            title: t("pluginsPage.trustStatus"),
            control: html`<span>${trust.disposition}</span>`,
            carapace: true,
          })
        : nothing
    }
    ${
      plugin.removable
        ? renderSettingsRow({
            title: t("pluginsPage.uninstall"),
            description: t("pluginsPage.uninstallDescription"),
            control: renderReasonedDisabledControl(
              props.mutationBlockedReason,
              html`<button
                type="button"
                class="btn danger oc-action oc-action-secondary"
                ?disabled=${
                  !props.mutationBlockedReason && (!props.canMutate || Boolean(props.busy[key]))
                }
                aria-disabled=${!props.canMutate ? "true" : nothing}
                aria-label=${t("pluginsPage.uninstallNamed", { name: plugin.name })}
                @click=${() => {
                  if (props.canMutate && !props.busy[key]) {
                    props.onUninstall(plugin.id, key);
                  }
                }}
              >
                ${t("pluginsPage.uninstall")}
              </button>`,
            ),
            carapace: true,
          })
        : renderSettingsRow({
            title: t("pluginsPage.uninstall"),
            description: t("pluginsPage.managedCannotUninstall"),
            carapace: true,
          })
    }
  `;
  return rows;
}

export function renderPluginSettingsDetail(props: DetailProps): TemplateResult {
  const plugin = props.result?.plugins.find((entry) => entry.id === props.pluginId);
  if (!props.connected) {
    return renderSettingsPage(
      renderSettingsEmpty(t("pluginsPage.connectToManage"), { carapace: true }),
      { carapace: true },
    );
  }
  if (props.error && !props.result) {
    return renderSettingsPage(renderRetryError(props.error, props.onRefresh), { carapace: true });
  }
  if (props.loading || !props.result) {
    return renderSettingsPage(renderSettingsLoadingSkeleton({ rows: 5, carapace: true }), {
      carapace: true,
    });
  }
  if (!plugin?.installed) {
    return renderSettingsPage(
      html`
        <a
          class="btn btn--sm oc-action oc-action-secondary"
          href=${props.backHref}
          @click=${(event: Event) => {
            event.preventDefault();
            props.onBack();
          }}
        >
          ${icons.chevronLeft} ${props.backLabel}
        </a>
        ${renderSettingsEmpty(t("pluginsPage.pluginNotFound"), { carapace: true })}
      `,
      { carapace: true },
    );
  }
  const key = pluginRowKey(plugin.id);
  const statePresentation = pluginStatePresentation(plugin);
  const stateStatus =
    plugin.state === "needs-setup" || plugin.state === "error"
      ? renderSettingsStatus({
          ...statePresentation,
          carapace: true,
        })
      : nothing;
  return renderSettingsPage(
    html`<section class="plugins-settings-detail-header">
        <nav class="plugins-settings-breadcrumb" aria-label=${t("pluginsPage.breadcrumb")}>
          <a
            class="plugins-settings-breadcrumb__parent"
            href=${props.backHref}
            @click=${(event: Event) => {
              event.preventDefault();
              props.onBack();
            }}
            >${props.backLabel}</a
          >
          <span class="plugins-settings-breadcrumb__chevron" aria-hidden="true"
            >${icons.chevronRight}</span
          >
          <span class="plugins-settings-breadcrumb__current" aria-current="page"
            >${plugin.name}</span
          >
        </nav>
        <div class="plugins-settings-detail-hero">
          ${renderArtTile(plugin.id, plugin.name, props.iconUrls[plugin.id], () =>
            props.onIconError(plugin.id),
          )}
          <div class="plugins-settings-detail-identity">
            <h1 class="plugins-settings-detail-title">${plugin.name}</h1>
            <p class="plugins-settings-detail-description">${plugin.description || plugin.id}</p>
          </div>
          <div class="plugins-settings-detail-actions">
            ${stateStatus}
            ${renderReasonedDisabledControl(
              props.mutationBlockedReason,
              renderSettingsToggle({
                checked: plugin.enabled,
                disabled:
                  !props.mutationBlockedReason && (!props.canMutate || Boolean(props.busy[key])),
                ariaDisabled: !props.canMutate,
                ariaLabel: t("pluginsPage.toggleNamed", { name: plugin.name }),
                onChange: (enabled) => {
                  if (!props.canMutate || props.busy[key]) {
                    return false;
                  }
                  props.onSetEnabled(plugin.id, enabled, key);
                  return true;
                },
              }),
            )}
          </div>
        </div>
      </section>
      ${props.pageNotice ? renderMessage(props.pageNotice) : nothing}
      ${props.error ? renderRetryError(props.error, props.onRefresh) : nothing}
      ${
        plugin.error
          ? html`<div class="callout danger oc-banner oc-banner-error" role="alert">
              ${formatUiExternalText(plugin.error)}
            </div>`
          : nothing
      }
      ${renderMessage(props.messages[key])}
      ${
        props.configSchema || props.configSchemaLoading || props.configError
          ? renderSettingsSection(
              {
                title: t("pluginsPage.configuration"),
                description: t("pluginsPage.configurationDescription"),
                actions: renderConfigActions(props),
                carapace: true,
              },
              html`${
                plugin.state === "needs-setup"
                  ? html`<div class="callout warning oc-banner oc-banner-warning" role="status">
                      ${t("pluginsPage.setupRequiredDescription")}
                    </div>`
                  : nothing
              }${renderConfiguration(props, plugin)}`,
            )
          : nothing
      }
      ${renderSettingsSection(
        {
          title: t("pluginsPage.accessCapabilities"),
          description: t("pluginsPage.accessCapabilitiesDescription"),
          carapace: true,
        },
        renderAccess(props),
      )}
      ${renderSettingsSection(
        {
          title: t("pluginsPage.lifecycle"),
          description: t("pluginsPage.lifecycleDescription"),
          carapace: true,
        },
        renderLifecycle(props, plugin),
      )}`,
    { carapace: true },
  );
}
