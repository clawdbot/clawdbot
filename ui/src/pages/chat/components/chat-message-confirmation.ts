import { html } from "lit";
import { icons } from "../../../components/icons.ts";
import { t } from "../../../i18n/index.ts";
import { getSafeLocalStorage } from "../../../local-storage.ts";

const SKIP_DELETE_CONFIRM_PREFERENCE = "openclaw:skipDeleteConfirm";
const SKIP_REWIND_CONFIRM_PREFERENCE = "openclaw:skip-rewind-confirm";
const DELETE_CONFIRM_VIEWPORT_MARGIN_PX = 8;
const DELETE_CONFIRM_TRIGGER_GAP_PX = 6;

type DeleteConfirmSide = "left" | "right";
type DeleteConfirmDismissOptions = { restoreFocus?: boolean };
type DeleteConfirmDismisser = (options?: DeleteConfirmDismissOptions) => void;

const deleteConfirmDismissers = new WeakMap<Element, DeleteConfirmDismisser>();

function shouldSkipActionConfirm(preferenceName: string): boolean {
  try {
    return getSafeLocalStorage()?.getItem(preferenceName) === "1";
  } catch {
    return false;
  }
}

function dismissDeleteConfirm(element: Element, options?: DeleteConfirmDismissOptions) {
  const dismiss = deleteConfirmDismissers.get(element);
  if (dismiss) {
    dismiss(options);
    return;
  }
  element.remove();
}

