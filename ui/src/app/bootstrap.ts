import type { RouteLocation } from "@openclaw/uirouter";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  createApplicationRouter,
  locationForRoute,
  pathForRoute,
  routeIdFromPath,
  startApplicationRouter,
  type ApplicationRouter,
  type RouteId,
} from "../app-routes.ts";
import { createAgentIdentityCapability } from "../lib/agents/identity.ts";
import { createAgentCapability } from "../lib/agents/index.ts";
import { createChannelCapability } from "../lib/channels/index.ts";
import { createRuntimeConfigCapability } from "../lib/config/index.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import { areUiSessionKeysEquivalentForHost } from "../lib/sessions/session-key.ts";
import { createWorkboardCapability } from "../lib/workboard/capability.ts";
import {
  isDefaultChatLanding,
  locationsMatch,
  startModelSetupFirstRunRedirect,
} from "../pages/model-setup/first-run.ts";
import { createAgentSelectionCapability } from "./agent-selection.ts";
import { resolveApprovalDocumentMode, type ApprovalDocumentMode } from "./approval-deep-link.ts";
import { createBrowserHistory, resolveControlUiBasePath } from "./browser.ts";
import { createApplicationConfigCapability } from "./config.ts";
import type {
  ApplicationNavigationOptions,
  ApplicationContext,
  ApplicationNavigationPreferences,
  ApplicationNavigationPreferencesSnapshot,
  ApplicationSkillWorkshopRevisionHandoff,
  ApplicationTheme,
} from "./context.ts";
import { syncCustomThemeStyleTag } from "./custom-theme.ts";
import { createApplicationGateway } from "./gateway-store.ts";
import { createInitialUserMessageHandoff } from "./initial-user-message-handoff.ts";
import { createNativeChatDrafts } from "./native-bridge.ts";
import { startNativeLinkRouting } from "./native-link-routing.ts";
import { createNativeNotificationsCapability } from "./native-notifications.ts";
import { createApplicationOverlays } from "./overlays.ts";
import {
  loadSettings,
  patchSettings,
  persistSessionToken,
  resolvePageGatewaySettings,
  saveSettings,
  type UiSettings,
} from "./settings.ts";
import { resolveApplicationStartupSettings } from "./startup-settings.ts";
import { startThemeTransition } from "./theme-transition.ts";
import { resolveTheme, type ThemeMode } from "./theme.ts";
import { createWebPushCapability } from "./web-push.ts";

function normalizeInitialApplicationLocation(
  location: RouteLocation,
  basePath: string,
  sessionKey: string,
) {
  const routeId = routeIdFromPath(location.pathname, basePath);
  if (!isDefaultChatLanding(location, basePath, routeIdFromPath) || !sessionKey.trim()) {
    return location;
  }

  const search = new URLSearchParams(location.search);
  if (!search.get("session")?.trim()) {
    search.set("session", sessionKey);
  }
  return {
    ...location,
    pathname: routeId === null ? pathForRoute("chat", basePath) : location.pathname,
    search: `?${search.toString()}`,
  };
}

function applyStartupPresentation(settings: ReturnType<typeof loadSettings>): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const resolvedTheme = resolveTheme(settings.theme, settings.themeMode);
  root.dataset.theme = resolvedTheme;
  root.dataset.themeMode = resolvedTheme.endsWith("light") ? "light" : "dark";
  root.classList.toggle("wa-light", root.dataset.themeMode === "light");
  root.classList.toggle("wa-dark", root.dataset.themeMode === "dark");
  root.style.colorScheme = root.dataset.themeMode;
  root.style.setProperty("--control-ui-text-scale", `${(settings.textScale ?? 100) / 100}`);
  syncCustomThemeStyleTag(settings.customTheme);
}

