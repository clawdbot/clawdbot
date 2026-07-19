import { createCopilotController } from "./modules/copilot-background.js";
import {
  buildPageSharePayload,
  capturePageShare,
  waitForCondition,
} from "./modules/page-share-core.js";
// OpenClaw extension service worker.
//
// Thin transport between the OpenClaw extension relay (loopback WebSocket) and
// chrome.debugger. All CDP target synthesis lives server-side in the relay
// bridge; this worker only attaches tabs, forwards frames, and keeps the
// OpenClaw tab group in sync. Membership in that group is the user-visible
// consent boundary: only grouped tabs are reported to (and driven by) OpenClaw.
import {
  OPENCLAW_TAB_GROUP_TITLE,
  buildRelayWsProtocols,
  nearestGroupColor,
  parsePairingString,
  reconnectDelayMs,
  toRelayTabInfo,
} from "./modules/relay-core.js";

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
const RELAY_OPENING_TIMEOUT_MS = 30_000;

/** @type {WebSocket|null} */
let relayWs = null;
let relayState = "off"; // off | connecting | on | error
let copilot = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let relayOpeningDeadlineAt = 0;
/** Tab ids with an active chrome.debugger attachment. */
const attachedTabs = new Set();
/** Tabs denied to every relay attach while copilot run cleanup is pending. */
const copilotDeniedTabs = new Set();
/** Monotonic revocation epochs invalidate attaches already in flight. */
const copilotAccessRevisions = new Map();
/** In-flight attach promises per tab id (coalesces concurrent attaches). */
const attachingTabs = new Map();
/** Latest revocation task per tab; restoration waits for its exact epoch. */
const copilotRevocations = new Map();
/** Debounce handle for tab-list refreshes. */
let tabsSyncTimer = null;
let nextPageShareRequestId = 1;
let pageShareBadgeTimer = null;
/** @type {Map<number, {resolve: (value: void) => void, reject: (error: Error) => void, timer: ReturnType<typeof setTimeout>}>} */
const pendingPageShares = new Map();

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
  const stored = await chrome.storage.local.get(["relayUrl", "token", "groupColor"]);
  return {
    relayUrl: typeof stored.relayUrl === "string" ? stored.relayUrl : "",
    token: typeof stored.token === "string" ? stored.token : "",
    groupColor: typeof stored.groupColor === "string" ? stored.groupColor : "orange",
  };
}

async function getCopilotConfig() {
  const config = await getConfig();
  const stored = await chrome.storage.local.get(["gatewayUrl"]);
  return {
    ...config,
    gatewayUrl: typeof stored.gatewayUrl === "string" ? stored.gatewayUrl : "",
  };
}

// ---------------------------------------------------------------------------
// Tab group management (the consent boundary)
// ---------------------------------------------------------------------------

async function findOpenClawGroups() {
  try {
    return await chrome.tabGroups.query({ title: OPENCLAW_TAB_GROUP_TITLE });
  } catch {
    return [];
  }
}

async function listSharedTabs() {
  const groups = await findOpenClawGroups();
  const tabs = [];
  for (const group of groups) {
    const groupTabs = await chrome.tabs.query({ groupId: group.id });
    tabs.push(...groupTabs);
  }
  return tabs.filter((tab) => typeof tab.id === "number");
}

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

