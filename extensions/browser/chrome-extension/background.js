import {
  createNativeBootstrapController,
  discardRetiredCopilotState,
  prepareRetiredCopilotState,
} from "./modules/native-bootstrap.js";
import { createPopupMessageHandler } from "./modules/popup-background.js";
import { createRelayCommandHandler } from "./modules/relay-command-handler.js";
import { openAuthenticatedRelaySocket } from "./modules/relay-connection.js";
// OpenClaw extension service worker.
//
// Thin transport between the OpenClaw extension relay (loopback WebSocket) and
// chrome.debugger. All CDP target synthesis lives server-side in the relay
// bridge; this worker owns tab eligibility/access and forwards allowed frames.
// The OpenClaw tab group is the ACL in selected mode and an ownership marker
// in all-tabs mode.
import {
  ACCESS_MODE_SELECTED,
  createPairingConfigStore,
  reconnectDelayMs,
  toRelayTabInfo,
} from "./modules/relay-core.js";
import { createRelayDebugger } from "./modules/relay-debugger.js";
import { isTabSelected } from "./modules/relay-tab-groups.js";
import { registerTabAccessEvents } from "./modules/tab-access-events.js";
import { createTabAccessPolicy } from "./modules/tab-access.js";

const BADGE = {
  off: { text: "", color: "#000000" },
  connecting: { text: "…", color: "#F59E0B" },
  on: { text: "ON", color: "#0F9D58" },
  error: { text: "!", color: "#B91C1C" },
};
const RELAY_WATCHDOG_ALARM = "openclaw-relay-watchdog";
const RELAY_OPENING_DEADLINE_ALARM = "openclaw-relay-opening-deadline";
const RELAY_AUTH_TIMEOUT_MS = 10_000;

/** @type {WebSocket|null} */
let relayWs = null;
let relayState = "off"; // off | connecting | on | error
let reconnectAttempt = 0;
let reconnectTimer = null;
let relayOpeningDeadlineAt = 0;
let relayOpeningDeadlineTimer = null;
let relayAuthenticatedSocket = null;
let relaySocketOwner = null;
let relayStatusHint = "";
let reconciledPairingInvalidationRevision = 0;
let relayConnectionGeneration = 0;
let relayConnectionsSuspended = false;
let nativeBootstrap = null;
// Start blocked: no runtime path may outrun the retired-state storage read.
let retiredCopilotCustodyBlocked = true;
/** Debounce handle for tab-list refreshes. */
let tabsSyncTimer = null;
let accessMutationChain = Promise.resolve();
const pairingConfigStore = createPairingConfigStore(chrome.storage.local);
const tabAccessPolicy = createTabAccessPolicy({
  isSelectedTab: isTabSelected,
  getGroupColor: async () => (await getConfig()).groupColor,
});
const relayDebugger = createRelayDebugger({ policy: tabAccessPolicy, requireAutomationAllowed });
const { attachedTabs, attachedAccessEpochs, attachingTabs, detach: detachDebugger } = relayDebugger;
const tabAccessReady = (async () => {
  const retiredState = await prepareRetiredCopilotState();
  retiredCopilotCustodyBlocked = retiredState.blocked;
  const config = await pairingConfigStore.read();
  await tabAccessPolicy.initialize(
    config.accessMode,
    Boolean(config.relayUrl) && !retiredCopilotCustodyBlocked,
  );
  if (retiredCopilotCustodyBlocked) {
    tabAccessPolicy.setEnabled(false);
    await detachAllDebuggerSessions();
  }
})();

const custodyError = () =>
  new Error(
    "Automation is paused to protect a pre-upgrade copilot session. Open Settings to disconnect before reconnecting.",
  );

async function requireAutomationAllowed() {
  await tabAccessReady;
  if (retiredCopilotCustodyBlocked) {
    throw custodyError();
  }
}

function retireRelayOwner(owner) {
  void owner?.retire().catch((error) => {
    console.warn("Relay debugger retirement failed", error);
  });
}

