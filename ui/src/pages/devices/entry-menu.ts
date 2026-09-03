import { html, nothing } from "lit";
import { openDesktopFocus } from "../../components/desktop/desktop-focus-window.ts";
import { icons } from "../../components/icons.ts";
import "../../components/web-awesome.ts";
import { t } from "../../i18n/index.ts";
import { copyToClipboard } from "../../lib/clipboard.ts";
import { showToast } from "../../lib/toast.ts";
import type { DevicesProps } from "./view.types.ts";

export function deviceDesktopEnvironment(props: DevicesProps, environmentId: string) {
  return props.desktopEnvironments?.find(
    (environment) => environment.id === environmentId && environment.desktop === true,
  )?.id;
}

async function copyDeviceId(id: string) {
  const copied = await copyToClipboard(id);
  showToast({ message: copied ? t("devices.inventory.deviceIdCopied") : t("common.copyFailed") });
}

export function renderDeviceEntryMenu(
  props: DevicesProps,
  entry: {
    name: string;
    deviceId?: string;
    desktopEnvironment?: string;
    pendingRequestId?: string;
    onRemove?: () => void;
  },
) {
  if (!entry.deviceId && !entry.desktopEnvironment) {
    return nothing;
  }
  const pairingHint = props.canManagePairing ? nothing : t("devices.readOnly.pairingRequired");
  return html`
    <wa-dropdown
      placement="bottom-end"
      @wa-select=${(event: CustomEvent<{ item: { value?: string } }>) => {
        switch (event.detail.item.value) {
          case "desktop":
            if (entry.desktopEnvironment) {
              openDesktopFocus(props.basePath, entry.desktopEnvironment);
            }
            break;
          case "copy":
            if (entry.deviceId) {
              void copyDeviceId(entry.deviceId);
            }
            break;
          case "approve":
            if (props.canManagePairing && entry.pendingRequestId) {
              props.onNodeApprove(entry.pendingRequestId);
            }
            break;
          case "reject":
            if (props.canManagePairing && entry.pendingRequestId) {
              props.onNodeReject(entry.pendingRequestId);
            }
            break;
          case "remove":
            if (props.canManagePairing) {
              entry.onRemove?.();
            }
            break;
          default:
            break;
        }
      }}
    >
      <button
        slot="trigger"
        type="button"
        class="btn btn--sm btn--ghost device-entry__menu-trigger"
        aria-label=${t("devices.inventory.actionsName", { name: entry.name })}
        title=${t("devices.inventory.actions")}
      >
        ${icons.moreHorizontal}
      </button>
      ${entry.desktopEnvironment
        ? html`<wa-dropdown-item value="desktop"
            >${t("devices.inventory.openDesktop")}</wa-dropdown-item
          >`
        : nothing}
      ${entry.pendingRequestId
        ? html`
            <wa-dropdown-item
              value="approve"
              ?disabled=${!props.canManagePairing}
              title=${pairingHint}
              >${t("devices.inventory.approve")}</wa-dropdown-item
            >
            <wa-dropdown-item
              value="reject"
              ?disabled=${!props.canManagePairing}
              title=${pairingHint}
              >${t("devices.inventory.reject")}</wa-dropdown-item
            >
          `
        : nothing}
      ${entry.deviceId
        ? html`<wa-dropdown-item value="copy"
            >${t("devices.inventory.copyDeviceId")}</wa-dropdown-item
          >`
        : nothing}
      ${entry.onRemove
        ? html`<wa-dropdown-item
            value="remove"
            variant="danger"
            ?disabled=${!props.canManagePairing}
            title=${pairingHint}
            >${t("devices.inventory.removeAction")}</wa-dropdown-item
          >`
        : nothing}
    </wa-dropdown>
  `;
}
