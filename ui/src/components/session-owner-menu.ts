import { html, nothing } from "lit";
import { ref } from "lit/directives/ref.js";
import { t } from "../i18n/index.ts";
import { icons } from "./icons.ts";
import { renderSessionOwnerMenuAvatar, type SessionOwnerOption } from "./session-owner-chip.ts";
import { syncDropdownItemRadio } from "./web-awesome.ts";

type SessionOwnerAssignment = Pick<SessionOwnerOption, "type" | "id">;

type SessionOwnerMenuParams = {
  ownerOptions: readonly SessionOwnerOption[];
  currentOwnerId: string | null;
  disabled: boolean;
  disabledReason?: string;
};

export function sessionOwnerAssignmentFromMenuValue(value: string): SessionOwnerAssignment | null {
  if (!value.startsWith("assign-owner:")) {
    return null;
  }
  const [, type, encodedId] = value.split(":");
  const id = encodedId ? decodeURIComponent(encodedId) : "";
  return (type === "human" || type === "agent") && id ? { type, id } : null;
}

export function renderSessionOwnerAssignmentOptions(
  params: SessionOwnerMenuParams,
  inline = false,
) {
  const title = params.disabledReason ?? nothing;
  return params.ownerOptions.map((owner) => {
    const checked = owner.id === params.currentOwnerId;
    return html`
      <wa-dropdown-item
        slot=${inline ? nothing : "submenu"}
        class="session-menu__item"
        value=${`assign-owner:${owner.type}:${encodeURIComponent(owner.id)}`}
        role="menuitemradio"
        aria-checked=${String(checked)}
        ${ref((element) => syncDropdownItemRadio(element, checked))}
        ?disabled=${params.disabled || checked}
        title=${title}
      >
        <span slot="icon" class="session-menu__icon" aria-hidden="true"
          >${renderSessionOwnerMenuAvatar(owner)}</span
        >
        <span class="session-menu__text">${owner.label ?? owner.id}</span>
        ${checked
          ? html`<span slot="details" class="session-menu__check" aria-hidden="true"
              >${icons.check}</span
            >`
          : nothing}
      </wa-dropdown-item>
    `;
  });
}

export function renderSessionOwnerAssignmentMenu(
  params: SessionOwnerMenuParams & {
    selfOwner: SessionOwnerOption | null;
  },
) {
  const title = params.disabledReason ?? nothing;
  return html`
    ${params.selfOwner
      ? html`<wa-dropdown-item
          class="session-menu__item"
          value=${`assign-owner:${params.selfOwner.type}:${encodeURIComponent(params.selfOwner.id)}`}
          ?disabled=${params.disabled || params.currentOwnerId === params.selfOwner.id}
          title=${title}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.users}</span>
          <span class="session-menu__text">${t("sessionsView.assignToMe")}</span>
        </wa-dropdown-item>`
      : nothing}
    ${params.ownerOptions.length > 0
      ? html`<wa-dropdown-item
          class="session-menu__item"
          ?disabled=${params.disabled}
          title=${title}
        >
          <span slot="icon" class="session-menu__icon" aria-hidden="true">${icons.users}</span>
          <span class="session-menu__text">${t("sessionsView.assignTo")}</span>
          ${renderSessionOwnerAssignmentOptions(params)}
        </wa-dropdown-item>`
      : nothing}
  `;
}
