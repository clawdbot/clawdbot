import { createCopilotController } from "./modules/copilot-background.js";
import {
  buildPageSharePayload,
  capturePageShare,
  waitForCondition,
} from "./modules/page-share-core.js";
import { createPageShareRelay } from "./modules/page-share-relay.js";
import { createRelayCommandHandler } from "./modules/relay-command-handler.js";
import { openAuthenticatedRelaySocket } from "./modules/relay-connection.js";
// OpenClaw extension service worker.
//
// Thin transport between the OpenClaw extension relay (loopback WebSocket) and
// chrome.debugger. All CDP target synthesis lives server-side in the relay
// bridge; this worker only attaches tabs, forwards frames, and keeps the
// OpenClaw tab group in sync. Membership in that group is the user-visible
// consent boundary: only grouped tabs are reported to (and driven by) OpenClaw.
import {
  OPENCLAW_TAB_GROUP_TITLE,
  createPairingConfigStore,
  nearestGroupColor,
  parsePairingString,
  reconnectDelayMs,
  toRelayTabInfo,
} from "./modules/relay-core.js";
import {
  findOpenClawGroups,
  isOpenClawGroupId,
  listSharedTabs,
  requireSharedTab,
} from "./modules/relay-tab-groups.js";

const BADGE = {
  off: { text: "", color: "#000000" },
  connecting: { text: "…", color: "#F59E0B" },
  on: { text: "ON", color: "#0F9D58" },
  error: { text: "!", color: "#B91C1C" },
};
const COPILOT_RELAY_LABEL = {
  off: "Browser relay disconnected",
  connecting: "Connecting to browser relay",
  on: "Browser relay connected",
  error: "Browser relay reconnecting",
};
const RELAY_WATCHDOG_ALARM = "openclaw-relay-watchdog";
const RELAY_OPENING_DEADLINE_ALARM = "openclaw-relay-opening-deadline";
const RELAY_AUTH_TIMEOUT_MS = 10_000;

/** @type {WebSocket|null} */
let relayWs = null;
let relayState = "off"; // off | connecting | on | error
let copilot = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let relayOpeningDeadlineAt = 0;
let relayOpeningDeadlineTimer = null;
let relayAuthenticatedSocket = null;
let relayStatusHint = "";
let reconciledPairingInvalidationRevision = 0;
/** Tab ids with an active chrome.debugger attachment. */
const attachedTabs = new Set();
/** Tabs denied to every relay attach while copilot run cleanup is pending. */
const copilotDeniedTabs = new Set();
/** Monotonic revocation epochs invalidate debugger attaches already in flight. */
const tabAccessRevisions = new Map();
/** In-flight attach promises per tab id (coalesces concurrent attaches). */
const attachingTabs = new Map();
/** Latest revocation task per tab; restoration waits for its exact epoch. */
const copilotRevocations = new Map();
/** Debounce handle for tab-list refreshes. */
let tabsSyncTimer = null;
let pageShareBadgeTimer = null;
const pageShareRelay = createPageShareRelay();
const pairingConfigStore = createPairingConfigStore(chrome.storage.local);

function closeRelaySocket() {
  const socket = relayWs;
  if (!socket) {
    return;
  }
  relayWs = null;
  if (relayAuthenticatedSocket === socket) {
    relayAuthenticatedSocket = null;
  }
  // Chrome completes close asynchronously; fail pending requests before the
  // handshake so pairing and unpairing never leave a popup stuck on Sending.
  pageShareRelay.rejectSocket(socket);
  socket.close();
}

async function reconcilePairingInvalidation() {
  if (reconciledPairingInvalidationRevision === pairingConfigStore.invalidationRevision) {
    return;
  }
  reconciledPairingInvalidationRevision = pairingConfigStore.invalidationRevision;
  clearRelayOpeningDeadline();
  closeRelaySocket();
  setBadge("off");
  await copilot?.refreshConfig();
}

function setBadge(kind) {
  relayState = kind;
  const cfg = BADGE[kind] ?? BADGE.off;
  void chrome.action.setBadgeText({ text: cfg.text });
  void chrome.action.setBadgeBackgroundColor({ color: cfg.color });
  void copilot?.onRelayStatus({
    ready: kind === "on",
    label: COPILOT_RELAY_LABEL[kind] ?? COPILOT_RELAY_LABEL.off,
  });
}

