import { syncAnchoredOverlay } from "../../../components/anchored-overlay.ts";
import { consumeTooltipEscape } from "../../../components/tooltip.ts";

const MOBILE_COMPOSER_OVERLAY_QUERY =
  "(max-width: 640px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)";

const pointerOpenedDropdowns = new WeakSet<HTMLElement>();
const composerPickerDismissals = new WeakMap<
  Document,
  { owners: Set<symbol>; dispose: () => void }
>();
const POINTER_RESTORED_FOCUS_ATTRIBUTE = "data-chat-pointer-restored-focus";
const POINTER_OPENED_PICKER_ATTRIBUTE = "data-chat-pointer-opened-picker";
const CHAT_COMPOSER_DISMISS_INVOCATIONS_EVENT = "openclaw-composer-dismiss-invocations";

function composerPickerIsOpen(picker: HTMLElement): boolean {
  if (picker instanceof HTMLDetailsElement) {
    return picker.open;
  }
  return ("open" in picker && picker.open === true) || picker.hasAttribute("open");
}

function openChatComposerPickers(root: ParentNode): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      ".agent-chat__input details, .agent-chat__input wa-dropdown",
    ),
  ).filter(composerPickerIsOpen);
}

function closeComposerPicker(picker: HTMLElement): void {
  pointerOpenedDropdowns.delete(picker);
  picker.removeAttribute(POINTER_OPENED_PICKER_ATTRIBUTE);
  if (picker instanceof HTMLDetailsElement) {
    picker.open = false;
  } else {
    if ("open" in picker) {
      picker.open = false;
    }
    picker.removeAttribute("open");
  }
}

function pickerTrigger(picker: HTMLElement): HTMLElement | null {
  return picker instanceof HTMLDetailsElement
    ? picker.querySelector<HTMLElement>("summary")
    : picker.querySelector<HTMLElement>("[slot=trigger]");
}

// Split panes and Home can overlap New Session. Keep one document listener set
// until the last mounted composer releases it.
export function installChatComposerPickerDismissal(ownerDocument: Document): () => void {
  const dismissal = composerPickerDismissals.get(ownerDocument) ?? {
    owners: new Set<symbol>(),
    dispose: connectChatComposerPickerDismissal(ownerDocument),
  };
  composerPickerDismissals.set(ownerDocument, dismissal);
  const owner = Symbol("composer picker");
  dismissal.owners.add(owner);
  return () => {
    if (!dismissal.owners.delete(owner) || dismissal.owners.size > 0) {
      return;
    }
    composerPickerDismissals.delete(ownerDocument);
    dismissal.dispose();
  };
}

function connectChatComposerPickerDismissal(ownerDocument: Document): () => void {
  const controller = new AbortController();
  const options = { capture: true, signal: controller.signal };

  function dismissChatComposerPickersOutside(event: PointerEvent): void {
    const path = event.composedPath();
    for (const picker of openChatComposerPickers(ownerDocument)) {
      if (!path.includes(picker)) {
        closeComposerPicker(picker);
      }
    }
    for (const menu of ownerDocument.querySelectorAll<HTMLElement>(
      ".agent-chat__input > :is(.slash-menu, .skill-menu)",
    )) {
      if (!path.includes(menu)) {
        menu
          .closest(".agent-chat__input")
          ?.dispatchEvent(new CustomEvent(CHAT_COMPOSER_DISMISS_INVOCATIONS_EVENT));
      }
    }
  }

  function dismissChatComposerPickersOnEscape(event: KeyboardEvent): void {
    if (
      event.defaultPrevented ||
      consumeTooltipEscape(event, ownerDocument) ||
      event.key !== "Escape" ||
      ownerDocument.querySelector(".shell-nav[aria-modal='true']")
    ) {
      return;
    }
    const pickers = openChatComposerPickers(ownerDocument);
    const invocationComposer = ownerDocument
      .querySelector<HTMLElement>(".agent-chat__input > :is(.slash-menu, .skill-menu)")
      ?.closest<HTMLElement>(".agent-chat__input");
    if (pickers.length === 0 && !invocationComposer) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const lastPicker = pickers.at(-1);
    pickers.forEach(closeComposerPicker);
    invocationComposer?.dispatchEvent(new CustomEvent(CHAT_COMPOSER_DISMISS_INVOCATIONS_EVENT));
    invocationComposer
      ?.querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox > textarea")
      ?.focus({ preventScroll: true });
    if (lastPicker) {
      pickerTrigger(lastPicker)?.focus({ preventScroll: true });
    }
  }

  ownerDocument.addEventListener("pointerdown", dismissChatComposerPickersOutside, options);
  // Window capture observes the open picker before component Escape handlers
  // mutate details.open and erase the return-focus owner.
  ownerDocument.defaultView?.addEventListener(
    "keydown",
    dismissChatComposerPickersOnEscape,
    options,
  );
  ownerDocument.addEventListener(
    "keydown",
    (event) => {
      const dropdown = event
        .composedPath()
        .find(
          (node): node is HTMLElement =>
            node instanceof HTMLElement && node.localName === "wa-dropdown",
        );
      if (dropdown) {
        pointerOpenedDropdowns.delete(dropdown);
        dropdown.removeAttribute(POINTER_OPENED_PICKER_ATTRIBUTE);
      }
    },
    options,
  );

  return () => controller.abort();
}