function closeRelaySocket(code, reason) {
  clearRelayOpeningDeadline();
  const socket = relayWs;
  if (!socket) {
    return;
  }
  retireRelayOwner(relaySocketOwner);
  relaySocketOwner = null;
  relayWs = null;
  if (relayAuthenticatedSocket === socket) {
    relayAuthenticatedSocket = null;
  }
  socket.close(code, reason);
}

function suspendRelayConnections() {
  relayConnectionsSuspended = true;
  relayConnectionGeneration += 1;
}

function resumeRelayConnections() {
  relayConnectionsSuspended = false;
  relayConnectionGeneration += 1;
}

async function reconcilePairingInvalidation() {
  if (reconciledPairingInvalidationRevision === pairingConfigStore.invalidationRevision) {
    return;
  }
  reconciledPairingInvalidationRevision = pairingConfigStore.invalidationRevision;
  await syncTabsToRelay();
  closeRelaySocket();
  setBadge("off");
  await detachAllDebuggerSessions();
}

function setBadge(kind) {
  relayState = kind;
  const cfg = BADGE[kind] ?? BADGE.off;
  void chrome.action.setBadgeText({ text: cfg.text });
  void chrome.action.setBadgeBackgroundColor({ color: cfg.color });
}

async function getConfig() {
  await tabAccessReady;
  const config = await pairingConfigStore.read();
  if (retiredCopilotCustodyBlocked || !config.relayUrl) {
    tabAccessPolicy.setEnabled(false);
  }
  if (config.pairingStatusHint) {
    relayStatusHint = config.pairingStatusHint;
  }
  return config;
}

function runAccessMutation(task) {
  const pending = accessMutationChain.then(task, task);
  accessMutationChain = pending.catch(() => undefined);
  return pending;
}

// ---------------------------------------------------------------------------
// Tab group management (selected-mode ACL; all-mode ownership marker)
// ---------------------------------------------------------------------------

async function focusWindowForTab(tab) {
  if (typeof tab.windowId === "number") {
    await chrome.windows.update(tab.windowId, { focused: true });
  }
}

async function removeTabFromOpenClawGroup(tabId) {
  try {
    await chrome.tabs.ungroup([tabId]);
  } catch {
    // tab may already be gone
  }
}

function scheduleTabsSync() {
  if (tabsSyncTimer) {
    return;
  }
  tabsSyncTimer = setTimeout(() => {
    tabsSyncTimer = null;
    void syncTabsToRelay();
  }, 150);
}

async function syncTabsToRelay() {
  if (retiredCopilotCustodyBlocked) {
    return;
  }
  const socket = relayWs;
  if (!socket || socket.readyState !== WebSocket.OPEN || relayAuthenticatedSocket !== socket) {
    return;
  }
  const accessible = await tabAccessPolicy.listAccessibleTabs();
  if (relayWs !== socket || relayAuthenticatedSocket !== socket) {
    return;
  }
  const accessibleIds = new Set(accessible.map((tab) => tab.id));
  for (const tabId of attachedTabs) {
    if (!accessibleIds.has(tabId)) {
      void detachDebugger(tabId);
    }
  }
  // A creation is authorized internally, but discovery must wait for handoff.
  const tabs = accessible.filter((tab) => tabAccessPolicy.canPublishTab(tab.id));
  send({ type: "tabs", tabs: tabs.map(toRelayTabInfo) }, socket);
}

// ---------------------------------------------------------------------------
// chrome.debugger transport
// ---------------------------------------------------------------------------

async function detachAllDebuggerSessions() {
  await relayDebugger.detachAll();
  if (retiredCopilotCustodyBlocked) {
    // Startup recovery must also release inherited copilot attachments. Chrome
    // detach addresses only this extension's client; it never adopts a target.
    const targets = await chrome.debugger.getTargets();
    await Promise.all(
      targets
        .filter((target) => target.attached && typeof target.tabId === "number")
        .map((target) => detachDebugger(target.tabId)),
    );
  }
}

