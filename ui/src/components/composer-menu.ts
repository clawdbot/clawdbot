import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";

export function handleComposerMenuKeydown(
  event: KeyboardEvent,
  menu: {
    count: number;
    index: number;
    consumeEmpty: boolean;
    close: () => void;
    move: (index: number) => string | null;
    select: (key: "Enter" | "Tab") => void;
  },
): boolean {
  if (event.key === "Escape") {
    event.preventDefault();
    menu.close();
    return true;
  }
  if (
    !["ArrowDown", "ArrowUp", "Enter", "Tab"].includes(event.key) ||
    (menu.count === 0 && !menu.consumeEmpty)
  ) {
    return false;
  }
  event.preventDefault();
  if (menu.count > 0) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const offset = event.key === "ArrowDown" ? 1 : menu.count - 1;
      scrollActiveOptionIntoView(menu.move((menu.index + offset) % menu.count));
    } else if (event.key === "Enter" || event.key === "Tab") {
      menu.select(event.key);
    }
  }
  return true;
}

export function renderComposerMenu(options: {
  id: string;
  label: string;
  className?: string;
  trackScroll?: boolean;
  content: unknown;
}) {
  return html`<div
    id=${options.id}
    class="slash-menu ${options.className ?? ""}"
    role="listbox"
    aria-label=${options.label}
  >
    <div
      class="slash-menu__scroll"
      ${ref(syncMenuScroll)}
      @scroll=${
        options.trackScroll === false
          ? nothing
          : (event: Event) =>
              syncMenuScroll(
                event.currentTarget instanceof Element ? event.currentTarget : undefined,
              )
      }
    >
      ${options.content}
    </div>
  </div>`;
}

export function renderComposerMenuOption(options: {
  id: string;
  active: boolean;
  select: () => void;
  hover: () => void;
  preserveFocus?: boolean;
  icon: unknown;
  iconHidden?: boolean;
  name: unknown;
  description: unknown;
}) {
  return html`<div
    id=${options.id}
    class="slash-menu-item ${options.active ? "slash-menu-item--active" : ""}"
    role="option"
    aria-selected=${options.active}
    @mousedown=${options.preserveFocus === false ? nothing : (event: MouseEvent) => event.preventDefault()}
    @click=${options.select}
    @mouseenter=${options.hover}
  >
    <span class="slash-menu-icon" aria-hidden=${options.iconHidden ? "true" : nothing}
      >${options.icon}</span
    >
    <span class="slash-menu-copy">
      <span class="slash-menu-name">${options.name}</span>
      <span class="slash-menu-desc">${options.description}</span>
    </span>
  </div>`;
}

function scrollActiveOptionIntoView(activeId: string | null): void {
  if (!activeId) {
    return;
  }
  requestAnimationFrame(() => {
    const activeOption = document.getElementById(activeId);
    const scrollRegion = activeOption?.closest<HTMLElement>(".slash-menu__scroll");
    if (!activeOption || !scrollRegion) {
      return;
    }
    const menuBounds = scrollRegion.getBoundingClientRect();
    const optionBounds = activeOption.getBoundingClientRect();
    // scrollIntoView also moves the short-landscape composer and page.
    if (optionBounds.top < menuBounds.top) {
      scrollRegion.scrollTop -= menuBounds.top - optionBounds.top;
    } else if (optionBounds.bottom > menuBounds.bottom) {
      scrollRegion.scrollTop += optionBounds.bottom - menuBounds.bottom;
    }
  });
}

function syncMenuScroll(element: Element | undefined): void {
  if (!(element instanceof HTMLElement)) {
    return;
  }
  const sync = () => {
    const scrollable = element.scrollHeight > element.clientHeight + 1;
    element.dataset.scrollable = String(scrollable);
    element.dataset.atStart = String(!scrollable || element.scrollTop <= 1);
    element.dataset.atEnd = String(
      !scrollable || element.scrollTop + element.clientHeight >= element.scrollHeight - 1,
    );
  };
  sync();
  requestAnimationFrame(sync);
}
