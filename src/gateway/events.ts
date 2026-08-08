// Gateway event payload constants shared by server broadcasts and UI clients.
import type {
  UpdateAvailable,
  UpdateScheduleState,
} from "../../packages/gateway-protocol/src/index.js";

/** Event name emitted when a newer OpenClaw version is available. */
export const GATEWAY_EVENT_UPDATE_AVAILABLE = "update.available" as const;

/** Gateway event payload for update availability broadcasts. */
export type GatewayUpdateAvailableEventPayload = {
  updateAvailable: UpdateAvailable | null;
  schedule?: UpdateScheduleState;
};
