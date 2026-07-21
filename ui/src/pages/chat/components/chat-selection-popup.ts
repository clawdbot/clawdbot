// Floating toolbar over selected chat text: "More details" fires an implicit
// /btw side question; "Ask in side chat" pre-fills the composer with a /btw
// draft quoting the selection. Mirrors the imperative reply-context-menu
// pattern in chat-thread.ts (body-portaled fixed div, document-level dismiss).

type ChatSelectionPopupActions = {
  onMoreDetails: (selection: string) => void;
  onAskSideChat: (selection: string) => void;
};

let activeSelectionPopup: HTMLDivElement | null = null;
let removeDismissListeners: (() => void) | null = null;
let selectionPopupTimer: number | null = null;

export function removeChatSelectionPopup() {
  // The popup is a document singleton; teardown and replacement must cancel
  // deferred selection work so an old pane cannot recreate it.
  if (selectionPopupTimer !== null) {
    window.clearTimeout(selectionPopupTimer);
    selectionPopupTimer = null;
  }
  activeSelectionPopup?.remove();
  activeSelectionPopup = null;
  removeDismissListeners?.();
  removeDismissListeners = null;
}

function selectionTextWithinChatBubble(
  selection: Selection,
  threadRoot: HTMLElement,
): string | null {
  if (selection.isCollapsed || selection.rangeCount === 0) {
    return null;
  }
  const container = selection.getRangeAt(0).commonAncestorContainer;
  const element = container instanceof Element ? container : container.parentElement;
  // Cross-bubble selections resolve to a thread-level ancestor and bail here;
  // a quote spanning multiple messages makes a poor single side question.
  const bubble = element?.closest(".chat-bubble");
  if (!bubble || !threadRoot.contains(bubble)) {
    return null;
  }
  const text = selection.toString();
  return text.trim() ? text : null;
}

function createSelectionPopupButton(
  label: string,
  iconPath: string,
  onActivate: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", label);

  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "14");
  icon.setAttribute("height", "14");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "2");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", iconPath);
  icon.appendChild(path);

  const text = document.createElement("span");
  text.textContent = label;

  button.append(icon, text);
  // pointerdown would collapse the selection before click fires; the popup
  // must keep the selection alive until the action reads it.
  button.addEventListener("pointerdown", (event) => event.preventDefault());
  button.addEventListener("click", onActivate);
  return button;
}

function showChatSelectionPopup(
  selectionRect: DOMRect,
  selectionText: string,
  actions: ChatSelectionPopupActions,
) {
  removeChatSelectionPopup();
  const popup = document.createElement("div");
  popup.className = "chat-selection-popup";
  popup.setAttribute("role", "toolbar");
  popup.setAttribute("aria-label", "Selection actions");
  popup.addEventListener("pointerdown", (event) => event.preventDefault());

  const activate = (action: (selection: string) => void) => {
    removeChatSelectionPopup();
    window.getSelection()?.removeAllRanges();
    action(selectionText);
  };
  popup.append(
    createSelectionPopupButton(
      "More details",
      "M12 3v2m0 14v2M5.6 5.6l1.5 1.5m9.8 9.8 1.5 1.5M3 12h2m14 0h2M5.6 18.4l1.5-1.5m9.8-9.8 1.5-1.5",
      () => activate(actions.onMoreDetails),
    ),
    createSelectionPopupButton(
      "Ask in side chat",
      "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z",
      () => activate(actions.onAskSideChat),
    ),
  );
  document.body.appendChild(popup);
  activeSelectionPopup = popup;

  const popupRect = popup.getBoundingClientRect();
  let left = selectionRect.left + selectionRect.width / 2 - popupRect.width / 2;
  let top = selectionRect.top - popupRect.height - 8;
  if (top < 8) {
    top = selectionRect.bottom + 8;
  }
  left = Math.min(Math.max(8, left), window.innerWidth - popupRect.width - 8);
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;

  const handlePointerDown = (event: PointerEvent) => {
    if (!popup.contains(event.target as Node | null)) {
      removeChatSelectionPopup();
    }
  };
  const handleSelectionChange = () => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      removeChatSelectionPopup();
    }
  };
  const handleKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      removeChatSelectionPopup();
    }
  };
  // The popup is position:fixed against a since-scrolled selection rect;
  // dismiss instead of chasing the text.
  const handleScroll = () => removeChatSelectionPopup();
  document.addEventListener("pointerdown", handlePointerDown, true);
  document.addEventListener("selectionchange", handleSelectionChange);
  document.addEventListener("keydown", handleKeydown);
  document.addEventListener("scroll", handleScroll, { capture: true, passive: true });
  removeDismissListeners = () => {
    document.removeEventListener("pointerdown", handlePointerDown, true);
    document.removeEventListener("selectionchange", handleSelectionChange);
    document.removeEventListener("keydown", handleKeydown);
    document.removeEventListener("scroll", handleScroll, { capture: true });
  };
}

export function handleChatSelectionPointerUp(
  event: PointerEvent,
  actions: ChatSelectionPopupActions,
) {
  const threadRoot = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  if (!threadRoot) {
    return;
  }
  // Defer one tick so the browser finalizes the selection for this pointerup.
  removeChatSelectionPopup();
  selectionPopupTimer = window.setTimeout(() => {
    selectionPopupTimer = null;
    const selection = window.getSelection();
    const text = selection ? selectionTextWithinChatBubble(selection, threadRoot) : null;
    if (!text || !selection) {
      removeChatSelectionPopup();
      return;
    }
    showChatSelectionPopup(selection.getRangeAt(0).getBoundingClientRect(), text, actions);
  }, 0);
}
