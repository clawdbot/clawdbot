// Memory destination shell and its merged Settings surface.
import { html, nothing, type TemplateResult } from "lit";
import "../../components/agent-select-registration.ts";
import type { AgentSelectOption } from "../../components/agent-select.ts";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import {
  renderLearnMoreLink,
  renderSettingsDefaultDescription,
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsStatus,
  renderSettingsToggleRow,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";
import { registerMemoryImportEnglish } from "../../i18n/locales/en-memory-import.ts";
import type { PluginCatalogItem } from "../../lib/plugins/index.ts";
import {
  selectedEngineId,
  DEFAULT_MEMORY_ENGINE_ID,
  type MemoryEngineSelection,
  type MemoryTab,
} from "./memory-schema.ts";

registerMemoryImportEnglish();

/** One installed plugin that can claim the exclusive `plugins.slots.memory` slot. */
type MemoryEngineOption = {
  id: string;
  label: string;
  /** False when config names an engine absent from the current plugin catalog. */
  available: boolean;
};

/**
 * Enablement as the page actually knows it, shared by the engine row and the
 * add-on rows. `loading` and `unknown` exist so a catalog that was never read
 * cannot render as a definite "Disabled"; only a successful read decides.
 */
export type MemoryPluginState = "enabled" | "disabled" | "loading" | "unknown";

export type MemoryCatalogState =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "ready"; plugins: readonly PluginCatalogItem[]; mutationAllowed: boolean };

export function buildMemoryEngineOptions(
  catalog: MemoryCatalogState,
  selection: MemoryEngineSelection,
): MemoryEngineOption[] {
  if (catalog.kind !== "ready") {
    return [];
  }
  const options = catalog.plugins
    .filter((plugin) => plugin.installed && plugin.kind?.includes("memory") === true)
    .map((plugin) => ({
      id: plugin.id,
      label:
        plugin.id === DEFAULT_MEMORY_ENGINE_ID
          ? t("memoryPage.engine.openClawMemory")
          : plugin.name,
      available: true,
    }))
    .toSorted((left, right) => {
      const leftIsDefault = left.id === DEFAULT_MEMORY_ENGINE_ID;
      const rightIsDefault = right.id === DEFAULT_MEMORY_ENGINE_ID;
      return leftIsDefault === rightIsDefault
        ? left.label.localeCompare(right.label)
        : leftIsDefault
          ? -1
          : 1;
    });
  const selected = selectedEngineId(selection);
  if (selected && !options.some((option) => option.id === selected)) {
    const unavailable = {
      id: selected,
      label:
        selected === DEFAULT_MEMORY_ENGINE_ID ? t("memoryPage.engine.openClawMemory") : selected,
      available: false,
    };
    if (selected === DEFAULT_MEMORY_ENGINE_ID) {
      options.unshift(unavailable);
    } else {
      options.push(unavailable);
    }
  }
  return options;
}

export function resolveMemoryPluginState(
  catalog: MemoryCatalogState,
  entry: PluginCatalogItem | undefined,
): MemoryPluginState {
  if (catalog.kind !== "ready") {
    return catalog.kind === "loading" ? "loading" : "unknown";
  }
  return !entry?.installed || entry.state === "not-installed" || entry.state === "error"
    ? "unknown"
    : entry.enabled
      ? "enabled"
      : "disabled";
}

export function findMemoryCatalogPlugin(catalog: MemoryCatalogState, pluginId: string | null) {
  return catalog.kind === "ready" && pluginId
    ? catalog.plugins.find((plugin) => plugin.id === pluginId)
    : undefined;
}

/** Additive memory plugin: no `kind`, so it layers on top of whichever engine wins the slot. */
type MemoryAddonRow = {
  id: string;
  label: string;
  description: string;
  state: MemoryPluginState;
  busy: boolean;
  error: string | null;
  notice: string | null;
};

