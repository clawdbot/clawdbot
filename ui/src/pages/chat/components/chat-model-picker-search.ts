import { generateUUID } from "../../../lib/uuid.ts";

export function pickerMenu(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element
    ? target.closest<HTMLElement>(".chat-controls__model-menu")
    : null;
}

function visibleModelRows(root: HTMLElement): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]")]
    .filter((row) => !row.hidden)
    .toSorted(
      (left, right) =>
        Number(left.dataset.chatModelRank ?? left.dataset.chatModelIndex ?? 0) -
        Number(right.dataset.chatModelRank ?? right.dataset.chatModelIndex ?? 0),
    );
}

function selectableModelRows(root: HTMLElement): HTMLButtonElement[] {
  return visibleModelRows(root).filter((row) => !row.disabled);
}

function ensureModelPickerIds(menu: HTMLElement): void {
  const details = menu.closest<HTMLDetailsElement>(".chat-controls__model-picker");
  const input = menu.querySelector<HTMLInputElement>("[data-chat-model-search]");
  const listboxes = [...menu.querySelectorAll<HTMLElement>("[data-chat-model-list]")];
  if (!details || !input || listboxes.length === 0) {
    return;
  }
  const prefix = details.dataset.chatModelPickerId ?? `chat-model-picker-${generateUUID()}`;
  details.dataset.chatModelPickerId = prefix;
  listboxes.forEach((listbox, index) => {
    listbox.id = `${prefix}-listbox-${index}`;
  });
  menu.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]").forEach((row, index) => {
    row.id = `${prefix}-option-${index}`;
  });
  input.setAttribute("aria-controls", listboxes.map((listbox) => listbox.id).join(" "));
  input.setAttribute("aria-expanded", details.open ? "true" : "false");
}

export function highlightModelRow(menu: HTMLElement, row: HTMLButtonElement | undefined): void {
  menu.querySelectorAll<HTMLElement>("[data-chat-model-option]").forEach((candidate) => {
    candidate.toggleAttribute("data-chat-model-highlighted", candidate === row);
  });
  const input = menu.querySelector<HTMLInputElement>("[data-chat-model-search]");
  if (row?.id) {
    input?.setAttribute("aria-activedescendant", row.id);
  } else {
    input?.removeAttribute("aria-activedescendant");
  }
}

// Numbers follow the filtered order because digit selection reads that same row list.
// Search inputs and nested dropdowns own digits instead. The :focus-within rule
// in styles/chat/composer.css hides these keycaps while the search input has focus.
function updateModelShortcuts(menu: HTMLElement, rows: readonly HTMLButtonElement[]): void {
  menu.querySelectorAll<HTMLElement>("[data-chat-model-shortcut]").forEach((shortcut) => {
    shortcut.hidden = true;
    shortcut.removeAttribute("data-shortcut");
    shortcut.removeAttribute("data-chat-model-shortcut-number");
  });
  rows.slice(0, 9).forEach((row, index) => {
    const shortcut = row.querySelector<HTMLElement>("[data-chat-model-shortcut]");
    if (!shortcut) {
      return;
    }
    shortcut.hidden = false;
    shortcut.setAttribute("data-shortcut", String(index + 1));
    shortcut.setAttribute("data-chat-model-shortcut-number", String(index + 1));
  });
}

function modelMatchRank(row: HTMLButtonElement, query: string): number | null {
  const model = row.dataset.chatModelName ?? "";
  const keywords = row.dataset.chatModelKeywords ?? "";
  const provider = row.dataset.chatModelProviderLabel ?? "";
  if (model.startsWith(query)) {
    return 0;
  }
  if (model.includes(query)) {
    return 1;
  }
  if (keywords.includes(query)) {
    return 2;
  }
  if (provider.startsWith(query)) {
    return 3;
  }
  return provider.includes(query) ? 4 : null;
}

