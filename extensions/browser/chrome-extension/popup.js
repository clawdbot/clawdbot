// Popup: pairing, connection status, per-tab share toggle, and settings.

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
let sendingPage = false;
let settingsOpen = false;

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
  statusDot.className = `status-dot ${status.state}`;
  pairSection.classList.toggle("hidden", status.paired || settingsOpen);
  connectedSection.classList.toggle("hidden", !status.paired || settingsOpen);
  settingsSection.classList.toggle("hidden", !settingsOpen);
  settingsButton.classList.toggle("active", settingsOpen);
  relayValue.textContent = status.paired ? relayHost(status.relayUrl) : "—";
  unpairButton.classList.toggle("hidden", !status.paired);
  unpairNote.classList.toggle("hidden", !status.paired);
  if (!status.paired) {
    statusLine.textContent = "Not paired with a gateway";
    return;
  }
  const label = STATE_LABEL[status.state] ?? STATE_LABEL.off;
  statusLine.textContent = `${label} · ${status.sharedTabCount} tab${status.sharedTabCount === 1 ? "" : "s"} shared`;
  statusHint.classList.toggle("hidden", status.state !== "error");
  const tab = await activeTab();
  if (tab?.id === undefined) {
    shareButton.classList.add("hidden");
    copilotButton.disabled = true;
    sendPageButton.disabled = true;
    delete sendPageButton.dataset.tabId;
    return;
  }
  sendPageButton.dataset.tabId = String(tab.id);
  sendPageButton.disabled = sendingPage || status.state !== "on";
  const panel = await chrome.runtime.sendMessage({ type: "prepareCopilotPanel", tabId: tab.id });
  copilotButton.disabled = !panel?.ok;
  copilotButton.dataset.tabId = String(tab.id);
  copilotButton.dataset.path = panel?.path ?? "";
  const { shared } = await chrome.runtime.sendMessage({ type: "isTabShared", tabId: tab.id });
  shareButton.classList.remove("hidden");
  shareButton.textContent = shared ? "Stop sharing this tab" : "Share this tab with OpenClaw";
  shareButton.dataset.tabId = String(tab.id);
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
  });
  if (!result.ok) {
    errorLine.textContent = result.error ?? "Pairing failed.";
    errorLine.classList.remove("hidden");
    return;
  }
  await refresh();
}

async function onUnpair() {
  await chrome.runtime.sendMessage({ type: "unpair" });
  settingsOpen = false;
  await refresh();
}

async function onToggleShare() {
  const tabId = Number.parseInt(shareButton.dataset.tabId ?? "", 10);
  if (Number.isFinite(tabId)) {
    await chrome.runtime.sendMessage({ type: "toggleShareTab", tabId });
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
shareButton.addEventListener("click", () => void onToggleShare());
copilotButton.addEventListener("click", () => void onOpenCopilot());
sendPageButton.addEventListener("click", () => void onSendPage());

void refresh();
setInterval(() => void refresh(), 2000);
