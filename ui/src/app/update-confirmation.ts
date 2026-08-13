// Canonical confirmation gate for the Control UI's disruptive update action.
// Every affordance that can start an update routes its first click here, so no
// surface dispatches an unconfirmed update or drifts from the shared policy.
// The dialog itself loads lazily: startup pays nothing for a confirmation the
// operator has not opened.
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";

/** What the dialog needs to narrate an install it cannot observe directly. */
export type UpdateProgress = {
  /** The install is accepted and unfinished, across the restart. */
  busy: boolean;
  connected: boolean;
  /** Set once the update produced a definitive failure. */
  failure: string | null;
};

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
  /**
   * Streams the update lifecycle so the dialog can stay open and report it.
   * A surface that cannot supply one closes on confirm instead of holding a
   * dialog it can never update; the ambient surfaces narrate from there.
   */
  watchUpdateProgress?: (listener: (progress: UpdateProgress) => void) => () => void;
};

export async function confirmAndStartUpdate(params: ConfirmAndStartUpdateParams): Promise<void> {
  const { confirmAndStartUpdateRuntime } = await import("./update-confirmation.runtime.ts");
  await confirmAndStartUpdateRuntime(params);
}