function closeOtherChatComposerPickers(source: HTMLElement): void {
  const composer = source.closest(".agent-chat__input");
  if (!composer) {
    return;
  }
  for (const picker of openChatComposerPickers(composer)) {
    if (picker !== source) {
      closeComposerPicker(picker);
    }
  }
}

export function handleChatComposerDetailsToggle(event: Event): void {
  const details = event.currentTarget;
  if (details instanceof HTMLDetailsElement && details.open) {
    closeOtherChatComposerPickers(details);
  }
}

export function handleChatComposerDropdownShow(event: Event): void {
  const dropdown = event.target;
  if (dropdown instanceof HTMLElement && dropdown.localName === "wa-dropdown") {
    if (!pointerOpenedDropdowns.has(dropdown)) {
      dropdown.removeAttribute(POINTER_OPENED_PICKER_ATTRIBUTE);
    }
    closeOtherChatComposerPickers(dropdown);
  }
}

export function markPointerOpenedChatComposerDropdown(event: PointerEvent): void {
  const dropdown = event
    .composedPath()
    .find(
      (node): node is HTMLElement =>
        node instanceof HTMLElement && node.localName === "wa-dropdown",
    );
  if (dropdown) {
    pointerOpenedDropdowns.add(dropdown);
    dropdown.setAttribute(POINTER_OPENED_PICKER_ATTRIBUTE, "");
  }
}

export function restorePointerOpenedChatComposerTrigger(event: Event): void {
  const dropdown =
    event.target instanceof HTMLElement && event.target.localName === "wa-dropdown"
      ? event.target
      : event.currentTarget;
  if (
    dropdown instanceof HTMLElement &&
    dropdown.localName === "wa-dropdown" &&
    pointerOpenedDropdowns.delete(dropdown)
  ) {
    const trigger = pickerTrigger(dropdown);
    if (!trigger) {
      return;
    }
    trigger.setAttribute(POINTER_RESTORED_FOCUS_ATTRIBUTE, "");
    const clearPointerFocus = () => trigger.removeAttribute(POINTER_RESTORED_FOCUS_ATTRIBUTE);
    trigger.addEventListener("blur", clearPointerFocus, { once: true });
    trigger.addEventListener("keydown", clearPointerFocus, { once: true });
    trigger.focus({ preventScroll: true });
  }
}

export function syncChatPickerOverlay(details: HTMLDetailsElement): void {
  // Mobile panels span the composer, so anchor to that stable box; desktop
  // panels stay attached to the individual trigger.
  const composerAnchor =
    typeof window.matchMedia === "function" &&
    window.matchMedia(MOBILE_COMPOSER_OVERLAY_QUERY).matches
      ? (details.closest(".agent-chat__input") ?? undefined)
      : undefined;
  syncAnchoredOverlay(details, "top", { alignment: "end", anchor: composerAnchor });
}