function createApplicationTheme(
  initialSettings: UiSettings,
): ApplicationTheme & { dispose: () => void } {
  let settings = initialSettings;
  let systemThemeCleanup: (() => void) | undefined;
  const listeners = new Set<() => void>();

  const publish = () => {
    applyStartupPresentation(settings);
    for (const listener of listeners) {
      listener();
    }
  };

  const detachSystemThemeListener = () => {
    systemThemeCleanup?.();
    systemThemeCleanup = undefined;
  };

  const syncSystemThemeListener = () => {
    detachSystemThemeListener();
    if (settings.themeMode !== "system" || typeof globalThis.matchMedia !== "function") {
      return;
    }
    const mediaQuery = globalThis.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => {
      if (settings.themeMode === "system") {
        publish();
      }
    };
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", onChange);
      systemThemeCleanup = () => mediaQuery.removeEventListener("change", onChange);
    } else if (typeof mediaQuery.addListener === "function") {
      mediaQuery.addListener(onChange);
      systemThemeCleanup = () => mediaQuery.removeListener(onChange);
    }
  };

  syncSystemThemeListener();

  return {
    get mode() {
      return settings.themeMode;
    },
    setMode(mode: ThemeMode, element) {
      const currentSettings = loadSettings();
      const nextSettings = { ...currentSettings, themeMode: mode };
      const currentTheme = resolveTheme(currentSettings.theme, currentSettings.themeMode);
      const nextTheme = resolveTheme(nextSettings.theme, nextSettings.themeMode);
      startThemeTransition({
        nextTheme,
        currentTheme,
        context: { element },
        applyTheme: () => {
          settings = patchSettings({ themeMode: mode });
          publish();
          syncSystemThemeListener();
        },
      });
    },
    refresh() {
      settings = loadSettings();
      publish();
      syncSystemThemeListener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      detachSystemThemeListener();
      listeners.clear();
    },
  };
}

