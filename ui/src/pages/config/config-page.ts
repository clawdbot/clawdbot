import { consume } from "@lit/context";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type { SystemInfoResult } from "../../../../packages/gateway-protocol/src/index.js";
import { GatewayRequestError, type GatewayBrowserClient } from "../../api/gateway.ts";
import type { FastMode } from "../../api/types.ts";
import { pathForRoute, type RouteId } from "../../app-route-paths.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { importCustomThemeFromUrl } from "../../app/custom-theme.ts";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import {
  loadSettings,
  normalizeTextScale,
  patchSettings,
  type UiSettings,
} from "../../app/settings.ts";
import { startThemeTransition } from "../../app/theme-transition.ts";
import { resolveTheme, type ThemeMode, type ThemeName } from "../../app/theme.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { i18n, isSupportedLocale, t, type Locale } from "../../i18n/index.ts";
import { isMissingOperatorReadScopeError } from "../../lib/gateway-errors.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import { renderMcp } from "./mcp.ts";
import {
  renderQuickSettings,
  type QuickSettingsChannel,
  type QuickSettingsSecurity,
} from "./quick.ts";
import {
  createConfigViewState,
  renderConfig,
  type ConfigProps,
  type ConfigViewState,
} from "./view.ts";

export type ConfigPageId =
  | "config"
  | "communications"
  | "appearance"
  | "automation"
  | "mcp"
  | "infrastructure"
  | "ai-agents";

type ConfigFormMode = "form" | "raw";
type ConfigSelection = { activeSection: string | null; activeSubsection: string | null };

const CONFIG_PAGE_I18N_KEYS = {
  config: "config",
  communications: "communications",
  appearance: "appearance",
  automation: "automation",
  mcp: "mcp",
  infrastructure: "infrastructure",
  "ai-agents": "aiAgents",
} as const satisfies Record<ConfigPageId, string>;

const COMMUNICATION_SECTION_KEYS = [
  "messages",
  "broadcast",
  "__notifications__",
  "talk",
  "audio",
  "channels",
] as const;
const APPEARANCE_SECTION_KEYS = ["__appearance__", "ui", "wizard"] as const;
const AUTOMATION_SECTION_KEYS = ["commands", "hooks", "bindings", "cron", "approvals", "plugins"];
const INFRASTRUCTURE_SECTION_KEYS = [
  "gateway",
  "web",
  "browser",
  "nodeHost",
  "canvasHost",
  "discovery",
  "media",
  "acp",
  "mcp",
] as const;
const AI_AGENTS_SECTION_KEYS = [
  "agents",
  "models",
  "skills",
  "tools",
  "memory",
  "session",
] as const;
const SCOPED_CONFIG_SECTION_KEYS = new Set<string>([
  ...COMMUNICATION_SECTION_KEYS,
  ...APPEARANCE_SECTION_KEYS,
  ...AUTOMATION_SECTION_KEYS,
  ...INFRASTRUCTURE_SECTION_KEYS,
  ...AI_AGENTS_SECTION_KEYS,
]);
const KNOWN_CHANNELS = [
  { id: "telegram", label: "Telegram" },
  { id: "discord", label: "Discord" },
  { id: "slack", label: "Slack" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "signal", label: "Signal" },
  { id: "imessage", label: "iMessage" },
] as const;

const SYSTEM_INFO_POLL_INTERVAL_MS = 10_000;

function isUnknownSystemInfoMethodError(error: unknown): boolean {
  return (
    error instanceof GatewayRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message.includes("unknown method: system.info")
  );
}

export function supportsSystemInfo(hello: ApplicationGatewaySnapshot["hello"]): boolean {
  return hello?.features?.methods?.includes("system.info") === true;
}

function defaultConfigSelection(pageId: ConfigPageId): ConfigSelection {
  switch (pageId) {
    case "communications":
      return { activeSection: "messages", activeSubsection: null };
    case "appearance":
      return { activeSection: "__appearance__", activeSubsection: null };
    case "automation":
      return { activeSection: "commands", activeSubsection: null };
    case "mcp":
      return { activeSection: "mcp", activeSubsection: null };
    case "infrastructure":
      return { activeSection: "gateway", activeSubsection: null };
    case "ai-agents":
      return { activeSection: "agents", activeSubsection: null };
    case "config":
      return { activeSection: null, activeSubsection: null };
  }
  throw new Error("Unknown config page");
}

function asConfigRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeConfigSelection(
  pageId: ConfigPageId,
  activeSection: string | null,
  activeSubsection: string | null,
): ConfigSelection {
  const sections: readonly string[] | null =
    pageId === "communications"
      ? COMMUNICATION_SECTION_KEYS
      : pageId === "appearance"
        ? APPEARANCE_SECTION_KEYS
        : pageId === "automation"
          ? AUTOMATION_SECTION_KEYS
          : pageId === "mcp" || pageId === "infrastructure"
            ? INFRASTRUCTURE_SECTION_KEYS
            : pageId === "ai-agents"
              ? AI_AGENTS_SECTION_KEYS
              : null;
  if (pageId === "config" && activeSection && SCOPED_CONFIG_SECTION_KEYS.has(activeSection)) {
    return { activeSection: null, activeSubsection: null };
  }
  if (sections && (!activeSection || !sections.includes(activeSection))) {
    return defaultConfigSelection(pageId);
  }
  return { activeSection, activeSubsection };
}

export function configSelectionFromSearch(pageId: ConfigPageId, search: string): ConfigSelection {
  const section = new URLSearchParams(search).get("section");
  if (!section) {
    return defaultConfigSelection(pageId);
  }
  return normalizeConfigSelection(pageId, section, null);
}

function configPageTitle(pageId: ConfigPageId): string {
  // The takeover sidebar is titled "Settings"; the general page header reads
  // like its sibling sections instead of repeating it.
  return pageId === "config"
    ? t("nav.settingsGeneral")
    : t(`tabs.${CONFIG_PAGE_I18N_KEYS[pageId]}`);
}

function configPageSubtitle(pageId: ConfigPageId): string {
  return t(`subtitles.${CONFIG_PAGE_I18N_KEYS[pageId]}`);
}

function mcpServerCount(config: unknown): number {
  const servers = asConfigRecord(asConfigRecord(config)?.mcp)?.servers;
  return servers && typeof servers === "object" && !Array.isArray(servers)
    ? Object.keys(servers).length
    : 0;
}

function quickChannels(config: unknown): QuickSettingsChannel[] {
  const configured = asConfigRecord(asConfigRecord(config)?.channels) ?? {};
  const configuredIds = Object.keys(configured).filter((id) => id.trim().length > 0);
  const channelIds =
    configuredIds.length > 0
      ? configuredIds.toSorted((left, right) => left.localeCompare(right))
      : KNOWN_CHANNELS.map(({ id }) => id);
  const labels = new Map<string, string>(KNOWN_CHANNELS.map(({ id, label }) => [id, label]));
  return channelIds.map((id) => {
    const value = configured[id];
    const connected = Boolean(value && typeof value === "object" && Object.keys(value).length);
    return {
      id,
      label:
        labels.get(id) ??
        id.replace(/[-_]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase()),
      connected,
      detail: connected ? "Configured" : undefined,
    };
  });
}

function extractQuickSettingsSecurity(config: unknown): QuickSettingsSecurity {
  const root =
    asConfigRecord((config as { configForm?: unknown } | null)?.configForm) ??
    asConfigRecord(config);
  if (!root) {
    return {
      gatewayAuth: "unknown",
      execPolicy: "unknown",
      deviceAuth: false,
      browserEnabled: true,
      toolProfile: "full",
    };
  }
  const gateway = asConfigRecord(root.gateway);
  const auth = asConfigRecord(gateway?.auth);
  const tools = asConfigRecord(root.tools) ?? {};
  const exec = asConfigRecord(tools.exec) ?? {};
  const browser = asConfigRecord(root.browser);
  const controlUi = asConfigRecord(gateway?.controlUi);
  let gatewayAuth = "unknown";
  if (auth) {
    const mode = typeof auth.mode === "string" ? auth.mode.trim() : "";
    gatewayAuth = mode
      ? mode
      : auth.password
        ? "password"
        : auth.token
          ? "token"
          : auth.trustedProxy
            ? "trusted-proxy"
            : "none";
  }
  const profile = tools.profile;
  const security = exec.security;
  return {
    gatewayAuth,
    execPolicy: typeof security === "string" && security.trim() ? security.trim() : "allowlist",
    deviceAuth: controlUi?.dangerouslyDisableDeviceAuth !== true,
    browserEnabled: browser?.enabled !== false,
    toolProfile: typeof profile === "string" && profile.trim() ? profile.trim() : "full",
  };
}

