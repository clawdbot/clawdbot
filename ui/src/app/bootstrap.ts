import { gatewayCredentialScope, gatewayOriginScope } from "@openclaw/gateway-client/browser";
import {
  parseControlUiFocusLocation,
  type ControlUiFocusLocation,
} from "@openclaw/session-url-contract";
import type { RouteLocation } from "@openclaw/uirouter";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { isSettingsTakeover } from "../app-navigation.ts";
import {
  createApplicationRouter,
  locationForRoute,
  routeIdFromPath,
  sameRouteLocation,
  startApplicationRouter,
  warmApplicationRouteModule,
  type ApplicationRouter,
  type RouteId,
} from "../app-routes.ts";
import {
  SIDEBAR_SESSION_NAV_COLLAPSE_QUERY,
  sessionRefFromPath,
} from "../app-session-route-paths.ts";
import { createAgentIdentityCapability } from "../lib/agents/identity.ts";
import { createAgentCapability } from "../lib/agents/index.ts";
import { createChannelCapability } from "../lib/channels/index.ts";
import { createRuntimeConfigCapability } from "../lib/config/runtime-config-capability.ts";
import { loadCurrentDeviceAuthToken } from "../lib/nodes/index.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import { parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import { createLiveActivity } from "../pages/activity/live-activity.ts";
import { loadChatObserverDisplayPreference } from "../pages/chat/chat-observer-display.ts";
import { sendSessionObserverVisibility } from "../pages/chat/chat-observer.ts";
import { resolveChatSnapshotKey } from "../pages/chat/session-snapshot-key.ts";
import { prewarmChatSnapshot } from "../pages/chat/session-snapshot-prewarm.ts";
import {
  isDefaultChatLanding,
  startModelSetupFirstRunRedirectAfterLocation,
} from "../pages/model-setup/first-run.ts";
import { ControlUiPluginRuntime } from "../plugins/control-ui-runtime.ts";
import { createAgentSelectionCapability } from "./agent-selection.ts";
import type { ShellRouteState } from "./app-host-route-state.ts";
import { resolveControlUiDocumentMode, type ControlUiDocumentMode } from "./approval-deep-link.ts";
import { readBootRecord } from "./boot-record.ts";
import { resolveInitialApplicationLocation } from "./bootstrap-location.ts";
import { createApplicationTheme } from "./bootstrap-theme.ts";
import {
  subscribeBootRecordPersistence,
  subscribeWarmBootConnection,
} from "./bootstrap-warm-boot.ts";
import { createBrowserHistory, resolveControlUiPaths } from "./browser.ts";
import { createChatAttachmentHandoff } from "./chat-attachment-handoff.ts";
import { createChatSubmissions } from "./chat-submissions.ts";
import { createApplicationConfigCapability } from "./config.ts";
import { createConnectionBootstrapCoordinator } from "./connection-bootstrap.ts";
import type {
  ApplicationNavigationOptions,
  ApplicationContext,
  ApplicationNavigationPreferences,
  ApplicationNavigationPreferencesSnapshot,
} from "./context.ts";
import { createScopeUpgradeCapability } from "./device-scope-upgrade.ts";
import { startGatewayPageActivation } from "./gateway-page-activation.ts";
import { createApplicationGateway } from "./gateway-store.ts";
import { createNativeChatDrafts } from "./native-bridge.ts";
import { startNativeLinkRouting } from "./native-link-routing.ts";
import { createApplicationOverlays } from "./overlays.ts";
import { isBrowserPanelAvailable } from "./panel-availability.ts";
import { createApplicationPlacementStartup } from "./session-placement-startup.ts";
import {
  loadGatewaySessionSelection,
  loadSettings,
  patchSettings,
  resolveGatewayCredentialsForUrlEdit,
  resolvePageGatewaySettings,
  saveSettings,
  type UiSettings,
} from "./settings.ts";
import { createSidebarAttentionStore } from "./sidebar-attention-store.ts";
import { createStartupLifecycle, type StartupStep } from "./startup-lifecycle.ts";
import {
  normalizeLegacyTerminalViewLocation,
  resolveApplicationStartupSettings,
} from "./startup-settings.ts";
import { openUpdateFailureTriage } from "./update-triage.ts";
import { createWebPushCapability } from "./web-push.ts";

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
  readonly warmBoot: boolean;
  readonly focusLocation: ControlUiFocusLocation | null;
  readonly pendingGatewayConnection: {
    readonly gatewayUrl: string;
    readonly token: string | null;
  } | null;
  readonly confirmPendingGatewayConnection: () => void;
  readonly cancelPendingGatewayConnection: () => void;
  start: () => Promise<void>;
  stop: () => void;
};