function flashPageShareBadge(ok) {
  if (pageShareBadgeTimer) {
    clearTimeout(pageShareBadgeTimer);
  }
  void chrome.action.setBadgeText({ text: ok ? "✓" : "!" });
  void chrome.action.setBadgeBackgroundColor({ color: ok ? "#0F9D58" : "#B91C1C" });
  pageShareBadgeTimer = setTimeout(
    () => {
      pageShareBadgeTimer = null;
      setBadge(relayState);
    },
    ok ? 2_000 : 3_000,
  );
}

async function getConfig() {
  const config = await pairingConfigStore.read();
  if (config.pairingStatusHint) {
    relayStatusHint = config.pairingStatusHint;
  }
  return config;
}

// ---------------------------------------------------------------------------
// Tab group management (the consent boundary)
// ---------------------------------------------------------------------------

async function addTabToOpenClawGroup(tabId) {
  const tab = await chrome.tabs.get(tabId);
  const groups = await findOpenClawGroups();
  const sameWindowGroup = groups.find((group) => group.windowId === tab.windowId);
  if (sameWindowGroup) {
    await chrome.tabs.group({ tabIds: [tabId], groupId: sameWindowGroup.id });
    return;
  }
  const { groupColor } = await getConfig();
  const groupId = await chrome.tabs.group({ tabIds: [tabId] });
  await chrome.tabGroups.update(groupId, {
    title: OPENCLAW_TAB_GROUP_TITLE,
    color: groupColor,
  });
}

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

async function isTabShared(tabId) {
  const shared = await listSharedTabs();
  return shared.some((tab) => tab.id === tabId);
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
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN || relayAuthenticatedSocket !== relayWs) {
    return;
  }
  const shared = await listSharedTabs();
  // Detach tabs the user pulled out of the group; leaving the group revokes
  // agent access immediately (and clears the per-tab debugger state).
  const sharedIds = new Set(shared.map((tab) => tab.id));
  for (const tabId of attachedTabs) {
    if (!sharedIds.has(tabId)) {
      void detachDebugger(tabId);
    }
  }
  send({ type: "tabs", tabs: shared.map(toRelayTabInfo) });
}

// ---------------------------------------------------------------------------
// chrome.debugger transport
// ---------------------------------------------------------------------------

async function attachDebugger(tabId) {
  await copilotCustodyReady;
  const accessRevision = tabAccessRevisions.get(tabId) ?? 0;
  const assertAccess = async () => {
    if (copilotDeniedTabs.has(tabId)) {
      throw new Error(`tab ${tabId} is blocked until its copilot run stops`);
    }
    if ((tabAccessRevisions.get(tabId) ?? 0) !== accessRevision) {
      throw new Error(`tab ${tabId} access was revoked`);
    }
    await requireSharedTab(tabId);
    if (copilotDeniedTabs.has(tabId)) {
      throw new Error(`tab ${tabId} is blocked until its copilot run stops`);
    }
    if ((tabAccessRevisions.get(tabId) ?? 0) !== accessRevision) {
      throw new Error(`tab ${tabId} access was revoked`);
    }
  };
  await assertAccess();
  // Coalesce concurrent attaches for one tab. Two relay attach commands (or an
  // auto-attach racing an explicit share) would otherwise both call
  // chrome.debugger.attach and the second throws "Another debugger is already
  // attached". The bridge and this worker can also disagree after an MV3 restart.
  const inFlight = attachingTabs.get(tabId);
  if (inFlight) {
    const result = await inFlight;
    try {
      await assertAccess();
    } catch (error) {
      await detachDebugger(tabId);
      throw error;
    }
    return result;
  }
  const attach = (async () => {
    await assertAccess();
    if (!attachedTabs.has(tabId)) {
      try {
        await chrome.debugger.attach({ tabId }, "1.3");
      } catch (err) {
        // Treat an existing attachment as success; our own debugger is already on.
        if (!String(err?.message ?? err).includes("Another debugger is already attached")) {
          throw err;
        }
      }
      try {
        await assertAccess();
      } catch (error) {
        await detachDebugger(tabId);
        throw error;
      }
      attachedTabs.add(tabId);
    }
    const targets = await chrome.debugger.getTargets();
    try {
      await assertAccess();
    } catch (error) {
      await detachDebugger(tabId);
      throw error;
    }
    const target = targets.find((candidate) => candidate.tabId === tabId && candidate.attached);
    return { targetId: target?.id ?? `tab-${tabId}` };
  })();
  attachingTabs.set(tabId, attach);
  try {
    return await attach;
  } finally {
    attachingTabs.delete(tabId);
  }
}

