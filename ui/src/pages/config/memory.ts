// Curated Memory home: engine/backend/add-on rows above the embedded memory
// schema editor, with Dreaming as a sibling tab (see security.ts for the same
// curated-rows-above-schema shape).
import { html, type TemplateResult } from "lit";
import { renderHubTabs } from "../../components/hub-tabs.ts";
import {
  renderSettingsRow,
  renderSettingsSection,
  renderSettingsSegmented,
  renderSettingsStatus,
  renderSettingsValue,
} from "../../components/settings-ui.ts";
import { t } from "../../i18n/index.ts";

export type MemoryTab = "overview" | "search" | "dreaming";

export type MemoryBackend = "builtin" | "qmd";

/** One installed plugin that can claim the exclusive `plugins.slots.memory` slot. */
export type MemoryEngineOption = {
  id: string;
  label: string;
};

/** Additive memory plugin: no `kind`, so it layers on top of whichever engine wins the slot. */
export type MemoryAddonRow = {
  id: string;
  label: string;
  description: string;
  enabled: boolean;
};

export type MemoryViewProps = {
  activeTab: MemoryTab;
  onTabChange: (tab: MemoryTab) => void;
  engineOptions: readonly MemoryEngineOption[];
  /** Resolved slot owner; null means the memory slot is switched off. */
  selectedEngineId: string | null;
  /** True when no explicit `plugins.slots.memory` exists and the slot was auto-filled. */
  engineAuto: boolean;
  engineBusy: boolean;
  onEngineChange: (engineId: string | null) => void;
  backend: MemoryBackend;
  backendBusy: boolean;
  onBackendChange: (backend: MemoryBackend) => void;
  addons: readonly MemoryAddonRow[];
  pluginsHref: string;
  memoryImportHref: string;
  /** Embedded schema editor for this tab's slice of the `memory` section. */
  editor: TemplateResult;
  /** Dreaming tab body; owns its own agent picker and per-agent reads. */
  dreaming: TemplateResult;
};

export const MEMORY_PANEL_ID = "memory-settings-panel";

const MEMORY_ENGINE_OFF = "";

function renderEngineSection(props: MemoryViewProps) {
  // The slot is exclusive (resolveMemorySlotDecisionShared): only one memory-kind
  // plugin loads. A segmented control states that up front instead of leaving it
  // to a post-save toast.
  if (props.engineOptions.length === 0) {
    return renderSettingsSection(
      { title: t("memoryPage.engine.title"), description: t("memoryPage.engine.description") },
      renderSettingsRow({
        title: t("memoryPage.engine.rowTitle"),
        description: t("memoryPage.engine.catalogUnavailable"),
        control: renderSettingsValue(props.selectedEngineId ?? t("memoryPage.engine.off"), {
          mono: true,
        }),
      }),
    );
  }
  const options = [
    ...props.engineOptions.map((option) => ({ value: option.id, label: option.label })),
    { value: MEMORY_ENGINE_OFF, label: t("memoryPage.engine.off") },
  ];
  return renderSettingsSection(
    { title: t("memoryPage.engine.title"), description: t("memoryPage.engine.description") },
    html`
      ${renderSettingsRow({
        title: t("memoryPage.engine.rowTitle"),
        description: props.engineAuto
          ? t("memoryPage.engine.autoHint")
          : t("memoryPage.engine.explicitHint"),
        stacked: true,
        control: renderSettingsSegmented({
          value: props.selectedEngineId ?? MEMORY_ENGINE_OFF,
          options,
          disabled: props.engineBusy,
          ariaLabel: t("memoryPage.engine.rowTitle"),
          onChange: (value) => props.onEngineChange(value || null),
        }),
      })}
    `,
  );
}

function renderBackendSection(props: MemoryViewProps) {
  return renderSettingsSection(
    { title: t("memoryPage.backend.title"), description: t("memoryPage.backend.description") },
    renderSettingsRow({
      title: t("memoryPage.backend.rowTitle"),
      description:
        props.backend === "qmd"
          ? t("memoryPage.backend.qmdHint")
          : t("memoryPage.backend.builtinHint"),
      stacked: true,
      control: renderSettingsSegmented<MemoryBackend>({
        value: props.backend,
        options: [
          { value: "builtin", label: t("memoryPage.backend.builtin") },
          { value: "qmd", label: t("memoryPage.backend.qmd") },
        ],
        disabled: props.backendBusy,
        ariaLabel: t("memoryPage.backend.rowTitle"),
        onChange: (value) => props.onBackendChange(value),
      }),
    }),
  );
}

