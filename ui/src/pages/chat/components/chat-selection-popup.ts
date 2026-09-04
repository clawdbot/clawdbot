// Floating toolbar over selected chat text: "Ask in side chat" pre-fills the
// session rail.
// Mirrors the imperative reply-context-menu pattern in chat-thread.ts.

import { t } from "../../../i18n/index.ts";

type ChatSelectionPopupActions = {
  onAskSideChat: (selection: string) => void;
};

let activeSelectionPopup: { element: HTMLDivElement; listeners: AbortController } | null = null;
let selectionPopupTimer: number | null = null;

export function removeChatSelectionPopup() {
  // The popup is a document singleton; teardown and replacement must cancel
  // deferred selection work so an old pane cannot recreate it.
  if (selectionPopupTimer !== null) {
    window.clearTimeout(selectionPopupTimer);
    selectionPopupTimer = null;
  }
  activeSelectionPopup?.element.remove();
  activeSelectionPopup?.listeners.abort();
  activeSelectionPopup = null;
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

function createSelectionPopupButton(label: string, onActivate: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.textContent = label;
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
  popup.setAttribute("aria-label", t("chat.messages.selectionActions"));
  popup.addEventListener("pointerdown", (event) => event.preventDefault());

  const activate = (action: (selection: string) => void) => {
    removeChatSelectionPopup();
    window.getSelection()?.removeAllRanges();
    action(selectionText);
  };
  popup.append(
    createSelectionPopupButton(t("chat.messages.askInSideChat"), () =>
      activate(actions.onAskSideChat),
    ),
  );
  document.body.appendChild(popup);
  const listeners = new AbortController();
  activeSelectionPopup = { element: popup, listeners };

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
  const { signal } = listeners;
  document.addEventListener("pointerdown", handlePointerDown, { capture: true, signal });
  document.addEventListener("selectionchange", handleSelectionChange, { signal });
  document.addEventListener("keydown", handleKeydown, { signal });
  document.addEventListener("scroll", handleScroll, { capture: true, passive: true, signal });
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