async function detachDebugger(tabId) {
  // Always call Chrome: an attach can complete before attachedTabs records it.
  // The unconditional detach closes that revocation race.
  attachedTabs.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // already detached or tab gone
  }
}

async function revokeCopilotDebugger(tabId) {
  tabAccessRevisions.set(tabId, (tabAccessRevisions.get(tabId) ?? 0) + 1);
  copilotDeniedTabs.add(tabId);
  const previous = copilotRevocations.get(tabId) ?? Promise.resolve();
  const revocation = previous
    .catch(() => undefined)
    .then(async () => {
      await Promise.allSettled([attachingTabs.get(tabId)]);
      await detachDebugger(tabId);
    });
  copilotRevocations.set(tabId, revocation);
  try {
    await revocation;
  } finally {
    if (copilotRevocations.get(tabId) === revocation) {
      copilotRevocations.delete(tabId);
    }
  }
}

async function restoreCopilotDebugger(tabId) {
  const accessRevision = tabAccessRevisions.get(tabId) ?? 0;
  await copilotRevocations.get(tabId);
  if ((tabAccessRevisions.get(tabId) ?? 0) === accessRevision) {
    copilotDeniedTabs.delete(tabId);
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (typeof source.tabId !== "number") {
    return;
  }
  send({
    type: "cdpEvent",
    tabId: source.tabId,
    ...(source.sessionId ? { sessionId: source.sessionId } : {}),
    method,
    params,
  });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  if (typeof source.tabId !== "number") {
    return;
  }
  attachedTabs.delete(source.tabId);
  send({ type: "detached", tabId: source.tabId, reason });
  if (reason === "canceled_by_user") {
    // The user hit "Cancel" on Chrome's debugging infobar: treat it as a
    // revocation and pull the tab out of the shared group so the agent does
    // not immediately re-attach.
    void removeTabFromOpenClawGroup(source.tabId).then(scheduleTabsSync);
  }
});

// ---------------------------------------------------------------------------
// Relay connection
// ---------------------------------------------------------------------------

function send(message) {
  if (relayWs && relayWs.readyState === WebSocket.OPEN && relayAuthenticatedSocket === relayWs) {
    relayWs.send(JSON.stringify(message));
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
    ws.close(4001, error instanceof Error ? error.message.slice(0, 120) : "authentication failed");
  } catch {
    closeRelaySocket();
    setBadge("error");
    scheduleReconnect();
  }
}

const handleRelayCommand = createRelayCommandHandler({
  send,
  attachDebugger,
  detachDebugger,
  addTabToOpenClawGroup,
  focusWindowForTab,
  scheduleTabsSync,
});

async function sendHello() {
  const shared = await listSharedTabs();
  const uaMatch = /Chrom(?:e|ium)\/[\d.]+/.exec(navigator.userAgent);
  send({
    type: "hello",
    userAgent: navigator.userAgent,
    browserVersion: uaMatch ? uaMatch[0] : "Chrome/unknown",
    extensionVersion: chrome.runtime.getManifest().version,
    tabs: shared.map(toRelayTabInfo),
  });
}

async function connectRelay() {
  const { relayUrl, token } = await getConfig();
  await reconcilePairingInvalidation();
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
  setBadge("connecting");
  let ws;
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
        await sendHello();
      },
      onApplicationMessage: (socket, msg) => {
        if (msg?.type === "pageShareResult") {
          pageShareRelay.settle(socket, msg);
          return;
        }
        void handleRelayCommand(msg);
      },
      onAuthenticationFailure: (socket, error) => failRelayAuthentication(socket, error),
      onClose: (socket, authenticated) => {
        pageShareRelay.rejectSocket(socket);
        if (relayWs !== socket) {
          return;
        }
        clearRelayOpeningDeadline();
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
  armRelayOpeningDeadline();
  // onclose follows onerror and drives the reconnect, so no error handler needed.
}

