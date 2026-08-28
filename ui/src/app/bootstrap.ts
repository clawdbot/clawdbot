import {
  parseControlUiFocusLocation,
  type ControlUiFocusLocation,
} from "@openclaw/session-url-contract";
import type { RouteLocation } from "@openclaw/uirouter";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import {
  createApplicationRouter,
  locationForRoute,
  routeIdFromPath,
  sameRouteLocation,
  startApplicationRouter,
  type ApplicationRouter,
  type RouteId,
} from "../app-routes.ts";
import { setSessionPathBuilder } from "../app-session-path-builder.ts";
import {
  SIDEBAR_SESSION_NAV_COLLAPSE_QUERY,
  sessionRefFromPath,
} from "../app-session-route-paths.ts";
import { createAgentIdentityCapability } from "../lib/agents/identity.ts";
import { createAgentCapability } from "../lib/agents/index.ts";
import { createChannelCapability } from "../lib/channels/index.ts";
import { createRuntimeConfigCapability } from "../lib/config/runtime-config-capability.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import { parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import { createWorkboardCapability } from "../lib/workboard/capability.ts";
import { loadChatObserverDisplayPreference } from "../pages/chat/chat-observer-display.ts";
import { sendSessionObserverVisibility } from "../pages/chat/chat-observer.ts";
import {
  isDefaultChatLanding,
  startModelSetupFirstRunRedirectAfterLocation,
} from "../pages/model-setup/first-run.ts";
import { createAgentSelectionCapability } from "./agent-selection.ts";
import { resolveControlUiDocumentMode, type ControlUiDocumentMode } from "./approval-deep-link.ts";
import { createBrowserHistory, resolveControlUiPaths } from "./browser.ts";
import { createChatAttachmentHandoff } from "./chat-attachment-handoff.ts";
import { createApplicationConfigCapability } from "./config.ts";
import type {
  ApplicationNavigationOptions,
  ApplicationContext,
  ApplicationNavigationPreferences,
  ApplicationNavigationPreferencesSnapshot,
  ApplicationTheme,
  ApplicationThemeServerSelection,
} from "./context.ts";
import { applyControlUiAccent, syncControlUiSystemChrome } from "./control-ui-presentation.ts";
import { syncCustomThemeStyleTag } from "./custom-theme.ts";
import { createScopeUpgradeCapability } from "./device-scope-upgrade.ts";
import { createApplicationGateway } from "./gateway-store.ts";
import { createInitialUserMessageHandoff } from "./initial-user-message-handoff.ts";
import { createNativeChatDrafts } from "./native-bridge.ts";
import { startNativeLinkRouting } from "./native-link-routing.ts";
import { createNativeNotificationsCapability } from "./native-notifications.ts";
import { createApplicationOverlays } from "./overlays.ts";
import { isBrowserPanelAvailable } from "./panel-availability.ts";
import { createApplicationPlacementStartup } from "./session-placement-startup.ts";
import {
  loadSettings,
  patchSettings,
  persistSessionToken,
  resolvePageGatewaySettings,
  saveSettings,
  type UiSettings,
} from "./settings.ts";
import { createSkillWorkshopRevisionAdmissions } from "./skill-workshop-revision-admissions.ts";
import { createStartupLifecycle, type StartupStep } from "./startup-lifecycle.ts";
import {
  normalizeLegacyTerminalViewLocation,
  resolveApplicationStartupSettings,
} from "./startup-settings.ts";
import { startThemeTransition } from "./theme-transition.ts";
import { resolveTheme, syncThemePaletteStylesheet, type ThemeMode } from "./theme.ts";
import {
  applyChatFontSmoothing,
  applyTypefaceOverrides,
  resolveTypefaces,
  syncTypefaceStylesheets,
} from "./typography.ts";
import { createWebPushCapability } from "./web-push.ts";

function applyThemePresentation(settings: ReturnType<typeof loadSettings>): void {
  if (typeof document === "undefined") {
    return;
  }
  const root = document.documentElement;
  const resolvedTheme = resolveTheme(settings.theme, settings.themeMode);
  root.dataset.theme = resolvedTheme;
  root.dataset.themeMode = resolvedTheme.endsWith("light") ? "light" : "dark";
  // Carapace CSS (openclaw/carapace) selects on [data-theme-resolved]; keep it
  // in lockstep with data-theme-mode so its stylesheets work unmodified here.
  root.dataset.themeResolved = root.dataset.themeMode;
  root.classList.toggle("wa-light", root.dataset.themeMode === "light");
  root.classList.toggle("wa-dark", root.dataset.themeMode === "dark");
  root.style.colorScheme = root.dataset.themeMode;
  root.style.setProperty("--control-ui-text-scale", `${(settings.textScale ?? 100) / 100}`);
  const typefaces = resolveTypefaces(settings.theme, settings.fontUi, settings.fontChat);
  syncTypefaceStylesheets(typefaces);
  applyTypefaceOverrides(settings.fontUi, settings.fontChat);
  applyChatFontSmoothing(typefaces.chat);
  syncCustomThemeStyleTag(settings.customTheme);
  applyControlUiAccent(settings.accent);
  syncControlUiSystemChrome();
}