const MEMORY_ADDON_PLUGINS = [
  { id: "active-memory", labelKey: "memoryPage.addons.activeMemory.title" },
  { id: "memory-wiki", labelKey: "memoryPage.addons.memoryWiki.title" },
] as const;

export function buildMemoryAddonRows(
  catalog: MemoryCatalogState,
  state: {
    busy: ReadonlySet<string>;
    errors: ReadonlyMap<string, string>;
    notices: ReadonlyMap<string, { message: string }>;
    refreshWarnings: ReadonlyMap<string, string>;
  },
): MemoryAddonRow[] {
  return MEMORY_ADDON_PLUGINS.map((addon) => {
    const entry = findMemoryCatalogPlugin(catalog, addon.id);
    return {
      id: addon.id,
      label: t(addon.labelKey),
      description: entry?.description ?? addon.id,
      state: resolveMemoryPluginState(catalog, entry),
      busy: state.busy.has(addon.id),
      error: state.errors.get(addon.id) ?? null,
      notice:
        [state.notices.get(addon.id)?.message, state.refreshWarnings.get(addon.id)]
          .filter(Boolean)
          .join(" ") || null,
    };
  });
}

export type MemoryEngineOutcome = { kind: "error" | "warning"; message: string };

type MemoryViewProps = {
  activeTab: MemoryTab;
  onTabChange: (tab: MemoryTab) => void;
  engineOptions: readonly MemoryEngineOption[];
  engineSelection: MemoryEngineSelection;
  /**
   * What the catalog says about the plugin the slot names. The slot and plugin
   * enablement are independent config surfaces, so the named owner can be
   * disabled and memory silently off; only `enabled` means it is running.
   */
  engineState: MemoryPluginState;
  engineBusy: boolean;
  /** Distinguishes a rejected write from a committed write with a failed refresh. */
  engineOutcome: MemoryEngineOutcome | null;
  onEngineChange: (engineId: string | null) => void;
  addons: readonly MemoryAddonRow[];
  canToggleAddons: boolean;
  onAddonChange: (pluginId: string, enabled: boolean) => void;
  pluginsHref: string;
  memoryImportHref: string;
  canImportMemory: boolean;
  /** New status-led landing view. */
  overview: TemplateResult;
  /** Search and read the selected agent's indexed memory. */
  memories: TemplateResult;
  /** Agent-scoped dream diary and scene. */
  dreams: TemplateResult;
  /** One embedded editor for every `memory.*` schema field. */
  editor: TemplateResult;
  /** Global dreaming controls, sharing runtimeConfig with the editor above. */
  dreamingSettings: TemplateResult;
  agentId: string | null;
  agents: readonly AgentSelectOption[];
  onAgentChange: (agentId: string | null) => void;
};

const MEMORY_PANEL_ID = "memory-settings-panel";

const MEMORY_DOCS_URL = "https://docs.openclaw.ai/concepts/memory";

const MEMORY_ENGINE_OFF = "";

function engineHintKey(selection: MemoryEngineSelection): string {
  switch (selection.kind) {
    case "auto":
      return "memoryPage.engine.autoHint";
    case "off":
      return "memoryPage.engine.offHint";
    default:
      return "memoryPage.engine.explicitHint";
  }
}

