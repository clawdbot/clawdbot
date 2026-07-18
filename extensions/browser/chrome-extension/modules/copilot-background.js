import {
  PANEL_PATH,
  resolveBindingTarget,
  resolveSidePanelTabId,
  safeTabLabel,
  selectCopilotPanelState,
  sessionKeyFromEvent,
} from "./copilot-background-shared.js";
import { CopilotGatewayClient } from "./copilot-gateway.js";
import { createCopilotRecoveryController } from "./copilot-recovery.js";
import { createCopilotRelayCustodyController } from "./copilot-relay-custody.js";
import { CopilotPanelBindingRegistry, CopilotSessionRegistry } from "./copilot-session-registry.js";
import { createCopilotSessionController } from "./copilot-session.js";
import { gatewayUrlFromPairing } from "./panel-core.js";

const PANEL_PORT = "openclaw-copilot-panel";

/** Background-owned session custody for all tab-specific panel documents. */
export function createCopilotController({
  chromeApi = chrome,
  getConfig,
  isTabShared,
  addTabToOpenClawGroup,
  attachDebugger,
  revokeDebugger,
  restoreDebugger,
  scheduleTabsSync,
  gateway = new CopilotGatewayClient(),
  recoveryGatewayFactory = () => new CopilotGatewayClient(),
}) {
  const registry = new CopilotSessionRegistry(chromeApi.storage);
  const panelBindings = new CopilotPanelBindingRegistry(chromeApi.storage.session);
  const portsByTab = new Map();
  const subscribedKeys = new Set();
  const sendsByTab = new Set();
  const ensureByTab = new Map();
  const suspendByTab = new Map();
  const tabRevisions = new Map();
  const portRevisions = new Map();
  const consentRevisions = new Map();
  const consentByTab = new Map();
  const historyTimers = new Map();
  let gatewayStatus = { state: "off", label: "Pair the extension first" };
  let currentConfig = null;
  let gatewayRevision = 0;
  let gatewayStatusRevision = 0;
  let reconciledGatewayStatusRevision = 0;
  let lastReadyStatus = null;
  let custodyInitialized = null;
  let initialized = null;
  let lifecycleChain = Promise.resolve();
  let pendingGatewayRevocation = Promise.resolve();
  let configTransitioning = false;

  const {
    abortEntry,
    clearAbortRetry,
    drainAborts,
    drainArchives,
    drainStaleScopes,
    reconcileGatewayReady,
    scheduleAbortRetry,
    scheduleStaleRecovery,
  } = createCopilotRecoveryController({
    gateway,
    recoveryGatewayFactory,
    registry,
    subscribedKeys,
    sendsByTab,
    currentGatewayScope,
    getGatewayStatus: () => gatewayStatus,
    getGatewayStatusRevision: () => gatewayStatusRevision,
    getLastReadyStatus: () => lastReadyStatus,
    isConfigTransitioning: () => configTransitioning,
    setReconciledGatewayStatus: (status, revision) => {
      gatewayStatus = status;
      reconciledGatewayStatusRevision = revision;
    },
    restoreDebuggerIfReleased,
    broadcastTab,
    broadcastStatus,
    refreshPanelState,
    runLifecycle,
  });

  const relayCustody = createCopilotRelayCustodyController({
    appendGatewayRevocation: (revocation) => {
      const previousRevocation = pendingGatewayRevocation;
      pendingGatewayRevocation = Promise.allSettled([previousRevocation, revocation]).then(
        () => undefined,
      );
    },
    broadcastStatus,
    currentGatewayScope,
    drainAborts,
    getGatewayStatus: () => gatewayStatus,
    invalidateGatewayEpoch: () => {
      gatewayRevision += 1;
    },
    markGatewayAbortError: () => {
      reconciledGatewayStatusRevision = 0;
      gatewayStatus = { state: "error", label: "Could not stop the previous tab run" };
    },
    registry,
    revokeActiveBindings,
    runLifecycle,
  });

  const { ensureSession, sendMessage } = createCopilotSessionController({
    chromeApi,
    gateway,
    registry,
    ensureByTab,
    tabRevisions,
    portsByTab,
    portRevisions,
    sendsByTab,
    currentGatewayScope,
    getGatewayRevision: () => gatewayRevision,
    getCurrentConfig: () => currentConfig,
    isConfigTransitioning: () => configTransitioning,
    currentReadyEpoch,
    readyEpochIsCurrent,
    isTabShared,
    attachDebugger,
    revokeDebugger,
    restoreDebuggerIfReleased,
    subscribe,
    unsubscribeTab,
    suspendTab,
    hydrate,
    refreshPanelState,
    drainArchives,
    scheduleAbortRetry,
  });

  async function initializeCustody() {
    if (custodyInitialized) {
      return await custodyInitialized;
    }
    custodyInitialized = (async () => {
      const tabs = await chromeApi.tabs.query({});
      await registry.initialize(
        new Set(tabs.map((tab) => tab.id).filter((tabId) => typeof tabId === "number")),
      );
      await panelBindings.initialize();
      const activeScopes = new Set(
        registry
          .list()
          .filter((entry) => entry.activeRunId)
          .map((entry) => entry.gatewayScope),
      );
      // MV3 can discard process memory mid-run. Rebuild the debugger deny set
      // from durable run custody before relay attachments can resume.
      await Promise.allSettled([...activeScopes].map((scope) => revokeActiveBindings(scope)));
    })();
    return await custodyInitialized;
  }

  async function initialize() {
    if (initialized) {
      return await initialized;
    }
    initialized = (async () => {
      await initializeCustody();
      await refreshConfig();
    })();
    return await initialized;
  }

  function post(port, message) {
    try {
      port.postMessage(message);
    } catch {
      // Panel closed between the state read and delivery.
    }
  }

  function broadcastTab(tabId, message) {
    for (const port of portsByTab.get(tabId) ?? []) {
      post(port, message);
    }
  }

  function broadcastStatus(options) {
    for (const tabId of portsByTab.keys()) {
      void refreshPanelState(tabId, options);
    }
  }

  function currentGatewayScope() {
    return typeof currentConfig?.gatewayUrl === "string" ? currentConfig.gatewayUrl : null;
  }

  function currentPanelStatus() {
    return relayCustody.currentPanelStatus();
  }

  async function restoreDebuggerIfReleased(tabId) {
    if (registry.list().some((entry) => entry.tabId === tabId && entry.activeRunId)) {
      return;
    }
    await restoreDebugger(tabId);
  }

  function currentReadyEpoch() {
    const gatewayScope = currentGatewayScope();
    if (
      !gatewayScope ||
      configTransitioning ||
      !relayCustody.isOperational() ||
      !gateway.ready ||
      gatewayStatus.state !== "ready" ||
      reconciledGatewayStatusRevision !== gatewayStatusRevision
    ) {
      return null;
    }
    return {
      gatewayScope,
      configRevision: gatewayRevision,
      statusRevision: gatewayStatusRevision,
    };
  }

  function readyEpochIsCurrent(epoch) {
    return (
      epoch?.gatewayScope === currentGatewayScope() &&
      epoch.configRevision === gatewayRevision &&
      epoch.statusRevision === gatewayStatusRevision &&
      reconciledGatewayStatusRevision === epoch.statusRevision &&
      !configTransitioning &&
      relayCustody.isOperational() &&
      gateway.ready &&
      gatewayStatus.state === "ready"
    );
  }

  async function applyConfig() {
    const nextConfig = await getConfig();
    const nextGatewayScope = gatewayUrlFromPairing(nextConfig.relayUrl, nextConfig.gatewayUrl);
    const previousGatewayScope = currentGatewayScope();
    if (!previousGatewayScope) {
      const staleScopes = registry.gatewayScopes().filter((scope) => scope !== nextGatewayScope);
      if (staleScopes.length > 0) {
        for (const staleScope of staleScopes) {
          await registry.closeInactiveScope(staleScope);
        }
        scheduleStaleRecovery();
      }
    }
    if (previousGatewayScope && previousGatewayScope !== nextGatewayScope) {
      configTransitioning = true;
      clearAbortRetry();
      lastReadyStatus = null;
      gatewayStatusRevision += 1;
      reconciledGatewayStatusRevision = 0;
      gatewayRevision += 1;
      gatewayStatus = { state: "connecting", label: "Changing Gateway" };
      broadcastStatus();
      let needsStaleRecovery = false;
      try {
        await revokeActiveBindings(previousGatewayScope);
        await Promise.allSettled([...ensureByTab.values()].map((entry) => entry.promise));
        await drainAborts(previousGatewayScope);
        const hasPendingAborts = registry.pendingAborts(previousGatewayScope).length > 0;
        if (hasPendingAborts) {
          await registry.closeInactiveScope(previousGatewayScope);
        } else {
          await registry.closeScope(previousGatewayScope);
        }
        await drainArchives(previousGatewayScope);
        needsStaleRecovery =
          hasPendingAborts || registry.pendingArchives(previousGatewayScope).length > 0;
      } catch {
        // The next Gateway may start, but old-scope custody remains denied and
        // the recovery client owns cleanup. Never strand the controller mid-switch.
        needsStaleRecovery = true;
      } finally {
        gateway.stop();
        sendsByTab.clear();
        subscribedKeys.clear();
        configTransitioning = false;
      }
      if (needsStaleRecovery) {
        scheduleStaleRecovery();
      }
    }
    currentConfig = { ...nextConfig, gatewayUrl: nextGatewayScope };
    configTransitioning = false;
    if (!currentConfig.relayUrl || !nextGatewayScope) {
      gateway.stop();
      gatewayStatus = {
        state: "off",
        label: currentConfig.relayUrl
          ? "Pair again to add the Gateway endpoint"
          : "Pair the extension first",
      };
      broadcastStatus();
      return;
    }
    try {
      resolveBindingTarget(currentConfig);
    } catch (error) {
      clearAbortRetry();
      lastReadyStatus = null;
      gatewayStatusRevision += 1;
      await registry.closeScope(nextGatewayScope);
      await drainArchives(nextGatewayScope);
      gateway.stop();
      gatewayStatus = { state: "denied", label: error.message };
      broadcastStatus();
      return;
    }
    gateway.start(nextGatewayScope);
  }

  function runLifecycle(task) {
    const pending = lifecycleChain.then(task);
    lifecycleChain = pending.catch(() => undefined);
    return pending;
  }

  function refreshConfig() {
    // Config changes and stale-scope recovery share one owner. Otherwise a
    // scope can become current while a recovery client is still destroying it.
    return runLifecycle(applyConfig);
  }

  async function refreshPanelState(
    tabId,
    { shared: knownShared, ensureSetup = false, hydrateHistory = false, suspended = false } = {},
  ) {
    let tab;
    try {
      tab = await chromeApi.tabs.get(tabId);
    } catch {
      return;
    }
    const shared = typeof knownShared === "boolean" ? knownShared : await isTabShared(tabId);
    const entry = registry.get(tabId, currentGatewayScope());
    const panelStatus = currentPanelStatus();
    const state = selectCopilotPanelState({
      paired: Boolean(currentConfig?.relayUrl),
      shared,
      abortPending: Boolean(entry?.abortPending),
      gatewayState: panelStatus.state,
    });
    const panelState = {
      type: "panel.state",
      state,
      label:
        state === "needs-sharing"
          ? "Share this tab before the copilot can act"
          : state === "reconciling"
            ? "Stopping the previous tab run"
            : panelStatus.label,
      requestId: panelStatus.requestId,
      tab: {
        title: typeof tab.title === "string" ? tab.title : "",
        url: typeof tab.url === "string" ? tab.url : "",
        label: safeTabLabel(tab),
      },
      sessionKey: entry?.sessionKey,
    };
    if (!shared) {
      broadcastTab(tabId, panelState);
      if (!suspended) {
        await suspendTab(tabId, { detachInactive: true });
      }
      return;
    }
    if (state !== "ready") {
      broadcastTab(tabId, panelState);
      return;
    }
    const needsSetup =
      ensureSetup || !entry || !subscribedKeys.has(entry.sessionKey) || !entry.binding;
    if (!needsSetup) {
      broadcastTab(tabId, panelState);
      return;
    }
    broadcastTab(tabId, {
      ...panelState,
      state: "connecting",
      label: "Preparing this tab",
    });
    try {
      const prepared = await ensureSession(tabId, { hydrateHistory });
      if (prepared) {
        await refreshPanelState(tabId, { shared: await isTabShared(tabId) });
      }
    } catch (error) {
      broadcastTab(tabId, {
        ...panelState,
        state: "error",
        label: error?.message || "Could not prepare this tab",
      });
    }
  }

  async function subscribe(entry) {
    if (subscribedKeys.has(entry.sessionKey)) {
      return;
    }
    await gateway.request("sessions.messages.subscribe", { key: entry.sessionKey });
    subscribedKeys.add(entry.sessionKey);
  }

  async function unsubscribeTab(tabId, gatewayScope = currentGatewayScope()) {
    const entry = registry.get(tabId, gatewayScope);
    if (!entry || !subscribedKeys.delete(entry.sessionKey)) {
      return;
    }
    try {
      await gateway.request("sessions.messages.unsubscribe", { key: entry.sessionKey });
    } catch {
      // Socket closure also clears the server-owned allowlist.
    }
  }

  async function suspendTab(tabId, { expectedPortRevision, detachInactive = false } = {}) {
    if (expectedPortRevision !== undefined && portRevisions.get(tabId) !== expectedPortRevision) {
      return;
    }
    const gatewayScope = currentGatewayScope();
    const entry = registry.get(tabId, gatewayScope);
    // Revoke local delivery and CDP access before any fallible Gateway RPC.
    const unsubscribing = unsubscribeTab(tabId, gatewayScope);
    const detaching = entry?.activeRunId
      ? revokeDebugger(tabId)
      : detachInactive
        ? revokeDebugger(tabId).then(() => restoreDebuggerIfReleased(tabId))
        : Promise.resolve();
    const queued = await registry.queueAbort(tabId, gatewayScope);
    sendsByTab.delete(tabId);
    await Promise.allSettled([unsubscribing, detaching]);
    if (queued && gateway.ready) {
      await abortEntry(queued);
    }
  }

  function scheduleSuspend(tabId, portRevision) {
    const pending = suspendTab(tabId, { expectedPortRevision: portRevision }).finally(() => {
      if (suspendByTab.get(tabId) === pending) {
        suspendByTab.delete(tabId);
      }
    });
    suspendByTab.set(tabId, pending);
    return pending;
  }

  async function hydrate(tabId, entry = registry.get(tabId, currentGatewayScope())) {
    if (!entry || !portsByTab.has(tabId)) {
      return;
    }
    try {
      const history = await gateway.request("chat.history", {
        sessionKey: entry.sessionKey,
        limit: 200,
      });
      broadcastTab(tabId, {
        type: "panel.history",
        sessionKey: entry.sessionKey,
        messages: Array.isArray(history?.messages) ? history.messages : [],
      });
    } catch (error) {
      broadcastTab(tabId, { type: "panel.error", message: error.message });
    }
  }

  function scheduleHydrate(tabId) {
    if (historyTimers.has(tabId)) {
      return;
    }
    historyTimers.set(
      tabId,
      setTimeout(() => {
        historyTimers.delete(tabId);
        void hydrate(tabId);
      }, 100),
    );
  }

  async function shareTab(tabId) {
    await addTabToOpenClawGroup(tabId);
    scheduleTabsSync();
    await refreshPanelState(tabId);
  }

  async function onTabRemoved(tabId) {
    tabRevisions.set(tabId, (tabRevisions.get(tabId) ?? 0) + 1);
    consentRevisions.set(tabId, (consentRevisions.get(tabId) ?? 0) + 1);
    await initialize();
    portsByTab.delete(tabId);
    portRevisions.set(tabId, (portRevisions.get(tabId) ?? 0) + 1);
    sendsByTab.delete(tabId);
    const timer = historyTimers.get(tabId);
    if (timer) {
      clearTimeout(timer);
      historyTimers.delete(tabId);
    }
    try {
      await ensureByTab.get(tabId)?.promise;
    } catch {
      // Closing the tab still owns cleanup when a concurrent session setup failed.
    }
    await registry.closeTab(tabId);
    await panelBindings.remove(tabId);
    await drainArchives(currentGatewayScope());
  }

  async function onConsentChanged(changedTabId, { revoked = false } = {}) {
    await initialize();
    const tabIds =
      typeof changedTabId === "number"
        ? portsByTab.has(changedTabId) ||
          registry.list().some((entry) => entry.tabId === changedTabId)
          ? [changedTabId]
          : []
        : [...new Set([...portsByTab.keys(), ...registry.list().map((entry) => entry.tabId)])];
    await Promise.all(
      tabIds.map((tabId) => {
        const revision = (consentRevisions.get(tabId) ?? 0) + 1;
        consentRevisions.set(tabId, revision);
        const previous = consentByTab.get(tabId) ?? Promise.resolve();
        const pending = previous
          .catch(() => undefined)
          .then(async () => {
            // Event-time revocation is sticky even if a later update observes
            // the tab re-shared. CDP must detach for the revoked interval.
            if (revoked) {
              await suspendTab(tabId, { detachInactive: true });
            }
            if (consentRevisions.get(tabId) !== revision) {
              return;
            }
            let shared = false;
            try {
              shared = await isTabShared(tabId);
            } catch {
              // Missing tab state is treated as revoked consent.
            }
            if (!shared) {
              await suspendTab(tabId, { detachInactive: true });
            }
            if (consentRevisions.get(tabId) !== revision) {
              return;
            }
            try {
              shared = await isTabShared(tabId);
            } catch {
              shared = false;
            }
            if (consentRevisions.get(tabId) !== revision) {
              return;
            }
            if (shared) {
              await restoreDebuggerIfReleased(tabId);
            }
            await refreshPanelState(tabId, { shared, suspended: !shared });
          })
          .finally(() => {
            if (consentByTab.get(tabId) === pending) {
              consentByTab.delete(tabId);
            }
          });
        consentByTab.set(tabId, pending);
        return pending;
      }),
    );
  }

  async function preparePanel(tabId) {
    if (!Number.isInteger(tabId)) {
      throw new Error("No active tab.");
    }
    await chromeApi.tabs.get(tabId);
    const binding = await panelBindings.bind(tabId);
    return { path: `${PANEL_PATH}?binding=${encodeURIComponent(binding)}` };
  }

  async function connectPort(port) {
    await initialize();
    let tabId;
    try {
      tabId = await resolveSidePanelTabId(chromeApi, port, panelBindings);
    } catch (error) {
      post(port, { type: "panel.state", state: "denied", label: error.message });
      port.disconnect();
      return;
    }
    const ports = portsByTab.get(tabId) ?? new Set();
    ports.add(port);
    portsByTab.set(tabId, ports);
    const portRevision = (portRevisions.get(tabId) ?? 0) + 1;
    portRevisions.set(tabId, portRevision);
    port.onMessage.addListener((message) => {
      void (async () => {
        try {
          if (message?.type === "panel.send") {
            await sendMessage(tabId, port, portRevision, message.message);
          } else if (message?.type === "panel.share") {
            await shareTab(tabId);
          } else if (message?.type === "panel.refresh") {
            await refreshPanelState(tabId);
          }
        } catch (error) {
          post(port, { type: "panel.error", message: error.message });
        }
      })();
    });
    port.onDisconnect.addListener(() => {
      ports.delete(port);
      if (ports.size === 0) {
        portsByTab.delete(tabId);
        const disconnectedRevision = (portRevisions.get(tabId) ?? 0) + 1;
        portRevisions.set(tabId, disconnectedRevision);
        void scheduleSuspend(tabId, disconnectedRevision);
      }
    });
    await suspendByTab.get(tabId);
    await refreshPanelState(tabId, { ensureSetup: true, hydrateHistory: true });
  }

  async function revokeActiveBindings(gatewayScope) {
    const activeEntries = registry
      .list()
      .filter((entry) => entry.gatewayScope === gatewayScope && entry.activeRunId);
    await Promise.allSettled([
      registry.queueActiveAborts(gatewayScope),
      ...activeEntries.map((entry) => revokeDebugger(entry.tabId)),
    ]);
  }

  gateway.onStatus((status) => {
    const statusRevision = ++gatewayStatusRevision;
    // A new connection epoch owns its own abort retry timer.
    clearAbortRetry();
    subscribedKeys.clear();
    if (status.state === "ready") {
      const gatewayScope = currentGatewayScope();
      lastReadyStatus = status;
      gatewayStatus = { state: "connecting", label: "Reconciling previous tab runs" };
      broadcastStatus();
      void runLifecycle(() =>
        reconcileGatewayReady(status, statusRevision, gatewayScope, pendingGatewayRevocation),
      ).catch(() => {
        if (gatewayScope === currentGatewayScope() && statusRevision === gatewayStatusRevision) {
          gatewayStatus = { state: "error", label: "Could not reconcile previous tab runs" };
          broadcastStatus();
        }
      });
      return;
    }
    reconciledGatewayStatusRevision = 0;
    const gatewayScope = currentGatewayScope();
    if (gatewayScope) {
      pendingGatewayRevocation = revokeActiveBindings(gatewayScope);
    } else {
      pendingGatewayRevocation = Promise.resolve();
    }
    lastReadyStatus = null;
    gatewayStatus = status;
    broadcastStatus();
  });

  gateway.onEvent((event) => {
    const sessionKey = sessionKeyFromEvent(event);
    if (!sessionKey) {
      return;
    }
    for (const [tabId, ports] of portsByTab) {
      const entry = registry.get(tabId, currentGatewayScope());
      if (entry?.sessionKey !== sessionKey || !subscribedKeys.has(sessionKey)) {
        continue;
      }
      for (const port of ports) {
        post(port, { type: "panel.event", event });
      }
      const state = event.payload?.state;
      if (event.event === "session.message") {
        scheduleHydrate(tabId);
      }
      if (
        event.event === "chat" &&
        (state === "final" || state === "aborted" || state === "error")
      ) {
        const runId = event.payload?.runId;
        if (typeof runId === "string" && entry.activeRunId === runId) {
          const gatewayScope = currentGatewayScope();
          sendsByTab.delete(tabId);
          scheduleHydrate(tabId);
          if (gatewayScope) {
            void registry
              .finishRun(gatewayScope, entry.sessionKey, runId)
              .then(async (finished) => {
                if (finished) {
                  await restoreDebuggerIfReleased(tabId);
                  void refreshPanelState(tabId);
                }
                void drainArchives(gatewayScope);
              });
            continue;
          }
        }
        void drainArchives();
      }
    }
  });

  chromeApi.runtime.onConnect.addListener((port) => {
    if (port.name === PANEL_PORT) {
      void connectPort(port);
    }
  });

  return {
    initializeCustody,
    initialize,
    preparePanel,
    onConsentChanged,
    onRelayStatus: (status) => relayCustody.onStatus(status),
    onTabRemoved,
    refreshConfig,
    drainAborts,
    drainArchives,
    drainStaleScopes,
    registry,
  };
}
