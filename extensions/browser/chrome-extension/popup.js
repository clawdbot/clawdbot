// Popup: pairing, connection status, access mode, per-tab control, and settings.

const statusDot = document.getElementById("statusDot");
const pairSection = document.getElementById("pairSection");
const connectedSection = document.getElementById("connectedSection");
const settingsSection = document.getElementById("settingsSection");
const settingsButton = document.getElementById("settingsButton");
const pairingInput = document.getElementById("pairingString");
const pairButton = document.getElementById("pairButton");
const unpairButton = document.getElementById("unpairButton");
const shareButton = document.getElementById("shareButton");
const copilotButton = document.getElementById("copilotButton");
const statusLine = document.getElementById("statusLine");
const errorLine = document.getElementById("error");
const pageNote = document.getElementById("pageNote");
const sendPageButton = document.getElementById("sendPageButton");
const pageShareStatus = document.getElementById("pageShareStatus");
const versionValue = document.getElementById("versionValue");
const statusHint = document.getElementById("statusHint");
const unpairNote = document.getElementById("unpairNote");
const relayValue = document.getElementById("relayValue");
const accessModeSelect = document.getElementById("accessModeSelect");
const accessWarning = document.getElementById("accessWarning");
let sendingPage = false;
let settingsOpen = false;
// Preserve rejected actions across status polls until a successful retry.
let actionError = null;

const STATE_LABEL = {
  on: "Connected",
  connecting: "Connecting…",
  error: "Relay unreachable",
  off: "Not connected",
};

versionValue.textContent = `v${chrome.runtime.getManifest().version}`;

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab ?? null;
}

function relayHost(relayUrl) {
  try {
    return new URL(relayUrl).host;
  } catch {
    return "—";
  }
}

async function refresh() {
  const status = await chrome.runtime.sendMessage({ type: "getStatus" });
  if (status?.ok === false) {
    statusLine.textContent = actionError ?? status.error ?? "Could not refresh browser status.";
    return;
  }
  statusDot.className = `status-dot ${status.state}`;
  pairSection.classList.toggle("hidden", status.paired || settingsOpen);
  connectedSection.classList.toggle("hidden", !status.paired || settingsOpen);
  settingsSection.classList.toggle("hidden", !settingsOpen);
  settingsButton.classList.toggle("active", settingsOpen);
  relayValue.textContent = status.paired ? relayHost(status.relayUrl) : "—";
  accessModeSelect.value = status.accessMode === "selected" ? "selected" : "all";
  accessModeSelect.disabled = !status.paired;
  accessWarning.classList.toggle("hidden", status.accessMode !== "all" || !status.paired);
  unpairButton.classList.toggle("hidden", !status.paired);
  unpairNote.classList.toggle("hidden", !status.paired);
  if (!status.paired) {
    statusLine.textContent = actionError ?? status.hint ?? "Not paired with a gateway";
    return;
  }
  const label = STATE_LABEL[status.state] ?? STATE_LABEL.off;
  statusLine.textContent =
    actionError ??
    `${label} · ${status.accessibleTabCount} tab${status.accessibleTabCount === 1 ? "" : "s"} ${status.accessMode === "all" ? "available" : "shared"}`;
  statusHint.textContent =
    status.hint || "Relay unreachable — is the OpenClaw gateway running and up to date?";
  statusHint.classList.toggle("hidden", status.state !== "error");
  const tab = await activeTab();
  if (tab?.id === undefined) {
    shareButton.classList.add("hidden");
    copilotButton.disabled = true;
    sendPageButton.disabled = true;
    delete sendPageButton.dataset.tabId;
    delete shareButton.dataset.accessMode;
    delete shareButton.dataset.grant;
    return;
  }
  sendPageButton.dataset.tabId = String(tab.id);
  sendPageButton.disabled = sendingPage || status.state !== "on";
  const panel = await chrome.runtime.sendMessage({ type: "prepareCopilotPanel", tabId: tab.id });
  copilotButton.disabled = !panel?.ok;
  copilotButton.dataset.tabId = String(tab.id);
  copilotButton.dataset.path = panel?.path ?? "";
  const tabAccess = await chrome.runtime.sendMessage({ type: "getTabAccess", tabId: tab.id });
  shareButton.classList.toggle("hidden", !tabAccess.eligible);
  copilotButton.disabled = !panel?.ok || !tabAccess.accessible;
  shareButton.textContent =
    status.accessMode === "all"
      ? tabAccess.denied
        ? "Allow OpenClaw on this tab"
        : "Pause OpenClaw on this tab"
      : tabAccess.accessible
        ? "Stop sharing this tab"
        : "Share this tab with OpenClaw";
  shareButton.dataset.tabId = String(tab.id);
  shareButton.dataset.accessMode = status.accessMode === "selected" ? "selected" : "all";
  shareButton.dataset.grant = String(!tabAccess.accessible);
}

