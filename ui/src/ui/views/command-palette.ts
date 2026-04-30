import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { t } from "../../i18n/index.ts";
import { SLASH_COMMANDS } from "../chat/slash-commands.ts";
import { icons, type IconName } from "../icons.ts";
import { normalizeLowercaseStringOrEmpty } from "../string-coerce.ts";

type PaletteItem = {
  id: string;
  label: string;
  icon: IconName;
  category: "search" | "navigation" | "skills";
  action: string;
  description?: string;
};

function buildSlashPaletteItems(): PaletteItem[] {
  return SLASH_COMMANDS.map((command) => ({
    id: `slash:${command.name}`,
    label: `/${command.name}`,
    icon: command.icon ?? "terminal",
    category: "search",
    action: `/${command.name}`,
    description: command.description,
  }));
}

function getPaletteBaseItems(): PaletteItem[] {
  return [
    {
      id: "nav-overview",
      label: t("overview.palette.items.overview"),
      icon: "barChart",
      category: "navigation",
      action: "nav:overview",
    },
    {
      id: "nav-sessions",
      label: t("overview.palette.items.sessions"),
      icon: "fileText",
      category: "navigation",
      action: "nav:sessions",
    },
    {
      id: "nav-cron",
      label: t("overview.palette.items.scheduled"),
      icon: "scrollText",
      category: "navigation",
      action: "nav:cron",
    },
    {
      id: "nav-skills",
      label: t("overview.palette.items.skills"),
      icon: "zap",
      category: "navigation",
      action: "nav:skills",
    },
    {
      id: "nav-config",
      label: t("overview.palette.items.settings"),
      icon: "settings",
      category: "navigation",
      action: "nav:config",
    },
    {
      id: "nav-agents",
      label: t("overview.palette.items.agents"),
      icon: "folder",
      category: "navigation",
      action: "nav:agents",
    },
    {
      id: "skill-shell",
      label: t("overview.palette.items.shellCommand"),
      icon: "monitor",
      category: "skills",
      action: "/skill shell",
      description: t("overview.palette.descriptions.shellCommand"),
    },
    {
      id: "skill-debug",
      label: t("overview.palette.items.debugMode"),
      icon: "bug",
      category: "skills",
      action: "/verbose full",
      description: t("overview.palette.descriptions.debugMode"),
    },
  ];
}

function getPaletteItemsInternal(): PaletteItem[] {
  return [...buildSlashPaletteItems(), ...getPaletteBaseItems()];
}

export function getPaletteItems(): readonly PaletteItem[] {
  return getPaletteItemsInternal();
}

export type CommandPaletteProps = {
  open: boolean;
  query: string;
  activeIndex: number;
  onToggle: () => void;
  onQueryChange: (query: string) => void;
  onActiveIndexChange: (index: number) => void;
  onNavigate: (tab: string) => void;
  onSlashCommand: (command: string) => void;
};

function filteredItems(query: string): PaletteItem[] {
  const items = getPaletteItemsInternal();
  if (!query) {
    return items;
  }
  const q = normalizeLowercaseStringOrEmpty(query);
  return items.filter(
    (item) =>
      normalizeLowercaseStringOrEmpty(item.label).includes(q) ||
      normalizeLowercaseStringOrEmpty(item.description).includes(q),
  );
}

export function getFilteredPaletteItems(query: string): readonly PaletteItem[] {
  return filteredItems(query);
}

function groupItems(items: PaletteItem[]): Array<[string, PaletteItem[]]> {
  const map = new Map<string, PaletteItem[]>();
  for (const item of items) {
    const group = map.get(item.category) ?? [];
    group.push(item);
    map.set(item.category, group);
  }
  return [...map.entries()];
}

let previouslyFocused: Element | null = null;
let activeDialog: HTMLDialogElement | null = null;

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "summary",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

const paletteDialogLabelId = "cmd-palette-label";
const paletteInputId = "cmd-palette-input";
const paletteListboxId = "cmd-palette-listbox";

function saveFocus() {
  if (previouslyFocused) {
    return;
  }
  previouslyFocused = document.activeElement;
}

function restoreFocus() {
  const target = previouslyFocused;
  previouslyFocused = null;
  activeDialog = null;
  if (target instanceof HTMLElement && target.isConnected) {
    requestAnimationFrame(() => {
      if (target.isConnected) {
        target.focus();
      }
    });
  }
}

function selectItem(item: PaletteItem, props: CommandPaletteProps) {
  if (item.action.startsWith("nav:")) {
    props.onNavigate(item.action.slice(4));
  } else {
    props.onSlashCommand(item.action);
  }
  props.onToggle();
  restoreFocus();
}

function closePalette(props: CommandPaletteProps) {
  if (!activeDialog) {
    return;
  }
  props.onToggle();
  restoreFocus();
}

function scrollActiveIntoView() {
  requestAnimationFrame(() => {
    const el = document.querySelector(".cmd-palette__item--active");
    el?.scrollIntoView({ block: "nearest" });
  });
}

function trapFocus(event: KeyboardEvent, root: HTMLElement) {
  const focusable = [...root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
    (element) => element.isConnected && element.tabIndex >= 0 && !element.closest("[hidden]"),
  );
  if (focusable.length === 0) {
    event.preventDefault();
    root.focus();
    return;
  }

  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const focusInside = active ? focusable.includes(active) : false;

  if (event.shiftKey && (!focusInside || active === first)) {
    event.preventDefault();
    last.focus();
    return;
  }
  if (!event.shiftKey && (!focusInside || active === last)) {
    event.preventDefault();
    first.focus();
  }
}

