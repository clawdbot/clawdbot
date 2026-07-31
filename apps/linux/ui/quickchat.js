// Pure stream helpers stay above browser bindings so the Node regression test can exercise the
// Gateway-compatible assembler without constructing a WebView.
function chatMessageText(message) {
  const content = message?.content;
  if (Array.isArray(content)) {
    const textBlocks = content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text);
    if (textBlocks.length > 0) {
      return textBlocks.join("\n\n");
    }
  }
  // Match the Control UI fallback contract in ui/src/lib/chat/message-extract.ts: typed content
  // blocks, then plain-string content, then top-level message.text.
  if (typeof content === "string") {
    return content;
  }
  return typeof message?.text === "string" ? message.text : null;
}

function assembleChatDelta(currentText, payload) {
  const snapshot = chatMessageText(payload?.message);
  if (typeof payload?.deltaText === "string") {
    if (payload.replace === true) {
      return payload.deltaText;
    }
    if (currentText === null) {
      return snapshot ?? payload.deltaText;
    }
    if (snapshot !== null) {
      const prefixLength = snapshot.length - payload.deltaText.length;
      if (
        prefixLength !== currentText.length ||
        snapshot.slice(0, prefixLength) !== currentText
      ) {
        return snapshot;
      }
    }
    return `${currentText}${payload.deltaText}`;
  }
  return snapshot;
}

const INLINE_WIDGET_DOCUMENTS_PATH = "/__openclaw__/canvas/documents";
const INLINE_WIDGET_MIN_HEIGHT = 160;
const INLINE_WIDGET_MAX_HEIGHT = 1200;
const INLINE_WIDGET_VIEWPORT_MAX_HEIGHT = 160;
const CANVAS_SURFACE_REFRESH_INTERVAL_MS = 8 * 60 * 1_000;
const CANVAS_SURFACE_REFRESH_RETRY_MS = 5_000;

function decodeRepeatedly(raw) {
  let value = raw;
  for (let index = 0; index < 8; index += 1) {
    let decoded;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return null;
    }
    if (decoded === value) {
      return decoded;
    }
    value = decoded;
  }
  return null;
}

function canonicalInlineWidgetTarget(raw) {
  if (typeof raw !== "string") {
    return null;
  }
  const target = raw.trim();
  if (!target.startsWith("/") || target.startsWith("//") || target.includes("\\")) {
    return null;
  }
  const suffixIndex = [target.indexOf("?"), target.indexOf("#")]
    .filter((index) => index >= 0)
    .reduce((lowest, index) => Math.min(lowest, index), target.length);
  const path = target.slice(0, suffixIndex);
  if (!path.startsWith(`${INLINE_WIDGET_DOCUMENTS_PATH}/`)) {
    return null;
  }
  const segments = path.split("/");
  if (
    segments[0] !== "" ||
    segments.slice(1).some((segment) => {
      if (!segment) {
        return true;
      }
      const decoded = decodeRepeatedly(segment);
      return (
        decoded === null ||
        decoded === "." ||
        decoded === ".." ||
        decoded.includes("/") ||
        decoded.includes("\\")
      );
    })
  ) {
    return null;
  }
  try {
    const parsed = new URL(target, "http://openclaw.invalid");
    return parsed.origin === "http://openclaw.invalid" && parsed.pathname === path ? target : null;
  } catch {
    return null;
  }
}

function boundedWidgetKey(raw) {
  if (new TextEncoder().encode(raw).length <= 200) {
    return raw;
  }
  let hash = 2166136261;
  for (const character of raw) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return `widget-${hash.toString(16).padStart(8, "0")}`;
}

function coerceInlineWidgetPreview(block) {
  const preview = block?.type === "canvas" ? block.preview : null;
  if (
    !preview ||
    preview.kind !== "canvas" ||
    preview.surface !== "assistant_message" ||
    preview.render !== "url" ||
    !["scripts", "strict"].includes(preview.sandbox)
  ) {
    return null;
  }
  const target = canonicalInlineWidgetTarget(preview.url);
  if (!target) {
    return null;
  }
  const preferredHeight = Number.isFinite(preview.preferredHeight)
    ? Math.min(
        Math.max(Math.trunc(preview.preferredHeight), INLINE_WIDGET_MIN_HEIGHT),
        INLINE_WIDGET_MAX_HEIGHT,
      )
    : 320;
  return {
    key: boundedWidgetKey(
      typeof preview.viewId === "string" && preview.viewId.trim() ? preview.viewId.trim() : target,
    ),
    title: typeof preview.title === "string" && preview.title.trim() ? preview.title.trim() : "Widget",
    target,
    preferredHeight,
    sandbox: preview.sandbox,
  };
}

