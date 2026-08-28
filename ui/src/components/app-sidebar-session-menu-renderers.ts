import { html, nothing } from "lit";
import { keyed } from "lit/directives/keyed.js";
import { ref } from "lit/directives/ref.js";
import { t } from "../i18n/index.ts";
import type { CatalogProjectGrouping } from "../lib/sessions/catalog-project-grouping.ts";
import type { SidebarSessionsGrouping } from "../lib/sessions/grouping.ts";
import {
  SIDEBAR_SESSION_SORT_OPTIONS,
  SIDEBAR_SESSION_STATUS_OPTIONS,
  type SidebarSessionGroupMenuState,
  type SidebarSessionSortMode,
  type SidebarSessionStatusFilter,
} from "./app-sidebar-session-types.ts";
import { icons } from "./icons.ts";
import { renderSessionOwnerChip, type SessionOwnerOption } from "./session-owner-chip.ts";
import {
  consumeDropdownKeyboardDismissal,
  syncDropdownItemRadio,
  trackDropdownKeyboardDismissal,
} from "./web-awesome.ts";

type SidebarSessionGroupMenuAction =
  | "group-defaults"
  | "rename-group"
  | "new-group"
  | "delete-group";

function renderSidebarMenuTrigger(position: { x: number; y: number }, label: string) {
  return html`
    <button
      slot="trigger"
      type="button"
      tabindex="-1"
      aria-hidden="true"
      aria-label=${label}
      style="position: fixed; left: ${position.x}px; top: ${position.y}px; width: 1px; height: 1px; opacity: 0; pointer-events: none;"
    ></button>
  `;
}

function renderSidebarMenuRadioItem(params: {
  value: string;
  checked: boolean;
  label: string;
  owner?: SessionOwnerOption;
}) {
  return html`
    <wa-dropdown-item
      class="sidebar-session-sort-menu__item"
      value=${params.value}
      role="menuitemradio"
      aria-checked=${String(params.checked)}
      ${ref((element) => syncDropdownItemRadio(element, params.checked))}
    >
      <span slot="details" class="session-menu__check" aria-hidden="true"
        >${params.checked ? icons.check : nothing}</span
      >
      <span class="row session-menu__label">
        ${params.owner ? renderSessionOwnerChip(params.owner, "row", "owned") : nothing}
        <span class="session-menu__text">${params.label}</span>
      </span>
    </wa-dropdown-item>
  `;
}

function renderSidebarOwnerFilter(
  owners: readonly SessionOwnerOption[],
  ownerFilterId: string | null,
  involvingMe: boolean,
  selfOwnerId: string | null,
) {
  if (owners.length === 0 && ownerFilterId === null && !involvingMe) {
    return nothing;
  }
  return html`
    <div class="session-menu__separator" role="separator"></div>
    <div class="sidebar-session-sort-menu__title">${t("sessionsView.owners")}</div>
    ${renderSidebarMenuRadioItem({
      value: "owner:",
      checked: ownerFilterId === null && !involvingMe,
      label: t("sessionsView.allOwners"),
    })}
    ${renderSidebarMenuRadioItem({
      value: "involving-me",
      checked: involvingMe,
      label: t("sessionsView.involvingMe"),
    })}
    ${owners.map((owner) =>
      renderSidebarMenuRadioItem({
        value: `owner:${owner.id}`,
        checked: ownerFilterId === owner.id,
        label:
          owner.id === selfOwnerId
            ? t("sessionsView.ownerYou", { name: owner.label ?? owner.id })
            : (owner.label ?? owner.id),
        owner,
      }),
    )}
  `;
}