export function dismissConfirmedActionPopovers(owner: ParentNode): void {
  owner.querySelectorAll(".chat-delete-confirm").forEach((popover) => {
    dismissDeleteConfirm(popover);
  });
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

function clampDeleteConfirmPosition(value: number, min: number, max: number) {
  if (max < min) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}

function placeDeleteConfirmPopover(
  trigger: HTMLElement,
  popover: HTMLElement,
  side: DeleteConfirmSide,
) {
  const triggerRect = trigger.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const viewport = resolveViewportBounds();
  const margin = DELETE_CONFIRM_VIEWPORT_MARGIN_PX;
  const gap = DELETE_CONFIRM_TRIGGER_GAP_PX;
  const viewportWidth = viewport.right - viewport.left;
  const viewportHeight = viewport.bottom - viewport.top;
  const popoverWidth = Math.min(popoverRect.width, viewportWidth - margin * 2);
  const popoverHeight = Math.min(popoverRect.height, viewportHeight - margin * 2);
  const spaceAbove = triggerRect.top - viewport.top - margin - gap;
  const spaceBelow = viewport.bottom - triggerRect.bottom - margin - gap;
  const placeBelow = spaceAbove < popoverHeight && spaceBelow >= spaceAbove;
  const desiredLeft = side === "left" ? triggerRect.right - popoverWidth : triggerRect.left;
  const left = clampDeleteConfirmPosition(
    desiredLeft,
    viewport.left + margin,
    viewport.right - margin - popoverWidth,
  );
  const desiredTop = placeBelow ? triggerRect.bottom + gap : triggerRect.top - gap - popoverHeight;
  const top = clampDeleteConfirmPosition(
    desiredTop,
    viewport.top + margin,
    viewport.bottom - margin - popoverHeight,
  );

  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
  popover.dataset.placement = placeBelow ? "below" : "above";
}

export function renderDeleteButton(onDelete: () => void, side: DeleteConfirmSide) {
  // "Hide" is honest copy: this action only hides the bubble in this browser's
  // localStorage; the message stays in the transcript and in agent context.
  return renderConfirmedActionButton({
    action: onDelete,
    ariaLabel: t("chat.messages.hideMessage"),
    buttonClass: "chat-group-delete",
    confirmLabel: t("chat.messages.hide"),
    confirmText: t("chat.messages.hideConfirm"),
    icon: icons.eyeOff ?? icons.x,
    preferenceName: SKIP_DELETE_CONFIRM_PREFERENCE,
    side,
    tooltip: t("chat.messages.hideTooltip"),
  });
}

export function renderRewindButton(
  onRewind: () => void,
  disabled: boolean,
  side: DeleteConfirmSide,
) {
  return renderConfirmedActionButton({
    action: onRewind,
    ariaLabel: t("chat.messages.rewind"),
    buttonClass: "chat-group-rewind",
    confirmLabel: t("chat.messages.rewind"),
    confirmText: t("chat.messages.rewindConfirm"),
    disabled,
    icon: icons.refresh,
    preferenceName: SKIP_REWIND_CONFIRM_PREFERENCE,
    side,
    tooltip: disabled ? t("chat.messages.rewindUnavailable") : t("chat.messages.rewind"),
    wrapClass: "chat-rewind-wrap",
  });
}

type ConfirmedActionParams = {
  action: () => void;
  ariaLabel: string;
  buttonClass?: string;
  confirmLabel: string;
  confirmText: string;
  disabled?: boolean;
  icon: unknown;
  preferenceName: string;
  side: DeleteConfirmSide;
  tooltip: string;
  wrapClass?: string;
};

export function openChatRewindConfirmation(trigger: HTMLElement, action: () => void): void {
  openConfirmedActionPopover(trigger, {
    action,
    confirmLabel: t("chat.messages.rewind"),
    confirmText: t("chat.messages.rewindConfirm"),
    preferenceName: SKIP_REWIND_CONFIRM_PREFERENCE,
    side: "left",
  });
}

export function openChatHideConfirmation(trigger: HTMLElement, action: () => void): void {
  openConfirmedActionPopover(trigger, {
    action,
    confirmLabel: t("chat.messages.hide"),
    confirmText: t("chat.messages.hideConfirm"),
    preferenceName: SKIP_DELETE_CONFIRM_PREFERENCE,
    side: "right",
  });
}

function openConfirmedActionPopover(
  btn: HTMLElement,
  params: Pick<
    ConfirmedActionParams,
    "action" | "confirmLabel" | "confirmText" | "preferenceName" | "side"
  >,
): void {
  if (shouldSkipActionConfirm(params.preferenceName)) {
    params.action();
    return;
  }
  const wrap = btn.closest(".chat-delete-wrap") as HTMLElement | null;
  if (!wrap) {
    return;
  }
  const existing = wrap.querySelector(".chat-delete-confirm");
  if (existing) {
    dismissDeleteConfirm(existing, { restoreFocus: true });
    return;
  }
  const popover = document.createElement("div");
  popover.className = `chat-delete-confirm chat-delete-confirm--${params.side}`;
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-modal", "true");
  popover.setAttribute("aria-label", params.confirmText);
  popover.innerHTML = `
    <p class="chat-delete-confirm__text"></p>
    <label class="chat-delete-confirm__remember">
      <input type="checkbox" class="chat-delete-confirm__check" />
      <span>Don't ask again</span>
    </label>
    <div class="chat-delete-confirm__actions">
      <button class="chat-delete-confirm__cancel" type="button">Cancel</button>
      <button class="chat-delete-confirm__yes" type="button"></button>
    </div>
  `;
  const confirmText = popover.querySelector(".chat-delete-confirm__text");
  const confirmButton = popover.querySelector(".chat-delete-confirm__yes");
  if (confirmText) {
    confirmText.textContent = params.confirmText;
  }
  if (confirmButton) {
    confirmButton.textContent = params.confirmLabel;
  }
  wrap.appendChild(popover);
  placeDeleteConfirmPopover(btn, popover, params.side);

  const cancel = popover.querySelector<HTMLButtonElement>(".chat-delete-confirm__cancel")!;
  const yes = popover.querySelector<HTMLButtonElement>(".chat-delete-confirm__yes")!;
  const check = popover.querySelector<HTMLInputElement>(".chat-delete-confirm__check")!;
  let dismissed = false;
  function dismissPopover(options?: DeleteConfirmDismissOptions) {
    if (dismissed) {
      return;
    }
    dismissed = true;
    document.removeEventListener("click", closeOnOutside, true);
    document.removeEventListener("contextmenu", closeOnContextMenu, true);
    window.removeEventListener("keydown", closeOnEscape, true);
    deleteConfirmDismissers.delete(popover);
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
  deleteConfirmDismissers.set(popover, dismissPopover);
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
  cancel.focus({ preventScroll: true });
  requestAnimationFrame(() => {
    if (!dismissed && popover.isConnected) {
      placeDeleteConfirmPopover(btn, popover, params.side);
      document.addEventListener("click", closeOnOutside, true);
    }
  });
}

function renderConfirmedActionButton(params: ConfirmedActionParams) {
  return html`
    <span class="chat-delete-wrap ${params.wrapClass ?? ""}">
      <openclaw-tooltip .content=${params.tooltip}>
        <button
          class=${params.buttonClass ?? ""}
          aria-label=${params.ariaLabel}
          ?disabled=${params.disabled}
          @click=${(event: Event) =>
            openConfirmedActionPopover(event.currentTarget as HTMLElement, params)}
        >
          ${params.icon}
        </button>
      </openclaw-tooltip>
    </span>
  `;
}
