import "../../styles/config.css";
import { consume } from "@lit/context";
import { initialState, Task, TaskStatus } from "@lit/task";
import { asNullableRecord as asConfigRecord } from "@openclaw/normalization-core/record-coerce";
import { html, nothing, type PropertyValues } from "lit";
import { property, state } from "lit/decorators.js";
import type {
  SessionsCatalogListResult,
  SystemInfoResult,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ModelCatalogEntry } from "../../api/types.ts";
import { subtitleForRoute, titleForRoute } from "../../app-navigation.ts";
import { pathForRoute, type RouteId } from "../../app-route-paths.ts";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationGatewaySnapshot,
} from "../../app/context.ts";
import { hasOperatorAdminAccess, hasOperatorWriteAccess } from "../../app/operator-access.ts";
import { isBrowserPanelAvailable } from "../../app/panel-availability.ts";
import { isAppearancePref, type ResettableServerUiPrefKey } from "../../app/server-prefs-state.ts";
import { resetServerUiPref, resolveServerUiPrefState } from "../../app/server-prefs.ts";
import {
  loadSettings,
  normalizeCatalogOpenTarget,
  normalizeTextScale,
  normalizeChatSendShortcut,
  patchSettings,
  UI_APPEARANCE_DEFAULTS,
  type UiSettings,
} from "../../app/settings.ts";
import { startThemeTransition } from "../../app/theme-transition.ts";
import { resolveTheme, type ThemeMode, type ThemeName } from "../../app/theme.ts";
import type { TypefaceId } from "../../app/typography.ts";
import {
  confirmAndStartUpdate,
  createUpdateProgressWatcher,
  type UpdateProgress,
} from "../../app/update-confirmation.ts";
import { CONTROL_UI_BUILD_INFO } from "../../build-info.ts";
import {
  loadStoredHiddenSessionCatalogIds,
  SIDEBAR_HIDDEN_SESSION_CATALOGS_CHANGED_EVENT,
  setStoredSessionCatalogHidden,
} from "../../components/app-sidebar-session-types.ts";
import { renderLearnMoreLink, renderSettingsPageHeader } from "../../components/settings-ui.ts";
import { renderSettingsWorkspace } from "../../components/settings-workspace.ts";
import { i18n, isSupportedLocale, t, type Locale } from "../../i18n/index.ts";
import { registerSettingsEnglish } from "../../i18n/locales/en-settings.ts";
import { resolveControlUiServerQueueMode } from "../../lib/chat/follow-up-mode.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { isMissingOperatorReadScopeError } from "../../lib/gateway-errors.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { loadModelCatalog } from "../../lib/model-catalog-store.ts";
import { resolveScrollBehavior } from "../../lib/scroll-behavior.ts";
import { OpenClawLightDomElement } from "../../lit/openclaw-element.ts";
import { PollController } from "../../lit/poll-controller.ts";
import { SubscriptionsController } from "../../lit/subscriptions-controller.ts";
import {
  discoverRealtimeTalkCameras,
  discoverRealtimeTalkInputs,
  observeRealtimeTalkDevices,
  realtimeTalkDeviceIssueMessage,
  type RealtimeTalkCameraDevice,
  type RealtimeTalkInputDevice,
} from "../chat/realtime-talk-input.ts";
import { switchActiveRealtimeTalkCameras } from "../chat/realtime-talk.ts";
import { isUnknownSystemInfoMethodError, supportsSystemInfo } from "../connection/system-info.ts";
import { renderBrowserLinkPreferencesRow } from "./browser-link-preferences.ts";
import {
  configSectionKeysForPage,
  SCOPED_CONFIG_SECTION_KEYS,
  type ConfigPageId,
} from "./config-sections.ts";
import * as themeImport from "./custom-theme-import-owner.ts";
import { importCustomThemeFromUrl } from "./custom-theme-import.ts";
import { renderMcp } from "./mcp.ts";
import { renderMemoryPage } from "./memory-page.ts";
import { narrowMemorySchema } from "./memory-schema.ts";
import { configTargetIdFromHash, type ConfigRouteData } from "./route-data.ts";
import { renderSecurity, type SecurityOverview } from "./security.ts";
import {
  buildSessionObserverTogglePatch,
  buildSessionObserverUtilityModelPatch,
} from "./session-observer-settings.ts";
import { renderTalkPage } from "./talk-page.ts";
import { renderUpdates } from "./updates.ts";
import {
  createConfigViewState,
  renderConfig,
  type ConfigProps,
  type ConfigViewState,
} from "./view.ts";

registerSettingsEnglish();

export type { ConfigPageId } from "./config-sections.ts";

type ConfigFormMode = "form" | "raw";
type ConfigSelection = { activeSection: string | null; activeSubsection: string | null };
type SessionObserverModelsResult = {
  gateway: ApplicationContext["gateway"];
  client: GatewayBrowserClient;
  agentId: string;
  models: ModelCatalogEntry[];
};
// Keys settable through this page's setSetting helper. Whether a key syncs
// across devices is owned by app/server-prefs.ts, not by this type.
type ConfigPageSetting =
  | "textScale"
  | "sidebarLiveActivity"
  | "chatMessageMaxWidth"
  | "chatCollapseTaskProgress"
  | "showAdvancedSettings"
  | "chatSendShortcut"
  | "chatFollowUpMode"
  | "catalogOpenTarget"
  | "composerHoldToRecord"
  | "openLinksInControlUiBrowser";

// Sections relocated by the settings restructure, keyed by "<oldPage>:<section>".
// Kept so pre-restructure bookmarks and generated links still land somewhere
// sensible instead of silently opening the old page's default section.
const MOVED_SECTION_ROUTES: Record<string, { routeId: RouteId; keepSection: boolean }> = {
  "communications:__notifications__": { routeId: "notifications", keepSection: false },
  "communications:channels": { routeId: "channels", keepSection: false },
  "communications:broadcast": { routeId: "advanced", keepSection: true },
  "communications:talk": { routeId: "talk", keepSection: true },
  "appearance:wizard": { routeId: "advanced", keepSection: true },
  "automation:approvals": { routeId: "security", keepSection: true },
  "ai-agents:memory": { routeId: "memory", keepSection: true },
  "ai-agents:models": { routeId: "model-providers", keepSection: false },
};

const SESSION_OBSERVER_STATUS_POLL_INTERVAL_MS = 10_000;
const EMPTY_SESSION_CATALOG_LABELS: ReadonlyMap<string, string> = new Map();

