// Devices page renders the pending device pairing-request rows.
import { html, nothing } from "lit";
import {
  resolvePendingDeviceApprovalState,
  type DevicePairingAccessSummary,
  type PendingDeviceApprovalKind,
} from "../../../../src/shared/device-pairing-access.js";
import { icons } from "../../components/icons.ts";
import { t } from "../../i18n/index.ts";
import { formatList, formatRelativeTimestamp } from "../../lib/format.ts";
import type { PairedDevice, PendingDevice } from "../../lib/nodes/index.ts";
import { normalizeOptionalString } from "../../lib/string-coerce.ts";
import { renderDeviceTile } from "./view-shared.ts";
import type { DevicesProps } from "./view.types.ts";

export function renderPendingDeviceRows(
  pending: PendingDevice[],
  paired: PairedDevice[],
  props: DevicesProps,
) {
  const pairedByDeviceId = new Map(
    paired
      .map((device) => [normalizeOptionalString(device.deviceId), device] as const)
      .filter((entry): entry is [string, PairedDevice] => Boolean(entry[0])),
  );
  return pending.map((req) =>
    renderPendingDevice(req, props, lookupPairedDevice(pairedByDeviceId, req)),
  );
}

function lookupPairedDevice(
  pairedByDeviceId: ReadonlyMap<string, PairedDevice>,
  request: Pick<PendingDevice, "deviceId" | "publicKey">,
): PairedDevice | undefined {
  const deviceId = normalizeOptionalString(request.deviceId);
  if (!deviceId) {
    return undefined;
  }
  const paired = pairedByDeviceId.get(deviceId);
  if (!paired) {
    return undefined;
  }
  const requestPublicKey = normalizeOptionalString(request.publicKey);
  const pairedPublicKey = normalizeOptionalString(paired.publicKey);
  if (requestPublicKey && pairedPublicKey && requestPublicKey !== pairedPublicKey) {
    return undefined;
  }
  return paired;
}

function formatAccessSummary(access: DevicePairingAccessSummary | null): string {
  if (!access) {
    return t("devices.inventory.none");
  }
  return t("devices.inventory.rolesAndScopes", {
    roles: formatList(access.roles),
    scopes: formatList(access.scopes),
  });
}

function renderPendingApprovalNote(kind: PendingDeviceApprovalKind) {
  switch (kind) {
    case "scope-upgrade":
      return t("devices.inventory.scopeUpgrade");
    case "role-upgrade":
      return t("devices.inventory.roleUpgrade");
    case "re-approval":
      return t("devices.inventory.reapproval");
    case "new-pairing":
      return t("devices.inventory.newPairing");
  }
  const exhaustiveKind: never = kind;
  void exhaustiveKind;
  throw new Error("unsupported pending approval kind");
}

function renderPendingDevice(req: PendingDevice, props: DevicesProps, paired?: PairedDevice) {
  const name = normalizeOptionalString(req.displayName) || req.deviceId;
  const age = typeof req.ts === "number" ? formatRelativeTimestamp(req.ts) : t("common.na");
  const approval = resolvePendingDeviceApprovalState(req, paired);
  const repair = req.isRepair ? ` · ${t("devices.inventory.repair")}` : "";
  const ip = req.remoteIp ? ` · ${req.remoteIp}` : "";
  return html`
    <div class="settings-row device-entry">
      ${renderDeviceTile(icons.monitorSmartphone)}
      <div class="settings-row__text">
        <span class="settings-row__title">${name}</span>
        <span class="settings-row__desc">${req.deviceId}${ip}</span>
        <span class="settings-row__desc">
          ${t("devices.inventory.requestedAt", {
            note: renderPendingApprovalNote(approval.kind),
            time: age,
          })}${repair}
        </span>
        <span class="settings-row__desc">
          ${t("devices.inventory.requestedAccess", {
            access: formatAccessSummary(approval.requested),
          })}
        </span>
        ${approval.approved
          ? html`
              <span class="settings-row__desc">
                ${t("devices.inventory.approvedAccess", {
                  access: formatAccessSummary(approval.approved),
                })}
              </span>
            `
          : nothing}
      </div>
      <div class="settings-row__control">
        <button class="btn btn--sm" @click=${() => props.onDeviceApprove(req.requestId)}>
          ${t("devices.inventory.approve")}
        </button>
        <button class="btn btn--sm" @click=${() => props.onDeviceReject(req.requestId)}>
          ${t("devices.inventory.reject")}
        </button>
      </div>
    </div>
  `;
}