function applyTextScale(value: unknown) {
  if (typeof document === "undefined") {
    return;
  }
  document.documentElement.style.setProperty(
    "--control-ui-text-scale",
    (normalizeTextScale(value) / 100).toFixed(2),
  );
}

export class ConfigPage extends OpenClawLightDomElement {
  @consume({ context: applicationContext, subscribe: true })
  private context!: ApplicationContext;

  @property({ attribute: "page-id" }) pageId: ConfigPageId = "config";

  @state() private settings = loadSettings();
  @state() private settingsMode: "quick" | "advanced" = "quick";
  @state() private systemInfo: SystemInfoResult | null = null;
  @state() private systemInfoUnavailable = false;
  @state() private formModes: Record<ConfigPageId, ConfigFormMode> = {
    config: "form",
    communications: "form",
    appearance: "form",
    automation: "form",
    mcp: "form",
    infrastructure: "form",
    "ai-agents": "form",
  };
  @state() private searchQueries: Record<ConfigPageId, string> = {
    config: "",
    communications: "",
    appearance: "",
    automation: "",
    mcp: "",
    infrastructure: "",
    "ai-agents": "",
  };
  @state() private selections: Record<ConfigPageId, ConfigSelection> = {
    config: defaultConfigSelection("config"),
    communications: defaultConfigSelection("communications"),
    appearance: defaultConfigSelection("appearance"),
    automation: defaultConfigSelection("automation"),
    mcp: defaultConfigSelection("mcp"),
    infrastructure: defaultConfigSelection("infrastructure"),
    "ai-agents": defaultConfigSelection("ai-agents"),
  };
  @state() private customThemeImportUrl = "";
  @state() private customThemeImportBusy = false;
  @state() private customThemeImportMessage: { kind: "success" | "error"; text: string } | null =
    null;
  @state() private customThemeImportExpanded = false;
  @state() private customThemeImportFocusToken = 0;
  private customThemeImportSelectOnSuccess = false;
  private configViewState: ConfigViewState = createConfigViewState();
  private runtimeConfigSource: ApplicationContext["runtimeConfig"] | null = null;
  private systemInfoGatewaySource: ApplicationContext["gateway"] | null = null;
  private systemInfoClient: GatewayBrowserClient | null = null;
  private systemInfoLoading = false;
  private systemInfoRequestId = 0;
  private systemInfoPollInterval: ReturnType<typeof globalThis.setInterval> | null = null;
  private readonly subscriptions = new SubscriptionsController(this)
    .watch(
      () => this.context?.runtimeConfig,
      (runtimeConfig, notify) => runtimeConfig.subscribe(notify),
      (runtimeConfig) => this.synchronizeRuntimeConfig(runtimeConfig),
    )
    .watch(
      () => this.context?.overlays,
      (overlays, notify) => overlays.subscribe(notify),
    )
    .watch(
      () => this.context?.config,
      (config, notify) => config.subscribe(notify),
    )
    .watch(
      () => this.context?.gateway,
      (gateway, notify) => gateway.subscribe(notify),
      (gateway) => this.synchronizeSystemInfoGateway(gateway),
    )
    .watch(
      () => this.context?.webPush,
      (webPush, notify) => webPush.subscribe(notify),
    )
    .watch(
      () => this.context?.theme,
      (theme, notify) => theme.subscribe(notify),
      () => {
        this.settings = loadSettings();
      },
    );

  override connectedCallback() {
    super.connectedCallback();
    this.settings = loadSettings();
    const linkedSelection = configSelectionFromSearch(
      this.pageId,
      globalThis.location?.search ?? "",
    );
    this.selections = { ...this.selections, [this.pageId]: linkedSelection };
  }