function defaultConfigSelection(pageId: ConfigPageId): ConfigSelection {
  switch (pageId) {
    case "communications":
      return { activeSection: "messages", activeSubsection: null };
    case "appearance":
      return { activeSection: "__appearance__", activeSubsection: null };
    case "notifications":
      return { activeSection: "__notifications__", activeSubsection: null };
    case "security":
      return { activeSection: "security", activeSubsection: null };
    case "automation":
      return { activeSection: "commands", activeSubsection: null };
    case "mcp":
      return { activeSection: "mcp", activeSubsection: null };
    case "memory":
      return { activeSection: "memory", activeSubsection: null };
    case "talk":
      return { activeSection: "talk", activeSubsection: null };
    case "infrastructure":
      return { activeSection: "gateway", activeSubsection: null };
    case "updates":
      return { activeSection: "update", activeSubsection: null };
    case "ai-agents":
      return { activeSection: "agents", activeSubsection: null };
    case "advanced":
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
  // Advanced renders without an include list; sections that have a curated
  // home elsewhere must not activate here.
  if (pageId === "advanced" && activeSection && SCOPED_CONFIG_SECTION_KEYS.has(activeSection)) {
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
  return titleForRoute(pageId);
}

function renderConfigPageSubtitle(pageId: ConfigPageId) {
  switch (pageId) {
    case "appearance":
      return html`${t("configView.appearance.intro")}
      ${renderLearnMoreLink("https://docs.openclaw.ai/web/control-ui")}`;
    case "mcp":
      return html`${t("mcpPage.intro")} ${renderLearnMoreLink("https://docs.openclaw.ai/tools/mcp")}`;
    case "security":
      return html`${t("quickSettings.security.intro")}
      ${renderLearnMoreLink("https://docs.openclaw.ai/gateway/security")}`;
    case "talk":
      return html`${t("talkPage.intro")}
      ${renderLearnMoreLink("https://docs.openclaw.ai/nodes/talk")}`;
    case "updates":
      return t("updates.page.intro");
    default:
      return subtitleForRoute(pageId);
  }
}

export function extractQuickSettingsSecurity(config: unknown): SecurityOverview {
  const root =
    asConfigRecord((config as { configForm?: unknown } | null)?.configForm) ??
    asConfigRecord(config);
  if (!root) {
    return {
      gatewayAuth: "unknown",
      execPolicy: "unknown",
      browserEnabled: true,
      browserEnabledOverridden: false,
      toolProfile: "full",
      toolProfileOverridden: false,
    };
  }
  const gateway = asConfigRecord(root.gateway);
  const auth = asConfigRecord(gateway?.auth);
  const tools = asConfigRecord(root.tools);
  const exec = asConfigRecord(tools?.exec) ?? {};
  const browser = asConfigRecord(root.browser);
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
  const profile = tools?.profile;
  const security = exec.security;
  return {
    gatewayAuth,
    execPolicy: typeof security === "string" && security.trim() ? security.trim() : "allowlist",
    browserEnabled: browser?.enabled !== false,
    browserEnabledOverridden: browser !== null && Object.hasOwn(browser, "enabled"),
    toolProfile: typeof profile === "string" && profile.trim() ? profile.trim() : "full",
    toolProfileOverridden: tools !== null && Object.hasOwn(tools, "profile"),
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

  @property({ attribute: "page-id" }) pageId: ConfigPageId = "advanced";
  @property({ attribute: false }) routeData: ConfigRouteData | null = null;

  @state() private settings = loadSettings();
  @state() private hiddenSessionCatalogIds = loadStoredHiddenSessionCatalogIds();
  @state() private systemInfo: SystemInfoResult | null = null;
  @state() private systemInfoUnavailable = false;
  @state() private sessionObserverModels: ModelCatalogEntry[] = [];
  @state() private sessionObserverModelsUnavailable = false;
  private mediaDeviceWatch: (() => void) | null = null;
  @state() private microphoneDevices: RealtimeTalkInputDevice[] = [];
  @state() private microphonePermissionRequired = true;
  @state() private microphoneLoading = false;
  @state() private microphoneError: string | null = null;
  private microphoneLoaded = false;
  private microphoneRefreshRequestsPermission = false;
  @state() private cameraDevices: RealtimeTalkCameraDevice[] = [];
  @state() private cameraPermissionRequired = true;
  @state() private cameraLoading = false;
  @state() private cameraError: string | null = null;
  private cameraLoaded = false;
  private cameraRefreshRequestsPermission = false;
  private cameraSelectionRequest = 0;
  @state() private formModes: Record<ConfigPageId, ConfigFormMode> = {
    communications: "form",
    appearance: "form",
    notifications: "form",
    security: "form",
    automation: "form",
    mcp: "form",
    memory: "form",
    talk: "form",
    infrastructure: "form",
    updates: "form",
    "ai-agents": "form",
    advanced: "form",
  };
  @state() private selections: Record<ConfigPageId, ConfigSelection> = {
    communications: defaultConfigSelection("communications"),
    appearance: defaultConfigSelection("appearance"),
    notifications: defaultConfigSelection("notifications"),
    security: defaultConfigSelection("security"),
    automation: defaultConfigSelection("automation"),
    mcp: defaultConfigSelection("mcp"),
    memory: defaultConfigSelection("memory"),
    talk: defaultConfigSelection("talk"),
    infrastructure: defaultConfigSelection("infrastructure"),
    updates: defaultConfigSelection("updates"),
    "ai-agents": defaultConfigSelection("ai-agents"),
    advanced: defaultConfigSelection("advanced"),
  };
  @state() private customThemeImport = themeImport.INITIAL_CUSTOM_THEME_IMPORT_STATE;
  private readonly customThemeImportOwner = new themeImport.CustomThemeImportOwner((next) => {
    this.customThemeImport = next;
  });
  private configViewState: ConfigViewState = createConfigViewState();
  private runtimeConfigSource: ApplicationContext["runtimeConfig"] | null = null;
  private systemInfoGatewaySource: ApplicationContext["gateway"] | null = null;
  private systemInfoClient: GatewayBrowserClient | null = null;
  private updateStatusClient: GatewayBrowserClient | null = null;
  private readonly systemInfoPolling = new PollController(
    this,
    SESSION_OBSERVER_STATUS_POLL_INTERVAL_MS,
    () => {
      if (this.systemInfoTask.status !== TaskStatus.PENDING) {
        void this.systemInfoTask.run();
      }
    },
    false,
  );
  private readonly updateCountdownPolling = new PollController(
    this,
    1_000,
    () => this.requestUpdate(),
    false,
  );
  private readonly systemInfoTask = new Task(this, {
    autoRun: false,
    // Null is an explicit visibility/capability invalidation for the current source.
    args: () => [this.systemInfoGatewaySource, this.systemInfoRequestClient()] as const,
    task: ([gateway, client], { signal }) =>
      gateway && client
        ? client.request<SystemInfoResult>("system.info", {}, { signal })
        : initialState,
    onComplete: (systemInfo) => {
      this.systemInfo = systemInfo;
      // Status polling must not restart a slow catalog read. Changed owners
      // still replace pending work through the model task's reactive args.
      if (this.sessionObserverModelsTask.status !== TaskStatus.PENDING) {
        void this.sessionObserverModelsTask.run();
      }
    },
    onError: (error) => {
      if (isMissingOperatorReadScopeError(error) || isUnknownSystemInfoMethodError(error)) {
        this.systemInfo = null;
        this.systemInfoUnavailable = true;
        this.systemInfoPolling.stop();
      }
    },
  });
  private readonly sessionObserverModelsTask: Task<
    readonly [ApplicationContext["gateway"] | null, GatewayBrowserClient | null, string | null],
    SessionObserverModelsResult
  > = new Task(this, {
    args: () =>
      [
        this.systemInfoGatewaySource,
        this.systemInfo ? this.systemInfoRequestClient() : null,
        this.context?.agentSelection.state.selectedId ?? null,
      ] as const,
    task: async ([gateway, client, agentId], { signal }) => {
      if (!gateway || !client || !agentId) {
        this.resetSessionObserverModels(!agentId);
        return initialState;
      }
      const previous = this.sessionObserverModelsTask.value;
      if (
        previous?.gateway !== gateway ||
        previous.client !== client ||
        previous.agentId !== agentId
      ) {
        this.resetSessionObserverModels();
      }
      // Keep same-owner options visible during refresh; the shared store owns
      // cache freshness/coalescing and Task fences publication after retirement.
      const { models } = await loadModelCatalog(client, { agentId, preparedOnly: true, signal });
      return { gateway, client, agentId, models };
    },
    onComplete: ({ models }) => {
      this.sessionObserverModels = models;
      this.sessionObserverModelsUnavailable = false;
    },
    onError: () => this.resetSessionObserverModels(true),
  });
  private readonly hiddenSessionCatalogLabelsTask = new Task(this, {
    args: () => {
      const gateway = this.context?.gateway.snapshot;
      const hiddenCatalogIds = [...this.hiddenSessionCatalogIds].toSorted();
      const client =
        this.pageId === "appearance" &&
        hiddenCatalogIds.length > 0 &&
        canCallGatewayMethod(gateway, "sessions.catalog.list", "operator.read")
          ? gateway?.client
          : null;
      return [
        client,
        this.context?.agentSelection.state.selectedId ?? null,
        hiddenCatalogIds.join("\0"),
      ] as const;
    },
    task: async ([client, agentId], { signal }) => {
      if (!client) {
        return EMPTY_SESSION_CATALOG_LABELS;
      }
      try {
        const result = await client.request<SessionsCatalogListResult>(
          "sessions.catalog.list",
          {
            ...(agentId ? { agentId } : {}),
            limitPerHost: 1,
          },
          { signal },
        );
        return new Map(result.catalogs.map((catalog) => [catalog.id, catalog.label]));
      } catch {
        // Recovery must remain available when catalog discovery is unsupported or offline.
        return EMPTY_SESSION_CATALOG_LABELS;
      }
    },
  });
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
      () => this.context?.agentSelection,
      (selection, notify) => selection.subscribe(notify),
    )
    .watch(
      () => this.context?.nativeDeviceSettings ?? undefined,
      (nativeDeviceSettings, notify) => nativeDeviceSettings.subscribe(notify),
    )
    .watch(
      () => this.context?.nativeNotifications ?? undefined,
      (nativeNotifications, notify) => nativeNotifications.subscribe(notify),
    )
    .watch(
      () => this.context?.webPush,
      (webPush, notify) => webPush.subscribe(notify),
    )
    .watch(
      () => this.context?.theme,
      (theme, notify) => theme.subscribe(notify),
      () => {
        this.settings = this.customThemeImportOwner.adoptSettings(
          this.settings,
          loadSettings(),
          this.context.theme.serverSelection,
        );
      },
    );
  private readonly hiddenSessionCatalogsChanged = () => {
    this.hiddenSessionCatalogIds = loadStoredHiddenSessionCatalogIds();
  };

  private retireMediaPermissionRequests() {
    this.microphoneRefreshRequestsPermission = false;
    this.cameraRefreshRequestsPermission = false;
  }

  override connectedCallback() {
    super.connectedCallback();
    this.hiddenSessionCatalogsChanged();
    window.addEventListener(
      SIDEBAR_HIDDEN_SESSION_CATALOGS_CHANGED_EVENT,
      this.hiddenSessionCatalogsChanged,
    );
    this.customThemeImportOwner.connect(
      this.context.gateway.connection.gatewayUrl,
      this.context.theme.serverSelection,
    );
    this.settings = loadSettings();
    // Passive refresh only: the media rows already own the permission prompt
    // behind their own controls, and a hardware change must never turn into an
    // unasked-for browser dialog on a settings page.
    this.mediaDeviceWatch = observeRealtimeTalkDevices(() => {
      void this.refreshMicrophones(false);
      void this.refreshCameras(false);
    });
    this.syncRouteData();
  }

  override disconnectedCallback() {
    window.removeEventListener(
      SIDEBAR_HIDDEN_SESSION_CATALOGS_CHANGED_EVENT,
      this.hiddenSessionCatalogsChanged,
    );
    this.customThemeImportOwner.retireImport();
    this.retireMediaPermissionRequests();
    this.mediaDeviceWatch?.();
    this.mediaDeviceWatch = null;
    this.systemInfoPolling.stop();
    this.updateCountdownPolling.stop();
    this.invalidateSystemInfoRequest();
    this.runtimeConfigSource = null;
    this.resetConfigViewState();
    this.systemInfoGatewaySource = null;
    this.systemInfoClient = null;
    this.updateStatusClient = null;
    this.subscriptions.clear();
    super.disconnectedCallback();
  }

  override willUpdate(changed: PropertyValues) {
    if (changed.get("pageId") === "appearance" && this.pageId !== "appearance") {
      this.customThemeImportOwner.retireImport();
      this.retireMediaPermissionRequests();
    }
    if (changed.has("pageId") || changed.has("routeData")) {
      this.syncRouteData();
    }
  }

  override updated(changed: PropertyValues) {
    const pageChanged = changed.has("pageId") && changed.get("pageId") !== undefined;
    if (pageChanged) {
      this.invalidateSystemInfoRequest();
    }
    this.syncSystemInfoPolling();
    this.syncUpdateStatusRefresh();
    this.syncUpdateCountdownPolling();
    this.scrollToPendingRouteTarget();
    // Device labels stay hidden until the user grants media permission; each
    // picker requests its permission explicitly when opened.
    if (this.pageId === "appearance" && !this.microphoneLoaded) {
      this.microphoneLoaded = true;
      void this.refreshMicrophones(false);
    }
    if (this.pageId === "appearance" && !this.cameraLoaded) {
      this.cameraLoaded = true;
      void this.refreshCameras(false);
    }
  }

  private async refreshMicrophones(requestPermission: boolean) {
    if (this.microphoneLoading) {
      this.microphoneRefreshRequestsPermission ||= requestPermission;
      return;
    }
    this.microphoneLoading = true;
    this.microphoneRefreshRequestsPermission = requestPermission;
    this.microphoneError = null;
    try {
      const result = await discoverRealtimeTalkInputs(
        () => this.microphoneRefreshRequestsPermission,
      );
      this.microphoneDevices = result.devices;
      this.microphonePermissionRequired = result.permissionRequired;
      this.microphoneError = result.issue
        ? realtimeTalkDeviceIssueMessage(result.issue, "audioinput")
        : null;
    } catch (error) {
      // Discovery is best-effort in blocked/inactive contexts; a rejection
      // must not wedge the picker in its loading state.
      this.microphoneError = formatUiError(error);
    } finally {
      this.microphoneLoading = false;
      this.microphoneRefreshRequestsPermission = false;
    }
  }

  private async refreshCameras(requestPermission: boolean) {
    if (this.cameraLoading) {
      this.cameraRefreshRequestsPermission ||= requestPermission;
      return;
    }
    this.cameraLoading = true;
    this.cameraRefreshRequestsPermission = requestPermission;
    this.cameraError = null;
    try {
      const result = await discoverRealtimeTalkCameras(() => this.cameraRefreshRequestsPermission);
      this.cameraDevices = result.devices;
      this.cameraPermissionRequired = result.permissionRequired;
      this.cameraError = result.issue
        ? realtimeTalkDeviceIssueMessage(result.issue, "videoinput")
        : null;
    } catch (error) {
      this.cameraError = formatUiError(error);
    } finally {
      this.cameraLoading = false;
      this.cameraRefreshRequestsPermission = false;
    }
  }

  private syncRouteData() {
    // Pre-restructure deep links: sections that moved to their own page must
    // redirect before normalization discards them from the old page's list.
    const rawSection = this.routeData
      ? this.routeData.section
      : new URLSearchParams(globalThis.location?.search ?? "").get("section");
    if (rawSection) {
      const movedRoute = MOVED_SECTION_ROUTES[`${this.pageId}:${rawSection}`];
      if (movedRoute) {
        this.context?.navigate(movedRoute.routeId, {
          search: movedRoute.keepSection ? `?section=${encodeURIComponent(rawSection)}` : "",
          hash: globalThis.location?.hash ?? "",
        });
        return;
      }
    }
    const selection = this.routeData
      ? normalizeConfigSelection(this.pageId, this.routeData.section, null)
      : configSelectionFromSearch(this.pageId, globalThis.location?.search ?? "");
    this.selections = { ...this.selections, [this.pageId]: selection };
    const targetBlockId =
      this.routeData?.targetBlockId ?? configTargetIdFromHash(globalThis.location?.hash ?? "");
    this.pendingRouteTargetId = targetBlockId;
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
    target.scrollIntoView?.({ behavior: resolveScrollBehavior(), block: "start" });
    this.pendingRouteTargetId = null;
  }

  private isSystemInfoVisible(): boolean {
    // Appearance still uses system.info to show the Session Observer's server-resolved utility
    // model. Gateway host polling itself belongs exclusively to the Connection page.
    return this.pageId === "appearance";
  }

  private syncUpdateCountdownPolling() {
    const campaign = this.context?.overlays.snapshot.updateSchedule?.campaign;
    if (
      this.pageId === "updates" &&
      (campaign?.state === "countdown" || campaign?.state === "waiting-for-idle")
    ) {
      this.updateCountdownPolling.start();
      return;
    }
    this.updateCountdownPolling.stop();
  }

  private syncUpdateStatusRefresh() {
    const gateway = this.context.gateway.snapshot;
    const client =
      this.pageId === "updates" &&
      gateway.phase === "connected" &&
      canCallGatewayMethod(gateway, "update.status", "operator.admin")
        ? gateway.client
        : null;
    if (client === this.updateStatusClient) {
      return;
    }
    this.updateStatusClient = client;
    if (client) {
      void this.context.overlays.refreshUpdateStatus();
    }
  }

  private synchronizeRuntimeConfig(runtimeConfig: ApplicationContext["runtimeConfig"]) {
    if (runtimeConfig !== this.runtimeConfigSource) {
      if (this.runtimeConfigSource) {
        this.customThemeImportOwner.retireImport();
      }
      this.runtimeConfigSource = runtimeConfig;
      this.resetConfigViewState();
    }
    const config = runtimeConfig.state;
    if (!config.configSnapshot && !config.configLoading) {
      void runtimeConfig
        .ensureLoaded()
        .then(() =>
          this.runtimeConfigSource === runtimeConfig && this.pageId !== "updates"
            ? runtimeConfig.ensureSchemaLoaded()
            : undefined,
        )
        .catch(() => undefined);
      return;
    }
    if (this.pageId !== "updates" && !config.configSchema && !config.configSchemaLoading) {
      void runtimeConfig.ensureSchemaLoaded().catch(() => undefined);
    }
  }

  private synchronizeSystemInfoGateway(gateway: ApplicationContext["gateway"]) {
    this.customThemeImportOwner.synchronizeScope(
      gateway.connection.gatewayUrl,
      this.context.theme.serverSelection,
    );
    if (gateway !== this.systemInfoGatewaySource) {
      this.systemInfoPolling.stop();
      this.invalidateSystemInfoRequest();
      this.systemInfoGatewaySource = gateway;
      this.resetConfigViewState();
      this.systemInfoClient = null;
      this.updateStatusClient = null;
      this.systemInfo = null;
      this.systemInfoUnavailable = false;
      this.resetSessionObserverModels();
    }
    this.handleSystemInfoGatewaySnapshot(gateway.snapshot);
    this.syncUpdateStatusRefresh();
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
      this.resetSessionObserverModels();
    } else if (snapshot.phase !== "connected") {
      this.invalidateSystemInfoRequest();
      this.systemInfo = null;
    }
    if (snapshot.phase === "connected" && snapshot.hello) {
      this.systemInfoUnavailable = !hasSystemInfo;
      if (!hasSystemInfo) {
        this.invalidateSystemInfoRequest();
        this.systemInfo = null;
      }
    }
    this.syncSystemInfoPolling(clientChanged);
  }

  private syncSystemInfoPolling(forceRefresh = false) {
    const gateway = this.context.gateway.snapshot;
    const shouldPoll =
      this.isConnected &&
      this.isSystemInfoVisible() &&
      !this.systemInfoUnavailable &&
      gateway.phase === "connected" &&
      supportsSystemInfo(gateway.hello) &&
      gateway.client != null;
    if (!shouldPoll) {
      this.systemInfoPolling.stop();
      return;
    }
    if (this.systemInfoPolling.start() || forceRefresh) {
      void this.systemInfoTask.run();
    }
  }

  private invalidateSystemInfoRequest() {
    void this.systemInfoTask.run([null, null]);
    void this.sessionObserverModelsTask.run([null, null, null]);
    this.resetSessionObserverModels();
  }

  private systemInfoRequestClient(): GatewayBrowserClient | null {
    const gatewaySource = this.systemInfoGatewaySource;
    const gateway = gatewaySource?.snapshot;
    if (
      !gatewaySource ||
      !gateway ||
      !this.isConnected ||
      !this.isSystemInfoVisible() ||
      this.context.gateway !== gatewaySource ||
      gateway.phase !== "connected" ||
      !supportsSystemInfo(gateway.hello) ||
      this.systemInfoUnavailable
    ) {
      return null;
    }
    return gateway.client;
  }

  private resetSessionObserverModels(unavailable = false) {
    this.sessionObserverModels = [];
    this.sessionObserverModelsUnavailable = unavailable;
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

  private applySettings(patch: Partial<UiSettings>) {
    this.settings = patchSettings(patch);
    applyTextScale(this.settings.textScale);
    // theme.refresh() also republishes non-theme appearance prefs (text
    // scale, lobster pet visits/sounds) to app-host subscribers.
    this.context.theme.refresh();
  }

  private setLocale(locale: Locale | undefined) {
    if (locale === undefined) {
      this.resetLocale();
      return;
    }
    this.settings = patchSettings({ locale });
    void i18n.setLocale(locale);
  }

  private currentSyncedPref<K extends ResettableServerUiPrefKey>(key: K) {
    return resolveServerUiPrefState(
      this.context.runtimeConfig.state.configSnapshot?.config,
      key,
      this.context.gateway.connection.gatewayUrl,
      this.settings,
      isAppearancePref(key)
        ? {
            canSync: this.serverUiPrefsCanSync(key),
            profileId: this.context.gateway.snapshot?.selfUser?.id,
          }
        : { canSync: this.serverUiPrefsCanSync() },
    );
  }

  private setFont(key: "fontUi" | "fontChat", font: TypefaceId | undefined) {
    const preference = this.currentSyncedPref(key);
    if (preference.overridden && font === preference.resetValue) {
      this.resetSyncedAppearancePref(key);
    } else {
      this.applySettings({ [key]: font });
    }
  }

  private serverUiPrefsCanSync(
    key?: "theme" | "themeMode" | "accent" | "fontUi" | "fontChat",
  ): boolean | null {
    const runtimeConfig = this.context.runtimeConfig;
    if (!runtimeConfig.state.connected) {
      return null;
    }
    const gateway = this.context.gateway.snapshot;
    if ((key === "fontUi" || key === "fontChat") && !gateway?.selfUser) {
      return false;
    }
    return key && gateway?.selfUser
      ? hasOperatorWriteAccess(gateway.hello?.auth ?? null)
      : runtimeConfig.canPatch !== false;
  }

  private resetLocale() {
    this.settings = resetServerUiPref(
      "locale",
      this.currentSyncedPref("locale"),
      this.context.gateway.connection.gatewayUrl,
    );
    if (isSupportedLocale(this.settings.locale)) {
      void i18n.setLocale(this.settings.locale);
    } else {
      void i18n.useSystemLocale();
    }
  }

  private resetSyncedAppearancePref(key: Exclude<ResettableServerUiPrefKey, "locale">) {
    this.settings = resetServerUiPref(
      key,
      this.currentSyncedPref(key),
      this.context.gateway.connection.gatewayUrl,
    );
    this.context.theme.refresh();
  }

  private setTheme(
    theme: ThemeName,
    context?: Parameters<typeof startThemeTransition>[0]["context"],
  ) {
    const preference = this.currentSyncedPref("theme");
    const reset = preference.overridden && theme === preference.resetValue;
    this.customThemeImportOwner.recordActivation(reset ? null : theme);
    const currentTheme = resolveTheme(this.settings.theme, this.settings.themeMode);
    startThemeTransition({
      currentTheme,
      nextTheme: resolveTheme(theme, this.settings.themeMode),
      context,
      applyTheme: () =>
        reset ? this.resetSyncedAppearancePref("theme") : this.applySettings({ theme }),
    });
  }

  private setThemeMode(
    mode: ThemeMode,
    context?: Parameters<typeof startThemeTransition>[0]["context"],
  ) {
    const preference = this.currentSyncedPref("themeMode");
    const reset = preference.overridden && mode === preference.resetValue;
    const currentTheme = resolveTheme(this.settings.theme, this.settings.themeMode);
    startThemeTransition({
      currentTheme,
      nextTheme: resolveTheme(this.settings.theme, mode),
      context,
      applyTheme: () =>
        reset
          ? this.resetSyncedAppearancePref("themeMode")
          : this.applySettings({ themeMode: mode }),
    });
  }

  private setSetting<K extends ConfigPageSetting>(key: K, value: UiSettings[K]) {
    this.applySettings({ [key]: value });
  }

  private selectMicrophone(deviceId: string) {
    this.applySettings({
      realtimeTalkInputDeviceId: deviceId.trim() || undefined,
    });
  }

  private async selectCamera(deviceId: string) {
    const request = ++this.cameraSelectionRequest;
    const videoDeviceId = deviceId.trim() || undefined;
    this.cameraError = null;
    try {
      await switchActiveRealtimeTalkCameras(videoDeviceId);
      if (request !== this.cameraSelectionRequest) {
        return;
      }
      // Persist only a camera the active Talk session accepted. A superseded
      // request must not overwrite the newer confirmed selection.
      this.applySettings({
        realtimeTalkVideoDeviceId: videoDeviceId,
      });
    } catch (error) {
      if (request === this.cameraSelectionRequest) {
        this.cameraError = formatUiError(error);
      }
    }
  }

  private async importCustomTheme() {
    await this.customThemeImportOwner.import({
      config: this.context.runtimeConfig.state,
      hasCustomTheme: Boolean(this.settings.customTheme),
      load: importCustomThemeFromUrl,
      apply: (customTheme, activate) =>
        this.applySettings({
          customTheme,
          theme: activate ? "custom" : this.settings.theme,
        }),
      messages: {
        blocked: (reason) => t(reason === "loading" ? "common.loading" : "common.unsavedChanges"),
        imported: (label) => t("configPage.themeImported", { name: label }),
      },
    });
  }

  private clearCustomTheme() {
    this.customThemeImportOwner.clear({
      apply: () =>
        this.applySettings({
          theme: this.settings.theme === "custom" ? "claw" : this.settings.theme,
          customTheme: undefined,
        }),
      message: t("configPage.themeRemoved"),
    });
  }

  private includeSections(): readonly string[] | undefined {
    return configSectionKeysForPage(this.pageId);
  }

  private isUpdateBusy(): boolean {
    const update = this.context.overlays.snapshot;
    return (
      update.updateRunning || update.updateStatusRefreshing || update.updateReconciliationPending
    );
  }

  // The update dialog outlives this page and the connection, so it reads live
  // snapshots rather than the values captured during a render.
  private readonly watchUpdateProgress = (listener: (progress: UpdateProgress) => void) =>
    createUpdateProgressWatcher(this.context)(listener);

  private isCuratedConfigMutationDisabled(): boolean {
    const runtimeState = this.context.runtimeConfig.state;
    return (
      !runtimeState.connected ||
      runtimeState.configLoading ||
      runtimeState.configSaving ||
      runtimeState.configApplying ||
      this.isUpdateBusy() ||
      !this.context.runtimeConfig.canSet ||
      !hasOperatorAdminAccess(this.context.gateway.snapshot.hello?.auth ?? null)
    );
  }

  private renderAdvancedConfig(configObject: Record<string, unknown>) {
    const runtimeConfig = this.context.runtimeConfig;
    const configState = runtimeConfig.state;
    if (this.pageId === "updates") {
      const gatewaySnapshot = this.context.gateway.snapshot;
      const overlaySnapshot = this.context.overlays.snapshot;
      const canAdmin = hasOperatorAdminAccess(gatewaySnapshot.hello?.auth ?? null);
      return renderUpdates({
        nativeDeviceSettings: this.context.nativeDeviceSettings,
        configObject,
        gatewayVersion:
          this.context.config.current.serverVersion ??
          gatewaySnapshot.hello?.server?.version ??
          null,
        controlUiCommit: CONTROL_UI_BUILD_INFO.commit,
        controlUiCommitAt: CONTROL_UI_BUILD_INFO.commitAt,
        controlUiBuiltAt: CONTROL_UI_BUILD_INFO.builtAt,
        schedule: overlaySnapshot.updateSchedule,
        heldUpdateCampaignId: overlaySnapshot.heldUpdateCampaignId,
        updateAvailable: overlaySnapshot.updateAvailable,
        statusBanner: overlaySnapshot.updateStatusBanner,
        run: overlaySnapshot.updateRun,
        connected: gatewaySnapshot.phase === "connected",
        configBusy: this.isCuratedConfigMutationDisabled(),
        canAdmin,
        canUpdate: canCallGatewayMethod(gatewaySnapshot, "update.run", "operator.admin"),
        canCheckStatus: canCallGatewayMethod(gatewaySnapshot, "update.status", "operator.admin"),
        canHoldUpdate: canCallGatewayMethod(gatewaySnapshot, "update.hold", "operator.admin"),
        updateBusy: this.isUpdateBusy(),
        onChannelChange: (channel) => runtimeConfig.patchForm(["update", "channel"], channel),
        onUpdateChecksChange: (enabled) =>
          runtimeConfig.patchForm(["update", "checkOnStart"], enabled),
        onAutomaticUpdatesChange: (enabled) =>
          runtimeConfig.patchForm(["update", "auto", "enabled"], enabled),
        onUpdateNow: () =>
          void confirmAndStartUpdate({
            startGatewayUpdate: () => void this.context.overlays.runUpdate(),
            watchUpdateProgress: this.watchUpdateProgress,
            onCheckStatus: () => this.context.overlays.refreshUpdateStatus(),
            onAcknowledge: () => this.context.overlays.acknowledgeUpdateRun(),
            updateAvailable: overlaySnapshot.updateAvailable,
            updateSchedule: overlaySnapshot.updateSchedule,
            // This row has no native-decline listener, so a handoff the Mac app
            // refuses would end in silence. Keep it on the Gateway route.
            viaNativeApp: false,
          }),
        onHoldUpdate: () => this.context.overlays.holdUpdate(),
        onCheckStatus: () => this.context.overlays.refreshUpdateStatus(),
      });
    }
    const includeSections = this.includeSections();
    // Advanced shows everything without a curated home elsewhere.
    const excludeSections =
      this.pageId === "advanced" ? [...SCOPED_CONFIG_SECTION_KEYS] : undefined;
    const selection = normalizeConfigSelection(
      this.pageId,
      this.selections[this.pageId].activeSection,
      this.selections[this.pageId].activeSubsection,
    );
    const activeSection = this.pageId === "mcp" ? "mcp" : selection.activeSection;
    const browserPanelAvailable = isBrowserPanelAvailable(this.context.gateway.snapshot);
    const activeSubsection = this.pageId === "mcp" ? null : selection.activeSubsection;
    const gatewayConfig = asConfigRecord(configObject.gateway);
    const controlUiConfig = asConfigRecord(gatewayConfig?.controlUi);
    const agentsDefaults = asConfigRecord(asConfigRecord(configObject.agents)?.defaults);
    const themePref = this.currentSyncedPref("theme");
    const themeModePref = this.currentSyncedPref("themeMode");
    const accentPref = this.currentSyncedPref("accent");
    const localePref = this.currentSyncedPref("locale");
    const chatSendShortcutPref = this.currentSyncedPref("chatSendShortcut");
    const chatFollowUpModePref = this.currentSyncedPref("chatFollowUpMode");
    const sessionObserverBusy =
      !configState.connected ||
      configState.configSaving ||
      configState.configApplying ||
      this.isUpdateBusy() ||
      !hasOperatorAdminAccess(this.context.gateway.snapshot.hello?.auth ?? null);
    const props: ConfigProps = {
      raw: configState.configRaw,
      originalRaw: configState.configRawOriginal,
      valid: configState.configValid,
      issues: configState.configIssues,
      loading: configState.configLoading,
      saving: configState.configSaving,
      applying: configState.configApplying,
      updating: this.isUpdateBusy(),
      connected: configState.connected,
      mutationAllowed: runtimeConfig.canSet,
      openFileAllowed: runtimeConfig.canOpenFile,
      schema: configState.configSchema,
      schemaLoading: configState.configSchemaLoading,
      uiHints: configState.configUiHints,
      formMode: this.formModes[this.pageId],
      rawDraftPending: configState.configFormMode === "raw" && configState.configFormDirty,
      viewState: this.configViewState,
      rawAvailable: Boolean(
        configState.configSnapshot?.config || configState.configForm || configState.configRaw,
      ),
      showModeToggle: this.pageId === "advanced",
      formValue: configState.configForm,
      originalValue: configState.configFormOriginal,
      activeSection,
      activeSubsection,
      onRawChange: (next) => {
        this.customThemeImportOwner.retireForConfigMutation(t("common.unsavedChanges"));
        runtimeConfig.setRaw(next);
      },
      onFormModeChange: (mode) => this.setFormMode(mode),
      onViewStateChange: () => this.requestUpdate(),
      onFormPatch: (path, value) => {
        this.customThemeImportOwner.retireForConfigMutation(t("common.unsavedChanges"));
        runtimeConfig.patchForm(path, value);
      },
      onFormRemove: (path) => {
        this.customThemeImportOwner.retireForConfigMutation(t("common.unsavedChanges"));
        runtimeConfig.removeFormValue(path);
      },
      onSectionChange: (section) => this.setActiveSection(section),
      onSubsectionChange: (section) => this.setActiveSubsection(section),
      onSave: () => void runtimeConfig.save(),
      onRawDiscard: () => void runtimeConfig.discardDraft(),
      onOpenFile: () => void runtimeConfig.openFile(),
      version:
        this.context.config.current.serverVersion ??
        this.context.gateway.snapshot.hello?.server?.version ??
        "",
      theme: this.settings.theme,
      themeOverridden: themePref.overridden,
      themeProvenance: themePref.provenance,
      themeResetValue: themePref.resetValue ?? UI_APPEARANCE_DEFAULTS.theme,
      themeMode: this.settings.themeMode,
      themeModeOverridden: themeModePref.overridden,
      themeModeProvenance: themeModePref.provenance,
      themeModeResetValue: themeModePref.resetValue ?? UI_APPEARANCE_DEFAULTS.themeMode,
      accent: this.settings.accent,
      accentProvenance: accentPref.provenance,
      accentResetValue: accentPref.resetValue,
      fontUi: this.settings.fontUi,
      fontChat: this.settings.fontChat,
      fontUiProvenance: this.currentSyncedPref("fontUi").provenance,
      fontChatProvenance: this.currentSyncedPref("fontChat").provenance,
      setFontUi: (font) => this.setFont("fontUi", font),
      setFontChat: (font) => this.setFont("fontChat", font),
      systemLocale: i18n.getSystemLocale(),
      localeOverride: isSupportedLocale(localePref.value) ? localePref.value : undefined,
      localeOverridden: localePref.overridden,
      localeProvenance: localePref.provenance,
      localeResetValue: isSupportedLocale(localePref.resetValue)
        ? localePref.resetValue
        : undefined,
      onLocaleChange: (locale) => this.setLocale(locale),
      setTheme: (theme, transitionContext) => this.setTheme(theme, transitionContext),
      setThemeMode: (mode, transitionContext) => this.setThemeMode(mode, transitionContext),
      setAccent: (accent) =>
        accent === undefined
          ? this.resetSyncedAppearancePref("accent")
          : this.applySettings({ accent }),
      hasCustomTheme: Boolean(this.settings.customTheme),
      customThemeLabel: this.settings.customTheme?.label ?? null,
      customThemeSourceUrl: this.settings.customTheme?.sourceUrl ?? null,
      customThemeImportUrl: this.customThemeImport.url,
      customThemeImportBusy: this.customThemeImport.busy,
      customThemeImportMessage: this.customThemeImport.message,
      customThemeImportExpanded: this.customThemeImport.expanded,
      customThemeImportFocusToken: this.customThemeImport.focusToken,
      onCustomThemeImportUrlChange: (next) => this.customThemeImportOwner.setUrl(next),
      onImportCustomTheme: () => void this.importCustomTheme(),
      onClearCustomTheme: () => this.clearCustomTheme(),
      onOpenCustomThemeImport: () => this.customThemeImportOwner.open(),
      textScale: this.settings.textScale ?? UI_APPEARANCE_DEFAULTS.textScale,
      textScaleOverridden: this.settings.textScale !== undefined,
      setTextScale: (value) =>
        this.setSetting(
          "textScale",
          value === UI_APPEARANCE_DEFAULTS.textScale ? undefined : normalizeTextScale(value),
        ),
      sidebarLiveActivity:
        this.settings.sidebarLiveActivity ?? UI_APPEARANCE_DEFAULTS.sidebarLiveActivity,
      setSidebarLiveActivity: (enabled) => this.setSetting("sidebarLiveActivity", enabled),
      hiddenSessionCatalogIds: this.hiddenSessionCatalogIds,
      hiddenSessionCatalogLabels:
        this.hiddenSessionCatalogLabelsTask.status === TaskStatus.COMPLETE
          ? (this.hiddenSessionCatalogLabelsTask.value ?? EMPTY_SESSION_CATALOG_LABELS)
          : EMPTY_SESSION_CATALOG_LABELS,
      setSessionCatalogHidden: setStoredSessionCatalogHidden,
      chatMessageMaxWidth: this.settings.chatMessageMaxWidth,
      setChatMessageMaxWidth: (value) => this.setSetting("chatMessageMaxWidth", value),
      chatCollapseTaskProgress: this.settings.chatCollapseTaskProgress === true,
      setChatCollapseTaskProgress: (enabled) =>
        this.setSetting("chatCollapseTaskProgress", enabled),
      showAdvancedSettings: this.settings.showAdvancedSettings === true,
      setShowAdvancedSettings: (enabled) => this.setSetting("showAdvancedSettings", enabled),
      forceShowAdvanced: this.pageId === "advanced",
      forceAdvancedSection: this.routeData?.advanced ? this.routeData.section : null,
      sessionObserverEnabled: controlUiConfig?.sessionObserver !== false,
      sessionObserverUtilityModel:
        typeof agentsDefaults?.utilityModel === "string" ? agentsDefaults.utilityModel : undefined,
      sessionObserverResolvedModel: this.systemInfo?.defaultAgentUtilityModel,
      sessionObserverModels: this.sessionObserverModels,
      sessionObserverModelsUnavailable: this.sessionObserverModelsUnavailable,
      sessionObserverDisabled: sessionObserverBusy,
      setSessionObserverEnabled: (enabled) => {
        void runtimeConfig.patch({
          raw: buildSessionObserverTogglePatch(enabled),
          note: t("configView.sessionObserver.toggleNote"),
        });
      },
      setSessionObserverUtilityModel: (modelSelection) => {
        void runtimeConfig
          .patch({
            raw: buildSessionObserverUtilityModelPatch(modelSelection),
            note: t("configView.sessionObserver.modelNote"),
          })
          .then((saved) => {
            if (saved) {
              void this.systemInfoTask.run();
            }
          });
      },
      lobsterPetVisits: this.settings.lobsterPetVisits ?? UI_APPEARANCE_DEFAULTS.lobsterPetVisits,
      setLobsterPetVisits: (enabled) => this.applySettings({ lobsterPetVisits: enabled }),
      sessionDeleteConfirm:
        this.settings.sessionDeleteConfirm ?? UI_APPEARANCE_DEFAULTS.sessionDeleteConfirm,
      setSessionDeleteConfirm: (enabled) => this.applySettings({ sessionDeleteConfirm: enabled }),
      lobsterPetSounds: this.settings.lobsterPetSounds ?? UI_APPEARANCE_DEFAULTS.lobsterPetSounds,
      setLobsterPetSounds: (enabled) => this.applySettings({ lobsterPetSounds: enabled }),
      lobsterdexHref: pathForRoute("lobsterdex", this.context.basePath),
      onOpenLobsterdex: () => this.context.navigate("lobsterdex"),
      chatSendShortcut: normalizeChatSendShortcut(this.settings.chatSendShortcut),
      chatSendShortcutOverridden: chatSendShortcutPref.overridden,
      chatSendShortcutProvenance: chatSendShortcutPref.provenance,
      chatSendShortcutResetValue:
        chatSendShortcutPref.resetValue ?? UI_APPEARANCE_DEFAULTS.chatSendShortcut,
      setChatSendShortcut: (value) => this.setSetting("chatSendShortcut", value),
      chatFollowUpMode: this.settings.chatFollowUpMode,
      chatFollowUpModeOverridden: chatFollowUpModePref.overridden,
      chatFollowUpModeProvenance: chatFollowUpModePref.provenance,
      serverQueueMode: configState.configSnapshot
        ? resolveControlUiServerQueueMode(configState.configSnapshot.runtimeConfig, {
            configNeedsApply: configState.configNeedsApply,
          })
        : undefined,
      setChatFollowUpMode: (value) => this.setSetting("chatFollowUpMode", value),
      resetChatFollowUpMode: () => this.resetSyncedAppearancePref("chatFollowUpMode"),
      catalogOpenTarget: normalizeCatalogOpenTarget(this.settings.catalogOpenTarget),
      setCatalogOpenTarget: (value) => this.setSetting("catalogOpenTarget", value),
      microphone: {
        devices: this.microphoneDevices,
        permissionRequired: this.microphonePermissionRequired,
        selectedDeviceId: this.settings.realtimeTalkInputDeviceId ?? "",
        loading: this.microphoneLoading,
        error: this.microphoneError,
      },
      composerHoldToRecord: this.settings.composerHoldToRecord !== false,
      setComposerHoldToRecord: (enabled) => this.setSetting("composerHoldToRecord", enabled),
      onMicrophoneRefresh: () => void this.refreshMicrophones(true),
      onMicrophoneSelect: (deviceId) => this.selectMicrophone(deviceId),
      camera: {
        devices: this.cameraDevices,
        permissionRequired: this.cameraPermissionRequired,
        selectedDeviceId: this.settings.realtimeTalkVideoDeviceId ?? "",
        loading: this.cameraLoading,
        error: this.cameraError,
      },
      onCameraRefresh: () => void this.refreshCameras(true),
      onCameraSelect: (deviceId) => void this.selectCamera(deviceId),
      gatewayUrl: this.context.gateway.connection.gatewayUrl,
      assistantName: this.context.config.current.assistantIdentity.name,
      configPath: configState.configSnapshot?.path ?? null,
      navRootLabel: this.pageId === "advanced" ? undefined : configPageTitle(this.pageId),
      showSectionDocs: this.pageId !== "communications",
      sectionPrelude:
        activeSection === "browser" && browserPanelAvailable
          ? renderBrowserLinkPreferencesRow({
              enabled: this.settings.openLinksInControlUiBrowser === true,
              onChange: (enabled) => this.setSetting("openLinksInControlUiBrowser", enabled),
            })
          : undefined,
      showRootTab: !includeSections?.length,
      includeSections: includeSections ? [...includeSections] : undefined,
      excludeSections,
      includeVirtualSections: this.pageId === "appearance" || this.pageId === "notifications",
      settingsLayout: this.pageId === "advanced" ? "accordion" : undefined,
      nativeNotifications: this.context.nativeNotifications?.snapshot,
      onNativeNotificationsRequestPermission: () =>
        this.context.nativeNotifications?.requestPermission(),
      onNativeNotificationsSendTest: () => this.context.nativeNotifications?.sendTest(),
      webPush: this.context.webPush.snapshot,
      onWebPushSubscribe: () => void this.context.webPush.run({ kind: "enable" }),
      onWebPushUnsubscribe: () => void this.context.webPush.run({ kind: "disable" }),
      onWebPushTest: () => void this.context.webPush.run({ kind: "test" }),
      onWebPushSetUserPreferences: (preferences) =>
        void this.context.webPush.run({ kind: "set", scope: "user", preferences }),
      onWebPushSetDevicePreferences: (preferences) =>
        void this.context.webPush.run({ kind: "set", scope: "device", preferences }),
    };
    if (this.pageId === "mcp") {
      return renderMcp({
        configObject,
        pluginsHref: pathForRoute("plugins", this.context.basePath),
        editor: renderConfig({
          ...props,
          activeSection: "mcp",
          activeSubsection: null,
          showModeToggle: false,
          embeddedEditor: true,
          navRootLabel: "MCP",
        }),
      });
    }
    if (this.pageId === "memory") {
      return renderMemoryPage({
        configObject,
        mutationDisabled: this.isCuratedConfigMutationDisabled(),
        pluginsHref: pathForRoute("plugins", this.context.basePath),
        memoryImportHref: pathForRoute("memory-import", this.context.basePath),
        routeData: this.routeData,
        buildEditor: (keys) =>
          renderConfig({
            ...props,
            schema: narrowMemorySchema(props.schema, keys),
            activeSection: "memory",
            activeSubsection: null,
            showModeToggle: false,
            embeddedEditor: true,
            navRootLabel: t("tabs.memory"),
          }),
      });
    }
    if (this.pageId === "talk") {
      return renderTalkPage({
        configObject,
        mutationDisabled: this.isCuratedConfigMutationDisabled(),
        buildEditor: () =>
          renderConfig({
            ...props,
            activeSection: "talk",
            activeSubsection: null,
            showModeToggle: false,
            embeddedEditor: true,
            navRootLabel: t("tabs.talk"),
          }),
      });
    }
    if (this.pageId === "security") {
      const runtimeState = runtimeConfig.state;
      const configBusy = this.isCuratedConfigMutationDisabled();
      return renderSecurity({
        security: extractQuickSettingsSecurity(configObject),
        configBusy,
        canPairDevice:
          runtimeState.connected &&
          hasOperatorAdminAccess(this.context.gateway.snapshot.hello?.auth ?? null),
        onPairMobile: () => void this.context.overlays.openDevicePairSetup(),
        onBrowserEnabledToggle: (enabled) => {
          if (enabled) {
            runtimeConfig.removeFormValue(["browser", "enabled"]);
            return;
          }
          runtimeConfig.patchForm(["browser", "enabled"], false);
        },
        onToolProfileChange: (profile) => {
          if (profile === "full") {
            runtimeConfig.removeFormValue(["tools", "profile"]);
            return;
          }
          runtimeConfig.patchForm(["tools", "profile"], profile);
        },
        editor: renderConfig({ ...props, embeddedEditor: true }),
      });
    }
    return renderConfig(props);
  }

  override render() {
    const configState = this.context.runtimeConfig.state;
    const configObject =
      asConfigRecord(configState.configForm ?? configState.configSnapshot?.config) ?? {};
    const body = this.renderAdvancedConfig(configObject);
    return html`
      ${
        this.pageId === "memory"
          ? nothing
          : html`
              ${renderSettingsPageHeader({
                title: configPageTitle(this.pageId),
                subtitle: renderConfigPageSubtitle(this.pageId),
              })}
            `
      }
      ${renderSettingsWorkspace(body)}
    `;
  }
}

if (!customElements.get("openclaw-config-page")) {
  customElements.define("openclaw-config-page", ConfigPage);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
