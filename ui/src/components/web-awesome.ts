// Shared dropdown registration and behavior. Other Web Awesome components use
// surface-specific registrars so route-only controls stay out of startup.
import "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";

const keyboardDismissedDropdowns = new WeakSet<EventTarget>();

/** Transient menus use hidden triggers. Keep Escape intent on the host so Lit
 * re-renders cannot lose it before Web Awesome finishes hiding the popup. */
export function trackDropdownKeyboardDismissal(
  event: KeyboardEvent,
  focusDurableTrigger?: () => void,
) {
  // Web Awesome hides on Tab without restoring its trigger. Transient menus
  // use a hidden trigger, so move focus first and let native Tab continue.
  if (event.key === "Tab") {
    focusDurableTrigger?.();
    return;
  }
  if (event.key === "Escape" && event.currentTarget) {
    keyboardDismissedDropdowns.add(event.currentTarget);
  }
}

export function consumeDropdownKeyboardDismissal(event: Event): boolean {
  const dropdown = event.currentTarget;
  if (!dropdown || !keyboardDismissedDropdowns.has(dropdown)) {
    return false;
  }
  keyboardDismissedDropdowns.delete(dropdown);
  return true;
}

/** Web Awesome exposes checkbox items only. Preserve its roving-focus item
 * while restoring radio semantics for choices where exactly one value wins. */
export function syncDropdownItemRadio(element: Element | undefined, checked: boolean) {
  if (!(element instanceof HTMLElement) || element.localName !== "wa-dropdown-item") {
    return;
  }
  const item = element as HTMLElement & { updateComplete?: Promise<unknown> };
  void Promise.resolve(item.updateComplete).then(() => {
    if (!item.isConnected) {
      return;
    }
    item.setAttribute("role", "menuitemradio");
    item.setAttribute("aria-checked", String(checked));
  });
}

// Web Awesome labels its trigger but leaves the internal menu unnamed. Copy
// the host label, or reference the trigger, when the popup enters the a11y tree.
function labelDropdownMenu(dropdown: HTMLElement) {
  const menu = dropdown.shadowRoot?.querySelector<HTMLElement>('[part="menu"]');
  if (!menu) {
    return;
  }
  const label = dropdown.getAttribute("aria-label");
  if (label) {
    menu.setAttribute("aria-label", label);
    menu.removeAttribute("aria-labelledby");
    return;
  }
  const trigger = dropdown.querySelector<HTMLElement>('[slot="trigger"]');
  const triggerLabel = trigger?.getAttribute("aria-label") ?? trigger?.textContent?.trim();
  if (triggerLabel) {
    menu.setAttribute("aria-label", triggerLabel);
    menu.removeAttribute("aria-labelledby");
  }
}

function labelDropdownSubmenu(item: HTMLElement) {
  const submenu = item.shadowRoot?.querySelector<HTMLElement>('[part="submenu"]');
  if (!submenu) {
    return;
  }
  const labelSlot = item.shadowRoot?.querySelector<HTMLSlotElement>("slot:not([name])");
  const slottedLabel = labelSlot
    ?.assignedNodes({ flatten: true })
    .map((node) => node.textContent)
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
  const label = item.getAttribute("aria-label") ?? slottedLabel;
  if (label) {
    submenu.setAttribute("aria-label", label);
    submenu.removeAttribute("aria-labelledby");
  }
}

function labelDropdownSubmenus(dropdown: HTMLElement) {
  dropdown.querySelectorAll<HTMLElement>("wa-dropdown-item").forEach(labelDropdownSubmenu);
}

function labelOpeningSubmenu(event: CustomEvent<{ item?: unknown }>) {
  const item = event.detail?.item;
  if (!(item instanceof HTMLElement) || item.localName !== "wa-dropdown-item") {
    return;
  }
  const updateComplete = "updateComplete" in item ? item.updateComplete : undefined;
  void Promise.resolve(updateComplete).then(() => {
    if (item.isConnected) {
      labelDropdownSubmenu(item);
    }
  });
}

const dropdownLabelObservers = new WeakMap<HTMLElement, MutationObserver>();

function startDropdownLabelSync(event: Event) {
  // Document listeners otherwise see the containing component's shadow host.
  const dropdown = event.composedPath()[0];
  if (!(dropdown instanceof HTMLElement) || dropdown.localName !== "wa-dropdown") {
    return;
  }
  // Reopening must restore the menu before Web Awesome moves focus into it.
  dropdown.shadowRoot?.querySelector<HTMLElement>('[part="menu"]')?.removeAttribute("inert");
  labelDropdownMenu(dropdown);
  labelDropdownSubmenus(dropdown);
  dropdownLabelObservers.get(dropdown)?.disconnect();
  if (typeof MutationObserver === "undefined") {
    return;
  }
  const observer = new MutationObserver(() => {
    labelDropdownMenu(dropdown);
    labelDropdownSubmenus(dropdown);
  });
  // Open menus can survive an in-place locale render. Watch only their light
  // DOM so translated labels stay current without observing the whole app.
  observer.observe(dropdown, {
    attributes: true,
    attributeFilter: ["aria-label"],
    childList: true,
    characterData: true,
    subtree: true,
  });
  dropdownLabelObservers.set(dropdown, observer);
}

function disableClosingDropdownMenu(event: Event) {
  const dropdown = event.composedPath()[0];
  if (!(dropdown instanceof HTMLElement) || dropdown.localName !== "wa-dropdown") {
    return;
  }
  // Later document listeners may still cancel the hide. Its final outcome is
  // known in the next microtask, before a native Tab can enter the fading menu.
  queueMicrotask(() => {
    if (
      event.defaultPrevented ||
      !dropdown.isConnected ||
      (dropdown as HTMLElement & { open?: boolean }).open
    ) {
      return;
    }
    dropdown.shadowRoot?.querySelector<HTMLElement>('[part="menu"]')?.setAttribute("inert", "");
  });
}

function stopDropdownLabelSync(event: Event) {
  const dropdown = event.composedPath()[0];
  if (!(dropdown instanceof HTMLElement) || dropdown.localName !== "wa-dropdown") {
    return;
  }
  dropdownLabelObservers.get(dropdown)?.disconnect();
  dropdownLabelObservers.delete(dropdown);
}

if (typeof document !== "undefined") {
  document.addEventListener("wa-show", startDropdownLabelSync);
  document.addEventListener(
    "submenu-opening",
    (event) => {
      if (event instanceof CustomEvent) {
        labelOpeningSubmenu(event);
      }
    },
    true,
  );
  document.addEventListener("wa-hide", disableClosingDropdownMenu);
  document.addEventListener("wa-after-hide", stopDropdownLabelSync);
}