type PendingRouterStartNavigation = {
  routeId: RouteId;
  location: RouteLocation;
  mode: "push" | "replace";
};

export function bootstrapApplication(): ApplicationRuntime {
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
  const startupTargetSelection =
    gatewayOriginScope(startup.settings.gatewayUrl) ===
    gatewayOriginScope(initialSettings.gatewayUrl)
      ? null
      : loadGatewaySessionSelection(startup.settings.gatewayUrl);
  const settings = startupTargetSelection
    ? {
        ...startup.settings,
        ...startupTargetSelection,
        selectedAgentId: startupTargetSelection.selectedAgentId,
      }
    : startup.settings;
  if (
    startup.location.pathname !== startupLocation.pathname ||
    startup.location.search !== startupLocation.search ||
    startup.location.hash !== startupLocation.hash
  ) {
    // Remove URL credentials before deferred routing or Gateway authentication can expose them.
    history.replace(startup.location);
  }
  if (startup.changed && !documentMode) {
    saveSettings(settings);
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
  const hasPendingGateway = startup.pendingGatewayUrl !== null;
  const gateway = createApplicationGateway(
    settings,
    startup.password ?? "",
    hasPendingGateway ? "" : (startup.pendingBootstrapToken ?? ""),
    undefined,
    {
      persistDefaultConnectionSettings: documentMode === null,
      resourceBasePath,
      ...(!hasPendingGateway && startup.pendingBootstrapProfile
        ? { bootstrapProfile: startup.pendingBootstrapProfile }
        : {}),
      ...(startup.nativeClient ? { clientOptions: startup.nativeClient } : {}),
    },
  );
  const liveActivity = createLiveActivity(gateway);
  const connectionBootstrap = createConnectionBootstrapCoordinator();
  const bootRecord = readBootRecord(gatewayCredentialScope(settings.gatewayUrl), (method) => {
    if (startup.pendingBootstrapToken || startup.password) {
      return null;
    }
    // An explicit token takes precedence over paired-device auth on the next connect.
    return method === "token"
      ? settings.token
      : settings.token.trim()
        ? null
        : loadCurrentDeviceAuthToken(settings.gatewayUrl);
  });
  const warmBoot = bootRecord !== null && startsApplicationRouter && !hasPendingGateway;
  if (warmBoot && parseAgentSessionKey(settings.sessionKey)) {
    prewarmChatSnapshot(
      resolveChatSnapshotKey(
        { agentsList: bootRecord.agents, hello: null, assistantAgentId: null },
        { sessionKey: settings.sessionKey },
      ),
    );
  }
  const stopWarmBootConnection = subscribeWarmBootConnection(
    gateway,
    startsApplicationRouter && !hasPendingGateway ? bootRecord?.profileId : undefined,
  );
  const agents = createAgentCapability(gateway, {
    cachedList: bootRecord?.agents ?? null,
    cachedProfileId: bootRecord?.profileId ?? null,
  });
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
      : resolveInitialApplicationLocation({
          location: applicationLocation,
          basePath,
          sessionKey: settings.sessionKey,
          gateway,
          agentsList: () => agents.state.agentsList,
          selectedAgentId: settings.selectedAgentId,
          signal: startupLifecycle.signal,
        })
  ).catch((error: unknown) => {
    // stop() aborts eager session lookups even before start() reaches location
    // resolution, so consume that teardown-only rejection here.
    if (startupLifecycle.signal.aborted) {
      return applicationLocation;
    }
    throw error;
  });
  const agentIdentity = createAgentIdentityCapability(gateway);
  const agentSelection = createAgentSelectionCapability(
    gateway,
    agents,
    startsApplicationRouter
      ? {
          load: (gatewayUrl) => loadGatewaySessionSelection(gatewayUrl).selectedAgentId ?? null,
          save: (gatewayUrl, selectedAgentId) => {
            if (gateway.connection.gatewayUrl === gatewayUrl) {
              patchSettings({ selectedAgentId: selectedAgentId ?? undefined });
            }
          },
        }
      : undefined,
  );
  const channels = createChannelCapability(gateway);
  const scopeUpgrade = createScopeUpgradeCapability(gateway);
  const config = createApplicationConfigCapability({
    resourceBasePath,
    getAuth: () => ({
      hello: gateway.snapshot.hello,
      settings: { token: gateway.connection.token },
      password: gateway.connection.password,
    }),
  });
  const sessions = createSessionCapability(gateway, agentSelection, { bootRecord });
  const stopBootRecordPersistence = subscribeBootRecordPersistence({ gateway, agents, sessions });
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  const overlays = createApplicationOverlays(gateway, {
    connectionBootstrap,
    getActiveSessionKey: () => gateway.snapshot.sessionKey || undefined,
    drainConfigWrites: () => runtimeConfig.waitForPendingWrites(),
    onUpdateFailure: (failure, admission) =>
      void openUpdateFailureTriage(context, failure, admission),
  });
  const sidebarAttention = createSidebarAttentionStore({
    gateway,
    agentSelection,
    agents,
    overlays,
    scopeUpgrade,
    connectionBootstrap,
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
  const theme = createApplicationTheme(settings, gateway);
  const nativeChatDrafts = createNativeChatDrafts();
  const nativeLinkRouting = startNativeLinkRouting({
    signal: startupLifecycle.signal,
    canPresentBrowserPanel: () => {
      const shell = document.querySelector<HTMLElement & { routeState: ShellRouteState }>(
        "openclaw-app-shell",
      );
      return shell?.isConnected === true && !isSettingsTakeover(shell.routeState.routeId);
    },
    onNativeUpdateDeclined: () => {
      const snapshot = overlays.snapshot;
      const campaign = snapshot.updateSchedule?.campaign;
      const busy =
        snapshot.updateRunning ||
        snapshot.updateReconciliationPending ||
        campaign?.state === "applying";
      if ((snapshot.updateAvailable || campaign) && !busy && !snapshot.controlUiRefreshRequired) {
        void overlays.runUpdate();
      }
    },
    shouldOpenInControlUiBrowser: () =>
      loadSettings().openLinksInControlUiBrowser === true &&
      isBrowserPanelAvailable(gateway.snapshot) &&
      document.querySelector("openclaw-app-shell")?.isConnected === true,
  });
  let nativeDeviceSettings: ApplicationContext["nativeDeviceSettings"] = null;
  let nativeNotifications: ApplicationContext["nativeNotifications"] = null;
  const webPush = createWebPushCapability(gateway, { connectionBootstrap });
  const chatSubmissions = createChatSubmissions();
  const placementStartup = createApplicationPlacementStartup({
    gateway,
    sessions,
    chatSubmissions,
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
          token: startup.pendingGatewayToken,
          bootstrapToken: startup.pendingBootstrapToken ?? "",
          ...(startup.pendingBootstrapProfile
            ? { bootstrapProfile: startup.pendingBootstrapProfile }
            : {}),
        }
      : null;
  let lastPostConnectClient: GatewayBrowserClient | null = null;
  let lastRecoveryClient: GatewayBrowserClient | null = null;
  let browserBootstrapAttempted = Boolean(
    hasPendingGateway || startup.nativeClient || startup.pendingBootstrapToken,
  );
  const initialConnectionRevision = gateway.connectionRevision;
  const stopPostConnect = gateway.subscribe((snapshot) => {
    connectionBootstrap.synchronize({
      client: snapshot.client,
      connected: snapshot.phase === "connected",
    });
    if (snapshot.phase === "connected") {
      browserBootstrapAttempted = true;
    }
    if (
      !browserBootstrapAttempted &&
      snapshot.phase === "stopped" &&
      (snapshot.lastErrorCode === ConnectErrorDetailCodes.AUTH_TOKEN_MISSING ||
        snapshot.lastErrorCode === ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING)
    ) {
      browserBootstrapAttempted = true;
      // Recovery stays off the startup path; loading it cannot revive a replaced connection.
      startupLifecycle.trackDisposer(
        import("./browser-bootstrap.runtime.ts").then(({ startBrowserBootstrapRecovery }) =>
          gateway.snapshot.client === snapshot.client &&
          gateway.connectionRevision === initialConnectionRevision &&
          !startupLifecycle.signal.aborted
            ? startBrowserBootstrapRecovery(gateway, basePath)
            : () => {},
        ),
        () => {},
      );
    }
    if (snapshot.phase !== "connected" || !snapshot.client) {
      lastPostConnectClient = null;
      lastRecoveryClient = null;
      return;
    }
    const client = snapshot.client;
    if (lastPostConnectClient !== client) {
      lastPostConnectClient = client;
      void connectionBootstrap.run("config", () => config.refresh());
      void connectionBootstrap.run("session-observer", () =>
        sendSessionObserverVisibility(client, loadChatObserverDisplayPreference() !== "off"),
      );
    }
    // Recovery scope resolves after hello, so dedupe its later publication independently.
    if (!client.recoveryScopeReady || lastRecoveryClient === client) {
      return;
    }
    lastRecoveryClient = client;
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
    const credentials = resolveGatewayCredentialsForUrlEdit(
      gateway.connection.gatewayUrl,
      pending.gatewayUrl,
      gateway.connection,
    );
    gateway.connect({
      gatewayUrl: pending.gatewayUrl,
      token: pending.bootstrapToken ? "" : (pending.token ?? credentials.token),
      password: credentials.password,
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
  const plugins = new ControlUiPluginRuntime(() => context);
  const context: ApplicationContext<RouteId> = {
    basePath,
    resourceBasePath,
    lifecycleAbortSignal: startupLifecycle.signal,
    router,
    gateway,
    connectionBootstrap,
    agents,
    agentIdentity,
    agentSelection,
    channels,
    config,
    scopeUpgrade,
    sidebarAttention,
    runtimeConfig,
    sessions,
    liveActivity,
    placementStartup,
    plugins,
    overlays,
    navigation,
    theme,
    nativeChatDrafts,
    get nativeDeviceSettings() {
      return nativeDeviceSettings;
    },
    get nativeNotifications() {
      return nativeNotifications;
    },
    webPush,
    chatSubmissions,
    chatAttachmentHandoff,
    navigate: (routeId, options) => {
      void navigateAndWait(routeId, options);
    },
    navigateAndWait,
    replace: (routeId, options) => {
      void navigateWithMode(routeId, options, "replace");
    },
    revalidate: (routeId) => router.revalidate(context, routeId),
    preload: (routeId) => router.preloadLocation(locationForRoute(routeId, basePath), context),
  };
  return {
    context,
    router,
    documentMode,
    warmBoot,
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
        () => startGatewayPageActivation(gateway, document, window),
        () => {
          plugins.start();
          return () => plugins.dispose();
        },
      ];
      if (startsApplicationRouter && !firstRunDefaultLanding) {
        // Download explicit-route chunks alongside startup. Default landing must
        // wait for setup's decision before fetching the Chat workspace graph.
        steps.unshift(() => warmApplicationRouteModule(router, applicationLocation, basePath));
      }
      // Only the native host needs bridge parsers. Initialize before routing,
      // and fence the import so a stopped application cannot install listeners.
      // SAFETY: WebKit adds this optional host field; its callable handler is checked below.
      const nativeWindow = window as Window & {
        webkit?: {
          messageHandlers?: {
            openclawDeviceSettings?: { postMessage?: unknown };
            openclawNotifications?: { postMessage?: unknown };
          };
        };
      };
      if (
        typeof nativeWindow.webkit?.messageHandlers?.openclawNotifications?.postMessage ===
        "function"
      ) {
        steps.unshift(async () => {
          const { createNativeNotificationsCapability } = await import("./native-notifications.ts");
          if (!startupLifecycle.signal.aborted) {
            nativeNotifications = createNativeNotificationsCapability();
            return () => nativeNotifications?.dispose();
          }
          return undefined;
        });
      }
      if (
        typeof nativeWindow.webkit?.messageHandlers?.openclawDeviceSettings?.postMessage ===
        "function"
      ) {
        steps.unshift(async () => {
          const { createNativeDeviceSettingsCapability } =
            await import("./native-device-settings.ts");
          if (!startupLifecycle.signal.aborted) {
            nativeDeviceSettings = createNativeDeviceSettingsCapability();
            return () => nativeDeviceSettings?.dispose();
          }
          return undefined;
        });
      }
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
      stopWarmBootConnection();
      stopBootRecordPersistence();
      stopPostConnect();
      connectionBootstrap.reset();
      agents.dispose();
      channels.dispose();
      scopeUpgrade.dispose();
      sidebarAttention.dispose();
      placementStartup.dispose();
      sessions.dispose();
      liveActivity.dispose();
      stopConfigWriteSuspension();
      runtimeConfig.dispose();
      overlays.dispose();
      theme.dispose();
      nativeChatDrafts.dispose();
      nativeLinkRouting.dispose();
      webPush.dispose();
      chatSubmissions.clear();
      chatAttachmentHandoff.dispose();
    },
  };
}
