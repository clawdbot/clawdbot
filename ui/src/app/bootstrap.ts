import type { RouteLocation } from "@openclaw/uirouter";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { sessionRouteNamespaceFromPath } from "../app-route-paths.ts";
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
import { isBrowserPanelAvailable } from "./app-shell-chrome.ts";
import { resolveApprovalDocumentMode, type ApprovalDocumentMode } from "./approval-deep-link.ts";
import { createBrowserHistory, resolveControlUiBasePath } from "./browser.ts";
import { createChatAttachmentHandoff } from "./chat-attachment-handoff.ts";
import { createApplicationCloudStartup } from "./cloud-session-startup.ts";
import { createApplicationConfigCapability } from "./config.ts";
import type {
  ApplicationNavigationOptions,
  ApplicationContext,
  ApplicationNavigationPreferences,
  ApplicationNavigationPreferencesSnapshot,
  ApplicationTheme,
  ApplicationThemeServerSelection,
} from "./context.ts";
import { syncCustomThemeStyleTag } from "./custom-theme.ts";
import { isDashboardOnlyView } from "./dashboard-document-mode.ts";
import { isDesktopDocumentPath, isDesktopOnlyView } from "./desktop-document-mode.ts";
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
import { createSkillWorkshopRevisionHandoff } from "./skill-workshop-revision-handoff.ts";
import { createStartupLifecycle, type StartupStep } from "./startup-lifecycle.ts";
import { resolveApplicationStartupSettings } from "./startup-settings.ts";
import { isTerminalDocumentPath, isTerminalOnlyView } from "./terminal-document-mode.ts";
import { startThemeTransition } from "./theme-transition.ts";
import { resolveTheme, type ThemeMode } from "./theme.ts";
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
  syncCustomThemeStyleTag(settings.customTheme);
  const background = getComputedStyle(root).getPropertyValue("--bg").trim();
  if (background) {
    for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
      meta.content = background;
      meta.removeAttribute("media");
    }
  }
}

function createApplicationTheme(
  initialSettings: UiSettings,
): ApplicationTheme & { dispose: () => void } {
  let settings = initialSettings;
  let serverSelection: ApplicationThemeServerSelection | null = null;
  let systemThemeCleanup: (() => void) | undefined;
  const listeners = new Set<() => void>();

  const publish = () => {
    applyThemePresentation(settings);
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
  const initialBasePath = resolveControlUiBasePath(
    startupLocation.pathname || globalThis.location?.pathname || "/",
  );
  const documentMode = resolveApprovalDocumentMode(startupLocation.pathname, initialBasePath);
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
  const basePath = resolveControlUiBasePath(
    startup.location.pathname || globalThis.location?.pathname || "/",
  );
  const dashboardDocument = isDashboardOnlyView(startup.location);
  const standaloneDocument =
    isTerminalDocumentPath(startup.location.pathname, basePath) ||
    isDesktopDocumentPath(startup.location.pathname, basePath) ||
    dashboardDocument;
  const firstRunDefaultLanding =
    documentMode === null && isDefaultChatLanding(startup.location, basePath, routeIdFromPath);
  // A `?view=` document mode still lands on the chat path, so it counts as the default landing
  // for routing, but it is an explicit destination that renders its own surface. Redirecting it
  // into model setup strands native app webviews on a blank page, so only gate the redirect.
  const firstRunRedirectEnabled =
    firstRunDefaultLanding &&
    !isTerminalOnlyView(startup.location, basePath) &&
    !isDesktopOnlyView(startup.location, basePath) &&
    !dashboardDocument;
  const sessionPathBuilderReady =
    dependencies.sessionPathBuilderReady ??
    (documentMode || dashboardDocument
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
      basePath,
      ...(startup.pendingBootstrapProfile
        ? { bootstrapProfile: startup.pendingBootstrapProfile }
        : {}),
    },
  );
  const agents = createAgentCapability(gateway);
  const startupLifecycle = createStartupLifecycle();
  const startupRouteId = routeIdFromPath(startup.location.pathname, basePath);
  const releasedSessionQuery =
    (startupRouteId === "chat" || startupRouteId === "dashboard") &&
    sessionRouteNamespaceFromPath(startup.location.pathname, basePath) === null &&
    new URLSearchParams(startup.location.search).has("session");
  const deferInitialLocationUntilGateway =
    documentMode === null &&
    !releasedSessionQuery &&
    firstRunDefaultLanding &&
    !parseAgentSessionKey(settings.sessionKey);
  const initialLocationReady = (
    documentMode || dashboardDocument
      ? Promise.resolve(startup.location)
      : Promise.all([sessionPathBuilderReady, import("./bootstrap-location.ts")]).then(
          ([, location]) =>
            location.resolveInitialApplicationLocation({
              location: startup.location,
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
      return startup.location;
    }
    throw error;
  });
  const agentIdentity = createAgentIdentityCapability(gateway);
  const agentSelection = createAgentSelectionCapability(gateway, agents);
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
  const nativeLinkRouting = startNativeLinkRouting({
    shouldOpenInControlUiBrowser: () =>
      loadSettings().openLinksInControlUiBrowser === true &&
      isBrowserPanelAvailable(gateway.snapshot) &&
      document.querySelector("openclaw-app-shell")?.isConnected === true,
  });
  const nativeNotifications = createNativeNotificationsCapability();
  const webPush = createWebPushCapability(gateway);
  const skillWorkshopRevision = createSkillWorkshopRevisionHandoff();
  const initialUserMessage = createInitialUserMessageHandoff();
  const cloudStartup = createApplicationCloudStartup({ gateway, sessions, initialUserMessage });
  const chatAttachmentHandoff = createChatAttachmentHandoff();
  applyThemePresentation(settings);
  const router = createApplicationRouter();
  // Standalone terminal, desktop, and dashboard documents render before the
  // shell; starting the page router would rewrite them to an application route.
  const startsApplicationRouter = documentMode === null && !standaloneDocument;
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
    cloudStartup.resumeRecovery();
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
    gateway,
    agents,
    agentIdentity,
    agentSelection,
    channels,
    config,
    runtimeConfig,
    sessions,
    cloudStartup,
    workboard,
    overlays,
    navigation,
    theme,
    nativeChatDrafts,
    nativeNotifications,
    webPush,
    skillWorkshopRevision,
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
      if (!deferInitialLocationUntilGateway) {
        steps.push(() =>
          startModelSetupFirstRunRedirectAfterLocation({
            context,
            enabled: firstRunRedirectEnabled,
            history,
            initialLocationReady,
          }),
        );
      }
      steps.push(() => {
        void config.refresh({ skipWithoutAuthCandidate: true });
      });
      if (startsApplicationRouter) {
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
          // The bare /chat route remains not-found while disconnected. Its shell
          // fallback is gated on the same connected defaults, so both paths converge.
          startupLifecycle.trackDisposer(
            startModelSetupFirstRunRedirectAfterLocation({
              context,
              enabled: firstRunRedirectEnabled,
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
      cloudStartup.dispose();
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
      chatAttachmentHandoff.dispose();
    },
  };
}
