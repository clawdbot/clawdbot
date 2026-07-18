import {
  applyChatDelta,
  createChatStream,
  readMessageText,
  renderMarkdownLite,
  resetChatStream,
} from "./modules/panel-core.js";

const tabTitle = document.getElementById("tab-title");
const tabOrigin = document.getElementById("tab-origin");
const statusDot = document.getElementById("status-dot");
const gate = document.getElementById("gate");
const gateTitle = document.getElementById("gate-title");
const gateDetail = document.getElementById("gate-detail");
const gateAction = document.getElementById("gate-action");
const requestId = document.getElementById("request-id");
const messages = document.getElementById("messages");
const sessionNote = document.getElementById("session-note");
const input = document.getElementById("message-input");
const sendButton = document.getElementById("send-button");

const stream = createChatStream();
let streamingBubble = null;
let panelReady = false;
let sending = false;
let panelState = "connecting";
let port = null;
let reconnectTimer = null;
let reconnectDelayMs = 250;

function setComposerEnabled(enabled) {
  panelReady = enabled;
  input.disabled = !enabled || sending;
  sendButton.disabled = !enabled || sending || !input.value.trim();
}

function setGate({ action = null, detail, title }) {
  gate.classList.remove("hidden");
  messages.classList.add("hidden");
  gateTitle.textContent = title;
  gateDetail.textContent = detail;
  gateAction.classList.toggle("hidden", action !== "share");
  setComposerEnabled(false);
}

function addBubble(role, text, streaming = false) {
  const bubble = document.createElement("div");
  bubble.className = `message ${role}${streaming ? " streaming" : ""}`;
  if (role === "system") {
    bubble.textContent = text;
  } else {
    bubble.innerHTML = renderMarkdownLite(text);
  }
  messages.appendChild(bubble);
  messages.parentElement.scrollTop = messages.parentElement.scrollHeight;
  return bubble;
}

function renderHistory(history) {
  messages.replaceChildren();
  for (const message of history) {
    if (message?.role !== "user" && message?.role !== "assistant") {
      continue;
    }
    const text = readMessageText(message);
    if (text) {
      addBubble(message.role, text);
    }
  }
  if (messages.childElementCount === 0) {
    addBubble("system", "New tab conversation · page content is not added automatically");
  }
}

function finalizeStream() {
  streamingBubble?.classList.remove("streaming");
  streamingBubble = null;
  resetChatStream(stream);
  sending = false;
  setComposerEnabled(panelReady);
}

function handleChatEvent(payload) {
  if (payload.state === "delta") {
    const update = applyChatDelta(stream, payload);
    if (!update) {
      return;
    }
    if (!streamingBubble || update.newBubble) {
      streamingBubble?.classList.remove("streaming");
      streamingBubble = addBubble("assistant", update.text, true);
    } else {
      streamingBubble.innerHTML = renderMarkdownLite(update.text);
      streamingBubble.classList.add("streaming");
    }
    return;
  }
  if (payload.state === "error") {
    addBubble("system", payload.errorMessage || "The run failed.");
  }
  if (payload.state === "aborted") {
    addBubble("system", "Run stopped because this tab was closed or unshared.");
  }
  if (payload.state === "final" || payload.state === "error" || payload.state === "aborted") {
    finalizeStream();
  }
}

function updateState(state) {
  panelState = state.state;
  statusDot.className = `status-dot ${state.state}`;
  statusDot.title = state.label || state.state;
  if (state.tab) {
    tabTitle.textContent = state.tab.title || state.tab.label || "Untitled tab";
    tabOrigin.textContent = state.tab.label
      ? `${state.tab.label} · Chrome-bound tab`
      : "Chrome-bound tab";
  }
  requestId.classList.toggle("hidden", !state.requestId);
  requestId.textContent = state.requestId ? `request ${state.requestId}` : "";
  switch (state.state) {
    case "ready":
      gate.classList.add("hidden");
      messages.classList.remove("hidden");
      sessionNote.textContent = "Live only for this tab · transcript retained after archive";
      setComposerEnabled(true);
      break;
    case "needs-sharing":
      sessionNote.textContent = "No session until this tab is shared.";
      setGate({
        action: "share",
        title: "Keep the boundary visible",
        detail:
          "Sharing adds this tab to the OpenClaw group. The copilot can act here, but nowhere else.",
      });
      break;
    case "needs-pairing":
      setGate({
        title: "Pair the extension first",
        detail:
          "Open the OpenClaw toolbar popup and paste the output of openclaw browser extension pair.",
      });
      break;
    case "approval":
      setGate({
        title: "Approve this copilot device",
        detail:
          "On the Gateway, run openclaw devices list, inspect this dedicated browser identity, then approve its current request.",
      });
      break;
    case "denied":
      setGate({ title: "This panel was denied", detail: state.label });
      break;
    case "error":
      setGate({ title: "Gateway unavailable", detail: state.label });
      break;
    default:
      setGate({ title: "Preparing this tab", detail: state.label || "Connecting securely…" });
  }
}

function handlePortMessage(message) {
  reconnectDelayMs = 250;
  if (message?.type === "panel.state") {
    updateState(message);
  } else if (message?.type === "panel.history") {
    if (!sending) {
      renderHistory(message.messages);
    }
  } else if (message?.type === "panel.event" && message.event?.event === "chat") {
    handleChatEvent(message.event.payload ?? {});
  } else if (message?.type === "panel.turn-reset") {
    if (sending) {
      addBubble("system", "Previous run stopped after the Gateway reconnected.");
    }
    finalizeStream();
  } else if (message?.type === "panel.error") {
    addBubble("system", message.message || "Request failed.");
    sending = false;
    setComposerEnabled(panelReady);
  }
}

function schedulePortReconnect() {
  if (reconnectTimer || panelState === "denied") {
    return;
  }
  const delayMs = reconnectDelayMs;
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 5_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    updateState({ state: "connecting", label: "Reconnecting to the extension background" });
    connectPanelPort();
  }, delayMs);
}

function connectPanelPort() {
  if (port) {
    return;
  }
  let nextPort;
  try {
    nextPort = chrome.runtime.connect({ name: "openclaw-copilot-panel" });
  } catch {
    schedulePortReconnect();
    return;
  }
  port = nextPort;
  nextPort.onMessage.addListener((message) => {
    if (port === nextPort) {
      handlePortMessage(message);
    }
  });
  nextPort.onDisconnect.addListener(() => {
    if (port !== nextPort) {
      return;
    }
    port = null;
    finalizeStream();
    if (panelState !== "denied") {
      updateState({ state: "error", label: "Extension background disconnected." });
      schedulePortReconnect();
    }
  });
  port?.postMessage({ type: "panel.refresh" });
}

async function send() {
  const message = input.value.trim();
  if (!message || !panelReady || sending) {
    return;
  }
  addBubble("user", message);
  input.value = "";
  input.style.height = "auto";
  sending = true;
  setComposerEnabled(true);
  port?.postMessage({ type: "panel.send", message });
}

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 130)}px`;
  setComposerEnabled(panelReady);
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void send();
  }
});
sendButton.addEventListener("click", () => void send());
gateAction.addEventListener("click", () => port?.postMessage({ type: "panel.share" }));
connectPanelPort();
