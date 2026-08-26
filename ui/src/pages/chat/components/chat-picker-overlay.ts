import { syncAnchoredOverlay } from "../../../components/anchored-overlay.ts";

const MOBILE_COMPOSER_OVERLAY_QUERY =
  "(max-width: 640px), (max-width: 932px) and (max-height: 500px) and (orientation: landscape)";

const pointerOpenedDropdowns = new WeakSet<HTMLElement>();
const POINTER_RESTORED_FOCUS_ATTRIBUTE = "data-chat-pointer-restored-focus";
const POINTER_OPENED_PICKER_ATTRIBUTE = "data-chat-pointer-opened-picker";
const CHAT_COMPOSER_DISMISS_INVOCATIONS_EVENT = "openclaw-composer-dismiss-invocations";

let composerPickerDismissalInstalled = false;

function composerPickerIsOpen(picker: HTMLElement): boolean {
  if (picker instanceof HTMLDetailsElement) {
    return picker.open;
  }
  return ("open" in picker && picker.open === true) || picker.hasAttribute("open");
}

function openChatComposerPickers(root: ParentNode = document): HTMLElement[] {
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

function restoreEscapeFocus(picker: HTMLElement): void {
  const trigger = pickerTrigger(picker);
  if (!trigger || getComputedStyle(trigger).display !== "none") {
    trigger?.focus({ preventScroll: true });
    return;
  }
  const focusScope = picker.closest("openclaw-chat-pane") ?? picker.closest("openclaw-app");
  // Closing can replace the composer subtree; resolve the visible trigger only
  // after the retained pane has rendered the replacement controls.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      const target = (focusScope ?? document).querySelector<HTMLElement>(
        ".chat-controls__model-settings .chat-controls__model-picker > summary",
      );
      target?.focus({ preventScroll: true });
    }),
  );
}

function dismissChatComposerPickersOutside(event: PointerEvent): void {
  const path = event.composedPath();
  for (const picker of openChatComposerPickers()) {
    if (!path.includes(picker)) {
      closeComposerPicker(picker);
    }
  }
  for (const menu of document.querySelectorAll<HTMLElement>(
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
  if (event.key !== "Escape") {
    return;
  }
  const pickers = openChatComposerPickers();
  const invocationComposer = document
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
    restoreEscapeFocus(lastPicker);
  }
}

export function ensureChatComposerPickerDismissal(): void {
  if (composerPickerDismissalInstalled || typeof document === "undefined") {
    return;
  }
  composerPickerDismissalInstalled = true;
  document.addEventListener("pointerdown", dismissChatComposerPickersOutside, true);
  // Window capture observes the open picker before component Escape handlers
  // mutate details.open and erase the return-focus owner.
  window.addEventListener("keydown", dismissChatComposerPickersOnEscape, true);
  document.addEventListener(
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
    true,
  );
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
    ensureChatComposerPickerDismissal();
    closeOtherChatComposerPickers(details);
  }
}

export function handleChatComposerDropdownShow(event: Event): void {
  const dropdown = event.target;
  if (dropdown instanceof HTMLElement && dropdown.localName === "wa-dropdown") {
    if (!pointerOpenedDropdowns.has(dropdown)) {
      dropdown.removeAttribute(POINTER_OPENED_PICKER_ATTRIBUTE);
    }
    ensureChatComposerPickerDismissal();
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
