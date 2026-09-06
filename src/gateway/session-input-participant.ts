import type { SessionParticipantIdentity } from "../config/sessions/session-participant-identity.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import { isOperatorUiClient } from "../utils/message-channel.js";
import type { GatewayClient } from "./server-methods/shared-types.js";

/** Only the live authenticated profile establishes a person; client metadata stays unresolved. */
export function resolveGatewayInputParticipant(
  client:
    | Pick<GatewayClient, "authenticatedUserProfile" | "internal" | "connect">
    | null
    | undefined,
  provenance?: InputProvenance,
): SessionParticipantIdentity | undefined {
  if (
    !client ||
    client.internal?.syntheticClient ||
    (provenance && provenance.kind !== "external_user")
  ) {
    return undefined;
  }
  const profileId = client.authenticatedUserProfile?.profileId;
  if (profileId) {
    return { type: "profile", id: profileId };
  }
  // Direct dispatch can omit transport metadata; absence cannot identify a sender.
  const clientInfo = client.connect?.client;
  return !clientInfo || isOperatorUiClient(clientInfo)
    ? undefined
    : {
        type: "observation",
        pluginId: null,
        accountId: null,
        senderKind: "unknown",
        id: clientInfo.id,
      };
}