function chatMessageWidgets(message) {
  const role = typeof message?.role === "string" ? message.role.trim().toLowerCase() : null;
  if (role !== "assistant" || !Array.isArray(message?.content)) {
    return [];
  }
  const emitted = new Set();
  return message.content
    .map(coerceInlineWidgetPreview)
    .filter(Boolean)
    .map((widget) => {
      const base = widget.key.slice(0, 240);
      let key = widget.key;
      let suffix = 2;
      while (emitted.has(key)) {
        key = `${base}-${suffix}`;
        suffix += 1;
      }
      emitted.add(key);
      return key === widget.key ? widget : { ...widget, key };
    });
}

function isLoopbackHostname(rawHostname) {
  const hostname = rawHostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "::1") {
    return true;
  }
  const octets = hostname.split(".");
  return (
    octets.length === 4 &&
    octets[0] === "127" &&
    octets.every((octet) => /^\d{1,3}$/u.test(octet) && Number(octet) <= 255)
  );
}

function resolveInlineWidgetUrl(rawSurfaceUrl, rawTarget) {
  const target = canonicalInlineWidgetTarget(rawTarget);
  if (!target || typeof rawSurfaceUrl !== "string") {
    return null;
  }
  let surface;
  try {
    surface = new URL(rawSurfaceUrl.trim());
  } catch {
    return null;
  }
  const secureTransport =
    surface.protocol === "https:" ||
    (surface.protocol === "http:" && isLoopbackHostname(surface.hostname));
  if (
    !secureTransport ||
    surface.username ||
    surface.password ||
    surface.search ||
    surface.hash
  ) {
    return null;
  }
  const encodedSegments = surface.pathname.split("/");
  if (encodedSegments[0] !== "" || encodedSegments.slice(1).some((segment) => !segment)) {
    return null;
  }
  const segments = [];
  for (const encoded of encodedSegments.slice(1)) {
    const decoded = decodeRepeatedly(encoded);
    if (
      decoded === null ||
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\")
    ) {
      return null;
    }
    segments.push(decoded);
  }
  if (
    segments.length < 3 ||
    segments.at(-3) !== "__openclaw__" ||
    segments.at(-2) !== "cap" ||
    !segments.at(-1)
  ) {
    return null;
  }
  const prefix = surface.pathname.replace(/\/+$/u, "");
  return `${surface.origin}${prefix}${target}`;
}

const tauri = window["__TAURI__"];
const { invoke } = tauri.core;
const { listen } = tauri.event;
const rendererSessionId =
  globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const rendererEpoch = Math.max(
  1,
  Math.trunc((globalThis.performance?.timeOrigin ?? Date.now()) * 1_000),
);

const elements = {
  agentAvatar: document.querySelector("#agent-avatar"),
  agentChip: document.querySelector("#agent-chip"),
  agentList: document.querySelector("#agent-list"),
  agentMenu: document.querySelector("#agent-menu"),
  composer: document.querySelector("#composer"),
  input: document.querySelector("#message"),
  reply: document.querySelector("#reply"),
  replyAgentAvatar: document.querySelector("#reply-agent-avatar"),
  replyAgentName: document.querySelector("#reply-agent-name"),
  replyError: document.querySelector("#reply-error"),
  replyScroll: document.querySelector("#reply-scroll"),
  replyState: document.querySelector("#reply-state"),
  replyText: document.querySelector("#reply-text"),
  replyThinking: document.querySelector("#reply-thinking"),
  replyWidgets: document.querySelector("#reply-widgets"),
  send: document.querySelector("#send"),
  sendIcon: document.querySelector("#send-icon"),
  shortcutCapture: document.querySelector("#shortcut-capture"),
  shortcutError: document.querySelector("#shortcut-error"),
  shortcutReset: document.querySelector("#shortcut-reset"),
  shortcutSettings: document.querySelector("#shortcut-settings"),
  shortcutSettingsButton: document.querySelector("#shortcut-settings-button"),
  shortcutValue: document.querySelector("#shortcut-value"),
  status: document.querySelector("#status"),
};

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let agents = [];
let activeIdentity = { id: "", name: "Agent", isDefault: true };
let selectingAgent = false;
let sending = false;
let accepted = false;
let hiding = false;
let hideTimer = null;
let acceptedTimer = null;
let visibilitySequence = 0;
let popoverSequence = 0;

function nextVisibilityOperation() {
  visibilitySequence += 1;
  return visibilitySequence;
}
let sendError = "";
let gatewayState = "down";
let gatewayNotice = "";
let canvasSurfaceUrl = null;
let canvasSurfaceObservedUrl = null;
let canvasSurfaceRefreshedAt = 0;
let canvasSurfaceRetryAt = 0;
let canvasSurfaceRefreshPromise = null;
let canvasSurfaceRetryTimer = null;
let gatewayDisconnectSequence = 0;
let openPopover = null;
let menuIndex = 0;
let capturingShortcut = false;
let activeReply = null;
let pendingChatEvents = [];

