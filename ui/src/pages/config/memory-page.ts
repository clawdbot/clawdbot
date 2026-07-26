// Controller for the curated Memory settings page. Owns tab state, the plugin
// catalog read used for the exclusive engine choice, and the two config writes
// that live above the embedded schema editor.
import { consume } from "@lit/context";
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
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
import "./memory-dreaming.ts";
import {
  memorySchemaKeysForTab,
  renderMemory,
  type MemoryAddonRow,
  type MemoryBackend,
  type MemoryEngineOption,
  type MemoryTab,
} from "./memory.ts";

// Curated presentation list. These bundled plugins declare no manifest `kind`,
// so nothing in plugin metadata marks them as memory add-ons; the exclusive
// engine below is still resolved through `plugins.slots.memory`, never by id.
const MEMORY_ADDON_PLUGINS = [
  { id: "active-memory", labelKey: "memoryPage.addons.activeMemory.title" },
  { id: "memory-wiki", labelKey: "memoryPage.addons.memoryWiki.title" },
] as const;

// Mirrors DEFAULT_SLOT_BY_KEY in src/plugins/slots.ts: an unset slot resolves to
// memory-core, so the picker must show that instead of "off".
const IMPLICIT_MEMORY_SLOT_ID = "memory-core";

type MemoryPageProps = {
  configObject: Record<string, unknown>;
  pluginsHref: string;
  memoryImportHref: string;
  /** Builds the embedded schema editor over the given `memory.*` children. */
  buildEditor: (keys: readonly string[]) => TemplateResult;
};

function resolveBackend(configObject: Record<string, unknown>): MemoryBackend {
  return asConfigRecord(configObject.memory)?.backend === "qmd" ? "qmd" : "builtin";
}

function resolveConfiguredSlotId(configObject: Record<string, unknown>): string | null {
  const slots = asConfigRecord(asConfigRecord(configObject.plugins)?.slots);
  const configured = typeof slots?.memory === "string" ? slots.memory.trim() : "";
  return configured.length > 0 ? configured : null;
}

function isMemoryEngine(plugin: PluginCatalogItem): boolean {
  return plugin.installed && plugin.kind?.includes("memory") === true;
}

class MemorySettingsPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: false }) configObject: Record<string, unknown> = {};
  @property() pluginsHref = "";
  @property() memoryImportHref = "";
  @property({ attribute: false }) buildEditor: MemoryPageProps["buildEditor"] = () => html``;

  @state() private activeTab: MemoryTab = "overview";
  @state() private catalog: readonly PluginCatalogItem[] = [];
  @state() private engineBusy = false;

  private catalogClient: ApplicationContext["gateway"]["snapshot"]["client"] = null;
  private readonly subscriptions = new SubscriptionsController(this).watch(
    () => this.context?.gateway,
    (gateway, notify) => gateway.subscribe(notify),
    (gateway) => this.syncCatalog(gateway.snapshot.client, gateway.snapshot.phase === "connected"),
  );

  override disconnectedCallback() {
    this.subscriptions.clear();
    this.catalogClient = null;
    this.catalog = [];
    super.disconnectedCallback();
  }

  private syncCatalog(
    client: ApplicationContext["gateway"]["snapshot"]["client"],
    connected: boolean,
  ) {
    if (client === this.catalogClient) {
      return;
    }
    this.catalogClient = client;
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

  private selectedEngineId(options: readonly MemoryEngineOption[]): string | null {
    const configured = resolveConfiguredSlotId(this.configObject);
    if (configured) {
      return configured;
    }
    // No explicit slot: the first enabled memory-kind plugin owns it.
    const enabled = this.catalog.find((plugin) => isMemoryEngine(plugin) && plugin.enabled);
    if (enabled) {
      return enabled.id;
    }
    // Only a readable catalog proves the slot is empty; without one, report the
    // implicit default rather than claiming memory is switched off.
    return options.length === 0 ? IMPLICIT_MEMORY_SLOT_ID : null;
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
   * Engine selection goes through plugins.setEnabled so the gateway's exclusive
   * slot policy (applySlotSelectionForPlugin) stays the single owner; writing
   * plugins.slots.memory from here would duplicate that policy in the UI.
   */
  private async changeEngine(engineId: string | null, currentEngineId: string | null) {
    const client = this.context.gateway.snapshot.client;
    if (!client || this.engineBusy || engineId === currentEngineId) {
      return;
    }
    this.engineBusy = true;
    try {
      if (engineId) {
        await setPluginEnabled(client, engineId, true);
      } else if (currentEngineId) {
        await setPluginEnabled(client, currentEngineId, false);
      }
      await this.context.runtimeConfig.refresh();
      if (this.isConnected && this.catalogClient === client) {
        await this.loadCatalog(client);
      }
    } catch {
      // Failures surface through the plugin catalog state on next refresh; the
      // page must not wedge its control in a busy state.
    } finally {
      this.engineBusy = false;
    }
  }

  override render() {
    const runtimeConfig = this.context.runtimeConfig;
    const backend = resolveBackend(this.configObject);
    const options = this.engineOptions();
    const selectedEngineId = this.selectedEngineId(options);
    return renderMemory({
      activeTab: this.activeTab,
      onTabChange: (tab) => {
        this.activeTab = tab;
      },
      engineOptions: options,
      selectedEngineId,
      engineAuto: resolveConfiguredSlotId(this.configObject) === null,
      engineBusy: this.engineBusy,
      onEngineChange: (engineId) => void this.changeEngine(engineId, selectedEngineId),
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
      .buildEditor=${props.buildEditor}
    ></openclaw-memory-settings>
  `;
}
