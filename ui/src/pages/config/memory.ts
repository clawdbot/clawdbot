// Curated Memory home: engine/backend/add-on rows above the embedded memory
// schema editor, with Dreaming as a sibling tab (see security.ts for the same
// curated-rows-above-schema shape).
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type TemplateResult } from "lit";
import { resolveSlotSelection } from "../../../../src/plugins/slots.ts";
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

type MemoryBackend = "builtin" | "qmd";

/** One installed plugin that can claim the exclusive `plugins.slots.memory` slot. */
export type MemoryEngineOption = {
  id: string;
  label: string;
};

/**
 * Enablement as the page actually knows it, shared by the engine row and the
 * add-on rows. `loading` and `unknown` exist so a catalog that was never read
 * cannot render as a definite "Disabled"; only a successful read decides.
 */
export type MemoryPluginState = "enabled" | "disabled" | "loading" | "unknown";

/** Additive memory plugin: no `kind`, so it layers on top of whichever engine wins the slot. */
export type MemoryAddonRow = {
  id: string;
  label: string;
  description: string;
  state: MemoryPluginState;
};

/**
 * How `plugins.slots.memory` reads today, mirroring resolveSlotSelection in
 * src/plugins/slots.ts. `off` is the explicit `none` sentinel; `auto` is an
 * unset slot, which always resolves to the slot's default owner rather than to
 * whichever memory plugin happens to be enabled.
 */
export type MemoryEngineSelection =
  | { kind: "auto"; engineId: string }
  | { kind: "off" }
  | { kind: "pinned"; engineId: string };

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
  /** Last failed engine write, so a rejected change is not just a snap-back. */
  engineError: string | null;
  onEngineChange: (engineId: string | null) => void;
  /** null when the slot owner runs its own retrieval, so this row does not apply. */
  backend: MemoryBackend | null;
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

const MEMORY_PANEL_ID = "memory-settings-panel";

/** Scroll target for `memory.backend`, which Overview curates out of the editor. */
export const MEMORY_BACKEND_ANCHOR_ID = "memory-backend";

const MEMORY_TABS: readonly MemoryTab[] = ["overview", "search", "dreaming"];

/** Reads a `?tab=` value from a settings-search destination or a shared link. */
export function normalizeMemoryTab(value: string | null | undefined): MemoryTab | null {
  return MEMORY_TABS.find((tab) => tab === value) ?? null;
}

const MEMORY_ENGINE_OFF = "";

/** The plugin that currently owns the slot, or null when nothing does. */
export function selectedEngineId(selection: MemoryEngineSelection): string | null {
  return selection.kind === "off" ? null : selection.engineId;
}

// memory-core is the only plugin registering the memory runtime that resolves
// `memory.backend`, so any other engine hides the backend row. This is a
// runtime-ownership fact, not the slot default; the slot comes from
// resolveSlotSelection.
const MEMORY_CORE_PLUGIN_ID = "memory-core";

/**
 * Mirrors the runtime exactly: resolveSlotSelection owns the rule, so an unset
 * slot reports the slot's default owner instead of guessing from the catalog.
 */
export function resolveMemoryEngineSelection(
  configObject: Record<string, unknown>,
): MemoryEngineSelection {
  const slots = asConfigRecord(asConfigRecord(configObject.plugins)?.slots);
  const selection = resolveSlotSelection("memory", slots?.memory);
  switch (selection.kind) {
    case "off":
      return { kind: "off" };
    case "pinned":
      return { kind: "pinned", engineId: selection.pluginId };
    default:
      return { kind: "auto", engineId: selection.pluginId };
  }
}

/**
 * The retrieval backend the page shows, or null when the slot owner runs its own
 * retrieval and `memory.backend` would save a value nothing consumes. Settings
 * search resolves it from the same config so both agree on what is visible.
 */
export function resolveMemoryBackend(configObject: Record<string, unknown>): MemoryBackend | null {
  if (selectedEngineId(resolveMemoryEngineSelection(configObject)) !== MEMORY_CORE_PLUGIN_ID) {
    return null;
  }
  return asConfigRecord(configObject.memory)?.backend === "qmd" ? "qmd" : "builtin";
}

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
  if (props.engineOptions.length === 0) {
    return renderSettingsSection(
      { title: t("memoryPage.engine.title"), description: t("memoryPage.engine.description") },
      renderSettingsRow({
        title: t("memoryPage.engine.rowTitle"),
        description: t("memoryPage.engine.catalogUnavailable"),
        control: renderSettingsValue(engineId ?? t("memoryPage.engine.off"), {
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
        description: t(engineHintKey(props.engineSelection)),
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
      ${props.engineError === null
        ? nothing
        : renderSettingsRow({
            title: t("memoryPage.engine.changeFailed"),
            description: props.engineError,
            control: renderSettingsStatus({ kind: "danger", label: t("common.failed") }),
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

function renderBackendSection(props: MemoryViewProps) {
  // builtin/qmd is resolved by the memory runtime the slot owner registers
  // (resolveActiveMemoryBackendConfig in src/plugins/memory-runtime.ts). An
  // engine that registers none ignores it, so the row must not appear there.
  if (props.backend === null) {
    return nothing;
  }
  // Anchor target for settings search: `backend` is curated out of the schema
  // editor, so it has no `#config-section-*` id of its own to scroll to.
  return html`<div id=${MEMORY_BACKEND_ANCHOR_ID}>
    ${renderSettingsSection(
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
    )}
  </div>`;
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
      ${props.addons.map((addon) =>
        renderSettingsRow({
          title: addon.label,
          description: addon.description,
          control: renderAddonStatus(addon.state),
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

/**
 * The `memory.*` children only the Search tab renders; every other child of the
 * section belongs to Overview. Settings search routes deep links through this so
 * a match cannot land on a tab whose editor omits the field it matched.
 */
export const MEMORY_SEARCH_TAB_SCHEMA_KEYS: readonly string[] = ["search"];

/**
 * The `memory.*` children Overview renders as curated rows instead of through
 * the embedded editor. They have no `#config-section-*` id, so settings search
 * routes their deep links to MEMORY_BACKEND_ANCHOR_ID.
 */
export const MEMORY_CURATED_SCHEMA_KEYS: readonly string[] = ["backend"];

/** Which `memory.*` children the embedded editor shows for a tab. */
export function memorySchemaKeysForTab(
  tab: MemoryTab,
  backend: MemoryBackend | null,
): readonly string[] {
  if (tab === "search") {
    return MEMORY_SEARCH_TAB_SCHEMA_KEYS;
  }
  // `backend` is a curated row above the editor; qmd's sub-config only matters
  // once qmd is the selected backend.
  return backend === "qmd" ? ["citations", "qmd"] : ["citations"];
}

/**
 * Every `memory.*` child the page surfaces for a config: both editor slices plus
 * `backend`, which Overview renders as a curated row rather than through the
 * editor. `qmd` and `backend` disappear with the backend/engine choice, so
 * settings search filters the section through this before matching — otherwise a
 * `memory.qmd` hit routes to an Overview whose editor omits it.
 */
export function memoryVisibleSchemaKeys(backend: MemoryBackend | null): readonly string[] {
  const editor = [...MEMORY_SEARCH_TAB_SCHEMA_KEYS, ...memorySchemaKeysForTab("overview", backend)];
  return backend === null ? editor : [...editor, "backend"];
}