const MAX_PENDING_CHAT_EVENTS = 64;

function friendlyError(error, fallback = "Could not send the message.") {
  if (typeof error === "string") {
    return error;
  }
  return error?.message || fallback;
}

function setError(message = "") {
  elements.status.textContent = message;
  elements.composer.classList.toggle("has-error", Boolean(message));
}

function renderStatus() {
  if (gatewayState === "pairing-required") {
    setError(gatewayNotice || "Approve this device in the dashboard (Nodes)");
    return;
  }
  if (gatewayState === "credential-required") {
    setError(
      gatewayNotice || "Gateway requires a credential — open the dashboard on the gateway host",
    );
    return;
  }
  if (gatewayState === "tls-failure") {
    setError("Gateway TLS trust failed — check the certificate fingerprint");
    return;
  }
  setError(
    gatewayState === "up" ? sendError : gatewayNotice || "Gateway unreachable — retrying",
  );
}

function setGatewayState(payload) {
  const wasUp = gatewayState === "up";
  gatewayState = payload?.state || "down";
  gatewayNotice = typeof payload?.notice === "string" ? payload.notice : "";
  const nextCanvasSurfaceUrl =
    gatewayState === "up" && typeof payload?.canvasSurfaceUrl === "string"
      ? payload.canvasSurfaceUrl
      : null;
  if (nextCanvasSurfaceUrl !== canvasSurfaceObservedUrl) {
    canvasSurfaceObservedUrl = nextCanvasSurfaceUrl;
    canvasSurfaceUrl = nextCanvasSurfaceUrl;
    canvasSurfaceRefreshedAt = nextCanvasSurfaceUrl ? Date.now() : 0;
    canvasSurfaceRetryAt = 0;
    window.clearTimeout(canvasSurfaceRetryTimer);
    canvasSurfaceRetryTimer = null;
    if (!nextCanvasSurfaceUrl) {
      canvasSurfaceRefreshPromise = null;
    }
  }
  if (gatewayState !== "up") {
    gatewayDisconnectSequence += 1;
    terminalizeDisconnectedReply();
  }
  renderStatus();
  updateSendButton();
  if (activeReply?.widgets.length) {
    renderReplyWidgets();
  }
  if (gatewayState === "up" && !wasUp) {
    void refreshAgents();
  }
}

function updateSendButton() {
  const empty = !elements.input.value.trim();
  const streaming = activeReply !== null && !activeReply.terminal;
  elements.send.disabled =
    gatewayState !== "up" || empty || selectingAgent || sending || accepted || streaming;
  elements.send.classList.toggle("sending", sending);
  elements.send.classList.toggle("accepted", accepted);
  elements.sendIcon.textContent = sending ? "" : accepted ? "✓" : "↑";
  elements.input.readOnly = sending || accepted || streaming;
}

function nameHue(name) {
  let hash = 0;
  for (const character of name) {
    hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  }
  return hash % 360;
}

function renderAvatarFallback(target, identity) {
  const name = identity?.name?.trim() || identity?.id?.trim() || "Agent";
  const initial = [...name][0]?.toUpperCase() || "A";
  target.replaceChildren(document.createTextNode(identity?.emoji?.trim() || initial));
}

function renderAvatar(target, identity) {
  const name = identity?.name?.trim() || identity?.id?.trim() || "Agent";
  target.style.setProperty("--agent-hue", nameHue(name));
  const avatarUrl = identity?.avatarUrl?.trim();
  if (!avatarUrl || !/^(?:https?:|data:)/i.test(avatarUrl)) {
    renderAvatarFallback(target, identity);
    return;
  }
  const image = document.createElement("img");
  image.alt = "";
  image.draggable = false;
  image.addEventListener("error", () => {
    if (target.contains(image)) {
      renderAvatarFallback(target, identity);
    }
  });
  image.src = avatarUrl;
  target.replaceChildren(image);
}

function resetAccepted() {
  window.clearTimeout(acceptedTimer);
  acceptedTimer = null;
  accepted = false;
}

function clearReply() {
  activeReply = null;
  elements.reply.hidden = true;
  elements.reply.classList.remove("has-error", "has-widgets", "is-terminal");
  elements.replyError.textContent = "";
  elements.replyState.textContent = "";
  elements.replyText.textContent = "";
  elements.replyWidgets.replaceChildren();
  elements.replyWidgets.hidden = true;
  elements.replyThinking.hidden = true;
  scheduleWidgetSync();
}

function scrollReplyToEnd() {
  window.requestAnimationFrame(() => {
    elements.replyScroll.scrollTop = elements.replyScroll.scrollHeight;
  });
}

function renderReplyText() {
  // Deliberately plain text: this small native surface avoids a Markdown dependency and preserves
  // whitespace, leaving Markdown punctuation visible instead of interpreting agent output.
  elements.replyText.textContent = activeReply?.text || "";
  if (activeReply?.widgets.length) {
    scheduleWidgetSync();
  }
  scrollReplyToEnd();
}