  override disconnectedCallback() {
    this.stopSystemInfoPolling();
    this.invalidateSystemInfoRequest();
    this.runtimeConfigSource = null;
    this.resetConfigViewState();
    this.systemInfoGatewaySource = null;
    this.systemInfoClient = null;
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override updated(changed: PropertyValues) {
    const pageChanged = changed.has("pageId") && changed.get("pageId") !== undefined;
    const modeChanged = changed.has("settingsMode") && changed.get("settingsMode") !== undefined;
    if (pageChanged || modeChanged) {
      this.invalidateSystemInfoRequest();
    }
    this.syncSystemInfoPolling();
  }

  private isSystemInfoVisible(): boolean {
    return this.pageId === "config" && this.settingsMode === "quick";
  }

  private synchronizeRuntimeConfig(runtimeConfig: ApplicationContext["runtimeConfig"]) {
    if (runtimeConfig !== this.runtimeConfigSource) {
      this.runtimeConfigSource = runtimeConfig;
      this.resetConfigViewState();
    }
    const config = runtimeConfig.state;
    if (!config.configSnapshot && !config.configLoading) {
      void runtimeConfig
        .ensureLoaded()
        .then(() =>
          this.runtimeConfigSource === runtimeConfig
            ? runtimeConfig.ensureSchemaLoaded()
            : undefined,
        );
      return;
    }
    if (!config.configSchema && !config.configSchemaLoading) {
      void runtimeConfig.ensureSchemaLoaded();
    }
  }

  private synchronizeSystemInfoGateway(gateway: ApplicationContext["gateway"]) {
    if (gateway !== this.systemInfoGatewaySource) {
      this.stopSystemInfoPolling();
      this.invalidateSystemInfoRequest();
      this.systemInfoGatewaySource = gateway;
      this.resetConfigViewState();
      this.systemInfoClient = null;
      this.systemInfo = null;
      this.systemInfoUnavailable = false;
    }
    this.handleSystemInfoGatewaySnapshot(gateway.snapshot);
  }

  private resetConfigViewState() {
    // Revealed secrets and raw caches never cross a capability/source epoch.
    this.configViewState = createConfigViewState();
  }

  private handleSystemInfoGatewaySnapshot(snapshot: ApplicationGatewaySnapshot) {
    const clientChanged = snapshot.client !== this.systemInfoClient;
    const hasSystemInfo = supportsSystemInfo(snapshot.hello);
    this.systemInfoClient = snapshot.client;
    if (clientChanged) {
      this.invalidateSystemInfoRequest();
      this.systemInfo = null;
      this.systemInfoUnavailable = false;
    } else if (!snapshot.connected) {
      this.invalidateSystemInfoRequest();
      this.systemInfo = null;
    }
    if (snapshot.connected && snapshot.hello) {
      this.systemInfoUnavailable = !hasSystemInfo;
      if (!hasSystemInfo) {
        this.invalidateSystemInfoRequest();
        this.systemInfo = null;
      }
    }
    this.syncSystemInfoPolling();
  }

  private syncSystemInfoPolling() {
    const gateway = this.context.gateway.snapshot;
    const shouldPoll =
      this.isConnected &&
      this.isSystemInfoVisible() &&
      !this.systemInfoUnavailable &&
      gateway.connected &&
      supportsSystemInfo(gateway.hello) &&
      gateway.client != null;
    if (!shouldPoll) {
      this.stopSystemInfoPolling();
      return;
    }
    if (this.systemInfoPollInterval !== null) {
      return;
    }
    void this.loadSystemInfo();
    this.systemInfoPollInterval = globalThis.setInterval(() => {
      void this.loadSystemInfo();
    }, SYSTEM_INFO_POLL_INTERVAL_MS);
  }

  private stopSystemInfoPolling() {
    if (this.systemInfoPollInterval === null) {
      return;
    }
    globalThis.clearInterval(this.systemInfoPollInterval);
    this.systemInfoPollInterval = null;
  }

  private invalidateSystemInfoRequest() {
    this.systemInfoRequestId += 1;
    this.systemInfoLoading = false;
  }

  private isCurrentSystemInfoRequest(
    requestId: number,
    client: GatewayBrowserClient,
    gatewaySource: ApplicationContext["gateway"],
  ): boolean {
    const gateway = gatewaySource.snapshot;
    return (
      this.isConnected &&
      this.isSystemInfoVisible() &&
      requestId === this.systemInfoRequestId &&
      this.systemInfoGatewaySource === gatewaySource &&
      this.context.gateway === gatewaySource &&
      gateway.connected &&
      gateway.client === client
    );
  }

  private async loadSystemInfo() {
    const gatewaySource = this.systemInfoGatewaySource;
    if (!gatewaySource || gatewaySource !== this.context.gateway) {
      return;
    }
    const gateway = gatewaySource.snapshot;
    const client = gateway.client;
    if (
      !gateway.connected ||
      !client ||
      !this.isSystemInfoVisible() ||
      this.systemInfoUnavailable ||
      this.systemInfoLoading
    ) {
      return;
    }

    const requestId = ++this.systemInfoRequestId;
    this.systemInfoLoading = true;
    try {
      const response = await client.request("system.info", {});
      if (!this.isCurrentSystemInfoRequest(requestId, client, gatewaySource)) {
        return;
      }
      this.systemInfo = response as SystemInfoResult;
    } catch (error) {
      if (!this.isCurrentSystemInfoRequest(requestId, client, gatewaySource)) {
        return;
      }
      if (isMissingOperatorReadScopeError(error) || isUnknownSystemInfoMethodError(error)) {
        this.systemInfo = null;
        this.systemInfoUnavailable = true;
        this.stopSystemInfoPolling();
      }
    } finally {
      if (this.isCurrentSystemInfoRequest(requestId, client, gatewaySource)) {
        this.systemInfoLoading = false;
      }
    }
  }

  private navigate(routeId: RouteId) {
    this.context.navigate(routeId);
  }

  private setFormMode(mode: ConfigFormMode) {
    this.formModes = { ...this.formModes, [this.pageId]: mode };
  }

  private setSearchQuery(query: string) {
    this.searchQueries = { ...this.searchQueries, [this.pageId]: query };
  }

  private setActiveSection(section: string | null) {
    this.selections = {
      ...this.selections,
      [this.pageId]: { activeSection: section, activeSubsection: null },
    };
  }

  private setActiveSubsection(section: string | null) {
    this.selections = {
      ...this.selections,
      [this.pageId]: { ...this.selections[this.pageId], activeSubsection: section },
    };
  }

  private applySettings(next: UiSettings) {
    this.settings = patchSettings({
      theme: next.theme,
      themeMode: next.themeMode,
      customTheme: next.customTheme,
      textScale: next.textScale,
      lobsterPetVisits: next.lobsterPetVisits,
      lobsterPetSounds: next.lobsterPetSounds,
    });
    applyTextScale(this.settings.textScale);
    // theme.refresh() also republishes non-theme appearance prefs (text
    // scale, lobster pet visits/sounds) to app-host subscribers.
    this.context.theme.refresh();
  }

  private setLocale(locale: Locale) {
    this.settings = patchSettings({ locale });
    void i18n.setLocale(locale);
  }

  private setTheme(
    theme: ThemeName,
    context?: Parameters<typeof startThemeTransition>[0]["context"],
  ) {
    const currentTheme = resolveTheme(this.settings.theme, this.settings.themeMode);
    const next = { ...this.settings, theme };
    startThemeTransition({
      currentTheme,
      nextTheme: resolveTheme(next.theme, next.themeMode),
      context,
      applyTheme: () => this.applySettings(next),
    });
  }

  private setThemeMode(
    mode: ThemeMode,
    context?: Parameters<typeof startThemeTransition>[0]["context"],
  ) {
    const currentTheme = resolveTheme(this.settings.theme, this.settings.themeMode);
    const next = { ...this.settings, themeMode: mode };
    startThemeTransition({
      currentTheme,
      nextTheme: resolveTheme(next.theme, next.themeMode),
      context,
      applyTheme: () => this.applySettings(next),
    });
  }

  private setTextScale(value: number) {
    this.applySettings({ ...this.settings, textScale: normalizeTextScale(value) });
  }

  private openCustomThemeImport() {
    this.customThemeImportExpanded = true;
    this.customThemeImportFocusToken += 1;
    if (!this.settings.customTheme) {
      this.customThemeImportSelectOnSuccess = true;
    }
  }

  private async importCustomTheme() {
    if (this.customThemeImportBusy) {
      return;
    }
    this.customThemeImportExpanded = true;
    this.customThemeImportBusy = true;
    this.customThemeImportMessage = null;
    try {
      const customTheme = await importCustomThemeFromUrl(this.customThemeImportUrl);
      const selectTheme = !this.settings.customTheme || this.customThemeImportSelectOnSuccess;
      this.applySettings({
        ...this.settings,
        customTheme,
        theme: selectTheme ? "custom" : this.settings.theme,
      });
      this.customThemeImportUrl = "";
      this.customThemeImportSelectOnSuccess = false;
      this.customThemeImportMessage = {
        kind: "success",
        text: `Imported ${customTheme.label}.`,
      };
    } catch (error) {
      this.customThemeImportMessage = {
        kind: "error",
        text: error instanceof Error ? error.message : String(error),
      };
    } finally {
      this.customThemeImportBusy = false;
    }
  }

  private clearCustomTheme() {
    this.customThemeImportExpanded = true;
    this.customThemeImportSelectOnSuccess = false;
    this.applySettings({
      ...this.settings,
      theme: this.settings.theme === "custom" ? "claw" : this.settings.theme,
      customTheme: undefined,
    });
    this.customThemeImportMessage = {
      kind: "success",
      text: "Custom theme removed.",
    };
  }

  private includeSections(): readonly string[] | undefined {
    return this.pageId === "communications"
      ? COMMUNICATION_SECTION_KEYS
      : this.pageId === "appearance"
        ? APPEARANCE_SECTION_KEYS
        : this.pageId === "automation"
          ? AUTOMATION_SECTION_KEYS
          : this.pageId === "mcp" || this.pageId === "infrastructure"
            ? INFRASTRUCTURE_SECTION_KEYS
            : this.pageId === "ai-agents"
              ? AI_AGENTS_SECTION_KEYS
              : undefined;
  }

  private renderAdvancedConfig(configObject: Record<string, unknown>) {
    const runtimeConfig = this.context.runtimeConfig;
    const configState = runtimeConfig.state;
    const includeSections = this.includeSections();
    const excludeSections =
      this.pageId === "config"
        ? [
            ...COMMUNICATION_SECTION_KEYS,
            ...AUTOMATION_SECTION_KEYS,
            ...INFRASTRUCTURE_SECTION_KEYS,
            ...AI_AGENTS_SECTION_KEYS,
            "ui",
            "wizard",
          ]
        : undefined;
    const selection = normalizeConfigSelection(
      this.pageId,
      this.selections[this.pageId].activeSection,
      this.selections[this.pageId].activeSubsection,
    );
    const activeSection = this.pageId === "mcp" ? "mcp" : selection.activeSection;
    const activeSubsection = this.pageId === "mcp" ? null : selection.activeSubsection;
    const props: ConfigProps = {
      raw: configState.configRaw,
      originalRaw: configState.configRawOriginal,
      valid: configState.configValid,
      issues: configState.configIssues,
      loading: configState.configLoading,
      saving: configState.configSaving,
      applying: configState.configApplying,
      updating: this.context.overlays.snapshot.updateRunning,
      connected: configState.connected,
      schema: configState.configSchema,
      schemaLoading: configState.configSchemaLoading,
      uiHints: configState.configUiHints,
      formMode: this.formModes[this.pageId],
      viewState: this.configViewState,
      rawAvailable: Boolean(
        configState.configSnapshot?.config || configState.configForm || configState.configRaw,
      ),
      showModeToggle: this.pageId === "config",
      formValue: configState.configForm,
      originalValue: configState.configFormOriginal,
      searchQuery: this.searchQueries[this.pageId],
      activeSection,
      activeSubsection,
      onRawChange: (next) => runtimeConfig.setRaw(next),
      onFormModeChange: (mode) => this.setFormMode(mode),
      onViewStateChange: () => this.requestUpdate(),
      onFormPatch: (path, value) => runtimeConfig.patchForm(path, value),
      onSearchChange: (query) => this.setSearchQuery(query),
      onSectionChange: (section) => this.setActiveSection(section),
      onSubsectionChange: (section) => this.setActiveSubsection(section),
      onReload: () => void runtimeConfig.refresh({ discardPendingChanges: true }),
      onReset: () => runtimeConfig.resetDraft(),
      onSave: () => void runtimeConfig.save(),
      onApply: () => void runtimeConfig.apply(),
      onUpdate: () => void this.context.overlays.runUpdate(),
      onOpenFile: () => void runtimeConfig.openFile(),
      version:
        this.context.config.current.serverVersion ??
        this.context.gateway.snapshot.hello?.server?.version ??
        "",
      theme: this.settings.theme,
      themeMode: this.settings.themeMode,
      setTheme: (theme, transitionContext) => this.setTheme(theme, transitionContext),
      setThemeMode: (mode, transitionContext) => this.setThemeMode(mode, transitionContext),
      hasCustomTheme: Boolean(this.settings.customTheme),
      customThemeLabel: this.settings.customTheme?.label ?? null,
      customThemeSourceUrl: this.settings.customTheme?.sourceUrl ?? null,
      customThemeImportUrl: this.customThemeImportUrl,
      customThemeImportBusy: this.customThemeImportBusy,
      customThemeImportMessage: this.customThemeImportMessage,
      customThemeImportExpanded: this.customThemeImportExpanded,
      customThemeImportFocusToken: this.customThemeImportFocusToken,
      onCustomThemeImportUrlChange: (next) => {
        this.customThemeImportUrl = next;
        if (this.customThemeImportMessage?.kind === "error") {
          this.customThemeImportMessage = null;
        }
      },
      onImportCustomTheme: () => void this.importCustomTheme(),
      onClearCustomTheme: () => this.clearCustomTheme(),
      onOpenCustomThemeImport: () => this.openCustomThemeImport(),
      textScale: this.settings.textScale ?? 100,
      setTextScale: (value) => this.setTextScale(value),
      gatewayUrl: this.context.gateway.connection.gatewayUrl,
      assistantName: this.context.config.current.assistantIdentity.name,
      configPath: configState.configSnapshot?.path ?? null,
      navRootLabel: this.pageId === "config" ? undefined : configPageTitle(this.pageId),
      showRootTab: !includeSections?.length,
      includeSections: includeSections ? [...includeSections] : undefined,
      excludeSections,
      includeVirtualSections: this.pageId === "communications" || this.pageId === "appearance",
      settingsLayout: this.pageId === "config" ? "accordion" : undefined,
      webPush: this.context.webPush.snapshot,
      onWebPushSubscribe: () => void this.context.webPush.enable(),
      onWebPushUnsubscribe: () => void this.context.webPush.disable(),
      onWebPushTest: () => void this.context.webPush.sendTest(),
    };
    if (this.pageId !== "mcp") {
      return renderConfig(props);
    }
    return renderMcp({
      configObject,
      configDirty: configState.configFormDirty,
      configSaving: configState.configSaving,
      configApplying: configState.configApplying,
      connected: configState.connected,
      pluginsHref: pathForRoute("plugins", this.context.basePath),
      onSaveConfig: () => void runtimeConfig.save(),
      onApplyConfig: () => void runtimeConfig.apply(),
      editor: renderConfig({
        ...props,
        activeSection: "mcp",
        activeSubsection: null,
        showModeToggle: false,
        includeSections: ["mcp"],
        navRootLabel: "MCP",
      }),
    });
  }

  private renderQuickConfig(configObject: Record<string, unknown>) {
    const runtimeConfig = this.context.runtimeConfig;
    const agentsDefaults = asConfigRecord(asConfigRecord(configObject.agents)?.defaults);
    const model = typeof agentsDefaults?.model === "string" ? agentsDefaults.model : "default";
    const thinkingLevel =
      typeof agentsDefaults?.thinkingDefault === "string" ? agentsDefaults.thinkingDefault : "off";
    const fastMode = agentsDefaults?.fastMode;
    const appConfig = this.context.config.current;
    return renderQuickSettings({
      locale: isSupportedLocale(this.settings.locale) ? this.settings.locale : i18n.getLocale(),
      onLocaleChange: (locale) => this.setLocale(locale),
      currentModel: model,
      thinkingLevel,
      fastMode: fastMode === "auto" || typeof fastMode === "boolean" ? fastMode : false,
      channels: quickChannels(configObject),
      automation: {
        cronJobCount: 0,
        skillCount: 0,
        mcpServerCount: mcpServerCount(configObject),
      },
      security: extractQuickSettingsSecurity(configObject),
      systemInfo: this.systemInfo,
      systemInfoUnavailable: this.systemInfoUnavailable,
      theme: this.settings.theme,
      themeMode: this.settings.themeMode,
      hasCustomTheme: Boolean(this.settings.customTheme),
      customThemeLabel: this.settings.customTheme?.label,
      textScale: this.settings.textScale ?? 100,
      setTheme: (theme, transitionContext) => this.setTheme(theme, transitionContext),
      setThemeMode: (mode, transitionContext) => this.setThemeMode(mode, transitionContext),
      onModelChange: () => {
        this.settingsMode = "advanced";
        this.selections = {
          ...this.selections,
          "ai-agents": { activeSection: "models", activeSubsection: null },
        };
        this.navigate("ai-agents");
      },
      setTextScale: (value) => this.setTextScale(value),
      lobsterPetVisits: this.settings.lobsterPetVisits !== false,
      setLobsterPetVisits: (enabled) =>
        this.applySettings({ ...this.settings, lobsterPetVisits: enabled }),
      lobsterPetSounds: this.settings.lobsterPetSounds === true,
      setLobsterPetSounds: (enabled) =>
        this.applySettings({ ...this.settings, lobsterPetSounds: enabled }),
      onOpenCustomThemeImport: () => {
        this.pageId = "appearance";
        this.setFormMode("form");
        this.setSearchQuery("");
        this.selections = {
          ...this.selections,
          appearance: { activeSection: "__appearance__", activeSubsection: null },
        };
        this.openCustomThemeImport();
      },
      connected: runtimeConfig.state.connected,
      gatewayUrl: this.context.gateway.connection.gatewayUrl,
      assistantName: appConfig.assistantIdentity.name,
      version:
        appConfig.serverVersion ?? this.context.gateway.snapshot.hello?.server?.version ?? "",
      configDirty: runtimeConfig.state.configFormDirty,
      configSaving: runtimeConfig.state.configSaving,
      configApplying: runtimeConfig.state.configApplying,
      configReady: Boolean(runtimeConfig.state.configSnapshot?.hash),
      onResetConfig: () => runtimeConfig.resetDraft(),
      onSaveConfig: () => void runtimeConfig.save(),
      onApplyConfig: () => void runtimeConfig.apply(),
      onThinkingChange: (level) =>
        runtimeConfig.patchForm(["agents", "defaults", "thinkingDefault"], level),
      onFastModeChange: (mode: FastMode) =>
        runtimeConfig.patchForm(["agents", "defaults", "fastMode"], mode),
      onChannelConfigure: () => this.navigate("communications"),
      onManageCron: () => this.navigate("cron"),
      onBrowseSkills: () => this.navigate("skills"),
      onConfigureMcp: () => this.navigate("mcp"),
      onSecurityConfigure: () => {
        this.settingsMode = "advanced";
        this.selections = {
          ...this.selections,
          config: { activeSection: "auth", activeSubsection: null },
        };
      },
      canPairDevice:
        runtimeConfig.state.connected &&
        hasOperatorAdminAccess(this.context.gateway.snapshot.hello?.auth ?? null),
      onPairMobile: () => void this.context.overlays.openDevicePairSetup(),
      onBrowserEnabledToggle: (enabled) => runtimeConfig.patchForm(["browser", "enabled"], enabled),
      onToolProfileChange: (profile) => runtimeConfig.patchForm(["tools", "profile"], profile),
      assistantAvatar: appConfig.assistantIdentity.avatar,
      assistantAvatarUrl: appConfig.assistantIdentity.avatar,
      assistantAvatarSource: appConfig.assistantIdentity.avatarSource,
      assistantAvatarStatus: appConfig.assistantIdentity.avatarStatus,
      assistantAvatarReason: appConfig.assistantIdentity.avatarReason,
      assistantAvatarOverride: null,
      basePath: this.context.basePath,
    });
  }

  private renderSettingsModeToggle() {
    if (this.pageId !== "config") {
      return nothing;
    }
    const modes = [
      ["quick", "Simple"],
      ["advanced", "Advanced"],
    ] as const;
    return html`
      <div class="config-view-toggle qs-segmented" role="tablist" aria-label="Settings view">
        ${modes.map(
          ([mode, label]) => html`
            <button
              class="qs-segmented__btn ${this.settingsMode === mode
                ? "qs-segmented__btn--active"
                : ""}"
              role="tab"
              aria-selected=${this.settingsMode === mode}
              @click=${() => (this.settingsMode = mode)}
            >
              ${label}
            </button>
          `,
        )}
      </div>
    `;
  }

  override render() {
    const configState = this.context.runtimeConfig.state;
    const configObject =
      asConfigRecord(configState.configForm ?? configState.configSnapshot?.config) ?? {};
    const body =
      this.pageId === "config" && this.settingsMode === "quick"
        ? this.renderQuickConfig(configObject)
        : this.renderAdvancedConfig(configObject);
    return html`
      <section class="content-header">
        <div>
          <div class="page-title">${configPageTitle(this.pageId)}</div>
          <div class="page-sub">${configPageSubtitle(this.pageId)}</div>
        </div>
        ${this.renderSettingsModeToggle()}
      </section>
      ${this.pageId === "config"
        ? html`<div class="config-view-toggle-row">${this.renderSettingsModeToggle()}</div>`
        : nothing}
      ${renderSettingsWorkspace(body)}
    `;
  }
}

customElements.define("openclaw-config-page", ConfigPage);