async function reconcileAccessMode(nextMode, { transitioning = false } = {}) {
  await tabAccessReady;
  const previousMode = tabAccessPolicy.mode;
  const mode = tabAccessPolicy.setMode(nextMode);
  if (mode === previousMode) {
    if (transitioning) {
      tabAccessPolicy.endTransition();
    }
    return mode;
  }
  await Promise.allSettled(attachingTabs.values());
  if (mode === ACCESS_MODE_SELECTED) {
    const selectedIds = new Set(
      (
        await tabAccessPolicy.listAccessibleTabs({
          allowDuringTransition: transitioning,
        })
      ).map((tab) => tab.id),
    );
    await Promise.allSettled(
      [...attachedTabs]
        .filter((tabId) => !selectedIds.has(tabId))
        .map((tabId) => detachDebugger(tabId)),
    );
  }
  if (transitioning) {
    tabAccessPolicy.endTransition();
  }
  for (const tabId of attachedTabs) {
    const epoch = tabAccessPolicy.capture(tabId);
    const state = await tabAccessPolicy.inspectTab(tabId, epoch);
    if (!tabAccessPolicy.epochIsCurrent(tabId, epoch)) {
      // A post-transition tab event owns the newer revision. Keep this
      // attachment fail-closed until that handler reconciles it.
      continue;
    }
    if (!state.accessible) {
      await detachDebugger(tabId);
    } else if (attachedTabs.has(tabId)) {
      attachedAccessEpochs.set(tabId, epoch);
    }
  }
  await syncTabsToRelay();
  return mode;
}

async function pauseTab(tabId) {
  let storageError = null;
  try {
    await tabAccessPolicy.pause(tabId);
  } catch (error) {
    storageError = error;
  }
  await Promise.allSettled([attachingTabs.get(tabId)]);
  await detachDebugger(tabId);
  await syncTabsToRelay();
  if (storageError) {
    throw storageError instanceof Error
      ? storageError
      : new Error("Could not persist the tab pause.");
  }
}

// ---------------------------------------------------------------------------
// Relay connection
// ---------------------------------------------------------------------------

function send(message, socket = relayWs) {
  if (
    !retiredCopilotCustodyBlocked &&
    socket &&
    relayWs === socket &&
    socket.readyState === WebSocket.OPEN &&
    relayAuthenticatedSocket === socket
  ) {
    socket.send(JSON.stringify(message));
  }
}

function clearRelayOpeningDeadline() {
  relayOpeningDeadlineAt = 0;
  if (relayOpeningDeadlineTimer) {
    clearTimeout(relayOpeningDeadlineTimer);
    relayOpeningDeadlineTimer = null;
  }
  void chrome.alarms.clear(RELAY_OPENING_DEADLINE_ALARM);
}

function armRelayOpeningDeadline() {
  clearRelayOpeningDeadline();
  relayOpeningDeadlineAt = Date.now() + RELAY_AUTH_TIMEOUT_MS;
  relayOpeningDeadlineTimer = setTimeout(handleRelayOpeningDeadline, RELAY_AUTH_TIMEOUT_MS);
  chrome.alarms.create(RELAY_OPENING_DEADLINE_ALARM, { when: relayOpeningDeadlineAt });
}

function failRelayAuthentication(ws, error) {
  if (relayWs !== ws) {
    return;
  }
  relayStatusHint =
    "Relay authentication v2 failed. Update OpenClaw, or re-pair after a relay key rotation.";
  try {
    closeRelaySocket(
      4001,
      error instanceof Error ? error.message.slice(0, 120) : "authentication failed",
    );
  } catch {
    ws.close();
  }
  setBadge("error");
  scheduleReconnect();
}

async function sendHello(socket) {
  const accessible = await tabAccessPolicy.listAccessibleTabs();
  const uaMatch = /Chrom(?:e|ium)\/[\d.]+/.exec(navigator.userAgent);
  send(
    {
      type: "hello",
      userAgent: navigator.userAgent,
      browserVersion: uaMatch ? uaMatch[0] : "Chrome/unknown",
      extensionVersion: chrome.runtime.getManifest().version,
      tabs: accessible.filter((tab) => tabAccessPolicy.canPublishTab(tab.id)).map(toRelayTabInfo),
    },
    socket,
  );
}