function canvasSurfaceNeedsRefresh() {
  const now = Date.now();
  return (
    Boolean(canvasSurfaceObservedUrl) &&
    now >= canvasSurfaceRetryAt &&
    (!canvasSurfaceUrl || now - canvasSurfaceRefreshedAt >= CANVAS_SURFACE_REFRESH_INTERVAL_MS)
  );
}

function scheduleCanvasSurfaceRetry() {
  window.clearTimeout(canvasSurfaceRetryTimer);
  if (!activeReply?.widgets.length || !canvasSurfaceObservedUrl) {
    canvasSurfaceRetryTimer = null;
    return;
  }
  const delay = Math.max(0, canvasSurfaceRetryAt - Date.now());
  canvasSurfaceRetryTimer = window.setTimeout(() => {
    canvasSurfaceRetryTimer = null;
    if (canvasSurfaceNeedsRefresh()) {
      void refreshCanvasSurface();
    }
  }, delay);
}

function refreshCanvasSurface() {
  if (canvasSurfaceRefreshPromise) {
    return canvasSurfaceRefreshPromise;
  }
  const requestedObservedUrl = canvasSurfaceObservedUrl;
  if (!requestedObservedUrl || Date.now() < canvasSurfaceRetryAt) {
    return Promise.resolve(canvasSurfaceUrl);
  }
  canvasSurfaceRefreshPromise = invoke("quickchat_refresh_widget_surface")
    .then((refreshed) => {
      if (canvasSurfaceObservedUrl !== requestedObservedUrl) {
        return canvasSurfaceUrl;
      }
      const next = typeof refreshed === "string" && refreshed.trim() ? refreshed : null;
      if (next) {
        canvasSurfaceObservedUrl = next;
        canvasSurfaceUrl = next;
        canvasSurfaceRefreshedAt = Date.now();
        canvasSurfaceRetryAt = 0;
      } else {
        canvasSurfaceUrl = null;
        canvasSurfaceRetryAt = Date.now() + CANVAS_SURFACE_REFRESH_RETRY_MS;
      }
      return canvasSurfaceUrl;
    })
    .catch(() => {
      if (canvasSurfaceObservedUrl === requestedObservedUrl) {
        canvasSurfaceUrl = null;
        canvasSurfaceRetryAt = Date.now() + CANVAS_SURFACE_REFRESH_RETRY_MS;
      }
      return canvasSurfaceUrl;
    })
    .finally(() => {
      canvasSurfaceRefreshPromise = null;
      if (activeReply?.widgets.length) {
        renderReplyWidgets();
      }
      if (
        activeReply?.widgets.length &&
        canvasSurfaceObservedUrl &&
        (!canvasSurfaceUrl || canvasSurfaceNeedsRefresh())
      ) {
        scheduleCanvasSurfaceRetry();
      }
    });
  return canvasSurfaceRefreshPromise;
}

let widgetSyncScheduled = false;
let widgetSyncPromise = Promise.resolve();

function scheduleWidgetSync() {
  if (widgetSyncScheduled) {
    return;
  }
  const generation = visibilitySequence;
  widgetSyncScheduled = true;
  window.requestAnimationFrame(() => {
    widgetSyncScheduled = false;
    const widgets = activeReply?.widgets || [];
    const activeKey = activeReply?.activeWidgetKey ?? null;
    const host = elements.replyWidgets.querySelector(".inline-widget-host");
    const rect = host?.getBoundingClientRect();
    const layouts = [];
    if (rect && rect.width > 0 && rect.height > 0) {
      for (const widget of widgets) {
        const url = resolveInlineWidgetUrl(canvasSurfaceUrl, widget.target);
        if (!url) {
          continue;
        }
        layouts.push({
          key: widget.key,
          url,
          sandbox: widget.sandbox,
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          visible: widget.key === activeKey && !openPopover,
        });
      }
    }
    widgetSyncPromise = widgetSyncPromise
      .catch(() => {})
      .then(() =>
        invoke("quickchat_sync_widgets", {
          widgets: layouts,
          hasWidgets: widgets.length > 0,
          expanded: !elements.reply.hidden || Boolean(openPopover),
          sessionId: rendererSessionId,
          rendererEpoch,
          generation,
        }),
      )
      .catch((error) => {
        sendError = friendlyError(error, "Could not render the widget.");
        renderStatus();
      });
  });
}

function selectReplyWidget(key) {
  if (!activeReply?.widgets.some((widget) => widget.key === key)) {
    return;
  }
  activeReply.activeWidgetKey = key;
  renderReplyWidgets();
}

