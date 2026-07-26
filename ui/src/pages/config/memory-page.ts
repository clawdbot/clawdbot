// Controller for the curated Memory settings page. Owns tab state, the plugin
// catalog read used for the exclusive engine choice, and the two config writes
// that live above the embedded schema editor.
import { consume } from "@lit/context";
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import { html, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
import { resolveSlotSelection } from "../../../../src/plugins/slots.ts";
import { applicationContext, type ApplicationContext } from "../../app/context.ts";
import { t } from "../../i18n/index.ts";
import {
  loadPluginCatalog,
  setPluginEnabled,
  type PluginCatalogItem,
} from "../../lib/plugins/index.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import "./memory-dreaming-page.ts";
import {
  memorySchemaKeysForTab,
  renderMemory,
  selectedEngineId,
  type MemoryAddonRow,
  type MemoryBackend,
  type MemoryEngineOption,
  type MemoryEngineSelection,
  type MemoryTab,
} from "./memory.ts";

// Curated presentation list. These bundled plugins declare no manifest `kind`,
// so nothing in plugin metadata marks them as memory add-ons; the exclusive
// engine below is still resolved through `plugins.slots.memory`, never by id.
const MEMORY_ADDON_PLUGINS = [
  { id: "active-memory", labelKey: "memoryPage.addons.activeMemory.title" },
  { id: "memory-wiki", labelKey: "memoryPage.addons.memoryWiki.title" },
] as const;

// memory-core is the only plugin registering the memory runtime that resolves
// `memory.backend`, so any other engine hides the backend row. This is a
// runtime-ownership fact, not the slot default; the slot comes from
// resolveSlotSelection.
const MEMORY_CORE_PLUGIN_ID = "memory-core";

/** Explicit-off sentinel; resolveSlotSelection maps it to an `off` selection. */
const MEMORY_SLOT_OFF = "none";

const MEMORY_SLOT_PATH = ["plugins", "slots", "memory"];

type MemoryPageProps = {
  configObject: Record<string, unknown>;
  pluginsHref: string;
  memoryImportHref: string;
  /** Tab requested via `?tab=`, so a settings-search hit opens where it matched. */
  initialTab: MemoryTab | null;
  /** Builds the embedded schema editor over the given `memory.*` children. */
  buildEditor: (keys: readonly string[]) => TemplateResult;
};

function resolveBackend(configObject: Record<string, unknown>): MemoryBackend {
  return asConfigRecord(configObject.memory)?.backend === "qmd" ? "qmd" : "builtin";
}

function isMemoryEngine(plugin: PluginCatalogItem): boolean {
  return plugin.installed && plugin.kind?.includes("memory") === true;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

class MemorySettingsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) configObject: Record<string, unknown> = {};
  @property() pluginsHref = "";
  @property() memoryImportHref = "";
  @property({ attribute: false }) initialTab: MemoryTab | null = null;
  @property({ attribute: false }) buildEditor: MemoryPageProps["buildEditor"] = () => html``;

  @state() private activeTab: MemoryTab = "overview";
  @state() private catalog: readonly PluginCatalogItem[] = [];
  @state() private engineBusy = false;
  @state() private engineError: string | null = null;

  private adoptedTab: MemoryTab | null = null;

  private catalogClient: ApplicationContext["gateway"]["snapshot"]["client"] = null;
  private catalogConnected = false;
  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.gateway,
    (gateway, notify) => gateway.subscribe(notify),
    (gateway) => this.syncCatalog(gateway.snapshot.client, gateway.snapshot.phase === "connected"),
  );

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.catalogClient = null;
    this.catalogConnected = false;
    this.catalog = [];
    this.adoptedTab = null;
    super.disconnectedCallback();
  }

  // `?tab=` is navigation intent, not state: adopt each distinct value once so a
  // settings-search hit opens its tab while later manual tab clicks still stick.
  override willUpdate() {
    if (this.initialTab && this.initialTab !== this.adoptedTab) {
      this.adoptedTab = this.initialTab;
      this.activeTab = this.initialTab;
    }
  }

  private syncCatalog(
    client: ApplicationContext["gateway"]["snapshot"]["client"],
    connected: boolean,
  ) {
    // The connecting -> connected transition keeps the same client object, so
    // keying only on client identity would strand the catalog empty for a page
    // mounted before the handshake finished.
    if (client === this.catalogClient && connected === this.catalogConnected) {
      return;
    }
    this.catalogClient = client;
    this.catalogConnected = connected;
    this.catalog = [];
    if (client && connected) {
      void this.loadCatalog(client);
    }
  }

  private async loadCatalog(
    client: NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>,
  ) {
    try {
      const result = await loadPluginCatalog(client);
      if (this.isConnected && this.catalogClient === client) {
        this.catalog = result.plugins;
      }
    } catch {
      // The catalog is a convenience for the engine picker; the page still
      // renders the configured slot id when it cannot be read.
      if (this.isConnected && this.catalogClient === client) {
        this.catalog = [];
      }
    }
  }

  private engineOptions(): MemoryEngineOption[] {
    return this.catalog
      .filter(isMemoryEngine)
      .map((plugin) => ({ id: plugin.id, label: plugin.name }))
      .toSorted((left, right) => left.label.localeCompare(right.label));
  }

  /**
   * Mirrors the runtime exactly: resolveSlotSelection owns the rule, so an unset
   * slot reports the slot's default owner instead of guessing from the catalog.
   */
  private engineSelection(): MemoryEngineSelection {
    const slots = asConfigRecord(asConfigRecord(this.configObject.plugins)?.slots);
    const selection = resolveSlotSelection("memory", slots?.memory);
    switch (selection.kind) {
      case "off":
        return { kind: "off" };
      case "pinned":
        return { kind: "pinned", engineId: selection.pluginId };
      case "default":
        return { kind: "auto", engineId: selection.pluginId };
    }
  }

  private addonRows(): MemoryAddonRow[] {
    return MEMORY_ADDON_PLUGINS.map((addon) => {
      const entry = this.catalog.find((plugin) => plugin.id === addon.id);
      return {
        id: addon.id,
        label: t(addon.labelKey),
        description: entry?.description ?? addon.id,
        enabled: entry?.enabled === true,
      };
    });
  }

  /**
   * Picking an engine goes through plugins.setEnabled so the gateway's exclusive
   * slot policy (applySlotSelectionForPlugin) stays the single owner of pinning.
   * That RPC only writes plugin enablement, so Off has to write the slot itself:
   * disabling the current owner would leave a pinned slot behind, and re-enabling
   * that plugin anywhere else would silently switch memory back on.
   */
  private async changeEngine(engineId: string | null, currentSelection: MemoryEngineSelection) {
    const client = this.context.gateway.snapshot.client;
    if (this.engineBusy || engineId === selectedEngineId(currentSelection)) {
      return;
    }
    if (!engineId) {
      this.engineError = null;
      this.context.runtimeConfig.patchForm(MEMORY_SLOT_PATH, MEMORY_SLOT_OFF);
      return;
    }
    if (!client) {
      return;
    }
    this.engineBusy = true;
    this.engineError = null;
    try {
      await setPluginEnabled(client, engineId, true);
      await this.context.runtimeConfig.refresh();
      if (this.isConnected && this.catalogClient === client) {
        await this.loadCatalog(client);
      }
    } catch (error) {
      // Without this the selector just snaps back to the old engine and the
      // operator has no idea the gateway rejected the change.
      this.engineError = errorMessage(error);
    } finally {
      this.engineBusy = false;
    }
  }

  override render() {
    const runtimeConfig = this.context.runtimeConfig;
    const options = this.engineOptions();
    const engineSelection = this.engineSelection();
    const engineId = selectedEngineId(engineSelection);
    // Only memory-core's runtime reads memory.backend; under another engine the
    // row would save a value nothing consumes.
    const backend = engineId === MEMORY_CORE_PLUGIN_ID ? resolveBackend(this.configObject) : null;
    return renderMemory({
      activeTab: this.activeTab,
      onTabChange: (tab) => {
        this.activeTab = tab;
      },
      engineOptions: options,
      engineSelection,
      engineBusy: this.engineBusy,
      engineError: this.engineError,
      onEngineChange: (nextEngineId) => void this.changeEngine(nextEngineId, engineSelection),
      backend,
      backendBusy: runtimeConfig.state.configSaving || runtimeConfig.state.configApplying,
      onBackendChange: (next) => runtimeConfig.patchForm(["memory", "backend"], next),
      addons: this.addonRows(),
      pluginsHref: this.pluginsHref,
      memoryImportHref: this.memoryImportHref,
      editor: this.buildEditor(memorySchemaKeysForTab(this.activeTab, backend)),
      dreaming: html`<openclaw-memory-dreaming></openclaw-memory-dreaming>`,
    });
  }
}

if (!customElements.get("openclaw-memory-settings")) {
  customElements.define("openclaw-memory-settings", MemorySettingsPage);
}

export function renderMemoryPage(props: MemoryPageProps) {
  return html`
    <openclaw-memory-settings
      .configObject=${props.configObject}
      .pluginsHref=${props.pluginsHref}
      .memoryImportHref=${props.memoryImportHref}
      .initialTab=${props.initialTab}
      .buildEditor=${props.buildEditor}
    ></openclaw-memory-settings>
  `;
}
