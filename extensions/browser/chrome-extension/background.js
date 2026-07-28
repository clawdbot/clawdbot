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

/** @type {WebSocket|null} */
let relayWs = null;
let relayState = "off"; // off | connecting | on | error
let reconnectAttempt = 0;
let reconnectTimer = null;
/** Tab ids with an active chrome.debugger attachment. */
const attachedTabs = new Set();
/** In-flight attach promises per tab id (coalesces concurrent attaches). */
const attachingTabs = new Map();
/** Debounce handle for tab-list refreshes. */
let tabsSyncTimer = null;

function setBadge(kind) {
  relayState = kind;
  const cfg = BADGE[kind] ?? BADGE.off;
  void chrome.action.setBadgeText({ text: cfg.text });
  void chrome.action.setBadgeBackgroundColor({ color: cfg.color });
}

async function getConfig() {
  const stored = await chrome.storage.local.get(["relayUrl", "token", "groupColor"]);
  return {
    relayUrl: typeof stored.relayUrl === "string" ? stored.relayUrl : "",
    token: typeof stored.token === "string" ? stored.token : "",
    groupColor: typeof stored.groupColor === "string" ? stored.groupColor : "orange",
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
  if (!(await isTabShared(tabId))) {
    throw new Error(`tab ${tabId} is not in the ${OPENCLAW_TAB_GROUP_TITLE} tab group`);
  }
  // Coalesce concurrent attaches for one tab. Two relay attach commands (or an
  // auto-attach racing an explicit share) would otherwise both call
  // chrome.debugger.attach and the second throws "Another debugger is already
  // attached". The bridge and this worker can also disagree after an MV3 restart.
  const inFlight = attachingTabs.get(tabId);
  if (inFlight) {
    return await inFlight;
  }
  const attach = (async () => {
    if (!attachedTabs.has(tabId)) {
      try {
        await chrome.debugger.attach({ tabId }, "1.3");
      } catch (err) {
        // Treat an existing attachment as success; our own debugger is already on.
        if (!String(err?.message ?? err).includes("Another debugger is already attached")) {
          throw err;
        }
      }
      attachedTabs.add(tabId);
    }
    const targets = await chrome.debugger.getTargets();
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
  attachedTabs.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // already detached or tab gone
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
  ws.addEventListener("open", () => {
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
    void handleRelayCommand(msg);
  });
  ws.addEventListener("close", () => {
    if (relayWs === ws) {
      relayWs = null;
      setBadge("error");
      scheduleReconnect();
    }
  });
  // onclose follows onerror and drives the reconnect, so no error handler needed.
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
        relayWs?.close();
        relayWs = null;
        await connectRelay();
        sendResponse({ ok: true });
        return;
      }
      case "unpair": {
        await chrome.storage.local.remove(["relayUrl", "token"]);
        relayWs?.close();
        relayWs = null;
        setBadge("off");
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
        return;
      }
      case "isTabShared": {
        sendResponse({ shared: await isTabShared(msg.tabId) });
        return;
      }
      default:
        sendResponse({ ok: false, error: "unknown message" });
    }
  })();
  return true; // keep sendResponse alive for the async path
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  scheduleTabsSync();
});
chrome.tabs.onUpdated.addListener(() => scheduleTabsSync());
chrome.tabGroups.onUpdated.addListener(() => scheduleTabsSync());
chrome.tabGroups.onRemoved.addListener(() => scheduleTabsSync());

// Watchdog: MV3 can stop this worker; the alarm revives it and re-connects.
chrome.alarms.create("openclaw-relay-watchdog", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "openclaw-relay-watchdog") {
    void connectRelay();
  }
});
chrome.runtime.onStartup.addListener(() => void connectRelay());
chrome.runtime.onInstalled.addListener(() => void connectRelay());
void connectRelay();