function renderReplyWidgets() {
  elements.replyWidgets.replaceChildren();
  const widgets = activeReply?.widgets || [];
  elements.replyWidgets.hidden = widgets.length === 0;
  elements.reply.classList.toggle("has-widgets", widgets.length > 0);
  if (widgets.length === 0) {
    scheduleWidgetSync();
    return;
  }

  const activeKey = widgets.some((widget) => widget.key === activeReply.activeWidgetKey)
    ? activeReply.activeWidgetKey
    : widgets[0].key;
  activeReply.activeWidgetKey = activeKey;
  if (widgets.length > 1) {
    const tabs = document.createElement("div");
    tabs.className = "inline-widget-tabs";
    for (const widget of widgets) {
      const tab = document.createElement("button");
      tab.type = "button";
      tab.className = "inline-widget-tab";
      tab.classList.toggle("active", widget.key === activeKey);
      tab.textContent = widget.title;
      tab.addEventListener("click", () => selectReplyWidget(widget.key));
      tabs.append(tab);
    }
    elements.replyWidgets.append(tabs);
  }

  const widget = widgets.find((candidate) => candidate.key === activeKey) ?? widgets[0];
  const card = document.createElement("section");
  card.className = "inline-widget";
  card.dataset.widgetKey = widget.key;
  const title = document.createElement("div");
  title.className = "inline-widget-title";
  title.textContent = widget.title;
  card.append(title);

  if (!resolveInlineWidgetUrl(canvasSurfaceUrl, widget.target)) {
    const unavailable = document.createElement("div");
    unavailable.className = "inline-widget-unavailable";
    unavailable.textContent = "Widget unavailable until the Gateway reconnects.";
    card.append(unavailable);
  } else {
    const host = document.createElement("div");
    host.className = "inline-widget-host";
    host.style.height = `${Math.min(widget.preferredHeight, INLINE_WIDGET_VIEWPORT_MAX_HEIGHT)}px`;
    card.append(host);
  }
  elements.replyWidgets.append(card);
  scheduleWidgetSync();
  scrollReplyToEnd();
}

function updateReplyWidgets(message) {
  if (!Array.isArray(message?.content)) {
    return;
  }
  const role = typeof message?.role === "string" ? message.role.trim().toLowerCase() : null;
  if (role !== "assistant") {
    return;
  }
  const widgets = chatMessageWidgets(message);
  const changed = JSON.stringify(widgets) !== JSON.stringify(activeReply?.widgets || []);
  if (activeReply && changed) {
    activeReply.widgets = widgets;
    if (!widgets.some((widget) => widget.key === activeReply.activeWidgetKey)) {
      activeReply.activeWidgetKey = widgets[0]?.key ?? null;
    }
    if (widgets.length && canvasSurfaceNeedsRefresh()) {
      const refresh = refreshCanvasSurface();
      canvasSurfaceUrl = null;
      renderReplyWidgets();
      void refresh;
    } else {
      renderReplyWidgets();
    }
  }
}

function stopReplyThinking() {
  elements.replyThinking.hidden = true;
}

function terminalizeDisconnectedReply() {
  if (!activeReply || activeReply.terminal) {
    return;
  }
  // Chat events are not replayed after a socket gap. Unlock the composer instead of leaving a
  // reply waiting forever for a terminal frame that may have been lost while disconnected.
  activeReply.terminal = true;
  stopReplyThinking();
  elements.reply.classList.add("has-error", "is-terminal");
  elements.replyState.textContent = "Interrupted";
  elements.replyError.textContent = "Connection lost before the reply completed.";
  scrollReplyToEnd();
}

function replyTargetMatches(target, payload) {
  if (!target || payload?.sessionKey !== target.sessionKey) {
    return false;
  }
  return target.agentId == null || payload?.agentId === target.agentId;
}

function startReply(target, identity, runId) {
  activeReply = {
    runId,
    target: {
      sessionKey: target.sessionKey,
      agentId: typeof target.agentId === "string" ? target.agentId : null,
    },
    terminal: false,
    text: null,
    widgets: [],
    activeWidgetKey: null,
  };
  elements.reply.hidden = false;
  elements.reply.classList.remove("has-error", "has-widgets", "is-terminal");
  elements.replyError.textContent = "";
  elements.replyState.textContent = "";
  elements.replyText.textContent = "";
  elements.replyWidgets.replaceChildren();
  elements.replyWidgets.hidden = true;
  elements.replyThinking.textContent = reducedMotion.matches ? "…" : "Thinking…";
  elements.replyThinking.hidden = false;
  renderAvatar(elements.replyAgentAvatar, identity);
  elements.replyAgentName.textContent = identity?.name?.trim() || "Agent";
  void invoke("quickchat_set_expanded", { expanded: true });
}