async function sendPageShareRequest(payload) {
  const socket = relayWs;
  if (!socket || socket.readyState !== WebSocket.OPEN || relayAuthenticatedSocket !== socket) {
    throw new Error("Relay not connected.");
  }
  await pageShareRelay.send(socket, payload);
}

async function ensureRelayReady() {
  const config = await getConfig();
  await reconcilePairingInvalidation();
  if (!config.relayUrl || !config.token) {
    throw new Error("Pair the extension first.");
  }
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN || relayAuthenticatedSocket !== relayWs) {
    await connectRelay();
    if (
      !(await waitForCondition(
        () => relayWs?.readyState === WebSocket.OPEN && relayAuthenticatedSocket === relayWs,
        RELAY_AUTH_TIMEOUT_MS,
      ))
    ) {
      throw new Error("Relay not connected.");
    }
  }
}

async function sendPageToOpenClaw(tabId, note) {
  await ensureRelayReady();
  const tab = await chrome.tabs.get(tabId);
  const capture = await capturePageShare(tab);
  const payload = buildPageSharePayload({ ...capture, note });
  if (!payload.content && !payload.selection) {
    throw new Error("Nothing to send on this page.");
  }
  await sendPageShareRequest(payload);
}

// Context-menu selections bind to the click-time document: the relay-connect
// delay can outlive a navigation, and recapture cannot see iframe selections,
// so the payload is built from the click snapshot without touching the tab.
async function sendSelectionSnapshot(tab, selection) {
  await ensureRelayReady();
  const payload = buildPageSharePayload({
    url: tab.url ?? "",
    title: tab.title ?? "",
    content: "",
    selection,
    note: "",
  });
  await sendPageShareRequest(payload);
}

function withShareBadge(promise) {
  return promise.then(
    () => flashPageShareBadge(true),
    () => flashPageShareBadge(false),
  );
}

function sendPageFromChromeEntry(tabId) {
  return withShareBadge(sendPageToOpenClaw(tabId, ""));
}

async function installPageShareContextMenu() {
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: "openclaw-send-page",
    title: "Send page to OpenClaw",
    contexts: ["page", "selection"],
  });
}

copilot = createCopilotController({
  getConfig,
  isTabShared,
  addTabToOpenClawGroup,
  attachDebugger,
  detachDebugger,
  revokeDebugger: revokeCopilotDebugger,
  restoreDebugger: restoreCopilotDebugger,
  scheduleTabsSync,
});
const copilotCustodyReady = copilot.initializeCustody();
const copilotReady = copilot.initialize();

function handleRelayOpeningDeadline() {
  // Unit-test module isolation can outlive the mocked Chrome global. The real
  // MV3 worker always has chrome; a detached test timer has no owner to mutate.
  if (typeof chrome === "undefined") {
    relayOpeningDeadlineAt = 0;
    relayOpeningDeadlineTimer = null;
    return;
  }
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
  relayWs = null;
  relayAuthenticatedSocket = null;
  clearRelayOpeningDeadline();
  try {
    ws.close(4001, "relay authentication timed out");
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
    void connectRelay();
  }, delay);
}

// ---------------------------------------------------------------------------
// Popup messaging + lifecycle
// ---------------------------------------------------------------------------