function renderEngineSection(props: MemoryViewProps) {
  // The slot is exclusive (resolveMemorySlotDecisionShared): only one memory-kind
  // plugin loads. A segmented control states that up front instead of leaving it
  // to a post-save toast.
  const engineId = selectedEngineId(props.engineSelection);
  const defaultEngine =
    props.engineOptions.find((option) => option.id === DEFAULT_MEMORY_ENGINE_ID)?.label ??
    t("memoryPage.engine.openClawMemory");
  const defaultDescription = renderSettingsDefaultDescription(
    defaultEngine,
    props.engineSelection.kind !== "auto",
  );
  if (props.engineOptions.length === 0) {
    return renderSettingsSection(
      { title: t("memoryPage.engine.title"), description: t("memoryPage.engine.description") },
      renderSettingsRow({
        title: t("memoryPage.engine.rowTitle"),
        description: html`
          ${t("memoryPage.engine.catalogUnavailable")} ${t(engineHintKey(props.engineSelection))}
          ${defaultDescription}
        `,
        control: renderSettingsValue(engineId ?? t("memoryPage.engine.off"), { mono: true }),
      }),
    );
  }
  const options = [
    ...props.engineOptions.map((option) => ({
      value: option.id,
      label: option.available
        ? option.label
        : `${option.label} (${t("memoryPage.engine.unavailable")})`,
    })),
    { value: MEMORY_ENGINE_OFF, label: t("memoryPage.engine.off") },
  ];
  return renderSettingsSection(
    { title: t("memoryPage.engine.title"), description: t("memoryPage.engine.description") },
    html`
      ${renderSettingsRow({
        title: t("memoryPage.engine.rowTitle"),
        description: html`${t(engineHintKey(props.engineSelection))} ${defaultDescription}`,
        stacked: true,
        control: renderSettingsSegmented({
          value: engineId ?? MEMORY_ENGINE_OFF,
          options,
          disabled: props.engineBusy,
          ariaLabel: t("memoryPage.engine.rowTitle"),
          onChange: (value) => props.onEngineChange(value || null),
        }),
      })}
      ${renderDisabledEngineRow(props, engineId)}
      ${props.engineOutcome === null
        ? nothing
        : renderSettingsRow({
            title: t(
              props.engineOutcome.kind === "error"
                ? "memoryPage.engine.changeFailed"
                : "pluginsPage.needsAttention",
            ),
            description: props.engineOutcome.message,
            control: renderSettingsStatus({
              kind: props.engineOutcome.kind === "error" ? "danger" : "warn",
              label: t(
                props.engineOutcome.kind === "error"
                  ? "common.failed"
                  : "pluginsPage.needsAttention",
              ),
            }),
          })}
    `,
  );
}

/**
 * The segmented control shows the slot owner, which stays selected even when
 * that plugin is disabled — so re-picking it fires no change event and there
 * would be no way back. This row is the only path that re-enables the owner.
 */
function renderDisabledEngineRow(props: MemoryViewProps, engineId: string | null) {
  if (engineId === null || props.engineState !== "disabled") {
    return nothing;
  }
  return renderSettingsRow({
    title: t("memoryPage.engine.disabledTitle"),
    description: t("memoryPage.engine.disabledHint"),
    control: html`
      <button
        class="btn btn--sm"
        ?disabled=${props.engineBusy}
        @click=${() => props.onEngineChange(engineId)}
      >
        ${t("memoryPage.engine.enable")}
      </button>
    `,
  });
}

// Only `enabled` is a positive claim; the other three are deliberately muted so
// an unread catalog never looks like a decided "off".
function renderAddonStatus(state: MemoryPluginState) {
  switch (state) {
    case "enabled":
      return renderSettingsStatus({ kind: "ok", label: t("common.enabled") });
    case "disabled":
      return renderSettingsStatus({ kind: "muted", label: t("common.disabled") });
    case "loading":
      return renderSettingsStatus({ kind: "muted", label: t("common.loading") });
    default:
      return renderSettingsStatus({ kind: "muted", label: t("memoryPage.addons.stateUnknown") });
  }
}

