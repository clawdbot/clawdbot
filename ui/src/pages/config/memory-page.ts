// Controller for the curated Memory settings page. Owns the plugin catalog read
// used for the exclusive engine choice and the two config writes above the
// embedded schema editor; the tab lives in the URL, not here.
import { consume } from "@lit/context";
import { html, type TemplateResult } from "lit";
import { property, state } from "lit/decorators.js";
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
  resolveMemoryBackend,
  resolveMemoryEngineSelection,
  selectedEngineId,
  type MemoryEngineSelection,
  type MemoryTab,
} from "./memory-schema.ts";
import {
  renderMemory,
  type MemoryAddonRow,
  type MemoryEngineOption,
  type MemoryPluginState,
} from "./memory.ts";

// Curated presentation list. These bundled plugins declare no manifest `kind`,
// so nothing in plugin metadata marks them as memory add-ons; the exclusive
// engine below is still resolved through `plugins.slots.memory`, never by id.
const MEMORY_ADDON_PLUGINS = [
  { id: "active-memory", labelKey: "memoryPage.addons.activeMemory.title" },
  { id: "memory-wiki", labelKey: "memoryPage.addons.memoryWiki.title" },
] as const;

/** Explicit-off sentinel; resolveSlotSelection maps it to an `off` selection. */
const MEMORY_SLOT_OFF = "none";

const MEMORY_SLOT_PATH = ["plugins", "slots", "memory"];

type GatewayClient = NonNullable<ApplicationContext["gateway"]["snapshot"]["client"]>;

/**
 * One gateway connection phase. `syncCatalog` mints a fresh object per (client,
 * connected) transition and an in-flight load carries it, so the object identity
 * is the request generation: a completion that started under an older phase is
 * dropped instead of repopulating a disconnected page or clobbering a newer read.
 */
type CatalogConnection = {
  client: GatewayClient | null;
  connected: boolean;
};

/**
 * What the page knows about the plugin catalog. Absence of an entry only means
 * "not enabled" inside `ready`; every other state is genuinely unknown and must
 * not be rendered as a decided value.
 */
type MemoryCatalog =
  | { kind: "loading" }
  | { kind: "unavailable" }
  | { kind: "ready"; plugins: readonly PluginCatalogItem[] };

type MemoryPageProps = {
  configObject: Record<string, unknown>;
  pluginsHref: string;
  memoryImportHref: string;
  /** The `?tab=` the URL currently describes; the page holds no tab state of its own. */
  tab: MemoryTab | null;
  /** Builds the embedded schema editor over the given `memory.*` children. */
  buildEditor: (keys: readonly string[]) => TemplateResult;
};

function isMemoryEngine(plugin: PluginCatalogItem): boolean {
  return plugin.installed && plugin.kind?.includes("memory") === true;
}