async function connectRelay(isConnectionAllowed = () => true) {
  await tabAccessReady;
  if (retiredCopilotCustodyBlocked) {
    tabAccessPolicy.setEnabled(false);
    closeRelaySocket();
    setBadge("off");
    return;
  }
  const connectionGeneration = relayConnectionGeneration;
  const connectionIsCurrent = () =>
    !relayConnectionsSuspended &&
    connectionGeneration === relayConnectionGeneration &&
    isConnectionAllowed();
  const { relayUrl, token } = await getConfig();
  if (!connectionIsCurrent()) {
    return;
  }
  await reconcilePairingInvalidation();
  if (!connectionIsCurrent()) {
    return;
  }
  if (!relayUrl || !token) {
    clearRelayOpeningDeadline();
    setBadge("off");
    return;
  }
  if (
    relayWs &&
    (relayWs.readyState === WebSocket.OPEN || relayWs.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }
  // Pair revocation can race either awaited config step above. Keep the final
  // cancellation check adjacent to socket creation so a stale pair cannot reconnect.
  if (!connectionIsCurrent()) {
    return;
  }
  closeRelaySocket();
  setBadge("connecting");
  let ws;
  const owner = relayDebugger.createOwner(
    () =>
      relayWs === ws &&
      relayAuthenticatedSocket === ws &&
      ws.readyState === WebSocket.OPEN &&
      connectionIsCurrent(),
  );
  const handleRelayCommand = createRelayCommandHandler({
    send: (message) => send(message, ws),
    isCurrent: owner.isCurrent,
    attachDebugger: owner.attach,
    detachDebugger: owner.detach,
    createTab: (message, operation) => tabAccessPolicy.createTab(message, operation),
    focusWindowForTab,
    scheduleTabsSync,
    captureAccess: (tabId, method) => tabAccessPolicy.capture(tabId, method),
    requireAccessibleTab: owner.requireTab,
    requireNavigatedTab: (tabId, epoch) => owner.requireTab(tabId, epoch, true),
    navigateTab: (tabId, epoch, params, isCurrent, sendCommand) =>
      tabAccessPolicy.navigateTab(
        tabId,
        epoch,
        params,
        () => attachedAccessEpochs.get(tabId),
        isCurrent,
        sendCommand,
      ),
  });
  try {
    ws = openAuthenticatedRelaySocket({
      relayUrl,
      token,
      isCurrent: (socket) => relayWs === socket,
      onAuthenticated: async (socket) => {
        relayAuthenticatedSocket = socket;
        relayStatusHint = "";
        clearRelayOpeningDeadline();
        reconnectAttempt = 0;
        setBadge("on");
        await sendHello(socket);
      },
      onApplicationMessage: (_socket, msg) => {
        void handleRelayCommand(msg);
      },
      onAuthenticationFailure: (socket, error) => failRelayAuthentication(socket, error),
      onClose: (socket, authenticated) => {
        retireRelayOwner(owner);
        if (relayWs !== socket) {
          return;
        }
        clearRelayOpeningDeadline();
        relaySocketOwner = null;
        relayWs = null;
        if (authenticated) {
          relayAuthenticatedSocket = null;
        } else if (!relayStatusHint) {
          relayStatusHint =
            "Relay authentication v2 failed. Update OpenClaw, or re-pair after a relay key rotation.";
        }
        setBadge("error");
        scheduleReconnect();
      },
    });
  } catch {
    setBadge("error");
    scheduleReconnect();
    return;
  }
  relayWs = ws;
  relayAuthenticatedSocket = null;
  relaySocketOwner = owner;
  armRelayOpeningDeadline();
  // onclose follows onerror and drives the reconnect, so no error handler needed.
}

function handleRelayOpeningDeadline() {
  const ws = relayWs;
  if (!ws) {
    clearRelayOpeningDeadline();
    return;
  }
  if (relayAuthenticatedSocket === ws) {
    clearRelayOpeningDeadline();
    return;
  }
  if (relayOpeningDeadlineAt === 0 || Date.now() < relayOpeningDeadlineAt) {
    return;
  }

  // Clear ownership before close so a delayed close/open event from this
  // socket cannot mutate the replacement connection's badge or deadline.
  try {
    closeRelaySocket(4001, "relay authentication timed out");
  } catch {
    // The socket may have changed state while the alarm event was queued.
  }
  setBadge("error");
  relayStatusHint = "Relay authentication v2 timed out. Make sure OpenClaw is up to date.";
  scheduleReconnect();
}

function scheduleReconnect() {
  if (reconnectTimer) {
    return;
  }
  const delay = reconnectDelayMs(reconnectAttempt);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void startAutomation();
  }, delay);
}

