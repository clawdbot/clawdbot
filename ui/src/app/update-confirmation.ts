// Canonical confirmation gate for the Control UI's disruptive update action.
// Every affordance that can start an update routes its first click here, so no
// surface dispatches an unconfirmed update or drifts from the shared policy.
// The dialog itself loads lazily: startup pays nothing for a confirmation the
// operator has not opened.
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";

export type ConfirmAndStartUpdateParams = {
  updateAvailable: UpdateAvailable | null;
  updateSchedule: UpdateScheduleState | null;
  /**
   * True only where the surface can hand a confirmed update to the macOS app
   * and recover from its decline event. Surfaces without that listener stay on
   * the Gateway route so a declined handoff cannot end in silence.
   */
  viaNativeApp: boolean;
  startGatewayUpdate: () => void;
};

export async function confirmAndStartUpdate(params: ConfirmAndStartUpdateParams): Promise<void> {
  const { confirmAndStartUpdateRuntime } = await import("./update-confirmation.runtime.ts");
  await confirmAndStartUpdateRuntime(params);
}