function pluginState(
  catalog: MemoryCatalog,
  entry: PluginCatalogItem | undefined,
): MemoryPluginState {
  switch (catalog.kind) {
    case "loading":
      return "loading";
    case "unavailable":
      return "unknown";
    default:
      return entry?.enabled === true ? "enabled" : "disabled";
  }
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
  @property({ attribute: false }) tab: MemoryTab | null = null;
  @property({ attribute: false }) buildEditor: MemoryPageProps["buildEditor"] = () => html``;

  @state() private catalog: MemoryCatalog = { kind: "unavailable" };
  @state() private engineBusy = false;
  @state() private engineError: string | null = null;

  private connection: CatalogConnection | null = null;
  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.gateway,
    (gateway, notify) => gateway.subscribe(notify),
    (gateway) => this.syncCatalog(gateway.snapshot.client, gateway.snapshot.phase === "connected"),
  );

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.connection = null;
    this.catalog = { kind: "unavailable" };
    super.disconnectedCallback();
  }

  private syncCatalog(client: GatewayClient | null, connected: boolean) {
    // The connecting -> connected transition keeps the same client object, so
    // keying only on client identity would strand the catalog empty for a page
    // mounted before the handshake finished.
    if (this.connection?.client === client && this.connection.connected === connected) {
      return;
    }
    const connection: CatalogConnection = { client, connected };
    this.connection = connection;
    if (!client || !connected) {
      this.catalog = { kind: "unavailable" };
      return;
    }
    this.catalog = { kind: "loading" };
    void this.loadCatalog(client, connection);
  }

  private async loadCatalog(client: GatewayClient, connection: CatalogConnection) {
    try {
      const result = await loadPluginCatalog(client);
      this.applyCatalog(connection, { kind: "ready", plugins: result.plugins });
    } catch {
      // The catalog is a convenience for the engine picker; the page still
      // renders the configured slot id when it cannot be read.
      this.applyCatalog(connection, { kind: "unavailable" });
    }
  }

  private applyCatalog(connection: CatalogConnection, catalog: MemoryCatalog) {
    if (!this.isConnected || this.connection !== connection) {
      return;
    }
    this.catalog = catalog;
  }

  private engineOptions(): MemoryEngineOption[] {
    if (this.catalog.kind !== "ready") {
      return [];
    }
    return this.catalog.plugins
      .filter(isMemoryEngine)
      .map((plugin) => ({ id: plugin.id, label: plugin.name }))
      .toSorted((left, right) => left.label.localeCompare(right.label));
  }

  /** Catalog verdict on the plugin the slot names; `off` has no owner to report. */
  private engineState(selection: MemoryEngineSelection): MemoryPluginState {
    const engineId = selectedEngineId(selection);
    if (engineId === null) {
      return "unknown";
    }
    const catalog = this.catalog;
    const entry =
      catalog.kind === "ready"
        ? catalog.plugins.find((plugin) => plugin.id === engineId)
        : undefined;
    return pluginState(catalog, entry);
  }

  private addonRows(): MemoryAddonRow[] {
    const catalog = this.catalog;
    return MEMORY_ADDON_PLUGINS.map((addon) => {
      const entry =
        catalog.kind === "ready"
          ? catalog.plugins.find((plugin) => plugin.id === addon.id)
          : undefined;
      return {
        id: addon.id,
        label: t(addon.labelKey),
        description: entry?.description ?? addon.id,
        state: pluginState(catalog, entry),
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
    if (this.engineBusy) {
      return;
    }
    // Re-picking the current selection is a no-op only when it is already in
    // effect: Off always is, but a named owner the catalog reports as disabled
    // is not, and re-picking it is the one path that turns it back on.
    if (engineId === selectedEngineId(currentSelection)) {
      if (engineId === null || this.engineState(currentSelection) === "enabled") {
        return;
      }
    }
    if (!engineId) {
      this.engineError = null;
      this.context.runtimeConfig.patchForm(MEMORY_SLOT_PATH, MEMORY_SLOT_OFF);
      return;
    }
    const connection = this.connection;
    const client = connection?.connected ? connection.client : null;
    if (!connection || !client) {
      return;
    }
    this.engineBusy = true;
    this.engineError = null;
    try {
      await setPluginEnabled(client, engineId, true);
      await this.context.runtimeConfig.refresh();
      // Reuses the same generation guard: a connection change mid-write drops
      // the reload instead of writing a catalog the page no longer owns.
      await this.loadCatalog(client, connection);
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
    const engineSelection = resolveMemoryEngineSelection(this.configObject);
    const backend = resolveMemoryBackend(this.configObject);
    const activeTab = this.tab ?? "overview";
    return renderMemory({
      activeTab,
      // The URL is the only tab state, so every arrival honors its `?tab=` —
      // including a repeat of one the user has since navigated away from — and
      // history back/forward restores the tab the URL describes.
      onTabChange: (tab) => {
        this.context.navigate("memory", tab === "overview" ? undefined : { search: `?tab=${tab}` });
      },
      engineOptions: options,
      engineSelection,
      engineState: this.engineState(engineSelection),
      engineBusy: this.engineBusy,
      engineError: this.engineError,
      onEngineChange: (nextEngineId) => void this.changeEngine(nextEngineId, engineSelection),
      backend,
      backendBusy: runtimeConfig.state.configSaving || runtimeConfig.state.configApplying,
      onBackendChange: (next) => runtimeConfig.patchForm(["memory", "backend"], next),
      addons: this.addonRows(),
      pluginsHref: this.pluginsHref,
      memoryImportHref: this.memoryImportHref,
      editor: this.buildEditor(memorySchemaKeysForTab(activeTab, backend)),
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
      .tab=${props.tab}
      .buildEditor=${props.buildEditor}
    ></openclaw-memory-settings>
  `;
}