function applyChatEvent(payload) {
  if (!activeReply) {
    return;
  }
  // The chat.send ACK owns this reply. Exact runId equality is primary; the routing target remains
  // a secondary guard so concurrent turns from other surfaces never enter this reply area.
  if (payload?.runId !== activeReply.runId || !replyTargetMatches(activeReply.target, payload)) {
    return;
  }
  if (activeReply.terminal) {
    return;
  }

  updateReplyWidgets(payload?.message);
  const hasTextUpdate =
    typeof payload?.deltaText === "string" || chatMessageText(payload?.message) !== null;
  if (hasTextUpdate) {
    const nextText = assembleChatDelta(activeReply.text, payload);
    if (nextText !== null) {
      activeReply.text = nextText;
      renderReplyText();
    }
  }

  if (payload?.state === "delta") {
    stopReplyThinking();
    return;
  }
  if (!["final", "aborted", "error"].includes(payload?.state)) {
    return;
  }

  activeReply.terminal = true;
  pendingChatEvents = [];
  stopReplyThinking();
  elements.reply.classList.add("is-terminal");
  if (payload.state === "final") {
    elements.replyState.textContent = "Done";
  } else if (payload.state === "aborted") {
    activeReply.text = `${activeReply.text || ""}${activeReply.text ? "\n\n" : ""}(stopped)`;
    elements.replyState.textContent = "Stopped";
    renderReplyText();
  } else {
    elements.reply.classList.add("has-error");
    elements.replyState.textContent = "Error";
    elements.replyError.textContent =
      typeof payload.errorMessage === "string" && payload.errorMessage.trim()
        ? payload.errorMessage
        : "Gateway reply failed.";
    scrollReplyToEnd();
  }
  updateSendButton();
}

function handleChatEvent(payload) {
  if (activeReply) {
    applyChatEvent(payload);
    return;
  }
  if (sending) {
    // The Gateway may stream before the chat.send ack reaches invoke; replay only after the native
    // command returns the accepted routing target, then apply the same session/run filters.
    if (pendingChatEvents.length === MAX_PENDING_CHAT_EVENTS) {
      pendingChatEvents.shift();
    }
    pendingChatEvents.push(payload);
  }
}

function renderIdentity(identity) {
  const name = identity?.name?.trim() || "Agent";
  activeIdentity = { ...identity, name };
  renderAvatar(elements.agentAvatar, activeIdentity);
  elements.agentChip.title = name;
  elements.input.placeholder = `Message ${name}`;
  renderAgentList();
}

function renderAgentList() {
  elements.agentList.replaceChildren();
  for (const [index, agent] of agents.entries()) {
    const option = document.createElement("button");
    option.className = "agent-option";
    option.type = "button";
    option.dataset.agentId = agent.id;
    option.setAttribute("role", "menuitemradio");
    const active = agent.id === activeIdentity.id;
    option.setAttribute("aria-checked", String(active));
    option.tabIndex = index === menuIndex ? 0 : -1;

    const avatar = document.createElement("span");
    avatar.className = "agent-avatar-mini";
    avatar.setAttribute("aria-hidden", "true");
    renderAvatar(avatar, agent);
    const name = document.createElement("span");
    name.className = "agent-option-name";
    name.textContent = agent.name;
    const check = document.createElement("span");
    check.className = "agent-check";
    check.setAttribute("aria-hidden", "true");
    check.textContent = active ? "✓" : "";
    option.append(avatar, name, check);
    option.addEventListener("click", () => {
      void selectAgent(agent.id);
    });
    elements.agentList.append(option);
  }
}

async function refreshIdentity() {
  try {
    renderIdentity(await invoke("quickchat_identity"));
  } catch {
    renderIdentity({ id: "", name: "Agent", isDefault: true });
  }
}

async function refreshAgents() {
  try {
    agents = await invoke("quickchat_agents");
  } catch {
    agents = [];
  }
  await refreshIdentity();
}

async function selectAgent(agentId) {
  if (selectingAgent) {
    return;
  }
  selectingAgent = true;
  updateSendButton();
  try {
    await invoke("quickchat_select_agent", { agentId });
    await refreshIdentity();
    closePopover();
  } catch (error) {
    sendError = friendlyError(error, "Could not select that agent.");
    renderStatus();
  } finally {
    selectingAgent = false;
    updateSendButton();
  }
}

function resetShortcutCapture() {
  capturingShortcut = false;
  elements.shortcutCapture.textContent = "Press new shortcut";
}

function setPopoverVisibility(kind) {
  openPopover = kind;
  elements.agentMenu.hidden = kind !== "agents";
  elements.shortcutSettings.hidden = kind !== "shortcut";
  elements.agentChip.setAttribute("aria-expanded", String(kind === "agents"));
  elements.shortcutSettingsButton.setAttribute("aria-expanded", String(kind === "shortcut"));
  document.body.classList.toggle("overlay-open", Boolean(kind));
  if (kind !== "shortcut") {
    resetShortcutCapture();
  }
  if (activeReply?.widgets.length) {
    scheduleWidgetSync();
  }
}

