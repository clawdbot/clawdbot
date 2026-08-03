// Gateway event payload constants shared by server broadcasts and UI clients.
/** Event name emitted when a newer OpenClaw version is available. */
export const GATEWAY_EVENT_UPDATE_AVAILABLE = "update.available" as const;

/** Version metadata included in update-available gateway events. */
type UpdateAvailableEventData = {
  currentVersion: string;
  latestVersion: string;
  channel: string;
};

/** Gateway event payload for update availability broadcasts. */
export type GatewayUpdateAvailableEventPayload = {
  updateAvailable: UpdateAvailableEventData | null;
};
