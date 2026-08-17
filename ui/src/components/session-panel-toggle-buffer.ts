export type SessionPanelToggleSlot = "browser" | "desktop" | "terminal";

const INTENT_TTL_MS = 10_000;
const pendingToggles = new Map<SessionPanelToggleSlot, { event: Event; createdAt: number }>();

/**
 * The application shell exists before a session pane finishes mounting. Keep
 * the newest panel intent so an early command is delivered to that pane rather
 * than disappearing during route startup.
 */
export function rememberSessionPanelToggle(slot: SessionPanelToggleSlot, event: Event): void {
  pendingToggles.set(slot, { event, createdAt: Date.now() });
}

/** Clear an intent that the active pane already handled directly. */
export function clearSessionPanelToggle(slot: SessionPanelToggleSlot, event: Event): void {
  if (pendingToggles.get(slot)?.event === event) {
    pendingToggles.delete(slot);
  }
}

/** Claim an intent only after a mounted pane becomes its active owner. */
export function takeSessionPanelToggle(slot: SessionPanelToggleSlot): Event | null {
  const pending = pendingToggles.get(slot) ?? null;
  pendingToggles.delete(slot);
  return pending && Date.now() - pending.createdAt <= INTENT_TTL_MS ? pending.event : null;
}