function renderAddonsSection(props: MemoryViewProps) {
  return renderSettingsSection(
    { title: t("memoryPage.addons.title"), description: t("memoryPage.addons.description") },
    html`
      ${props.addons.map(
        (addon) => html`
          ${props.canToggleAddons && (addon.state === "enabled" || addon.state === "disabled")
            ? renderSettingsToggleRow({
                title: addon.label,
                ariaLabel: t("memoryPage.addons.toggleAriaLabel", { plugin: addon.label }),
                description: addon.description,
                checked: addon.state === "enabled",
                disabled: addon.busy,
                onChange: (enabled) => props.onAddonChange(addon.id, enabled),
              })
            : renderSettingsRow({
                title: addon.label,
                description: addon.description,
                control: renderAddonStatus(addon.state),
              })}
          ${addon.error === null
            ? nothing
            : renderSettingsRow({
                title: t("memoryPage.addons.changeFailed", { plugin: addon.label }),
                description: addon.error,
                control: renderSettingsStatus({ kind: "danger", label: t("common.failed") }),
              })}
          ${addon.notice === null
            ? nothing
            : renderSettingsRow({
                title: t("pluginsPage.needsAttention"),
                description: addon.notice,
                control: renderSettingsStatus({
                  kind: "warn",
                  label: t("pluginsPage.needsAttention"),
                }),
              })}
        `,
      )}
      ${renderSettingsRow({
        title: t("memoryPage.addons.manage"),
        control: html`<a class="memory-page__link" href=${props.pluginsHref}
          >${t("memoryPage.addons.manageLink")}</a
        >`,
      })}
    `,
  );
}

function renderSettingsTab(props: MemoryViewProps) {
  return html`
    <div class="settings-page">
      ${renderEngineSection(props)} ${renderAddonsSection(props)}
      <p class="settings-page__intro">${t("memoryPage.search.intro")}</p>
    </div>
    ${props.editor}
    <div class="settings-page">
      ${props.dreamingSettings}
      ${renderSettingsSection(
        { title: t("memoryPage.import.title"), description: t("memoryPage.import.description") },
        renderSettingsRow({
          title: t("tabs.memoryImport"),
          description: t("subtitles.memoryImport"),
          control: props.canImportMemory
            ? html`<a class="memory-page__link" href=${props.memoryImportHref}
                >${t("memoryPage.import.link")}</a
              >`
            : renderSettingsValue(t("memoryImport.adminRequired")),
        }),
      )}
    </div>
  `;
}

export function renderMemory(props: MemoryViewProps) {
  return html`
    <section class="memory-page">
      <section class="content-header content-header--settings content-header--page hub-page-header">
        <div class="hub-page-header__title">
          <div class="page-title">${t("tabs.memory")}</div>
          <div class="page-subtitle">
            ${t("memoryPage.intro")} ${renderLearnMoreLink(MEMORY_DOCS_URL)}
          </div>
        </div>
        <div class="hub-page-header__tabs">
          ${renderHubTabs<MemoryTab>({
            id: "memory",
            active: props.activeTab,
            tabs: [
              { value: "overview", label: t("memoryPage.tabs.overview") },
              { value: "memories", label: t("memoryPage.tabs.memories") },
              { value: "dreams", label: t("memoryPage.tabs.dreams") },
              { value: "settings", label: t("memoryPage.tabs.settings") },
            ],
            ariaLabel: t("memoryPage.tablistLabel"),
            panelId: MEMORY_PANEL_ID,
            onSelect: (tab) => props.onTabChange(tab),
          })}
        </div>
        <div class="hub-page-header__actions">
          ${props.activeTab === "settings" || props.agents.length <= 1
            ? nothing
            : html`
                <div class="agent-scope-control">
                  <span class="agent-scope-control__label"
                    >${t("memoryPage.dreaming.agentScope.rowTitle")}</span
                  >
                  <openclaw-agent-select
                    .options=${props.agents}
                    .value=${props.agentId ?? ""}
                    .accessibleLabel=${t("memoryPage.dreaming.agentScope.rowTitle")}
                    .onSelect=${(value: string) => props.onAgentChange(value || null)}
                  ></openclaw-agent-select>
                </div>
              `}
        </div>
      </section>
      <div id=${MEMORY_PANEL_ID} class="memory-page__panel" role="tabpanel">
        ${props.activeTab === "overview"
          ? props.overview
          : props.activeTab === "memories"
            ? props.memories
            : props.activeTab === "dreams"
              ? props.dreams
              : renderSettingsTab(props)}
      </div>
    </section>
  `;
}