async function openNamedPopover(kind) {
  if (openPopover === kind) {
    closePopover();
    return;
  }
  const sequence = ++popoverSequence;
  try {
    await invoke("quickchat_set_expanded", { expanded: true });
  } catch (error) {
    sendError = friendlyError(error, "Could not open Quick Chat settings.");
    renderStatus();
    return;
  }
  if (sequence !== popoverSequence) {
    return;
  }
  setPopoverVisibility(kind);
  if (kind === "agents") {
    const selectedIndex = agents.findIndex((agent) => agent.id === activeIdentity.id);
    menuIndex = selectedIndex >= 0 ? selectedIndex : 0;
    renderAgentList();
    elements.agentList.querySelectorAll(".agent-option")[menuIndex]?.focus();
  } else {
    elements.shortcutError.textContent = "";
    elements.shortcutCapture.focus();
  }
}

function closePopover(focusInput = true, compact = true) {
  ++popoverSequence;
  setPopoverVisibility(null);
  if (compact) {
    void invoke("quickchat_set_expanded", { expanded: !elements.reply.hidden });
  }
  if (focusInput) {
    elements.input.focus();
  }
}

function focusMenuOption(index) {
  const options = [...elements.agentList.querySelectorAll(".agent-option")];
  if (options.length === 0) {
    return;
  }
  menuIndex = (index + options.length) % options.length;
  for (const [optionIndex, option] of options.entries()) {
    option.tabIndex = optionIndex === menuIndex ? 0 : -1;
  }
  options[menuIndex].focus();
}

function renderShortcutStatus(shortcut) {
  const supported = shortcut?.supported === true;
  elements.shortcutSettingsButton.hidden = !supported;
  elements.shortcutValue.textContent = shortcut?.accelerator || "";
  if (!supported && openPopover === "shortcut") {
    closePopover();
  }
}

async function refreshShortcutStatus() {
  try {
    renderShortcutStatus(await invoke("quickchat_shortcut"));
  } catch {
    renderShortcutStatus({ supported: false });
  }
}

function acceleratorFromEvent(event) {
  let key = "";
  if (/^Key[A-Z]$/.test(event.code)) {
    key = event.code;
  } else if (/^Digit[0-9]$/.test(event.code)) {
    key = event.code;
  } else if (event.code === "Space") {
    key = "Space";
  } else if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(event.code)) {
    key = event.code;
  }
  if (!key) {
    return null;
  }
  const parts = [];
  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push("Super");
  if (parts.length === 0) {
    return null;
  }
  parts.push(key);
  return parts.join("+");
}

async function saveShortcut(accelerator) {
  elements.shortcutError.textContent = "";
  try {
    const status = await invoke("quickchat_set_shortcut", { accelerator });
    renderShortcutStatus(status);
    resetShortcutCapture();
  } catch (error) {
    elements.shortcutError.textContent = friendlyError(
      error,
      "Could not update the Quick Chat shortcut.",
    );
    resetShortcutCapture();
    elements.shortcutCapture.focus();
  }
}

async function requestHide() {
  if (hiding) {
    return;
  }
  const operationGeneration = nextVisibilityOperation();
  hiding = true;
  pendingChatEvents = [];
  closePopover(false, false);
  document.body.classList.remove("shown");
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(
    async () => {
      try {
        const hidden = await invoke("quickchat_hide", {
          sessionId: rendererSessionId,
          rendererEpoch,
          generation: operationGeneration,
        });
        if (visibilitySequence !== operationGeneration) {
          return;
        }
        if (hidden !== true) {
          document.body.classList.add("shown");
          return;
        }
        resetAccepted();
        clearReply();
      } catch (error) {
        if (visibilitySequence === operationGeneration) {
          sendError = friendlyError(error);
          renderStatus();
          document.body.classList.add("shown");
          elements.input.focus();
        }
      } finally {
        if (visibilitySequence === operationGeneration) {
          hiding = false;
        }
      }
    },
    reducedMotion.matches ? 45 : 120,
  );
}

function reveal() {
  const operationGeneration = nextVisibilityOperation();
  void invoke("quickchat_activate", {
    sessionId: rendererSessionId,
    rendererEpoch,
    generation: operationGeneration,
  })
    .then((accepted) => {
      if (accepted !== true && visibilitySequence === operationGeneration) {
        document.body.classList.remove("shown");
        return;
      }
      if (
        accepted === true &&
        visibilitySequence === operationGeneration &&
        activeReply?.widgets.length
      ) {
        scheduleWidgetSync();
      }
    })
    .catch(() => {});
  window.clearTimeout(hideTimer);
  resetAccepted();
  hiding = false;
  setPopoverVisibility(null);
  renderStatus();
  updateSendButton();
  document.body.classList.remove("shown");
  window.requestAnimationFrame(() => {
    document.body.classList.add("shown");
    elements.input.focus();
  });
  if (gatewayState === "up") {
    void refreshAgents();
  }
  void refreshShortcutStatus();
}

