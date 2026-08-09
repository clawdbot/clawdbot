// Canonical confirmation gate for the Control UI's disruptive update action.
// Every affordance that can start an update routes its first click here: the
// dialog owns the copy, the safe-cancel default, and the choice between the
// macOS bridge and `update.run`, so no surface can dispatch an unconfirmed
// update or drift from the shared policy.
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import { showConfirmDialog } from "../components/confirm-dialog.ts";
import { t } from "../i18n/index.ts";
import { postNativeUpdate } from "./native-link-routing.ts";
import { formatUpdateTargetLabel } from "./update-overlay-helpers.ts";

function formatInstalledAndAvailable(
  updateAvailable: UpdateAvailable | null,
  updateSchedule: UpdateScheduleState | null,
): string | undefined {
  const currentVersion = updateAvailable?.currentVersion?.trim();
  const installed = currentVersion ? t("updates.target.version", { version: currentVersion }) : null;
  const available = formatUpdateTargetLabel(updateSchedule, updateAvailable);
  if (installed && available) {
    return t("updates.confirm.versions", { available, installed });
  }
  return installed ?? available ?? undefined;
}

export async function confirmAndStartUpdate(params: {
  updateAvailable: UpdateAvailable | null;
  updateSchedule: UpdateScheduleState | null;
  /**
   * True only where the surface can hand a confirmed update to the macOS app
   * and recover from its decline event. Surfaces without that listener stay on
   * the Gateway route so a declined handoff cannot end in silence.
   */
  viaNativeApp: boolean;
  startGatewayUpdate: () => void;
}): Promise<void> {
  const confirmed = await showConfirmDialog({
    title: params.viaNativeApp
      ? t("chat.sidebar.updateMacAndGateway")
      : t("chat.sidebar.updateGateway"),
    message: params.viaNativeApp ? t("updates.confirm.macMessage") : t("updates.confirm.message"),
    details: formatInstalledAndAvailable(params.updateAvailable, params.updateSchedule),
    confirmLabel: params.viaNativeApp
      ? t("updates.confirm.macAction")
      : t("updates.confirm.action"),
  });
  if (!confirmed) {
    return;
  }
  if (params.viaNativeApp && postNativeUpdate()) {
    return;
  }
  params.startGatewayUpdate();
}