async function startAutomation() {
  await tabAccessReady;
  if (retiredCopilotCustodyBlocked) {
    return;
  }
  await nativeBootstrap.attempt();
  await connectRelay();
}

// ---------------------------------------------------------------------------
// Popup messaging + lifecycle
// ---------------------------------------------------------------------------

const handlePopupMessage = createPopupMessageHandler({
  pairingConfigStore,
  policy: tabAccessPolicy,
  accessReady: tabAccessReady,
  getConfig,
  getRelayState: () => relayState,
  getRelayStatusHint: () => relayStatusHint,
  getNativeBootstrapStatus: async () => {
    await tabAccessReady;
    if (!retiredCopilotCustodyBlocked) {
      await nativeBootstrap.attempt();
    }
    return await nativeBootstrap.status();
  },
  enableNativeBootstrap: async (enabled) => {
    await requireAutomationAllowed();
    return enabled ? await nativeBootstrap.enable() : await nativeBootstrap.disableSynchronously();
  },
  onManualPairing: () => nativeBootstrap.enable({ attemptNow: false }),
  onUnpairStart: () => nativeBootstrap.disableSynchronously(),
  isRetiredCopilotCustodyBlocked: () => retiredCopilotCustodyBlocked,
  requireAutomationAllowed,
  discardRetiredCopilotCustody: async () => {
    retiredCopilotCustodyBlocked = true;
    tabAccessPolicy.setEnabled(false);
    tabAccessPolicy.invalidateAll();
    await discardRetiredCopilotState();
    retiredCopilotCustodyBlocked = false;
  },
  resetRelayState: () => {
    relayStatusHint = "";
    reconnectAttempt = 0;
  },
  suspendRelayConnections,
  resumeRelayConnections,
  reconcilePairingInvalidation,
  reconcileAccessMode,
  runAccessMutation,
  detachAllDebuggerSessions,
  syncTabsToRelay,
  closeRelaySocket,
  connectRelay,
  setBadge,
  attachingTabs,
  detachDebugger,
  removeTabFromOpenClawGroup,
  addTabToOpenClawGroup: (tabId) => tabAccessPolicy.addTabToGroup(tabId),
  scheduleTabsSync,
  pauseTab,
});
nativeBootstrap = createNativeBootstrapController({
  getPairing: getConfig,
  applyPairing: async (request) => await handlePopupMessage.applyPairing(request),
});
chrome.runtime.onMessage.addListener((msg, _sender, reply) => handlePopupMessage(msg, reply));

registerTabAccessEvents({
  accessReady: tabAccessReady,
  policy: tabAccessPolicy,
  attachedTabs,
  attachedAccessEpochs,
  attachingTabs,
  send,
  scheduleTabsSync,
  detachDebugger,
  pauseTab,
  removeTabFromOpenClawGroup,
  runAccessMutation,
});

// Watchdog: MV3 can stop this worker; the alarm revives it and re-connects.
chrome.alarms.create(RELAY_WATCHDOG_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RELAY_WATCHDOG_ALARM) {
    void startAutomation();
  } else if (alarm.name === RELAY_OPENING_DEADLINE_ALARM) {
    handleRelayOpeningDeadline();
  }
});
chrome.runtime.onStartup.addListener(() => {
  void startAutomation();
});
chrome.runtime.onInstalled.addListener(() => {
  void startAutomation();
});
void startAutomation();
