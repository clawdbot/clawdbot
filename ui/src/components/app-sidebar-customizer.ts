import { html, nothing, type TemplateResult } from "lit";
import {
  navigationIconForRoute,
  parseSidebarEntry,
  serializeSidebarEntry,
  SIDEBAR_NAV_ROUTES,
  titleForRoute,
  type NavigationRouteId,
} from "../app-navigation.ts";
import { t } from "../i18n/index.ts";
import { writeSidebarSectionDragData } from "../lib/sessions/drag.ts";
import type { SidebarVisibleSections } from "./app-sidebar-session-navigation-logic.ts";
import type { SidebarWorkboardBoard } from "./app-sidebar-workboard.ts";
import { icons } from "./icons.ts";

export type SidebarCustomizerItem = {
  id: string;
  label: string;
  icon?: TemplateResult;
  visible: boolean;
  kind: "entry" | "section";
  entry?: string;
  category?: string;
  reorderable?: boolean;
  toggleable?: boolean;
  sessionKey?: string;
};

export type SidebarCustomizerValue = {
  sidebarEntries: readonly string[];
  hiddenCatalogIds: readonly string[];
  groups: readonly string[];
  sectionOrder: readonly string[];
};

function equalStringArrays(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function sidebarCustomizerValuesEqual(
  left: SidebarCustomizerValue,
  right: SidebarCustomizerValue,
): boolean {
  return (
    equalStringArrays(left.sidebarEntries, right.sidebarEntries) &&
    equalStringArrays(left.hiddenCatalogIds, right.hiddenCatalogIds) &&
    equalStringArrays(left.groups, right.groups) &&
    equalStringArrays(left.sectionOrder, right.sectionOrder)
  );
}

export function mergeSidebarCustomizerEntries(
  current: readonly string[],
  snapshot: readonly string[],
  customizable: readonly string[],
): string[] {
  const customizableEntries = new Set(customizable);
  const remaining = [...snapshot];
  const merged = current.flatMap((entry) => {
    if (!customizableEntries.has(entry)) {
      return [entry];
    }
    const replacement = remaining.shift();
    return replacement ? [replacement] : [];
  });
  return [...merged, ...remaining];
}

export function buildSidebarCustomizerEntries(params: {
  canonical: readonly string[];
  enabledRouteIds?: readonly NavigationRouteId[];
  pinnedSessions?: ReadonlyMap<string, { key: string; label: string }>;
  workboards: readonly SidebarWorkboardBoard[];
}): SidebarCustomizerItem[] {
  const order = new Map(params.canonical.map((entry, index) => [entry, index]));
  const items: Array<SidebarCustomizerItem & { fallbackIndex: number }> = [
    {
      id: "fixed:home",
      kind: "entry",
      label: t("nav.home"),
      icon: icons.home,
      visible: true,
      reorderable: false,
      toggleable: false,
      fallbackIndex: -1,
    },
    ...SIDEBAR_NAV_ROUTES.filter(
      (routeId) => params.enabledRouteIds?.includes(routeId) ?? true,
    ).map((routeId, fallbackIndex) => {
      const entry = serializeSidebarEntry({ type: "route", route: routeId });
      return {
        id: entry,
        entry,
        kind: "entry" as const,
        label: titleForRoute(routeId),
        icon: icons[navigationIconForRoute(routeId)],
        visible: params.canonical.includes(entry),
        fallbackIndex,
      };
    }),
  ];
  const boardOffset = items.length;
  for (const [index, board] of params.workboards.entries()) {
    const entry = serializeSidebarEntry({ type: "workboard", boardId: board.id });
    items.push({
      id: entry,
      entry,
      kind: "entry",
      label: board.name?.trim() || board.id,
      icon: icons.layoutGrid,
      visible: params.canonical.includes(entry),
      fallbackIndex: boardOffset + index,
    });
  }
  for (const [index, entry] of params.canonical.entries()) {
    const parsed = parseSidebarEntry(entry);
    if (parsed?.type !== "session") {
      continue;
    }
    const session = params.pinnedSessions?.get(parsed.key);
    if (!session) {
      continue;
    }
    items.push({
      id: entry,
      entry,
      kind: "entry",
      label: session.label.trim() || session.key,
      sessionKey: session.key,
      visible: true,
      fallbackIndex: boardOffset + params.workboards.length + index,
    });
  }
  return items.toSorted((a, b) => {
    if (a.id === "fixed:home" || b.id === "fixed:home") {
      return a.id === "fixed:home" ? -1 : 1;
    }
    const aIndex = order.get(a.entry!);
    const bIndex = order.get(b.entry!);
    if (aIndex !== undefined && bIndex !== undefined) {
      return aIndex - bIndex;
    }
    if (aIndex !== undefined) {
      return -1;
    }
    if (bIndex !== undefined) {
      return 1;
    }
    return a.fallbackIndex - b.fallbackIndex;
  });
}

export function buildSidebarCustomizerSections(params: {
  sections: SidebarVisibleSections["sections"];
  catalogLabels: ReadonlyMap<string, string>;
  hiddenCatalogIds: ReadonlySet<string>;
}): SidebarCustomizerItem[] {
  return params.sections.map((section) => {
    const catalogId = section.id.startsWith("catalog:")
      ? section.id.slice("catalog:".length)
      : null;
    return {
      id: section.id,
      label: catalogId
        ? (params.catalogLabels.get(catalogId) ?? catalogId)
        : section.groups
          ? t("chat.sidebar.groups")
          : section.work
            ? t("chat.sidebar.coding")
            : section.category
              ? section.category
              : t("chat.sidebar.threads"),
      kind: "section",
      category: section.category,
      visible: catalogId ? !params.hiddenCatalogIds.has(catalogId) : true,
      reorderable: true,
      toggleable: catalogId !== null,
    };
  });
}

type SidebarCustomizerParams = {
  entries: readonly SidebarCustomizerItem[];
  sections: readonly SidebarCustomizerItem[];
  dirty: boolean;
  error: string | null;
  onToggle: (item: SidebarCustomizerItem) => void;
  onRemove: (item: SidebarCustomizerItem) => void;
  onDone: () => void;
  onBack: () => void;
  onEntryDragStart: (event: DragEvent, item: SidebarCustomizerItem) => void;
  onEntryDragOver: (event: DragEvent, entry: string) => void;
  onEntryDragLeave: (event: DragEvent) => void;
  onEntryDrop: (event: DragEvent, entry: string) => void;
  onSectionDragStart: (sectionId: string) => void;
  onSectionDragOver: (event: DragEvent, sectionId: string, category?: string) => void;
  onSectionDragLeave: (event: DragEvent, sectionId: string, category?: string) => void;
  onSectionDrop: (event: DragEvent, sectionId: string, category?: string) => void;
  onDragEnd: (kind: SidebarCustomizerItem["kind"]) => void;
};

function renderCustomizerItem(
  item: SidebarCustomizerItem,
  params: SidebarCustomizerParams,
  index: number,
) {
  const toggleable = item.toggleable !== false;
  const draggable =
    item.reorderable !== false && (item.kind === "section" || (toggleable && item.visible));
  const showVisibilityControl = toggleable;
  const removable = item.sessionKey !== undefined;
  const visibilityLabel = t(item.visible ? "nav.customizeHide" : "nav.customizeShow", {
    item: item.label,
  });
  return html`
    <div
      class="sidebar-customizer__row ${item.visible
        ? ""
        : "sidebar-customizer__row--hidden"} ${!draggable
        ? "sidebar-customizer__row--fixed"
        : ""} ${!toggleable && item.kind === "entry"
        ? "sidebar-customizer__row--disabled"
        : ""} ${item.kind === "section" ? "sidebar-customizer__row--section" : ""}"
      data-iconless=${item.icon || item.kind === "section" ? "false" : "true"}
      role="listitem"
      draggable=${draggable ? "true" : "false"}
      style=${`--sidebar-customizer-index: ${index}`}
      data-sidebar-customizer-id=${item.id}
      data-session-section=${item.kind === "section" ? item.id : ""}
      @dragstart=${(event: DragEvent) => {
        if (!draggable || !event.dataTransfer) {
          event.preventDefault();
          return;
        }
        if (item.kind === "section") {
          writeSidebarSectionDragData(event.dataTransfer, item.id);
          params.onSectionDragStart(item.id);
          return;
        }
        params.onEntryDragStart(event, item);
      }}
      @dragover=${(event: DragEvent) => {
        if (item.kind === "section" && item.reorderable !== false) {
          params.onSectionDragOver(event, item.id, item.category);
        } else if (item.entry) {
          params.onEntryDragOver(event, item.entry);
        }
      }}
      @dragleave=${(event: DragEvent) => {
        if (item.kind === "section" && item.reorderable !== false) {
          params.onSectionDragLeave(event, item.id, item.category);
        } else {
          params.onEntryDragLeave(event);
        }
      }}
      @drop=${(event: DragEvent) => {
        if (item.kind === "section" && item.reorderable !== false) {
          params.onSectionDrop(event, item.id, item.category);
        } else if (item.entry) {
          params.onEntryDrop(event, item.entry);
        }
      }}
      @dragend=${() => params.onDragEnd(item.kind)}
    >
      ${draggable
        ? html`<span class="sidebar-customizer__grip" aria-hidden="true"
            >${icons.gripVertical}</span
          >`
        : nothing}
      ${item.icon
        ? html`<span class="sidebar-customizer__item-icon" aria-hidden="true">${item.icon}</span>`
        : nothing}
      <span
        class="sidebar-customizer__label ${item.kind === "section"
          ? "sidebar-customizer__label--section"
          : ""}"
        >${item.label}</span
      >
      ${removable
        ? html`<button
            type="button"
            class="sidebar-customizer__visibility sidebar-customizer__remove"
            aria-label=${t("nav.customizeRemove", { item: item.label })}
            @mousedown=${(event: MouseEvent) => event.stopPropagation()}
            @click=${() => params.onRemove(item)}
          >
            ${icons.x}
          </button>`
        : showVisibilityControl
          ? html`<button
              type="button"
              class="sidebar-customizer__visibility"
              aria-label=${visibilityLabel}
              aria-pressed=${String(item.visible)}
              ?disabled=${!toggleable}
              title=${toggleable ? visibilityLabel : ""}
              @mousedown=${(event: MouseEvent) => event.stopPropagation()}
              @click=${() => {
                if (toggleable) {
                  params.onToggle(item);
                }
              }}
            >
              ${item.visible ? icons.eye : icons.eyeOff}
            </button>`
          : nothing}
    </div>
  `;
}

export function renderSidebarCustomizer(params: SidebarCustomizerParams) {
  return html`
    <section
      class="sidebar-customizer"
      aria-label=${t("nav.customize")}
      @keydown=${(event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.preventDefault();
          params.onBack();
        }
      }}
    >
      <div class="sidebar-customizer__scroll">
        <div class="sidebar-customizer__list" role="list">
          ${params.entries.map((item, index) => renderCustomizerItem(item, params, index))}
        </div>
        <div class="sidebar-customizer__separator" role="separator"></div>
        <div class="sidebar-customizer__list" role="list">
          ${params.sections.map((item, index) =>
            renderCustomizerItem(item, params, params.entries.length + index),
          )}
        </div>
      </div>
      ${params.error
        ? html`<div class="sidebar-customizer__error" role="alert">${params.error}</div>`
        : nothing}
      <div class="sidebar-customizer__footer">
        <button type="button" class="btn primary sidebar-customizer__done" @click=${params.onDone}>
          ${t("nav.customizeDone")}
        </button>
        <button type="button" class="btn sidebar-customizer__back" @click=${params.onBack}>
          ${params.dirty ? t("nav.customizeDiscard") : t("common.back")}
        </button>
      </div>
    </section>
  `;
}
