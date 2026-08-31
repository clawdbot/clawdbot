export type WebAwesomeSelectEvent = CustomEvent<{
  item: HTMLElement & { checked?: boolean; value?: string };
}>;

export function focusSelectedManualProvider(event: Event): void {
  const dropdown = event.currentTarget as HTMLElement;
  const options = Array.from(
    dropdown.querySelectorAll<HTMLElement & { active: boolean }>(
      "wa-dropdown-item[data-manual-provider]:not([disabled])",
    ),
  );
  const selected = options.find((option) => option.hasAttribute("data-selected")) ?? options[0];
  if (!selected) {
    return;
  }
  for (const option of options) {
    option.active = option === selected;
  }
  selected.focus({ preventScroll: true });
  selected.scrollIntoView?.({ block: "nearest" });
}

export function handleManualProviderKeydown(event: KeyboardEvent): void {
  const dropdown = event.currentTarget as HTMLElement & { open: boolean };
  if (!dropdown.open) {
    return;
  }
  if (event.key === "Tab") {
    event.preventDefault();
    event.stopPropagation();
    const focusTarget = event.shiftKey
      ? dropdown.querySelector<HTMLElement>('[slot="trigger"]')
      : dropdown
          .closest(".model-setup__manual")
          ?.querySelector<HTMLElement>('input[type="password"]');
    dropdown.addEventListener("wa-after-hide", () => focusTarget?.focus({ preventScroll: true }), {
      once: true,
    });
    dropdown.open = false;
    return;
  }
  if (event.key !== "Escape") {
    return;
  }
  // The settings-level Escape shortcut runs before Web Awesome's document
  // listener. Claim the event here and restore the durable trigger after hide.
  event.preventDefault();
  dropdown.addEventListener(
    "wa-after-hide",
    () => dropdown.querySelector<HTMLElement>('[slot="trigger"]')?.focus({ preventScroll: true }),
    { once: true },
  );
}

export function handleManualProviderSelect(
  event: WebAwesomeSelectEvent,
  currentProviderId: string,
  onChange: (providerId: string) => void,
): void {
  const item = event.detail.item;
  const dropdown = event.currentTarget as HTMLElement & { open: boolean };
  const value = item.value ?? item.getAttribute("value");
  if (!value) {
    return;
  }
  if (value !== currentProviderId) {
    dropdown.addEventListener(
      "wa-after-hide",
      () => dropdown.querySelector<HTMLElement>('[slot="trigger"]')?.focus({ preventScroll: true }),
      { once: true },
    );
    onChange(value);
    return;
  }
  event.preventDefault();
  item.checked = true;
  dropdown.querySelector<HTMLElement>('[slot="trigger"]')?.focus({ preventScroll: true });
  dropdown.open = false;
}
