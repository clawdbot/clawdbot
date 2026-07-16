import { consume } from "@lit/context";
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
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
  loadLocalUserIdentity,
  loadSettings,
  normalizeCatalogOpenTarget,
  normalizeTextScale,
  normalizeChatFollowUpMode,
  normalizeChatSendShortcut,
  patchSettings,
  saveLocalUserIdentity,
  type UiSettings,
} from "../../app/settings.ts";
import { startThemeTransition } from "../../app/theme-transition.ts";
import { resolveTheme, type ThemeMode, type ThemeName } from "../../app/theme.ts";
import { renderSettingsSegmented } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { i18n, isSupportedLocale, t, type Locale } from "../../i18n/index.ts";
import { isMissingOperatorReadScopeError } from "../../lib/gateway-errors.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PollController } from "../../lit/poll-controller.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import {
  discoverRealtimeTalkInputs,
  type RealtimeTalkInputDevice,
} from "../chat/realtime-talk-input.ts";
import {
  AI_AGENTS_SECTION_KEYS,
  AUTOMATION_SECTION_KEYS,
  COMMUNICATION_SECTION_KEYS,
  configSectionKeysForPage,
  INFRASTRUCTURE_SECTION_KEYS,
  SCOPED_CONFIG_SECTION_KEYS,
  type ConfigPageId,
} from "./config-sections.ts";
import { renderMcp } from "./mcp.ts";
import {
  renderQuickSettings,
  type QuickSettingsChannel,
  type QuickSettingsSecurity,
} from "./quick.ts";
import { configTargetIdFromHash, type ConfigRouteData } from "./route-data.ts";
import {
  createConfigViewState,
  renderConfig,
  type ConfigProps,
  type ConfigViewState,
} from "./view.ts";

export type { ConfigPageId } from "./config-sections.ts";

type ConfigFormMode = "form" | "raw";
type ConfigSelection = { activeSection: string | null; activeSubsection: string | null };
type LocalUiSetting = "textScale" | "chatSendShortcut" | "chatFollowUpMode" | "catalogOpenTarget";

const CONFIG_PAGE_I18N_KEYS = {
  config: "config",
  communications: "communications",
  appearance: "appearance",
  automation: "automation",
  mcp: "mcp",
  infrastructure: "infrastructure",
  "ai-agents": "aiAgents",
} as const satisfies Record<ConfigPageId, string>;