async function isOpenClawGroupId(groupId) {
  if (!Number.isInteger(groupId) || groupId < 0) {
    return false;
  }
  try {
    const group = await chrome.tabGroups.get(groupId);
    return group.title === OPENCLAW_TAB_GROUP_TITLE;
  } catch {
    return false;
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
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) {
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
  // Coalesce concurrent attaches for one tab. Two relay attach commands (or an
  // auto-attach racing an explicit share) would otherwise both call
  // chrome.debugger.attach and the second throws "Another debugger is already
  // attached". The bridge and this worker can also disagree after an MV3 restart.
  const inFlight = attachingTabs.get(tabId);
  if (inFlight) {
    return await inFlight;
  }
  const accessRevision = copilotAccessRevisions.get(tabId) ?? 0;
  const assertAccess = () => {
    if (
      copilotDeniedTabs.has(tabId) ||
      (copilotAccessRevisions.get(tabId) ?? 0) !== accessRevision
    ) {
      throw new Error(`tab ${tabId} is blocked until its copilot run stops`);
    }
  };
  const attach = (async () => {
    assertAccess();
    if (!(await isTabShared(tabId))) {
      throw new Error(`tab ${tabId} is not in the ${OPENCLAW_TAB_GROUP_TITLE} tab group`);
    }
    assertAccess();
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
        assertAccess();
      } catch (error) {
        await detachDebugger(tabId);
        throw error;
      }
      attachedTabs.add(tabId);
    }
    const targets = await chrome.debugger.getTargets();
    try {
      assertAccess();
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
  copilotAccessRevisions.set(tabId, (copilotAccessRevisions.get(tabId) ?? 0) + 1);
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
  const accessRevision = copilotAccessRevisions.get(tabId) ?? 0;
  await copilotRevocations.get(tabId);
  if ((copilotAccessRevisions.get(tabId) ?? 0) === accessRevision) {
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
  if (relayWs && relayWs.readyState === WebSocket.OPEN) {
    relayWs.send(JSON.stringify(message));
  }
}

function clearRelayOpeningDeadline() {
  relayOpeningDeadlineAt = 0;
  void chrome.alarms.clear(RELAY_OPENING_DEADLINE_ALARM);
}

function armRelayOpeningDeadline() {
  relayOpeningDeadlineAt = Date.now() + RELAY_OPENING_TIMEOUT_MS;
  chrome.alarms.create(RELAY_OPENING_DEADLINE_ALARM, { when: relayOpeningDeadlineAt });
}

async function handleRelayCommand(msg) {
  const { seq } = msg;
  try {
    switch (msg.type) {
      case "ping":
        send({ type: "pong" });
        return;
      case "attach": {
        const result = await attachDebugger(msg.tabId);
        send({ type: "result", seq, result });
        return;
      }
      case "detach": {
        await detachDebugger(msg.tabId);
        send({ type: "result", seq, result: {} });
        return;
      }
      case "cdp": {
        const target = msg.sessionId
          ? { tabId: msg.tabId, sessionId: msg.sessionId }
          : { tabId: msg.tabId };
        const result = await chrome.debugger.sendCommand(target, msg.method, msg.params ?? {});
        send({ type: "result", seq, result: result ?? {} });
        return;
      }
      case "createTab": {
        const tab = await chrome.tabs.create({ url: msg.url, active: msg.background !== true });
        await addTabToOpenClawGroup(tab.id);
        scheduleTabsSync();
        send({ type: "result", seq, result: { tabId: tab.id } });
        return;
      }
      case "closeTab": {
        await detachDebugger(msg.tabId);
        await chrome.tabs.remove(msg.tabId);
        send({ type: "result", seq, result: {} });
        return;
      }
      case "activateTab": {
        const tab = await chrome.tabs.get(msg.tabId);
        await chrome.tabs.update(msg.tabId, { active: true });
        if (typeof tab.windowId === "number") {
          await chrome.windows.update(tab.windowId, { focused: true });
        }
        send({ type: "result", seq, result: {} });
        return;
      }
      default:
        if (typeof seq === "number") {
          send({ type: "error", seq, message: `unknown relay command: ${msg.type}` });
        }
    }
  } catch (err) {
    if (typeof seq === "number") {
      send({ type: "error", seq, message: err instanceof Error ? err.message : String(err) });
    }
  }
}

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
    ws = new WebSocket(relayUrl, buildRelayWsProtocols(token));
  } catch {
    setBadge("error");
    scheduleReconnect();
    return;
  }
  relayWs = ws;
  armRelayOpeningDeadline();
  ws.addEventListener("open", () => {
    if (relayWs !== ws) {
      ws.close();
      return;
    }
    clearRelayOpeningDeadline();
    reconnectAttempt = 0;
    setBadge("on");
    void sendHello();
  });
  ws.addEventListener("message", (event) => {
    let msg;
    try {
      msg = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (msg?.type === "pageShareResult") {
      const pending = pendingPageShares.get(msg.requestId);
      if (pending) {
        pendingPageShares.delete(msg.requestId);
        clearTimeout(pending.timer);
        if (msg.ok) {
          pending.resolve();
        } else {
          pending.reject(new Error(msg.error || "Page share failed."));
        }
      }
      return;
    }
    void handleRelayCommand(msg);
  });
  ws.addEventListener("close", () => {
    if (relayWs === ws) {
      clearRelayOpeningDeadline();
      relayWs = null;
      setBadge("error");
      scheduleReconnect();
    }
  });
  // onclose follows onerror and drives the reconnect, so no error handler needed.
}

async function sendPageShareRequest(payload) {
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) {
    throw new Error("Relay not connected.");
  }
  const requestId = nextPageShareRequestId++;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingPageShares.delete(requestId);
      reject(new Error("Timed out waiting for OpenClaw."));
    }, 10_000);
    pendingPageShares.set(requestId, { resolve, reject, timer });
    try {
      relayWs.send(JSON.stringify({ type: "pageShare", requestId, payload }));
    } catch (error) {
      pendingPageShares.delete(requestId);
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function ensureRelayReady() {
  const config = await getConfig();
  if (!config.relayUrl || !config.token) {
    throw new Error("Pair the extension first.");
  }
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) {
    await connectRelay();
    if (!(await waitForCondition(() => relayWs?.readyState === WebSocket.OPEN, 3_000))) {
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
  getConfig: getCopilotConfig,
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
  const ws = relayWs;
  if (!ws) {
    clearRelayOpeningDeadline();
    void connectRelay();
    return;
  }
  if (ws.readyState === WebSocket.OPEN) {
    clearRelayOpeningDeadline();
    return;
  }
  if (
    ws.readyState !== WebSocket.CONNECTING ||
    relayOpeningDeadlineAt === 0 ||
    Date.now() < relayOpeningDeadlineAt
  ) {
    return;
  }

  // Clear ownership before close so a delayed close/open event from this
  // socket cannot mutate the replacement connection's badge or deadline.
  relayWs = null;
  clearRelayOpeningDeadline();
  try {
    ws.close();
  } catch {
    // The socket may have changed state while the alarm event was queued.
  }
  setBadge("error");
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  void (async () => {
    switch (msg?.type) {
      case "getStatus": {
        const { relayUrl } = await getConfig();
        const shared = await listSharedTabs();
        sendResponse({
          paired: Boolean(relayUrl),
          state: relayState,
          sharedTabCount: shared.length,
        });
        return;
      }
      case "pair": {
        const parsed = parsePairingString(msg.pairingString);
        if (!parsed) {
          sendResponse({ ok: false, error: "Invalid pairing string." });
          return;
        }
        await chrome.storage.local.set({
          relayUrl: parsed.relayUrl,
          token: parsed.token,
          groupColor: nearestGroupColor(msg.groupColor),
        });
        reconnectAttempt = 0;
        clearRelayOpeningDeadline();
        relayWs?.close();
        relayWs = null;
        await chrome.storage.local.set({ gatewayUrl: parsed.gatewayUrl ?? "" });
        await connectRelay();
        await copilot.refreshConfig();
        sendResponse({ ok: true });
        return;
      }
      case "unpair": {
        await chrome.storage.local.remove(["relayUrl", "gatewayUrl", "token"]);
        clearRelayOpeningDeadline();
        relayWs?.close();
        relayWs = null;
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
        if (await isTabShared(tabId)) {
          await detachDebugger(tabId);
          await removeTabFromOpenClawGroup(tabId);
          scheduleTabsSync();
          sendResponse({ ok: true, shared: false });
        } else {
          await addTabToOpenClawGroup(tabId);
          scheduleTabsSync();
          sendResponse({ ok: true, shared: true });
        }
        await copilot.onConsentChanged();
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
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      case "prepareCopilotPanel": {
        const options = await copilot.preparePanel(msg.tabId);
        sendResponse({ ok: true, ...options });
        return;
      }
      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true; // keep sendResponse alive for the async path
});

chrome.tabs.onRemoved.addListener((tabId) => {
  copilotAccessRevisions.set(tabId, (copilotAccessRevisions.get(tabId) ?? 0) + 1);
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
  void isOpenClawGroupId(changeInfo.groupId).then((shared) =>
    copilot.onConsentChanged(tabId, { revoked: !shared }),
  );
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
