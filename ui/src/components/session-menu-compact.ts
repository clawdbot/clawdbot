import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";
import type { SessionOwnerOption } from "./session-owner-chip.ts";
import { renderSessionOwnerAssignmentOptions } from "./session-owner-menu.ts";

export type CompactSessionMenuView = "root" | "open-in" | "assign-owner" | "icon" | "group";

const COMPACT_SESSION_MENU_VIEW_BY_VALUE: Record<string, CompactSessionMenuView> = {
  "compact:back": "root",
  "compact:open-assign-owner": "assign-owner",
  "compact:open-group": "group",
  "compact:open-icon": "icon",
  "compact:open-open-in": "open-in",
};

export function compactSessionMenuViewForValue(value: string): CompactSessionMenuView | null {
  return COMPACT_SESSION_MENU_VIEW_BY_VALUE[value] ?? null;
}

export function compactSessionOwnerOptions(
  ownerOptions: readonly SessionOwnerOption[],
  selfOwner: SessionOwnerOption | null,
): readonly SessionOwnerOption[] {
  if (!selfOwner || ownerOptions.some((owner) => owner.id === selfOwner.id)) {
    return ownerOptions;
  }
  return [selfOwner, ...ownerOptions];
}

export function renderCompactSessionMenuNavigationItem(params: {
  view: Exclude<CompactSessionMenuView, "root">;
  label: string;
  icon: TemplateResult;
  disabled?: boolean;
  title?: string;
}) {
  return html`
    <wa-dropdown-item
      class="session-menu__item"
      value=${`compact:open-${params.view}`}
      ?disabled=${params.disabled ?? false}
      title=${params.title ?? nothing}
    >
      <span slot="icon" class="session-menu__icon" aria-hidden="true">${params.icon}</span>
      <span class="session-menu__text">${params.label}</span>
      <span slot="details" class="session-menu__icon session-menu__chevron" aria-hidden="true"
        >${icons.chevronRight}</span
      >
    </wa-dropdown-item>
  `;
}

export function renderCompactSessionMenuView(params: {
  view: CompactSessionMenuView;
  ownerOptions: readonly SessionOwnerOption[];
  currentOwnerId: string | null;
  assignOwnerDisabled: boolean;
  assignOwnerDisabledReason?: string;
  renderOpenIn: () => TemplateResult;
  renderIcon: () => TemplateResult;
  renderGroup: () => TemplateResult;
}) {
  if (params.view === "root") {
    return nothing;
  }
  const body =
    params.view === "open-in"
      ? params.renderOpenIn()
      : params.view === "assign-owner"
        ? renderSessionOwnerAssignmentOptions(
            {
              ownerOptions: params.ownerOptions,
              currentOwnerId: params.currentOwnerId,
              disabled: params.assignOwnerDisabled,
              disabledReason: params.assignOwnerDisabledReason,
            },
            true,
          )
        : params.view === "icon"
          ? params.renderIcon()
          : params.renderGroup();
  return html`
    <wa-dropdown-item class="session-menu__item session-menu__back" value="compact:back">
      <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.arrowLeft}</span>
      <span class="session-menu__text">${t("common.back")}</span>
    </wa-dropdown-item>
    <div class="session-menu__separator" role="separator"></div>
    ${body}
  `;
}