export function updateModelSearch(input: HTMLInputElement, preserveHighlight = false): void {
  const menu = pickerMenu(input);
  if (!menu) {
    return;
  }
  ensureModelPickerIds(menu);
  const query = input.value.trim().toLocaleLowerCase();
  menu.toggleAttribute("data-chat-model-filtering", Boolean(query));
  const rows = [...menu.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]")];
  const matches: Array<{ row: HTMLButtonElement; score: number; index: number }> = [];
  rows.forEach((row, index) => {
    const score = query ? modelMatchRank(row, query) : 0;
    row.hidden = score === null;
    row.style.removeProperty("--chat-model-rank");
    delete row.dataset.chatModelRank;
    if (score !== null) {
      matches.push({ row, score, index });
    }
  });
  matches
    .toSorted((left, right) => left.score - right.score || left.index - right.index)
    .forEach(({ row }, rank) => {
      row.dataset.chatModelRank = String(rank);
      row.style.setProperty("--chat-model-rank", String(rank));
    });
  const visibleRows = visibleModelRows(menu);
  const selectableRows = selectableModelRows(menu);
  updateModelShortcuts(menu, selectableRows);
  const selected = selectableRows.find((row) => row.getAttribute("aria-selected") === "true");
  const highlighted = preserveHighlight
    ? selectableRows.find((row) => row.hasAttribute("data-chat-model-highlighted"))
    : undefined;
  highlightModelRow(
    menu,
    highlighted ?? (query ? selectableRows[0] : (selected ?? selectableRows[0])),
  );
  const empty = menu.querySelector<HTMLElement>("[data-chat-model-search-empty]");
  if (empty) {
    empty.hidden = !query || visibleRows.length > 0;
  }
}

export function resetModelSearch(details: HTMLDetailsElement): void {
  const input = details.querySelector<HTMLInputElement>("[data-chat-model-search]");
  if (!input) {
    return;
  }
  input.value = "";
  updateModelSearch(input);
}

export function clearChatModelSearchOnEscape(event: KeyboardEvent): boolean {
  if (event.key !== "Escape") {
    return false;
  }
  const input = event
    .composedPath()
    .find(
      (target): target is HTMLInputElement =>
        target instanceof HTMLInputElement && target.matches("[data-chat-model-search]"),
    );
  if (!input?.value) {
    return false;
  }
  input.value = "";
  updateModelSearch(input);
  event.preventDefault();
  event.stopPropagation();
  return true;
}

export function handleModelSearchKeydown(event: KeyboardEvent): void {
  // SAFETY: Bound only to the model-search input’s keydown event.
  const input = event.currentTarget as HTMLInputElement;
  const menu = pickerMenu(input);
  if (!menu) {
    return;
  }
  const rows = selectableModelRows(menu);
  if (rows.length === 0) {
    return;
  }
  if (event.key === "Enter") {
    const highlighted = rows.find((row) => row.hasAttribute("data-chat-model-highlighted"));
    if (highlighted) {
      event.preventDefault();
      highlighted.click();
    }
    return;
  }
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
    return;
  }
  event.preventDefault();
  const currentIndex = rows.findIndex((row) => row.hasAttribute("data-chat-model-highlighted"));
  const offset = event.key === "ArrowDown" ? 1 : rows.length - 1;
  const nextIndex = currentIndex < 0 ? 0 : (currentIndex + offset) % rows.length;
  highlightModelRow(menu, rows[nextIndex]);
  rows[nextIndex]?.scrollIntoView?.({ block: "nearest" });
}

export function handleModelPickerKeydown(event: KeyboardEvent): void {
  // SAFETY: Bound only to the model picker’s details element.
  const details = event.currentTarget as HTMLDetailsElement;
  if (
    !details.open ||
    event.target instanceof HTMLInputElement ||
    event
      .composedPath()
      .some((target) => target instanceof HTMLElement && target.localName === "wa-dropdown") ||
    !/^[1-9]$/u.test(event.key)
  ) {
    return;
  }
  const row = selectableModelRows(details)[Number(event.key) - 1];
  event.preventDefault();
  row?.click();
}

export function syncChatModelSearch(details: Element | undefined): void {
  if (!(details instanceof HTMLDetailsElement) || !details.open) {
    return;
  }
  // Keyed catalog rows commit after the details binding; project the retained
  // query onto the new DOM without resetting a still-valid keyboard selection.
  queueMicrotask(() => {
    const input = details.querySelector<HTMLInputElement>("[data-chat-model-search]");
    if (input) {
      updateModelSearch(input, true);
    }
  });
}