const KNOWN_CHANNELS = [
  { id: "telegram", labelKey: "configPage.channels.telegram" },
  { id: "discord", labelKey: "configPage.channels.discord" },
  { id: "slack", labelKey: "configPage.channels.slack" },
  { id: "whatsapp", labelKey: "configPage.channels.whatsapp" },
  { id: "signal", labelKey: "configPage.channels.signal" },
  { id: "imessage", labelKey: "configPage.channels.imessage" },
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

function normalizeConfigSelection(
  pageId: ConfigPageId,
  activeSection: string | null,
  activeSubsection: string | null,
): ConfigSelection {
  const sections = configSectionKeysForPage(pageId) ?? null;
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
  const labels = new Map<string, string>(
    KNOWN_CHANNELS.map(({ id, labelKey }) => [id, t(labelKey)]),
  );
  return channelIds.map((id) => {
    const value = configured[id];
    const connected = Boolean(value && typeof value === "object" && Object.keys(value).length);
    return {
      id,
      label:
        labels.get(id) ??
        id.replace(/[-_]+/g, " ").replace(/\b\w/g, (character) => character.toUpperCase()),
      connected,
      detail: connected ? t("common.configured") : undefined,
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
  @property({ attribute: false }) routeData: ConfigRouteData | null = null;

  @state() private settings = loadSettings();
  @state() private userAvatar: string | null = loadLocalUserIdentity().avatar;
  @state() private settingsMode: "quick" | "advanced" = "quick";
  @state() private systemInfo: SystemInfoResult | null = null;
  @state() private systemInfoUnavailable = false;
  @state() private microphoneDevices: RealtimeTalkInputDevice[] = [];
  @state() private microphoneLoading = false;
  @state() private microphoneError: string | null = null;
  private microphoneLoaded = false;
  @state() private formModes: Record<ConfigPageId, ConfigFormMode> = {
    config: "form",
    communications: "form",
    appearance: "form",
    automation: "form",
    mcp: "form",
    infrastructure: "form",
    "ai-agents": "form",
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
  private readonly systemInfoPolling = new PollController(
    this,
    SYSTEM_INFO_POLL_INTERVAL_MS,
    () => {
      void this.loadSystemInfo();
    },
    false,
  );
  private pendingRouteTargetId: string | null = null;
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
    this.userAvatar = loadLocalUserIdentity().avatar;
    this.syncRouteData();
  }

  private setLocalUserAvatar(avatar: string | null) {
    const identity = saveLocalUserIdentity({
      ...loadLocalUserIdentity(),
      avatar,
    });
    this.userAvatar = identity.avatar;
  }

  override disconnectedCallback() {
    this.systemInfoPolling.stop();
    this.invalidateSystemInfoRequest();
    this.runtimeConfigSource = null;
    this.resetConfigViewState();
    this.systemInfoGatewaySource = null;
    this.systemInfoClient = null;
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override willUpdate(changed: PropertyValues) {
    if (changed.has("pageId") || changed.has("routeData")) {
      this.syncRouteData();
    }
  }

  override updated(changed: PropertyValues) {
    const pageChanged = changed.has("pageId") && changed.get("pageId") !== undefined;
    const modeChanged = changed.has("settingsMode") && changed.get("settingsMode") !== undefined;
    if (pageChanged || modeChanged) {
      this.invalidateSystemInfoRequest();
    }
    this.syncSystemInfoPolling();
    this.scrollToPendingRouteTarget();
    // Device labels stay hidden until the user grants mic permission; the
    // refresh button next to the picker requests it explicitly.
    if (this.pageId === "appearance" && !this.microphoneLoaded) {
      this.microphoneLoaded = true;
      void this.refreshMicrophones(false);
    }
  }

  private async refreshMicrophones(requestPermission: boolean) {
    this.microphoneLoading = true;
    this.microphoneError = null;
    try {
      const result = await discoverRealtimeTalkInputs(requestPermission);
      this.microphoneDevices = result.devices;
      this.microphoneError = result.warning;
    } catch (error) {
      // Discovery is best-effort in blocked/inactive contexts; a rejection
      // must not wedge the picker in its loading state.
      this.microphoneError = error instanceof Error ? error.message : String(error);
    } finally {
      this.microphoneLoading = false;
    }
  }

  private syncRouteData() {
    const selection = this.routeData
      ? normalizeConfigSelection(this.pageId, this.routeData.section, null)
      : configSelectionFromSearch(this.pageId, globalThis.location?.search ?? "");
    this.selections = { ...this.selections, [this.pageId]: selection };
    const targetBlockId =
      this.routeData?.targetBlockId ?? configTargetIdFromHash(globalThis.location?.hash ?? "");
    this.pendingRouteTargetId = targetBlockId;
    if (this.pageId !== "config") {
      return;
    }
    if (this.routeData?.section) {
      this.settingsMode = "advanced";
    } else if (targetBlockId?.startsWith("settings-general-")) {
      this.settingsMode = "quick";
    }
  }

  private scrollToPendingRouteTarget() {
    const targetId = this.pendingRouteTargetId;
    if (!targetId) {
      return;
    }
    const target = [...this.renderRoot.querySelectorAll<HTMLElement>("[id]")].find(
      (element) => element.id === targetId,
    );
    if (!target) {
      return;
    }
    target.scrollIntoView?.({ behavior: "smooth", block: "start" });
    this.pendingRouteTargetId = null;
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
        )
        .catch(() => undefined);
      return;
    }
    if (!config.configSchema && !config.configSchemaLoading) {
      void runtimeConfig.ensureSchemaLoaded().catch(() => undefined);
    }
  }

  private synchronizeSystemInfoGateway(gateway: ApplicationContext["gateway"]) {
    if (gateway !== this.systemInfoGatewaySource) {
      this.systemInfoPolling.stop();
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
      this.systemInfoPolling.stop();
      return;
    }
    if (this.systemInfoPolling.start()) {
      void this.loadSystemInfo();
    }
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
        this.systemInfoPolling.stop();
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
      chatSendShortcut: next.chatSendShortcut,
      chatFollowUpMode: next.chatFollowUpMode,
      catalogOpenTarget: next.catalogOpenTarget,
      realtimeTalkInputDeviceId: next.realtimeTalkInputDeviceId,
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

  private setSetting<K extends LocalUiSetting>(key: K, value: UiSettings[K]) {
    this.applySettings({ ...this.settings, [key]: value });
  }

  private selectMicrophone(deviceId: string) {
    this.applySettings({
      ...this.settings,
      realtimeTalkInputDeviceId: deviceId.trim() || undefined,
    });
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
        text: t("configPage.themeImported", { name: customTheme.label }),
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
      text: t("configPage.themeRemoved"),
    };
  }

  private includeSections(): readonly string[] | undefined {
    return configSectionKeysForPage(this.pageId);
  }

  private isUpdateBusy(): boolean {
    const update = this.context.overlays.snapshot;
    return update.updateRunning || update.updateReconciliationPending;
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
      updating: this.isUpdateBusy(),
      autoSaveStatus: configState.configAutoSaveStatus,
      needsApply: configState.configNeedsApply,
      connected: configState.connected,
      schema: configState.configSchema,
      schemaLoading: configState.configSchemaLoading,
      uiHints: configState.configUiHints,
      formMode: this.formModes[this.pageId],
      rawDraftPending: configState.configFormMode === "raw" && configState.configFormDirty,
      viewState: this.configViewState,
      rawAvailable: Boolean(
        configState.configSnapshot?.config || configState.configForm || configState.configRaw,
      ),
      showModeToggle: this.pageId === "config",
      formValue: configState.configForm,
      originalValue: configState.configFormOriginal,
      activeSection,
      activeSubsection,
      onRawChange: (next) => runtimeConfig.setRaw(next),
      onFormModeChange: (mode) => this.setFormMode(mode),
      onViewStateChange: () => this.requestUpdate(),
      onFormPatch: (path, value) => runtimeConfig.patchForm(path, value),
      onSectionChange: (section) => this.setActiveSection(section),
      onSubsectionChange: (section) => this.setActiveSubsection(section),
      onSave: () => void runtimeConfig.save(),
      onApply: () => void runtimeConfig.apply(),
      onRawDiscard: () => void runtimeConfig.discardDraft(),
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
      setTextScale: (value) => this.setSetting("textScale", normalizeTextScale(value)),
      chatSendShortcut: normalizeChatSendShortcut(this.settings.chatSendShortcut),
      setChatSendShortcut: (value) => this.setSetting("chatSendShortcut", value),
      chatFollowUpMode: normalizeChatFollowUpMode(this.settings.chatFollowUpMode),
      setChatFollowUpMode: (value) => this.setSetting("chatFollowUpMode", value),
      catalogOpenTarget: normalizeCatalogOpenTarget(this.settings.catalogOpenTarget),
      setCatalogOpenTarget: (value) => this.setSetting("catalogOpenTarget", value),
      microphone: {
        devices: this.microphoneDevices,
        selectedDeviceId: this.settings.realtimeTalkInputDeviceId ?? "",
        loading: this.microphoneLoading,
        error: this.microphoneError,
      },
      onMicrophoneRefresh: () => void this.refreshMicrophones(true),
      onMicrophoneSelect: (deviceId) => this.selectMicrophone(deviceId),
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
      pluginsHref: pathForRoute("plugins", this.context.basePath),
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
      setTextScale: (value) => this.setSetting("textScale", normalizeTextScale(value)),
      lobsterPetVisits: this.settings.lobsterPetVisits !== false,
      setLobsterPetVisits: (enabled) =>
        this.applySettings({ ...this.settings, lobsterPetVisits: enabled }),
      lobsterPetSounds: this.settings.lobsterPetSounds === true,
      setLobsterPetSounds: (enabled) =>
        this.applySettings({ ...this.settings, lobsterPetSounds: enabled }),
      onOpenCustomThemeImport: () => {
        this.pageId = "appearance";
        this.setFormMode("form");
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
      configLoading: runtimeConfig.state.configLoading,
      configSaving: runtimeConfig.state.configSaving,
      configApplying: runtimeConfig.state.configApplying,
      configUpdating: this.isUpdateBusy(),
      configNeedsApply: runtimeConfig.state.configNeedsApply,
      configRawDraftPending:
        runtimeConfig.state.configFormMode === "raw" && runtimeConfig.state.configFormDirty,
      configAutoSaveStatus: runtimeConfig.state.configAutoSaveStatus,
      onApplyConfig: () => void runtimeConfig.apply(),
      onRetrySaveConfig: () => void runtimeConfig.save(),
      onDiscardConfig: () => void runtimeConfig.discardDraft(),
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
      userAvatar: this.userAvatar,
      onUserAvatarChange: (avatar) => this.setLocalUserAvatar(avatar),
      basePath: this.context.basePath,
    });
  }

  private renderSettingsModeToggle() {
    if (this.pageId !== "config") {
      return nothing;
    }
    return html`
      <div class="config-view-toggle">
        ${renderSettingsSegmented({
          value: this.settingsMode,
          options: [
            { value: "quick", label: t("configPage.simple") },
            { value: "advanced", label: t("configPage.advanced") },
          ],
          ariaLabel: t("configPage.settingsView"),
          onChange: (mode) => {
            this.settingsMode = mode;
          },
        })}
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
        </div>
        ${this.renderSettingsModeToggle()}
      </section>
      ${this.pageId === "config"
        ? html`<div class="config-view-toggle-row">${this.renderSettingsModeToggle()}</div>`
        : nothing}
      ${renderSettingsWorkspace(
        body,
        this.pageId === "config"
          ? {
              id: "config-settings-panel",
              ariaLabel: t("configPage.content"),
            }
          : {},
      )}
    `;
  }
}

customElements.define("openclaw-config-page", ConfigPage);
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