function handleKeydown(e: KeyboardEvent, props: CommandPaletteProps) {
  if (e.key === "Tab") {
    const dialog = (e.currentTarget as HTMLElement | null)?.closest("dialog");
    if (dialog instanceof HTMLElement) {
      trapFocus(e, dialog);
    }
    return;
  }

  const items = filteredItems(props.query);
  if (items.length === 0 && (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter")) {
    return;
  }
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      props.onActiveIndexChange((props.activeIndex + 1) % items.length);
      scrollActiveIntoView();
      break;
    case "ArrowUp":
      e.preventDefault();
      props.onActiveIndexChange((props.activeIndex - 1 + items.length) % items.length);
      scrollActiveIntoView();
      break;
    case "Enter":
      e.preventDefault();
      if (items[props.activeIndex]) {
        selectItem(items[props.activeIndex], props);
      }
      break;
    case "Escape":
      e.preventDefault();
      e.stopPropagation();
      closePalette(props);
      break;
  }
}

function getCategoryLabel(category: string): string {
  switch (category) {
    case "search":
      return t("overview.palette.categories.search");
    case "navigation":
      return t("overview.palette.categories.navigation");
    case "skills":
      return t("overview.palette.categories.skills");
    default:
      return category;
  }
}

function getOptionId(item: PaletteItem): string {
  return `cmd-palette-option-${item.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function syncDialog(el: Element | undefined) {
  if (!(el instanceof HTMLDialogElement)) {
    if (activeDialog) {
      restoreFocus();
    }
    return;
  }
  if (activeDialog !== el) {
    saveFocus();
    activeDialog = el;
  }
  if (el.open) {
    return;
  }
  if (typeof el.showModal === "function") {
    try {
      el.removeAttribute("aria-modal");
      el.showModal();
      return;
    } catch {
      // Fall through to the open attribute fallback below.
    }
  }
  el.setAttribute("aria-modal", "true");
  el.setAttribute("open", "");
}

function focusInput(el: Element | undefined) {
  if (el instanceof HTMLInputElement) {
    requestAnimationFrame(() => {
      if (el.isConnected) {
        el.focus();
      }
    });
  }
}

export function renderCommandPalette(props: CommandPaletteProps) {
  if (!props.open) {
    return nothing;
  }

  const items = filteredItems(props.query);
  const grouped = groupItems(items);
  const activeItem = items[props.activeIndex];
  const activeOptionId = activeItem ? getOptionId(activeItem) : nothing;
  const paletteLabel = t("overview.palette.placeholder");

  return html`
    <dialog
      ${ref(syncDialog)}
      class="cmd-palette-overlay"
      aria-labelledby=${paletteDialogLabelId}
      @cancel=${(e: Event) => {
        e.preventDefault();
        closePalette(props);
      }}
      @click=${(e: Event) => {
        if (e.target === e.currentTarget) {
          closePalette(props);
        }
      }}
    >
      <div
        class="cmd-palette"
        @click=${(e: Event) => e.stopPropagation()}
        @keydown=${(e: KeyboardEvent) => handleKeydown(e, props)}
      >
        <label id=${paletteDialogLabelId} class="cmd-palette__label" for=${paletteInputId}
          >${paletteLabel}</label
        >
        <input
          ${ref(focusInput)}
          id=${paletteInputId}
          class="cmd-palette__input"
          role="combobox"
          aria-autocomplete="list"
          aria-controls=${paletteListboxId}
          aria-activedescendant=${activeOptionId}
          aria-expanded="true"
          placeholder=${paletteLabel}
          .value=${props.query}
          @input=${(e: Event) => {
            props.onQueryChange((e.target as HTMLInputElement).value);
            props.onActiveIndexChange(0);
          }}
        />
        <div id=${paletteListboxId} class="cmd-palette__results" role="listbox">
          ${grouped.length === 0
            ? html`<div class="cmd-palette__empty">
                <span class="nav-item__icon" style="opacity:0.3;width:20px;height:20px"
                  >${icons.search}</span
                >
                <span>${t("overview.palette.noResults")}</span>
              </div>`
            : grouped.map(
                ([category, groupedItems]) => html`
                  <div class="cmd-palette__group-label">${getCategoryLabel(category)}</div>
                  ${groupedItems.map((item) => {
                    const globalIndex = items.indexOf(item);
                    const isActive = globalIndex === props.activeIndex;
                    return html`
                      <div
                        id=${getOptionId(item)}
                        class="cmd-palette__item ${isActive ? "cmd-palette__item--active" : ""}"
                        role="option"
                        aria-selected=${isActive ? "true" : "false"}
                        @click=${(e: Event) => {
                          e.stopPropagation();
                          selectItem(item, props);
                        }}
                        @mouseenter=${() => props.onActiveIndexChange(globalIndex)}
                      >
                        <span class="nav-item__icon">${icons[item.icon]}</span>
                        <span>${item.label}</span>
                        ${item.description
                          ? html`<span class="cmd-palette__item-desc muted"
                              >${item.description}</span
                            >`
                          : nothing}
                      </div>
                    `;
                  })}
                `,
              )}
        </div>
        <div class="cmd-palette__footer">
          <span><kbd>↑↓</kbd> ${t("overview.palette.footer.navigate")}</span>
          <span><kbd>↵</kbd> ${t("overview.palette.footer.select")}</span>
          <span><kbd>esc</kbd> ${t("overview.palette.footer.close")}</span>
        </div>
      </div>
    </dialog>
  `;
}
