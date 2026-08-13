import { html } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { getSafeLocalStorage } from "../../../local-storage.ts";

// Persisted preference key: renaming it would reset users' "Don't ask again" choice.
const SKIP_REWIND_CONFIRM_PREFERENCE = "openclaw:skip-rewind-confirm";
const CONFIRMED_ACTION_VIEWPORT_MARGIN_PX = 8;
const CONFIRMED_ACTION_TRIGGER_GAP_PX = 6;

type ConfirmedActionDismissOptions = { restoreFocus?: boolean };
type ConfirmedActionDismisser = (options?: ConfirmedActionDismissOptions) => void;

const confirmedActionDismissers = new WeakMap<Element, ConfirmedActionDismisser>();
const confirmedActionOwners = new WeakMap<Element, Element>();
const confirmedActionPopovers = new Set<HTMLElement>();
const confirmedActionPopoversByOwner = new WeakMap<Element, HTMLElement>();

function shouldSkipActionConfirm(preferenceName: string): boolean {
  try {
    return getSafeLocalStorage()?.getItem(preferenceName) === "1";
  } catch {
    return false;
  }
}

function dismissConfirmedAction(element: Element, options?: ConfirmedActionDismissOptions) {
  const dismiss = confirmedActionDismissers.get(element);
  if (dismiss) {
    dismiss(options);
    return;
  }
  element.remove();
}

export function dismissConfirmedActionPopovers(owner: ParentNode): void {
  for (const popover of confirmedActionPopovers) {
    const popoverOwner = confirmedActionOwners.get(popover);
    if (popoverOwner && owner instanceof Node && owner.contains(popoverOwner)) {
      dismissConfirmedAction(popover);
    }
  }
}

function resolveViewportBounds() {
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft ?? 0;
  const top = viewport?.offsetTop ?? 0;
  const width = viewport?.width ?? window.innerWidth ?? document.documentElement.clientWidth;
  const height = viewport?.height ?? window.innerHeight ?? document.documentElement.clientHeight;

  return {
    bottom: top + height,
    left,
    right: left + width,
    top,
  };
}

