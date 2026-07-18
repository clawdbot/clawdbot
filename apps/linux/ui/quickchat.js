const tauri = window["__TAURI__"];
const { invoke } = tauri.core;
const { listen } = tauri.event;

const elements = {
  agentAvatar: document.querySelector("#agent-avatar"),
  agentChip: document.querySelector("#agent-chip"),
  agentList: document.querySelector("#agent-list"),
  agentMenu: document.querySelector("#agent-menu"),
  composer: document.querySelector("#composer"),
  input: document.querySelector("#message"),
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
let sendError = "";
let openPopover = null;
let menuIndex = 0;
let capturingShortcut = false;

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

function updateSendButton() {
  const empty = !elements.input.value.trim();
  elements.send.disabled = empty || selectingAgent || sending || accepted;
  elements.send.classList.toggle("sending", sending);
  elements.send.classList.toggle("accepted", accepted);
  elements.sendIcon.textContent = sending ? "" : accepted ? "✓" : "↑";
  elements.input.readOnly = sending || accepted;
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
    setError(sendError);
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
    setError(sendError);
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
    void invoke("quickchat_set_expanded", { expanded: false });
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

async function requestHide(force = false) {
  if ((accepted && !force) || hiding) {
    return;
  }
  visibilitySequence += 1;
  const hideSequence = visibilitySequence;
  hiding = true;
  closePopover(false, false);
  document.body.classList.remove("shown");
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(
    async () => {
      try {
        await invoke("quickchat_hide");
      } catch (error) {
        if (visibilitySequence === hideSequence) {
          sendError = friendlyError(error);
          setError(sendError);
          document.body.classList.add("shown");
          elements.input.focus();
        }
      } finally {
        if (visibilitySequence === hideSequence) {
          hiding = false;
        }
      }
    },
    reducedMotion.matches ? 45 : 120,
  );
}

function reveal() {
  window.clearTimeout(hideTimer);
  if (accepted) {
    window.clearTimeout(acceptedTimer);
    acceptedTimer = null;
    accepted = false;
  }
  hiding = false;
  setPopoverVisibility(null);
  setError(sendError);
  updateSendButton();
  document.body.classList.remove("shown");
  window.requestAnimationFrame(() => {
    document.body.classList.add("shown");
    elements.input.focus();
  });
  void refreshAgents();
  void refreshShortcutStatus();
}

async function send(openDashboard) {
  const message = elements.input.value.trim();
  if (!message || selectingAgent || sending || accepted) {
    return;
  }
  sending = true;
  sendError = "";
  setError();
  updateSendButton();
  try {
    await invoke("quickchat_send", { message });
    sending = false;
    accepted = true;
    sendError = "";
    elements.input.value = "";
    updateSendButton();
    if (openDashboard) {
      void invoke("quickchat_show_dashboard");
    }
    acceptedTimer = window.setTimeout(() => {
      accepted = false;
      updateSendButton();
      void requestHide(true);
    }, 450);
  } catch (error) {
    sending = false;
    sendError = friendlyError(error);
    setError(sendError);
    updateSendButton();
    elements.input.focus();
    // A strict send failure can mean the pinned agent vanished; re-sync the chip.
    void refreshAgents();
  }
}

elements.input.addEventListener("input", () => {
  sendError = "";
  setError();
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
    void send(event.ctrlKey);
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
  visibilitySequence += 1;
  reveal();
});
await listen("quickchat:hide-requested", () => {
  void requestHide();
});

const readySequence = visibilitySequence;
try {
  const shouldShow = await invoke("quickchat_ready");
  if (visibilitySequence === readySequence) {
    if (shouldShow) {
      reveal();
    } else {
      void requestHide(true);
    }
  }
} catch {
  void requestHide(true);
}