function sendErrorResponse(sendResponse, error) {
  sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  let settled = false;
  const sendResponse = (response) => {
    if (settled) {
      return;
    }
    settled = true;
    reply(response);
  };
  void (async () => {
    switch (msg?.type) {
      case "getStatus": {
        const { relayUrl } = await getConfig();
        await reconcilePairingInvalidation();
        const shared = await listSharedTabs();
        sendResponse({
          paired: Boolean(relayUrl),
          state: relayState,
          sharedTabCount: shared.length,
          relayUrl: relayUrl ?? "",
          ...(relayStatusHint ? { hint: relayStatusHint } : {}),
        });
        return;
      }
      case "pair": {
        const parsed = parsePairingString(msg.pairingString);
        if (!parsed) {
          sendResponse({ ok: false, error: "Invalid pairing string." });
          return;
        }
        await pairingConfigStore.save(parsed, nearestGroupColor(msg.groupColor));
        relayStatusHint = "";
        reconnectAttempt = 0;
        clearRelayOpeningDeadline();
        closeRelaySocket();
        await connectRelay();
        await copilot.refreshConfig();
        sendResponse({ ok: true });
        return;
      }
      case "unpair": {
        await pairingConfigStore.clear();
        relayStatusHint = "";
        clearRelayOpeningDeadline();
        closeRelaySocket();
        setBadge("off");
        await copilot.refreshConfig();
        sendResponse({ ok: true });
        return;
      }
      case "toggleShareTab": {
        const tabId = msg.tabId;
        if (typeof tabId !== "number") {
          sendResponse({ ok: false, error: "No tab." });
          return;
        }
        const wasShared = await isTabShared(tabId);
        if (wasShared) {
          await detachDebugger(tabId);
          await removeTabFromOpenClawGroup(tabId);
        } else {
          await addTabToOpenClawGroup(tabId);
        }
        scheduleTabsSync();
        await copilot.onConsentChanged();
        sendResponse({ ok: true, shared: !wasShared });
        return;
      }
      case "isTabShared": {
        sendResponse({ shared: await isTabShared(msg.tabId) });
        return;
      }
      case "sendPageToOpenClaw": {
        if (typeof msg.tabId !== "number") {
          sendResponse({ ok: false, error: "No tab." });
          return;
        }
        try {
          await sendPageToOpenClaw(msg.tabId, msg.note);
          sendResponse({ ok: true });
        } catch (error) {
          sendErrorResponse(sendResponse, error);
        }
        return;
      }
      case "prepareCopilotPanel": {
        try {
          const options = await copilot.preparePanel(msg.tabId);
          sendResponse({ ok: true, ...options });
        } catch (error) {
          sendErrorResponse(sendResponse, error);
        }
        return;
      }
      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })().catch(sendErrorResponse.bind(null, sendResponse));
  return true; // keep sendResponse alive for the async path
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabAccessRevisions.set(tabId, (tabAccessRevisions.get(tabId) ?? 0) + 1);
  attachedTabs.delete(tabId);
  copilotDeniedTabs.delete(tabId);
  scheduleTabsSync();
  void copilot.onTabRemoved(tabId);
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  scheduleTabsSync();
  if (typeof changeInfo.groupId !== "number") {
    void copilot.onConsentChanged(tabId);
    return;
  }
  // changeInfo.groupId is the event-time membership snapshot. Preserve a
  // revocation even if a later event re-shares the tab before async cleanup.
  void isOpenClawGroupId(changeInfo.groupId).then(async (shared) => {
    if (!shared) {
      tabAccessRevisions.set(tabId, (tabAccessRevisions.get(tabId) ?? 0) + 1);
      await detachDebugger(tabId);
    }
    await copilot.onConsentChanged(tabId, { revoked: !shared });
  });
});
chrome.tabGroups.onUpdated.addListener(() => {
  scheduleTabsSync();
  void copilot.onConsentChanged();
});
chrome.tabGroups.onRemoved.addListener(() => {
  scheduleTabsSync();
  void copilot.onConsentChanged();
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== "send-page") {
    return;
  }
  void chrome.tabs
    .query({ active: true, lastFocusedWindow: true })
    .then(([tab]) => (typeof tab?.id === "number" ? sendPageFromChromeEntry(tab.id) : undefined));
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "openclaw-send-page" || typeof tab?.id !== "number") {
    return;
  }
  const selection = info.selectionText?.trim() ?? "";
  if (selection) {
    void withShareBadge(sendSelectionSnapshot(tab, selection));
    return;
  }
  void sendPageFromChromeEntry(tab.id);
});

// Watchdog: MV3 can stop this worker; the alarm revives it and re-connects.
chrome.alarms.create(RELAY_WATCHDOG_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RELAY_WATCHDOG_ALARM) {
    void connectRelay();
    void copilot.drainAborts();
    void copilot.drainArchives();
    void copilot.drainStaleScopes();
  } else if (alarm.name === RELAY_OPENING_DEADLINE_ALARM) {
    handleRelayOpeningDeadline();
  }
});
chrome.runtime.onStartup.addListener(() => void connectRelay());
chrome.runtime.onInstalled.addListener(() => {
  void installPageShareContextMenu();
  void connectRelay();
});
void [connectRelay(), copilotReady];