function renderAddonsSection(props: MemoryViewProps) {
  return renderSettingsSection(
    { title: t("memoryPage.addons.title"), description: t("memoryPage.addons.description") },
    html`
      ${props.addons.map((addon) =>
        renderSettingsRow({
          title: addon.label,
          description: addon.description,
          control: renderSettingsStatus({
            kind: addon.enabled ? "ok" : "muted",
            label: addon.enabled ? t("common.enabled") : t("common.disabled"),
          }),
        }),
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

function renderOverviewTab(props: MemoryViewProps) {
  return html`
    <div class="settings-page">
      ${renderEngineSection(props)} ${renderBackendSection(props)} ${renderAddonsSection(props)}
      ${renderSettingsSection(
        { title: t("memoryPage.import.title"), description: t("memoryPage.import.description") },
        renderSettingsRow({
          title: t("tabs.memoryImport"),
          description: t("subtitles.memoryImport"),
          control: html`<a class="memory-page__link" href=${props.memoryImportHref}
            >${t("memoryPage.import.link")}</a
          >`,
        }),
      )}
    </div>
    ${props.editor}
  `;
}

export function renderMemory(props: MemoryViewProps) {
  return html`
    <section class="memory-page">
      ${renderHubTabs<MemoryTab>({
        id: "memory",
        active: props.activeTab,
        tabs: [
          { value: "overview", label: t("memoryPage.tabs.overview") },
          { value: "search", label: t("memoryPage.tabs.search") },
          { value: "dreaming", label: t("memoryPage.tabs.dreaming") },
        ],
        ariaLabel: t("memoryPage.tablistLabel"),
        panelId: MEMORY_PANEL_ID,
        onSelect: (tab) => props.onTabChange(tab),
      })}
      <div id=${MEMORY_PANEL_ID} class="memory-page__panel" role="tabpanel">
        ${props.activeTab === "overview"
          ? renderOverviewTab(props)
          : props.activeTab === "search"
            ? html`
                <div class="settings-page">
                  <p class="settings-page__intro">${t("memoryPage.search.intro")}</p>
                </div>
                ${props.editor}
              `
            : props.dreaming}
      </div>
    </section>
  `;
}

type JsonRecord = Record<string, unknown>;

function asJsonRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

// One narrowed schema object per (source schema, key set): the config view caches
// its schema analysis by object identity, so a fresh clone per render would
// re-analyze the whole tree on every update.
const narrowedMemorySchemas = new WeakMap<JsonRecord, Map<string, unknown>>();

/**
 * Restrict the root config schema to `memory` with only `keys` retained, so one
 * page can host several tabs over disjoint slices of the same schema section.
 */
export function narrowMemorySchema(schema: unknown, keys: readonly string[]): unknown {
  const root = asJsonRecord(schema);
  const memorySchema = asJsonRecord(asJsonRecord(root?.properties)?.memory);
  const memoryProperties = asJsonRecord(memorySchema?.properties);
  if (!root || !memorySchema || !memoryProperties) {
    return schema;
  }
  const cacheKey = keys.join("");
  const bucket = narrowedMemorySchemas.get(root) ?? new Map<string, unknown>();
  const hit = bucket.get(cacheKey);
  if (hit !== undefined) {
    return hit;
  }
  const retained = Object.fromEntries(
    keys.filter((key) => key in memoryProperties).map((key) => [key, memoryProperties[key]]),
  );
  const narrowed = {
    ...root,
    properties: { memory: { ...memorySchema, properties: retained } },
  };
  bucket.set(cacheKey, narrowed);
  narrowedMemorySchemas.set(root, bucket);
  return narrowed;
}

/** Which `memory.*` children the embedded editor shows for a tab. */
export function memorySchemaKeysForTab(tab: MemoryTab, backend: MemoryBackend): readonly string[] {
  if (tab === "search") {
    return ["search"];
  }
  // `backend` is a curated row above the editor; qmd's sub-config only matters
  // once qmd is the selected backend.
  return backend === "qmd" ? ["citations", "qmd"] : ["citations"];
}