function createApplicationTheme(
  initialSettings: UiSettings,
): ApplicationTheme & { dispose: () => void } {
  let settings = initialSettings;
  let serverSelection: ApplicationThemeServerSelection | null = null;
  let systemThemeCleanup: (() => void) | undefined;
  let chromeBreakpointCleanup: (() => void) | undefined;
  const listeners = new Set<() => void>();

  let presentationGeneration = 0;
  const publish = () => {
    const generation = ++presentationGeneration;
    syncThemePaletteStylesheet(settings.theme, () => {
      // A slower palette cannot overwrite a newer selection or a disposed app.
      if (generation !== presentationGeneration) {
        return;
      }
      applyThemePresentation(settings);
      for (const listener of listeners) {
        listener();
      }
    });
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

  if (typeof globalThis.matchMedia === "function") {
    const mediaQuery = globalThis.matchMedia(
      "(max-width: 768px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)",
    );
    const onChange = () => syncControlUiSystemChrome();
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", onChange);
      chromeBreakpointCleanup = () => mediaQuery.removeEventListener("change", onChange);
    } else if (typeof mediaQuery.addListener === "function") {
      mediaQuery.addListener(onChange);
      chromeBreakpointCleanup = () => mediaQuery.removeListener(onChange);
    }
  }

  syncSystemThemeListener();
  publish();

  return {
    get settings() {
      return settings;
    },
    get mode() {
      return settings.themeMode;
    },
    get resolvedMode() {
      return resolveTheme(settings.theme, settings.themeMode).endsWith("light") ? "light" : "dark";
    },
    get serverSelection() {
      return serverSelection;
    },
    recordServerSelection(theme, scope) {
      serverSelection = { revision: (serverSelection?.revision ?? 0) + 1, scope, theme };
      publish();
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
      presentationGeneration += 1;
      detachSystemThemeListener();
      chromeBreakpointCleanup?.();
      listeners.clear();
    },
  };
}

