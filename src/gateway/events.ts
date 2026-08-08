// Gateway event payload constants shared by server broadcasts and UI clients.
import type {
  UpdateAvailable,
  UpdateScheduleState,
} from "../../packages/gateway-protocol/src/index.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { READ_SCOPE } from "./operator-scopes.js";

/** Event name emitted when a newer OpenClaw version is available. */
export const GATEWAY_EVENT_UPDATE_AVAILABLE = "update.available" as const;

/** Returns whether this authenticated client may receive detailed update metadata. */
export function canReadDetailedUpdateMetadata(role: string, scopes: readonly string[]): boolean {
  return roleScopesAllow({
    role,
    requestedScopes: [READ_SCOPE],
    allowedScopes: scopes,
  });
}

/** Projects update availability to the pre-detail wire shape for clients without read access. */
export function projectUpdateAvailable(
  updateAvailable: UpdateAvailable | null | undefined,
  includeDetails: boolean,
): UpdateAvailable | null | undefined {
  if (!updateAvailable || includeDetails) {
    return updateAvailable;
  }
  return {
    currentVersion: updateAvailable.currentVersion,
    latestVersion: updateAvailable.latestVersion,
    channel: updateAvailable.channel,
  };
}

/** Gateway event payload for update availability broadcasts. */
export type GatewayUpdateAvailableEventPayload = {
  updateAvailable: UpdateAvailable | null;
  schedule?: UpdateScheduleState;
};