async function onSendPage() {
  const tabId = Number.parseInt(sendPageButton.dataset.tabId ?? "", 10);
  if (!Number.isInteger(tabId) || sendingPage) {
    return;
  }
  sendingPage = true;
  sendPageButton.disabled = true;
  pageShareStatus.textContent = "Sending…";
  pageShareStatus.classList.remove("hidden", "error");
  try {
    const result = await chrome.runtime.sendMessage({
      type: "sendPageToOpenClaw",
      tabId,
      note: pageNote.value,
    });
    if (!result?.ok) {
      throw new Error(result?.error ?? "Could not send this page.");
    }
    pageNote.value = "";
    pageShareStatus.textContent = "Sent ✓";
  } catch (error) {
    pageShareStatus.textContent = error instanceof Error ? error.message : String(error);
    pageShareStatus.classList.add("error");
  } finally {
    sendingPage = false;
    await refresh();
  }
}

async function onPair() {
  errorLine.classList.add("hidden");
  const result = await chrome.runtime.sendMessage({
    type: "pair",
    pairingString: pairingInput.value,
    accessMode:
      document.querySelector('input[name="pairAccessMode"]:checked')?.value === "selected"
        ? "selected"
        : "all",
  });
  if (!result.ok) {
    actionError = result.error ?? "Pairing failed.";
    errorLine.textContent = actionError;
    errorLine.classList.remove("hidden");
    statusLine.textContent = actionError;
    await refresh();
    return;
  }
  actionError = null;
  await refresh();
}

async function onUnpair() {
  const result = await chrome.runtime.sendMessage({ type: "unpair" });
  if (result?.ok === false) {
    actionError = result.error ?? "Could not unpair this browser.";
    statusLine.textContent = actionError;
    await refresh();
    return;
  }
  actionError = null;
  settingsOpen = false;
  await refresh();
}

async function onToggleTabAccess() {
  const tabId = Number.parseInt(shareButton.dataset.tabId ?? "", 10);
  const accessMode = shareButton.dataset.accessMode;
  const grant = shareButton.dataset.grant === "true";
  if (Number.isFinite(tabId) && (accessMode === "all" || accessMode === "selected")) {
    const result = await chrome.runtime.sendMessage({
      type: "toggleTabAccess",
      tabId,
      accessMode,
      grant,
    });
    if (result?.ok === false) {
      actionError = result.error ?? "Could not update browser tab sharing.";
      statusLine.textContent = actionError;
      await refresh();
      return;
    }
    actionError = null;
  }
  await refresh();
}

async function onAccessModeChange() {
  const result = await chrome.runtime.sendMessage({
    type: "setAccessMode",
    accessMode: accessModeSelect.value,
  });
  if (!result?.ok) {
    actionError = result?.error ?? "Could not update browser access.";
    statusLine.textContent = actionError;
  } else {
    actionError = null;
  }
  await refresh();
}

async function onOpenCopilot() {
  const tabId = Number.parseInt(copilotButton.dataset.tabId ?? "", 10);
  const path = copilotButton.dataset.path;
  if (!Number.isInteger(tabId) || !path) {
    return;
  }
  await chrome.sidePanel.setOptions({ tabId, path, enabled: true });
  await chrome.sidePanel.open({ tabId });
  window.close();
}

settingsButton.addEventListener("click", () => {
  settingsOpen = !settingsOpen;
  void refresh();
});
pairButton.addEventListener("click", () => void onPair());
unpairButton.addEventListener("click", () => void onUnpair());
shareButton.addEventListener("click", () => void onToggleTabAccess());
copilotButton.addEventListener("click", () => void onOpenCopilot());
sendPageButton.addEventListener("click", () => void onSendPage());
accessModeSelect.addEventListener("change", () => void onAccessModeChange());

void refresh();
setInterval(() => void refresh(), 2000);
