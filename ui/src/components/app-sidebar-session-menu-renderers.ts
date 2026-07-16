import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import { t } from "../i18n/index.ts";
import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import {
  SIDEBAR_SESSION_SORT_OPTIONS,
  type SidebarSessionGroupMenuState,
  type SidebarSessionSortMode,
} from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import {
  consumeDropdownKeyboardDismissal,
  syncDropdownItemRadio,
  trackDropdownKeyboardDismissal,
} from "./web-awesome.ts";

type SidebarSessionGroupMenuAction = "rename-group" | "new-group" | "delete-group";

export function renderSidebarSessionGroupMenu(params: {
  menu: SidebarSessionGroupMenuState | null;
  trigger: HTMLElement | null;
  connected: boolean;
  onAction: (action: SidebarSessionGroupMenuAction, group: string) => void;
  onClose: (restoreFocus: boolean) => void;
}) {
  const menu = params.menu;
  if (!menu) {
    return nothing;
  }
  return keyed(
    menu,
    html`
      <openclaw-menu-surface>
        <wa-dropdown
          class="session-menu sidebar-session-group-menu"
          .open=${true}
          placement="bottom-start"
          .distance=${0}
          aria-label=${t("sessionsView.groupMenu", { group: menu.group })}
          @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
            event.preventDefault();
            const value = event.detail.item.value;
            if (value === "rename-group" || value === "new-group" || value === "delete-group") {
              params.onAction(value, menu.group);
            }
          }}
          @keydown=${(event: KeyboardEvent) =>
            trackDropdownKeyboardDismissal(event, () => params.trigger?.focus())}
          @wa-after-hide=${(event: Event) =>
            params.onClose(consumeDropdownKeyboardDismissal(event))}
        >
          <button
            slot="trigger"
            type="button"
            tabindex="-1"
            aria-hidden="true"
            aria-label=${t("sessionsView.groupMenu", { group: menu.group })}
            style="position: fixed; left: ${menu.x}px; top: ${menu.y}px; width: 1px; height: 1px; opacity: 0; pointer-events: none;"
          ></button>
          <wa-dropdown-item
            class="session-menu__item"
            value="rename-group"
            ?disabled=${!params.connected}
          >
            <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.edit}</span>
            <span class="session-menu__text">${t("sessionsView.renameGroupMenu")}</span>
          </wa-dropdown-item>
          <wa-dropdown-item class="session-menu__item" value="new-group">
            <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.folder}</span>
            <span class="session-menu__text">${t("sessionsView.newGroup")}</span>
          </wa-dropdown-item>
          <div class="session-menu__separator" role="separator"></div>
          <wa-dropdown-item
            class="session-menu__item session-menu__item--destructive"
            value="delete-group"
            variant="danger"
            ?disabled=${!params.connected}
          >
            <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.trash}</span>
            <span class="session-menu__text">${t("sessionsView.deleteGroupMenu")}</span>
          </wa-dropdown-item>
        </wa-dropdown>
      </openclaw-menu-surface>
    `,
  );
}

export function renderSidebarSessionSortMenu(params: {
  position: { x: number; y: number } | null;
  trigger: HTMLElement | null;
  grouping: SidebarSessionsGrouping;
  sortMode: SidebarSessionSortMode;
  showCron: boolean;
  onGroupingChange: (grouping: SidebarSessionsGrouping) => void;
  onSortModeChange: (mode: SidebarSessionSortMode) => void;
  onShowCronChange: (show: boolean) => void;
  onClose: (restoreFocus: boolean) => void;
}) {
  const position = params.position;
  if (!position) {
    return nothing;
  }
  const groupingOptions = [
    { grouping: "category", label: t("sessionsView.groupByCategory") },
    { grouping: "none", label: t("sessionsView.groupByNone") },
  ] as const satisfies ReadonlyArray<{ grouping: SidebarSessionsGrouping; label: string }>;
  return keyed(
    position,
    html`
      <openclaw-menu-surface>
        <wa-dropdown
          class="sidebar-session-sort-menu"
          .open=${true}
          placement="bottom-start"
          .distance=${0}
          aria-label=${t("chat.sidebar.sortSessions")}
          @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
            event.preventDefault();
            const value = event.detail.item.value;
            if (value?.startsWith("grouping:")) {
              params.onGroupingChange(value.slice("grouping:".length) as SidebarSessionsGrouping);
            } else if (value?.startsWith("sort:")) {
              params.onSortModeChange(value.slice("sort:".length) as SidebarSessionSortMode);
            } else if (value === "show-cron") {
              params.onShowCronChange(!params.showCron);
            }
          }}
          @keydown=${(event: KeyboardEvent) =>
            trackDropdownKeyboardDismissal(event, () => params.trigger?.focus())}
          @wa-after-hide=${(event: Event) =>
            params.onClose(consumeDropdownKeyboardDismissal(event))}
        >
          <button
            slot="trigger"
            type="button"
            tabindex="-1"
            aria-hidden="true"
            aria-label=${t("chat.sidebar.sortSessions")}
            style="position: fixed; left: ${position.x}px; top: ${position.y}px; width: 1px; height: 1px; opacity: 0; pointer-events: none;"
          ></button>
          <div class="sidebar-session-sort-menu__title">${t("sessionsView.groupBy")}</div>
          ${groupingOptions.map(
            (option) => html`
              <wa-dropdown-item
                class="sidebar-session-sort-menu__item"
                value=${`grouping:${option.grouping}`}
                role="menuitemradio"
                aria-checked=${String(params.grouping === option.grouping)}
                ${ref((element) =>
                  syncDropdownItemRadio(element, params.grouping === option.grouping),
                )}
              >
                <span slot="details" class="session-menu__check" aria-hidden="true"
                  >${params.grouping === option.grouping ? icons.check : nothing}</span
                >
                <span class="session-menu__text">${option.label}</span>
              </wa-dropdown-item>
            `,
          )}
          <div class="session-menu__separator" role="separator"></div>
          <div class="sidebar-session-sort-menu__title">${t("chat.sidebar.sortBy")}</div>
          ${SIDEBAR_SESSION_SORT_OPTIONS.map(
            (option) => html`
              <wa-dropdown-item
                class="sidebar-session-sort-menu__item"
                value=${`sort:${option.mode}`}
                role="menuitemradio"
                aria-checked=${String(params.sortMode === option.mode)}
                ${ref((element) => syncDropdownItemRadio(element, params.sortMode === option.mode))}
              >
                <span slot="details" class="session-menu__check" aria-hidden="true"
                  >${params.sortMode === option.mode ? icons.check : nothing}</span
                >
                <span class="session-menu__text">${t(option.labelKey)}</span>
              </wa-dropdown-item>
            `,
          )}
          <div class="session-menu__separator" role="separator"></div>
          <wa-dropdown-item
            class="sidebar-session-sort-menu__item"
            type="checkbox"
            value="show-cron"
            .checked=${params.showCron}
          >
            <span class="session-menu__text">${t("sessionsView.showCronSessions")}</span>
          </wa-dropdown-item>
        </wa-dropdown>
      </openclaw-menu-surface>
    `,
  );
}