export function renderSidebarSessionGroupMenu(params: {
  menu: SidebarSessionGroupMenuState | null;
  trigger: HTMLElement | null;
  connected: boolean;
  groupDefaultsUnavailable?: boolean;
  actionDisabledReasons?: Partial<Record<SidebarSessionGroupMenuAction, string>>;
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
      <wa-dropdown
        class="session-menu sidebar-session-group-menu"
        .open=${true}
        placement="bottom-start"
        .distance=${0}
        aria-label=${t("sessionsView.groupMenu", { group: menu.group })}
        @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
          event.preventDefault();
          const value = event.detail.item.value;
          if (
            (value === "group-defaults" ||
              value === "rename-group" ||
              value === "new-group" ||
              value === "delete-group") &&
            !params.actionDisabledReasons?.[value]
          ) {
            params.onAction(value, menu.group);
          }
        }}
        @keydown=${(event: KeyboardEvent) =>
          trackDropdownKeyboardDismissal(event, () => params.trigger?.focus())}
        @wa-after-hide=${(event: Event) => params.onClose(consumeDropdownKeyboardDismissal(event))}
      >
        ${renderSidebarMenuTrigger(menu, t("sessionsView.groupMenu", { group: menu.group }))}
        <wa-dropdown-item
          class="session-menu__item"
          value="group-defaults"
          ?disabled=${!params.connected ||
          Boolean(params.actionDisabledReasons?.["group-defaults"])}
          title=${params.actionDisabledReasons?.["group-defaults"] ?? nothing}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.settings}</span>
          <span class="session-menu__text"
            >${params.groupDefaultsUnavailable
              ? `${t("common.retry")}: ${t("sessionsView.groupDefaultsMenu")}`
              : t("sessionsView.groupDefaultsMenu")}</span
          >
        </wa-dropdown-item>
        <wa-dropdown-item
          class="session-menu__item"
          value="rename-group"
          ?disabled=${!params.connected || Boolean(params.actionDisabledReasons?.["rename-group"])}
          title=${params.actionDisabledReasons?.["rename-group"] ?? nothing}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.edit}</span>
          <span class="session-menu__text">${t("sessionsView.renameGroupMenu")}</span>
        </wa-dropdown-item>
        <wa-dropdown-item
          class="session-menu__item"
          value="new-group"
          ?disabled=${!params.connected || Boolean(params.actionDisabledReasons?.["new-group"])}
          title=${params.actionDisabledReasons?.["new-group"] ?? nothing}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.folder}</span>
          <span class="session-menu__text">${t("sessionsView.newGroup")}</span>
        </wa-dropdown-item>
        <div class="session-menu__separator" role="separator"></div>
        <wa-dropdown-item
          class="session-menu__item session-menu__item--destructive"
          value="delete-group"
          variant="danger"
          ?disabled=${!params.connected || Boolean(params.actionDisabledReasons?.["delete-group"])}
          title=${params.actionDisabledReasons?.["delete-group"] ?? nothing}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.trash}</span>
          <span class="session-menu__text">${t("sessionsView.deleteGroupMenu")}</span>
        </wa-dropdown-item>
      </wa-dropdown>
    `,
  );
}

export function renderSidebarCatalogViewMenu(params: {
  position: { x: number; y: number } | null;
  trigger: HTMLElement | null;
  grouping: CatalogProjectGrouping;
  owners: readonly SessionOwnerOption[];
  ownerFilterId: string | null;
  involvingMe: boolean;
  selfOwnerId: string | null;
  onGroupingChange: (grouping: CatalogProjectGrouping) => void;
  onOwnerFilterChange: (ownerId: string | null, involvingMe?: boolean) => void;
  onHide: () => void;
  onClose: (restoreFocus: boolean) => void;
}) {
  const position = params.position;
  if (!position) {
    return nothing;
  }
  const groupingOptions = [
    { grouping: "project", label: t("chat.sidebar.catalogGroupByProject") },
    { grouping: "person", label: t("chat.sidebar.catalogGroupByPerson") },
    { grouping: "none", label: t("sessionsView.groupByNone") },
  ] as const satisfies ReadonlyArray<{ grouping: CatalogProjectGrouping; label: string }>;
  return keyed(
    position,
    html`
      <wa-dropdown
        class="sidebar-session-sort-menu sidebar-catalog-view-menu"
        .open=${true}
        placement="bottom-start"
        .distance=${0}
        aria-label=${t("chat.sidebar.catalogViewOptions")}
        @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
          event.preventDefault();
          const value = event.detail.item.value;
          if (value?.startsWith("grouping:")) {
            params.onGroupingChange(value.slice("grouping:".length) as CatalogProjectGrouping);
          } else if (value?.startsWith("owner:")) {
            params.onOwnerFilterChange(value.slice("owner:".length) || null);
          } else if (value === "involving-me") {
            params.onOwnerFilterChange(null, true);
          } else if (value === "hide-catalog") {
            params.onHide();
          }
        }}
        @keydown=${(event: KeyboardEvent) =>
          trackDropdownKeyboardDismissal(event, () => params.trigger?.focus())}
        @wa-after-hide=${(event: Event) => params.onClose(consumeDropdownKeyboardDismissal(event))}
      >
        ${renderSidebarMenuTrigger(position, t("chat.sidebar.catalogViewOptions"))}
        <div class="sidebar-session-sort-menu__title">${t("sessionsView.groupBy")}</div>
        ${groupingOptions.map((option) =>
          renderSidebarMenuRadioItem({
            value: `grouping:${option.grouping}`,
            checked: params.grouping === option.grouping,
            label: option.label,
          }),
        )}
        ${renderSidebarOwnerFilter(
          params.owners,
          params.ownerFilterId,
          params.involvingMe,
          params.selfOwnerId,
        )}
        <div class="session-menu__separator" role="separator"></div>
        <wa-dropdown-item class="sidebar-session-sort-menu__item" value="hide-catalog">
          <span class="session-menu__text">${t("chat.sidebar.hideFromSidebar")}</span>
        </wa-dropdown-item>
      </wa-dropdown>
    `,
  );
}

export function renderSidebarSessionSortMenu(params: {
  position: { x: number; y: number } | null;
  trigger: HTMLElement | null;
  grouping: SidebarSessionsGrouping;
  sortMode: SidebarSessionSortMode;
  peopleSortAvailable: boolean;
  statusFilter: SidebarSessionStatusFilter;
  showCron: boolean;
  showPreview: boolean;
  showSystem: boolean;
  owners: readonly SessionOwnerOption[];
  ownerFilterId: string | null;
  involvingMe: boolean;
  selfOwnerId: string | null;
  onGroupingChange: (grouping: SidebarSessionsGrouping) => void;
  onSortModeChange: (mode: SidebarSessionSortMode) => void;
  onStatusFilterChange: (statusFilter: SidebarSessionStatusFilter) => void;
  onOwnerFilterChange: (ownerId: string | null, involvingMe?: boolean) => void;
  onShowCronChange: (show: boolean) => void;
  onShowPreviewChange: (show: boolean) => void;
  onShowSystemChange: (show: boolean) => void;
  onClose: (restoreFocus: boolean) => void;
}) {
  const position = params.position;
  if (!position) {
    return nothing;
  }
  const groupingOptions = [
    { grouping: "category", label: t("sessionsView.groupByCategory") },
    { grouping: "project", label: t("chat.sidebar.catalogGroupByProject") },
    { grouping: "person", label: t("sessionsView.groupByPerson") },
    { grouping: "none", label: t("sessionsView.groupByNone") },
  ] as const satisfies ReadonlyArray<{ grouping: SidebarSessionsGrouping; label: string }>;
  return keyed(
    position,
    html`
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
          } else if (value?.startsWith("status:")) {
            params.onStatusFilterChange(
              value.slice("status:".length) as SidebarSessionStatusFilter,
            );
          } else if (value?.startsWith("owner:")) {
            params.onOwnerFilterChange(value.slice("owner:".length) || null);
          } else if (value === "involving-me") {
            params.onOwnerFilterChange(null, true);
          } else if (value === "show-preview") {
            params.onShowPreviewChange(!params.showPreview);
          } else if (value === "show-cron") {
            params.onShowCronChange(!params.showCron);
          } else if (value === "show-system") {
            params.onShowSystemChange(!params.showSystem);
          }
        }}
        @keydown=${(event: KeyboardEvent) =>
          trackDropdownKeyboardDismissal(event, () => params.trigger?.focus())}
        @wa-after-hide=${(event: Event) => params.onClose(consumeDropdownKeyboardDismissal(event))}
      >
        ${renderSidebarMenuTrigger(position, t("chat.sidebar.sortSessions"))}
        <div class="sidebar-session-sort-menu__title">${t("sessionsView.groupBy")}</div>
        ${groupingOptions
          .filter((option) => option.grouping !== "person" || params.peopleSortAvailable)
          .map((option) =>
            renderSidebarMenuRadioItem({
              value: `grouping:${option.grouping}`,
              checked: params.grouping === option.grouping,
              label: option.label,
            }),
          )}
        <div class="session-menu__separator" role="separator"></div>
        <div class="sidebar-session-sort-menu__title">${t("chat.sidebar.sortBy")}</div>
        ${SIDEBAR_SESSION_SORT_OPTIONS.filter(
          (option) => option.mode !== "people" || params.peopleSortAvailable,
        ).map((option) =>
          renderSidebarMenuRadioItem({
            value: `sort:${option.mode}`,
            checked: params.sortMode === option.mode,
            label: t(option.labelKey),
          }),
        )}
        <div class="session-menu__separator" role="separator"></div>
        <div class="sidebar-session-sort-menu__title">${t("sessionsView.status")}</div>
        ${SIDEBAR_SESSION_STATUS_OPTIONS.map((statusFilter) =>
          renderSidebarMenuRadioItem({
            value: `status:${statusFilter}`,
            checked: params.statusFilter === statusFilter,
            label:
              statusFilter === "active"
                ? t("common.active")
                : statusFilter === "archived"
                  ? t("sessionsView.archived")
                  : t("sessionsView.all"),
          }),
        )}
        ${renderSidebarOwnerFilter(
          params.owners,
          params.ownerFilterId,
          params.involvingMe,
          params.selfOwnerId,
        )}
        <div class="session-menu__separator" role="separator"></div>
        <wa-dropdown-item
          class="sidebar-session-sort-menu__item"
          type="checkbox"
          value="show-preview"
          .checked=${params.showPreview}
        >
          <span class="session-menu__text">${t("sessionsView.showSessionPreview")}</span>
          <span slot="details" class="session-menu__check" aria-hidden="true"
            >${params.showPreview ? icons.check : nothing}</span
          >
        </wa-dropdown-item>
        <wa-dropdown-item
          class="sidebar-session-sort-menu__item"
          type="checkbox"
          value="show-cron"
          .checked=${params.showCron}
        >
          <span class="session-menu__text">${t("sessionsView.showCronSessions")}</span>
          <span slot="details" class="session-menu__check" aria-hidden="true"
            >${params.showCron ? icons.check : nothing}</span
          >
        </wa-dropdown-item>
        <wa-dropdown-item
          class="sidebar-session-sort-menu__item"
          type="checkbox"
          value="show-system"
          .checked=${params.showSystem}
        >
          <span class="session-menu__text">${t("sessionsView.showSystemSessions")}</span>
          <span slot="details" class="session-menu__check" aria-hidden="true"
            >${params.showSystem ? icons.check : nothing}</span
          >
        </wa-dropdown-item>
      </wa-dropdown>
    `,
  );
}