function createApplicationNavigationPreferences(
  initialSettings: UiSettings,
): ApplicationNavigationPreferences {
  let settings = initialSettings;
  let snapshot: ApplicationNavigationPreferencesSnapshot = {
    navCollapsed: settings.navCollapsed,
    navWidth: settings.navWidth,
    sidebarEntries: settings.sidebarEntries,
    pinnedAgentIds: settings.pinnedAgentIds ?? [],
  };
  const listeners = new Set<(next: ApplicationNavigationPreferencesSnapshot) => void>();

  return {
    get snapshot() {
      return snapshot;
    },
    update(patch) {
      const nextSnapshot = { ...snapshot, ...patch };
      if (
        nextSnapshot.navCollapsed === snapshot.navCollapsed &&
        nextSnapshot.navWidth === snapshot.navWidth &&
        nextSnapshot.sidebarEntries === snapshot.sidebarEntries &&
        nextSnapshot.pinnedAgentIds === snapshot.pinnedAgentIds
      ) {
        return;
      }
      settings = patchSettings({
        navCollapsed: nextSnapshot.navCollapsed,
        navWidth: nextSnapshot.navWidth,
        sidebarEntries: [...nextSnapshot.sidebarEntries],
        pinnedAgentIds: [...nextSnapshot.pinnedAgentIds],
      });
      snapshot = nextSnapshot;
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function createSkillWorkshopRevisionHandoff(): ApplicationSkillWorkshopRevisionHandoff {
  let pending: Parameters<ApplicationSkillWorkshopRevisionHandoff["prepare"]>[0] | null = null;
  return {
    prepare: (handoff) => {
      pending = handoff;
    },
    consume: (sessionKey) => {
      if (!pending || pending.sessionKey !== sessionKey) {
        return null;
      }
      const handoff = pending;
      pending = null;
      return handoff;
    },
    clear: () => {
      pending = null;
    },
  };
}

export type ApplicationRuntime = {
  readonly context: ApplicationContext<RouteId>;
  readonly router: ApplicationRouter;
  readonly documentMode: ApprovalDocumentMode | null;
  readonly pendingGatewayConnection: {
    readonly gatewayUrl: string;
    readonly token: string;
  } | null;
  readonly confirmPendingGatewayConnection: () => void;
  readonly cancelPendingGatewayConnection: () => void;
  start: () => Promise<void>;
  stop: () => void;
};

export function bootstrapApplication(): ApplicationRuntime {
  const history = createBrowserHistory();
  const startupLocation = history.location();
  const initialBasePath = resolveControlUiBasePath(
    startupLocation.pathname || globalThis.location?.pathname || "/",
  );
  const documentMode = resolveApprovalDocumentMode(startupLocation.pathname, initialBasePath);
  const persistedSettings = loadSettings();
  const initialSettings = documentMode
    ? resolvePageGatewaySettings(persistedSettings)
    : persistedSettings;
  const startup = resolveApplicationStartupSettings(initialSettings, startupLocation);
  if (startup.changed) {
    if (documentMode) {
      persistSessionToken(startup.settings.gatewayUrl, startup.settings.token);
    } else {
      saveSettings(startup.settings);
    }
  }
  const basePath = resolveControlUiBasePath(
    startup.location.pathname || globalThis.location?.pathname || "/",
  );
  const initialLocation = documentMode
    ? startup.location
    : normalizeInitialApplicationLocation(startup.location, basePath, startup.settings.sessionKey);
  const firstRunDefaultLanding =
    documentMode === null && isDefaultChatLanding(startup.location, basePath, routeIdFromPath);
  const expectedDefaultLanding = {
    ...initialLocation,
    pathname: pathForRoute("chat", basePath),
  };
  const currentLocation = history.location();
  if (
    currentLocation.pathname !== initialLocation.pathname ||
    currentLocation.search !== initialLocation.search ||
    currentLocation.hash !== initialLocation.hash
  ) {
    history.replace(initialLocation);
  }

  const settings = startup.settings;
  const gateway = createApplicationGateway(
    settings,
    startup.password ?? "",
    startup.pendingBootstrapToken ?? "",
    undefined,
    { persistDefaultConnectionSettings: documentMode === null },
  );
  const agents = createAgentCapability(gateway);
  const agentIdentity = createAgentIdentityCapability(gateway);
  const agentSelection = createAgentSelectionCapability(gateway);
  const channels = createChannelCapability(gateway);
  const config = createApplicationConfigCapability({
    basePath,
    auth: {
      settings: { token: settings.token },
      password: startup.password ?? "",
    },
  });
  const sessions = createSessionCapability(gateway);
  const workboard = createWorkboardCapability();
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  const overlays = createApplicationOverlays(gateway, {
    drainConfigWrites: () => runtimeConfig.waitForPendingWrites(),
  });
  // App-updater interlock: writing config (or restarting the gateway) while
  // the updater runs can corrupt the install; pause config writes until the
  // update settles. Wired app-lifetime so page unmounts cannot strand it.
  const syncConfigWriteSuspension = () => {
    const update = overlays.snapshot;
    runtimeConfig.setWritesSuspended(update.updateRunning || update.updateReconciliationPending);
  };
  const stopConfigWriteSuspension = overlays.subscribe(syncConfigWriteSuspension);
  syncConfigWriteSuspension();
  const navigation = createApplicationNavigationPreferences(settings);
  const theme = createApplicationTheme(settings);
  const nativeChatDrafts = createNativeChatDrafts();
  const nativeLinkRouting = startNativeLinkRouting();
  const nativeNotifications = createNativeNotificationsCapability();
  const webPush = createWebPushCapability(gateway);
  const skillWorkshopRevision = createSkillWorkshopRevisionHandoff();
  const initialUserMessage = createInitialUserMessageHandoff();
  applyStartupPresentation(settings);
  const router = createApplicationRouter();
  let pendingGatewayConnection =
    startup.pendingGatewayUrl !== null
      ? {
          gatewayUrl: startup.pendingGatewayUrl,
          token: startup.pendingGatewayToken ?? "",
          bootstrapToken: startup.pendingBootstrapToken ?? "",
        }
      : null;
  let lastConfigRefreshClient: GatewayBrowserClient | null = null;
  const stopConfigRefresh = gateway.subscribe((snapshot) => {
    if (!snapshot.connected || !snapshot.client) {
      lastConfigRefreshClient = null;
      return;
    }
    if (lastConfigRefreshClient === snapshot.client) {
      return;
    }
    lastConfigRefreshClient = snapshot.client;
    void config.refresh({
      auth: {
        hello: snapshot.hello,
        settings: { token: gateway.connection.token },
        password: gateway.connection.password,
      },
    });
  });
  const routeLocation = (routeId: RouteId, options?: ApplicationNavigationOptions) => {
    const location = locationForRoute(routeId, basePath);
    if (options?.search !== undefined || options?.hash !== undefined) {
      return {
        ...location,
        search: options?.search ?? "",
        hash: options?.hash ?? "",
      };
    }
    return location;
  };
  const confirmPendingGatewayConnection = () => {
    const pending = pendingGatewayConnection;
    if (!pending) {
      return;
    }
    pendingGatewayConnection = null;
    gateway.connect({
      gatewayUrl: pending.gatewayUrl,
      token: pending.token,
      bootstrapToken: pending.bootstrapToken,
    });
  };
  const cancelPendingGatewayConnection = () => {
    pendingGatewayConnection = null;
  };
  const context: ApplicationContext<RouteId> = {
    basePath,
    gateway,
    agents,
    agentIdentity,
    agentSelection,
    channels,
    config,
    runtimeConfig,
    sessions,
    workboard,
    overlays,
    navigation,
    theme,
    nativeChatDrafts,
    nativeNotifications,
    webPush,
    skillWorkshopRevision,
    initialUserMessage,
    navigate: (routeId, options) => {
      void router
        .navigate(routeId, context, { history: "push" }, routeLocation(routeId, options))
        .catch((error: unknown) => {
          console.error("[openclaw] route navigation failed", error);
        });
    },
    replace: (routeId, options) => {
      void router
        .navigate(routeId, context, { history: "replace" }, routeLocation(routeId, options))
        .catch((error: unknown) => {
          console.error("[openclaw] route replacement failed", error);
        });
    },
    revalidate: (routeId) => router.revalidate(context, routeId),
    preload: (routeId) => router.preloadRoute(routeId, context),
  };
  const stopModelSetupRedirect = firstRunDefaultLanding
    ? startModelSetupFirstRunRedirect({
        context,
        isStillDefaultLanding: () =>
          locationsMatch(history.location(), expectedDefaultLanding, (left, right) =>
            areUiSessionKeysEquivalentForHost({ hello: gateway.snapshot.hello }, left, right),
          ),
      })
    : () => undefined;
  return {
    context,
    router,
    documentMode,
    get pendingGatewayConnection() {
      return pendingGatewayConnection;
    },
    confirmPendingGatewayConnection,
    cancelPendingGatewayConnection,
    start: async () => {
      void config.refresh({ skipWithoutAuthCandidate: true });
      const routerStart = documentMode
        ? Promise.resolve()
        : startApplicationRouter(router, history, basePath, context);
      gateway.start();
      await routerStart;
    },
    stop: () => {
      stopModelSetupRedirect();
      stopConfigRefresh();
      router.stop();
      gateway.stop();
      agents.dispose();
      channels.dispose();
      sessions.dispose();
      workboard.dispose();
      stopConfigWriteSuspension();
      runtimeConfig.dispose();
      overlays.dispose();
      theme.dispose();
      nativeChatDrafts.dispose();
      nativeLinkRouting.dispose();
      nativeNotifications?.dispose();
      webPush.dispose();
      skillWorkshopRevision.clear();
      initialUserMessage.clear();
    },
  };
}
