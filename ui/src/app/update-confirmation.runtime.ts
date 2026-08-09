// Implementation of the Control UI's disruptive-update confirmation gate. It
// stays behind the `update-confirmation.ts` lazy boundary because nothing here
// runs until an operator clicks an update affordance, and the startup bundle
// has no room for a dialog nobody has opened yet.
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import { showConfirmDialog } from "../components/confirm-dialog.ts";
import { t } from "../i18n/index.ts";
import { postNativeUpdate } from "./native-link-routing.ts";
import type { ConfirmAndStartUpdateParams } from "./update-confirmation.ts";
import { formatUpdateTargetLabel } from "./update-overlay-helpers.ts";

function formatInstalledAndAvailable(
  updateAvailable: UpdateAvailable | null,
  updateSchedule: UpdateScheduleState | null,
): string | undefined {
  const currentVersion = updateAvailable?.currentVersion?.trim();
  const installed = currentVersion
    ? t("updates.target.version", { version: currentVersion })
    : null;
  const available = formatUpdateTargetLabel(updateSchedule, updateAvailable);
  if (installed && available) {
    return t("updates.confirm.versions", { available, installed });
  }
  return installed ?? available ?? undefined;
}

export async function confirmAndStartUpdateRuntime(
  params: ConfirmAndStartUpdateParams,
): Promise<void> {
  const route = params.viaNativeApp
    ? {
        confirmLabel: t("updates.confirm.macAction"),
        message: t("updates.confirm.macMessage"),
        title: t("chat.sidebar.updateMacAndGateway"),
      }
    : {
        confirmLabel: t("updates.confirm.action"),
        message: t("updates.confirm.message"),
        title: t("chat.sidebar.updateGateway"),
      };
  const confirmed = await showConfirmDialog({
    title: route.title,
    // The impact sentence is shared so both routes state the same consequence.
    message: `${route.message} ${t("updates.confirm.impact")}`,
    details: formatInstalledAndAvailable(params.updateAvailable, params.updateSchedule),
    confirmLabel: route.confirmLabel,
  });
  if (!confirmed) {
    return;
  }
  if (params.viaNativeApp && postNativeUpdate()) {
    return;
  }
  params.startGatewayUpdate();
}
