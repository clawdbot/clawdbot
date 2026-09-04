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

// Keep the lazy confirmation entry independent of the application context.
type UpdateProgressSources = {
  gateway: {
    snapshot: { phase: string };
    subscribe: (listener: () => void) => () => void;
  };
  overlays: {
    snapshot: {
      updateRunning: boolean;
      updateReconciliationPending: boolean;
      updateStatusBanner: { tone: string; text: string } | null;
    };
    subscribe: (listener: () => void) => () => void;
  };
};

export function createUpdateProgressWatcher(
  context: UpdateProgressSources,
): (listener: (progress: UpdateProgress) => void) => () => void {
  return (listener) => {
    const emit = () => {
      const update = context.overlays.snapshot;
      const banner = update.updateStatusBanner;
      listener({
        busy: update.updateRunning || update.updateReconciliationPending,
        connected: context.gateway.snapshot.phase === "connected",
        failure: banner && banner.tone !== "info" ? banner.text : null,
      });
    };
    const stopOverlays = context.overlays.subscribe(emit);
    const stopGateway = context.gateway.subscribe(emit);
    emit();
    return () => {
      stopOverlays();
      stopGateway();
    };
  };
}

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