function clampConfirmedActionPosition(value: number, min: number, max: number) {
  if (max < min) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function placeConfirmedActionPopover(trigger: HTMLElement, popover: HTMLElement) {
  const triggerRect = trigger.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const viewport = resolveViewportBounds();
  const margin = CONFIRMED_ACTION_VIEWPORT_MARGIN_PX;
  const gap = CONFIRMED_ACTION_TRIGGER_GAP_PX;
  const viewportWidth = viewport.right - viewport.left;
  const viewportHeight = viewport.bottom - viewport.top;
  const popoverWidth = Math.min(popoverRect.width, viewportWidth - margin * 2);
  const popoverHeight = Math.min(popoverRect.height, viewportHeight - margin * 2);
  const spaceAbove = triggerRect.top - viewport.top - margin - gap;
  const spaceBelow = viewport.bottom - triggerRect.bottom - margin - gap;
  const placeBelow = spaceAbove < popoverHeight && spaceBelow >= spaceAbove;
  const desiredLeft = triggerRect.right - popoverWidth;
  const left = clampConfirmedActionPosition(
    desiredLeft,
    viewport.left + margin,
    viewport.right - margin - popoverWidth,
  );
  const desiredTop = placeBelow ? triggerRect.bottom + gap : triggerRect.top - gap - popoverHeight;
  const top = clampConfirmedActionPosition(
    desiredTop,
    viewport.top + margin,
    viewport.bottom - margin - popoverHeight,
  );

  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
  popover.dataset.placement = placeBelow ? "below" : "above";
}

type ConfirmedActionParams = {
  action: () => void;
  confirmLabel: string;
  confirmText: string;
  preferenceName: string;
};

export function renderRewindButton(onRewind: () => void, disabled: boolean) {
  const label = t("chat.messages.rewind");
  const params: ConfirmedActionParams = {
    action: onRewind,
    confirmLabel: label,
    confirmText: t("chat.messages.rewindConfirm"),
    preferenceName: SKIP_REWIND_CONFIRM_PREFERENCE,
  };
  return html`
    <span class="chat-confirm-wrap chat-rewind-wrap">
      <openclaw-tooltip .content=${disabled ? t("chat.messages.rewindUnavailable") : label}>
        <button
          class="chat-group-rewind"
          aria-label=${label}
          ?disabled=${disabled}
          @click=${(event: Event) =>
            openConfirmedActionPopover(event.currentTarget as HTMLElement, params)}
        >
          ${icons.refresh}
        </button>
      </openclaw-tooltip>
    </span>
  `;
}

export function openChatRewindConfirmation(trigger: HTMLElement, action: () => void): void {
  openConfirmedActionPopover(trigger, {
    action,
    confirmLabel: t("chat.messages.rewind"),
    confirmText: t("chat.messages.rewindConfirm"),
    preferenceName: SKIP_REWIND_CONFIRM_PREFERENCE,
  });
}

function openConfirmedActionPopover(btn: HTMLElement, params: ConfirmedActionParams): void {
  if (shouldSkipActionConfirm(params.preferenceName)) {
    params.action();
    return;
  }
  const wrap = btn.closest(".chat-confirm-wrap") as HTMLElement | null;
  if (!wrap) {
    return;
  }
  const owner = wrap;
  const existing = confirmedActionPopoversByOwner.get(owner);
  if (existing) {
    dismissConfirmedAction(existing, { restoreFocus: true });
    return;
  }
  const popover = document.createElement("div");
  popover.className = "chat-confirm-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-modal", "true");
  popover.setAttribute("aria-label", params.confirmText);
  popover.innerHTML = `
    <p class="chat-confirm-popover__text"></p>
    <label class="chat-confirm-popover__remember">
      <input type="checkbox" class="chat-confirm-popover__check" />
      <span></span>
    </label>
    <div class="chat-confirm-popover__actions">
      <button class="chat-confirm-popover__cancel" type="button"></button>
      <button class="chat-confirm-popover__yes" type="button"></button>
    </div>
  `;
  const confirmText = popover.querySelector(".chat-confirm-popover__text");
  const rememberText = popover.querySelector(".chat-confirm-popover__remember span");
  const cancelButton = popover.querySelector(".chat-confirm-popover__cancel");
  const confirmButton = popover.querySelector(".chat-confirm-popover__yes");
  if (confirmText) {
    confirmText.textContent = params.confirmText;
  }
  if (confirmButton) {
    confirmButton.textContent = params.confirmLabel;
  }
  if (rememberText) {
    rememberText.textContent = t("chat.messages.dontAskAgain");
  }
  if (cancelButton) {
    cancelButton.textContent = t("common.cancel");
  }
  // Virtual transcript rows use transforms for positioning, which makes fixed
  // descendants relative to the row instead of the viewport. Portal the dialog
  // so the viewport-clamped coordinates stay correct in web and native hosts.
  owner.ownerDocument.body.appendChild(popover);
  confirmedActionOwners.set(popover, owner);
  confirmedActionPopovers.add(popover);
  confirmedActionPopoversByOwner.set(owner, popover);
  placeConfirmedActionPopover(btn, popover);

  const cancel = popover.querySelector<HTMLButtonElement>(".chat-confirm-popover__cancel")!;
  const yes = popover.querySelector<HTMLButtonElement>(".chat-confirm-popover__yes")!;
  const check = popover.querySelector<HTMLInputElement>(".chat-confirm-popover__check")!;
  let dismissed = false;
  let ownerObserver: MutationObserver | null = null;
  function dismissPopover(options?: ConfirmedActionDismissOptions) {
    if (dismissed) {
      return;
    }
    dismissed = true;
    ownerObserver?.disconnect();
    document.removeEventListener("click", closeOnOutside, true);
    document.removeEventListener("contextmenu", closeOnContextMenu, true);
    window.removeEventListener("keydown", closeOnEscape, true);
    confirmedActionDismissers.delete(popover);
    confirmedActionOwners.delete(popover);
    confirmedActionPopovers.delete(popover);
    confirmedActionPopoversByOwner.delete(owner);
    popover.remove();
    if (options?.restoreFocus && btn.isConnected) {
      btn.focus({ preventScroll: true });
    }
  }
  function closeOnOutside(evt: MouseEvent) {
    const target = evt.target;
    if (target instanceof Node && !popover.contains(target) && !btn.contains(target)) {
      dismissPopover();
    }
  }
  function closeOnContextMenu(evt: MouseEvent) {
    const target = evt.target;
    if (target instanceof Node && !popover.contains(target)) {
      dismissPopover();
    }
  }
  function closeOnEscape(evt: KeyboardEvent) {
    if (evt.key !== "Escape" || !popover.contains(document.activeElement)) {
      return;
    }
    evt.preventDefault();
    evt.stopImmediatePropagation();
    dismissPopover({ restoreFocus: true });
  }
  function containKeyboardFocus(evt: KeyboardEvent) {
    if (evt.key !== "Tab") {
      return;
    }
    const first = check;
    const last = yes;
    if (evt.shiftKey && document.activeElement === first) {
      evt.preventDefault();
      last.focus();
    } else if (!evt.shiftKey && document.activeElement === last) {
      evt.preventDefault();
      first.focus();
    }
  }
  confirmedActionDismissers.set(popover, dismissPopover);
  cancel.addEventListener("click", () => dismissPopover({ restoreFocus: true }));
  yes.addEventListener("click", () => {
    if (check.checked) {
      try {
        getSafeLocalStorage()?.setItem(params.preferenceName, "1");
      } catch {}
    }
    dismissPopover();
    params.action();
  });
  popover.addEventListener("keydown", containKeyboardFocus);
  document.addEventListener("contextmenu", closeOnContextMenu, true);
  window.addEventListener("keydown", closeOnEscape, true);
  ownerObserver = new MutationObserver(() => {
    if (!wrap.isConnected || !btn.isConnected) {
      dismissPopover();
    }
  });
  ownerObserver.observe(wrap.ownerDocument.body, { childList: true, subtree: true });
  cancel.focus({ preventScroll: true });
  requestAnimationFrame(() => {
    if (!dismissed && popover.isConnected) {
      placeConfirmedActionPopover(btn, popover);
      document.addEventListener("click", closeOnOutside, true);
    }
  });
}