async function send(openDashboard) {
  const message = elements.input.value.trim();
  if (gatewayState !== "up" || !message || selectingAgent || sending || accepted) {
    return;
  }
  sending = true;
  const sendDisconnectSequence = gatewayDisconnectSequence;
  const sendVisibilitySequence = visibilitySequence;
  clearReply();
  pendingChatEvents = [];
  void invoke("quickchat_set_expanded", { expanded: false });
  sendError = "";
  renderStatus();
  updateSendButton();
  try {
    const sentIdentity = { ...activeIdentity };
    const result = await invoke("quickchat_send", { message });
    if (!result || typeof result.sessionKey !== "string") {
      throw new Error("Gateway accepted the message without a routing target.");
    }
    if (typeof result.runId !== "string" || !result.runId) {
      throw new Error("Gateway accepted the message without a run ID.");
    }
    sending = false;
    sendError = "";
    elements.input.value = "";
    if (visibilitySequence !== sendVisibilitySequence || hiding) {
      pendingChatEvents = [];
      updateSendButton();
      return;
    }
    accepted = true;
    startReply(result, sentIdentity, result.runId);
    const bufferedEvents = pendingChatEvents;
    pendingChatEvents = [];
    for (const payload of bufferedEvents) {
      applyChatEvent(payload);
    }
    if (gatewayDisconnectSequence !== sendDisconnectSequence || gatewayState !== "up") {
      terminalizeDisconnectedReply();
    }
    updateSendButton();
    if (openDashboard) {
      void invoke("quickchat_show_dashboard");
    }
    acceptedTimer = window.setTimeout(() => {
      accepted = false;
      acceptedTimer = null;
      updateSendButton();
    }, 450);
  } catch (error) {
    sending = false;
    pendingChatEvents = [];
    if (visibilitySequence !== sendVisibilitySequence || hiding) {
      updateSendButton();
      return;
    }
    sendError = friendlyError(error);
    renderStatus();
    updateSendButton();
    elements.input.focus();
    // A strict send failure can mean the pinned agent vanished; re-sync the chip.
    void refreshAgents();
  }
}

window.addEventListener("resize", scheduleWidgetSync);
elements.input.addEventListener("input", () => {
  sendError = "";
  renderStatus();
  updateSendButton();
});
elements.input.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229) {
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    if (openPopover) {
      closePopover();
    } else {
      void requestHide();
    }
    return;
  }
  if (event.key === "Enter" && !openPopover) {
    event.preventDefault();
    void send(event.ctrlKey || event.metaKey);
  }
});
elements.agentChip.addEventListener("click", () => {
  void openNamedPopover("agents");
});
elements.shortcutSettingsButton.addEventListener("click", () => {
  void openNamedPopover("shortcut");
});
elements.shortcutCapture.addEventListener("click", () => {
  capturingShortcut = true;
  elements.shortcutError.textContent = "";
  elements.shortcutCapture.textContent = "Press keys…";
  elements.shortcutCapture.focus();
});
elements.shortcutReset.addEventListener("click", () => {
  void saveShortcut(null);
});
elements.send.addEventListener("click", () => {
  void send(false);
});

document.addEventListener(
  "keydown",
  (event) => {
    if (!openPopover) {
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closePopover();
      return;
    }
    if (openPopover === "agents") {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopPropagation();
        focusMenuOption(menuIndex + (event.key === "ArrowDown" ? 1 : -1));
      } else if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        elements.agentList.querySelectorAll(".agent-option")[menuIndex]?.click();
      }
      return;
    }
    if (openPopover === "shortcut" && capturingShortcut) {
      const accelerator = acceleratorFromEvent(event);
      if (!accelerator) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void saveShortcut(accelerator);
    }
  },
  true,
);

document.addEventListener("pointerdown", (event) => {
  if (!openPopover) {
    return;
  }
  const target = event.target;
  const insidePopover =
    elements.agentMenu.contains(target) ||
    elements.agentChip.contains(target) ||
    elements.shortcutSettings.contains(target) ||
    elements.shortcutSettingsButton.contains(target);
  if (!insidePopover) {
    closePopover(false);
  }
});

await listen("quickchat:shown", () => {
  reveal();
});
await listen("quickchat:hide-requested", () => {
  void requestHide();
});
await listen("quickchat:gateway-state", (event) => {
  setGatewayState(event.payload);
});
await listen("quickchat:chat-event", (event) => {
  handleChatEvent(event.payload);
});

const readySequence = visibilitySequence;
try {
  const shouldShow = await invoke("quickchat_ready", {
    sessionId: rendererSessionId,
    rendererEpoch,
  });
  if (visibilitySequence === readySequence) {
    if (shouldShow) {
      reveal();
    } else {
      void requestHide();
    }
  }
} catch {
  void requestHide();
}