function createApplicationNavigationPreferences(
  initialSettings: UiSettings,
  navCollapsed: boolean,
): ApplicationNavigationPreferences {
  let snapshot: ApplicationNavigationPreferencesSnapshot = {
    navCollapsed,
    navWidth: initialSettings.navWidth,
    sidebarEntries: initialSettings.sidebarEntries,
    pinnedAgentIds: initialSettings.pinnedAgentIds ?? [],
  };
  const listeners = new Set<(next: ApplicationNavigationPreferencesSnapshot) => void>();

  return {
    get snapshot() {
      return snapshot;
    },
    update(patch) {
      const nextSnapshot = { ...snapshot, ...patch };
      const persistedChanged =
        nextSnapshot.navWidth !== snapshot.navWidth ||
        nextSnapshot.sidebarEntries !== snapshot.sidebarEntries ||
        nextSnapshot.pinnedAgentIds !== snapshot.pinnedAgentIds;
      if (!persistedChanged && nextSnapshot.navCollapsed === snapshot.navCollapsed) {
        return;
      }
      if (persistedChanged) {
        patchSettings({
          navWidth: nextSnapshot.navWidth,
          sidebarEntries: [...nextSnapshot.sidebarEntries],
          pinnedAgentIds: [...nextSnapshot.pinnedAgentIds],
        });
      }
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

export type ApplicationRuntime = {
  readonly context: ApplicationContext<RouteId>;
  readonly router: ApplicationRouter;
  readonly documentMode: ControlUiDocumentMode | null;
  readonly focusLocation: ControlUiFocusLocation | null;
  readonly pendingGatewayConnection: {
    readonly gatewayUrl: string;
    readonly token: string;
  } | null;
  readonly confirmPendingGatewayConnection: () => void;
  readonly cancelPendingGatewayConnection: () => void;
  start: () => Promise<void>;
  stop: () => void;
};

type BootstrapApplicationDependencies = {
  sessionPathBuilderReady?: Promise<void>;
};

type PendingRouterStartNavigation = {
  routeId: RouteId;
  location: RouteLocation;
  mode: "push" | "replace";
};

export function bootstrapApplication(
  dependencies: BootstrapApplicationDependencies = {},
): ApplicationRuntime {
  const history = createBrowserHistory();
  const startupLocation = history.location();
  const [basePath, resourceBasePath] = resolveControlUiPaths(
    startupLocation.pathname || globalThis.location?.pathname || "/",
  );
  const documentMode = resolveControlUiDocumentMode(startupLocation.pathname, basePath);
  const persistedSettings = loadSettings();
  const initialSettings = documentMode
    ? resolvePageGatewaySettings(persistedSettings)
    : persistedSettings;
  const startup = resolveApplicationStartupSettings(initialSettings, startupLocation);
  if (
    startup.location.pathname !== startupLocation.pathname ||
    startup.location.search !== startupLocation.search ||
    startup.location.hash !== startupLocation.hash
  ) {
    // Remove URL credentials before deferred routing or Gateway authentication can expose them.
    history.replace(startup.location);
  }
  if (startup.changed) {
    if (documentMode) {
      persistSessionToken(startup.settings.gatewayUrl, startup.settings.token);
    } else {
      saveSettings(startup.settings);
    }
  }
  let applicationLocation = normalizeLegacyTerminalViewLocation(startup.location, basePath);
  const startupSearchParams = new URLSearchParams(applicationLocation.search);
  const hasSidebarCollapseIntent =
    startupSearchParams.get(SIDEBAR_SESSION_NAV_COLLAPSE_QUERY.name) ===
    SIDEBAR_SESSION_NAV_COLLAPSE_QUERY.value;
  if (hasSidebarCollapseIntent) {
    // Sidebar-row hrefs mark new-tab intent once; strip it so copied URLs and reloads stay canonical.
    startupSearchParams.delete(SIDEBAR_SESSION_NAV_COLLAPSE_QUERY.name);
    const search = startupSearchParams.toString();
    applicationLocation = { ...applicationLocation, search: search ? `?${search}` : "" };
  }
  if (applicationLocation !== startup.location) {
    history.replace(applicationLocation);
  }
  const focusLocation = parseControlUiFocusLocation(applicationLocation, basePath);
  // Focus documents render before the shell; starting the application router
  // would rewrite their reserved presentation route into an ordinary page.
  const startsApplicationRouter = documentMode === null && focusLocation === null;
  const firstRunDefaultLanding =
    startsApplicationRouter && isDefaultChatLanding(applicationLocation, basePath, routeIdFromPath);
  const sessionPathBuilderReady =
    dependencies.sessionPathBuilderReady ??
    (documentMode ||
    (focusLocation?.status === "valid" && focusLocation.target.kind !== "dashboard")
      ? Promise.resolve()
      : import("@openclaw/session-url-contract").then((contract) => {
          setSessionPathBuilder(contract.buildControlUiSessionPath);
        }));

  const settings = startup.settings;
  const gateway = createApplicationGateway(
    settings,
    startup.password ?? "",
    startup.pendingBootstrapToken ?? "",
    undefined,
    {
      persistDefaultConnectionSettings: documentMode === null,
      resourceBasePath,
      ...(startup.pendingBootstrapProfile
        ? { bootstrapProfile: startup.pendingBootstrapProfile }
        : {}),
    },
  );
  const agents = createAgentCapability(gateway);
  const startupLifecycle = createStartupLifecycle();
  const deferInitialLocationUntilGateway =
    firstRunDefaultLanding && !parseAgentSessionKey(settings.sessionKey);
  let resolveInitialFirstRunDecision: (() => void) | null = null;
  const initialFirstRunDecision = deferInitialLocationUntilGateway
    ? new Promise<void>((resolve) => {
        resolveInitialFirstRunDecision = resolve;
      })
    : null;
  const initialLocationReady = (
    documentMode || focusLocation
      ? Promise.resolve(applicationLocation)
      : Promise.all([sessionPathBuilderReady, import("./bootstrap-location.ts")]).then(
          ([, location]) =>
            location.resolveInitialApplicationLocation({
              location: applicationLocation,
              basePath,
              sessionKey: settings.sessionKey,
              gateway,
              agentsList: () => agents.state.agentsList,
              signal: startupLifecycle.signal,
            }),
        )
  ).catch((error: unknown) => {
    // stop() aborts an eager unscoped-session lookup even when start() returns
    // at the lazy-chunk guard, so consume that teardown-only rejection here.
    if (startupLifecycle.signal.aborted) {
      return applicationLocation;
    }
    throw error;
  });
  const agentIdentity = createAgentIdentityCapability(gateway);
  const agentSelection = createAgentSelectionCapability(gateway, agents);
  const channels = createChannelCapability(gateway);
  const scopeUpgrade = createScopeUpgradeCapability(gateway);
  const config = createApplicationConfigCapability({
    resourceBasePath,
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
  const navigation = createApplicationNavigationPreferences(
    settings,
    hasSidebarCollapseIntent &&
      sessionRefFromPath(applicationLocation.pathname, basePath)?.namespace === "chat",
  );
  const theme = createApplicationTheme(settings);
  const nativeChatDrafts = createNativeChatDrafts();
  const nativeLinkRouting = startNativeLinkRouting({
    shouldOpenInControlUiBrowser: () =>
      loadSettings().openLinksInControlUiBrowser === true &&
      isBrowserPanelAvailable(gateway.snapshot) &&
      document.querySelector("openclaw-app-shell")?.isConnected === true,
  });
  const nativeNotifications = createNativeNotificationsCapability();
  const webPush = createWebPushCapability(gateway);
  const skillWorkshopRevisionAdmissions = createSkillWorkshopRevisionAdmissions();
  const initialUserMessage = createInitialUserMessageHandoff();
  const placementStartup = createApplicationPlacementStartup({
    gateway,
    sessions,
    initialUserMessage,
  });
  const chatAttachmentHandoff = createChatAttachmentHandoff();
  const router = createApplicationRouter();
  let routerStarted = false;
  // Pre-start navigations are invisible to history; retain the latest request so
  // router.start() cannot resolve the stale browser URL over the user's route.
  let pendingRouterStartNavigation: PendingRouterStartNavigation | null = null;
  let pendingGatewayConnection =
    startup.pendingGatewayUrl !== null
      ? {
          gatewayUrl: startup.pendingGatewayUrl,
          token: startup.pendingGatewayToken ?? "",
          bootstrapToken: startup.pendingBootstrapToken ?? "",
          ...(startup.pendingBootstrapProfile
            ? { bootstrapProfile: startup.pendingBootstrapProfile }
            : {}),
        }
      : null;
  let lastPostConnectClient: GatewayBrowserClient | null = null;
  let lastRecoveryClient: GatewayBrowserClient | null = null;
  const stopPostConnect = gateway.subscribe((snapshot) => {
    if (snapshot.phase !== "connected" || !snapshot.client) {
      lastPostConnectClient = null;
      lastRecoveryClient = null;
      return;
    }
    if (lastPostConnectClient !== snapshot.client) {
      lastPostConnectClient = snapshot.client;
      void config.refresh({
        auth: {
          hello: snapshot.hello,
          settings: { token: gateway.connection.token },
          password: gateway.connection.password,
        },
      });
      void sendSessionObserverVisibility(
        snapshot.client,
        loadChatObserverDisplayPreference() !== "off",
      ).catch(() => undefined);
    }
    // Recovery scope resolves after hello, so dedupe its later publication independently.
    if (!snapshot.client.recoveryScopeReady || lastRecoveryClient === snapshot.client) {
      return;
    }
    lastRecoveryClient = snapshot.client;
    placementStartup.resumeRecovery();
  });
  const routeLocation = (routeId: RouteId, options?: ApplicationNavigationOptions) => {
    const location = locationForRoute(routeId, basePath);
    const activeMatch = router.getState().matches[0];
    const activeDynamicPath =
      activeMatch?.routeId === routeId && routeId === "workboard"
        ? activeMatch.location.pathname
        : null;
    if (
      options?.pathname !== undefined ||
      options?.search !== undefined ||
      options?.hash !== undefined
    ) {
      return {
        ...location,
        pathname: options?.pathname ?? activeDynamicPath ?? location.pathname,
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
      bootstrapProfile: pending.bootstrapProfile,
    });
  };
  const cancelPendingGatewayConnection = () => {
    pendingGatewayConnection = null;
  };
  const navigateWithMode = (
    routeId: RouteId,
    options: ApplicationNavigationOptions | undefined,
    requested: "push" | "replace",
  ) => {
    const location = routeLocation(routeId, options);
    // Preserve pre-start navigation exactly as the fire-and-forget entry point does.
    if (!routerStarted) {
      pendingRouterStartNavigation = { routeId, location, mode: requested };
    }
    // Re-clicking the active nav item must not stack identical history
    // entries: Back would appear dead until every duplicate is popped.
    const samePage = routerStarted && sameRouteLocation(history.location(), location);
    const historyMode = samePage ? "replace" : requested;
    const navigationPromise = router.navigate(routeId, context, { history: historyMode }, location);
    void navigationPromise.catch((error: unknown) => {
      console.error("[openclaw] route navigation failed", error);
    });
    return navigationPromise;
  };
  const navigateAndWait = (routeId: RouteId, options?: ApplicationNavigationOptions) =>
    navigateWithMode(routeId, options, "push");
  const context: ApplicationContext<RouteId> = {
    basePath,
    resourceBasePath,
    gateway,
    agents,
    agentIdentity,
    agentSelection,
    channels,
    config,
    scopeUpgrade,
    runtimeConfig,
    sessions,
    placementStartup,
    workboard,
    overlays,
    navigation,
    theme,
    nativeChatDrafts,
    nativeNotifications,
    webPush,
    skillWorkshopRevisionAdmissions,
    initialUserMessage,
    chatAttachmentHandoff,
    navigate: (routeId, options) => {
      void navigateAndWait(routeId, options);
    },
    navigateAndWait,
    replace: (routeId, options) => {
      void navigateWithMode(routeId, options, "replace");
    },
    revalidate: (routeId) => router.revalidate(context, routeId),
    preload: (routeId, options) => router.preloadLocation(routeLocation(routeId, options), context),
  };
  return {
    context,
    router,
    documentMode,
    focusLocation,
    get pendingGatewayConnection() {
      return pendingGatewayConnection;
    },
    confirmPendingGatewayConnection,
    cancelPendingGatewayConnection,
    start: () => {
      const stopRouter = () => router.stop();
      if (startsApplicationRouter) {
        startupLifecycle.addDisposer(stopRouter);
      }
      const steps: StartupStep[] = [
        () => {
          gateway.start();
          return () => gateway.stop();
        },
        () => sessionPathBuilderReady,
      ];
      // Resolve first-run setup before routing: the default Chat route owns the
      // workspace graph, which setup users would otherwise fetch and discard.
      steps.push(() =>
        startModelSetupFirstRunRedirectAfterLocation({
          context,
          enabled: firstRunDefaultLanding,
          history,
          initialLocationReady: deferInitialLocationUntilGateway
            ? Promise.resolve(applicationLocation)
            : initialLocationReady,
          ...(deferInitialLocationUntilGateway
            ? {
                redirect: () =>
                  history.replace({
                    ...locationForRoute("model-setup", basePath),
                    search: "?firstRun=1",
                  }),
                onInitialDecision: () => resolveInitialFirstRunDecision?.(),
              }
            : {}),
        }),
      );
      steps.push(() => {
        void config.refresh({ skipWithoutAuthCandidate: true });
      });
      if (startsApplicationRouter) {
        if (initialFirstRunDecision) {
          steps.push(() => initialFirstRunDecision);
        }
        steps.push(async () => {
          const pendingNavigation = pendingRouterStartNavigation;
          pendingRouterStartNavigation = null;
          routerStarted = true;
          if (pendingNavigation) {
            history[pendingNavigation.mode](pendingNavigation.location);
          }
          await startApplicationRouter(router, history, basePath, context);
          return stopRouter;
        });
      }
      if (deferInitialLocationUntilGateway) {
        steps.push(() => {
          // The router claims the connected Gateway session before persisted
          // location normalization can install a competing retained Chat pane.
          startupLifecycle.trackDisposer(
            startModelSetupFirstRunRedirectAfterLocation({
              context,
              enabled: false,
              history,
              initialLocationReady,
              installLocation: async (location) => {
                const routeId = routeIdFromPath(location.pathname, basePath);
                if (routeId) {
                  await router.navigate(routeId, context, { history: "replace" }, location);
                } else {
                  history.replace(location);
                }
              },
              shouldInstallLocation: () =>
                isDefaultChatLanding(history.location(), basePath, routeIdFromPath),
            }),
            (error) => {
              console.error("[openclaw] initial session location failed", error);
            },
          );
        });
      }
      return startupLifecycle.run(steps);
    },
    stop: () => {
      startupLifecycle.stop();
      stopPostConnect();
      agents.dispose();
      channels.dispose();
      scopeUpgrade.dispose();
      placementStartup.dispose();
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
      skillWorkshopRevisionAdmissions.dispose();
      initialUserMessage.clear();
      chatAttachmentHandoff.dispose();
    },
  };
}
