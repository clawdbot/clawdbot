import type { AdmittedChannelMemoryIdentity } from "../channels/message-access/memory-identity-admission.js";
import {
  adminLinkAdmittedMemoryIdentity,
  type MemoryIdentityBinding,
} from "../state/memory-identity.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type { GatewayClient } from "./server-methods/types.js";

/**
 * Gateway-only administrative bridge for a channel identity binding. The
 * gateway handshake, rather than request JSON, owns the durable operator
 * profile and its current scope grant.
 */
export function linkAdmittedMemoryIdentityFromGateway(params: {
  admission: AdmittedChannelMemoryIdentity;
  client: GatewayClient;
  targetProfileId: string;
  options?: OpenClawStateDatabaseOptions;
}): MemoryIdentityBinding {
  const profileId = params.client.authenticatedUserProfile?.profileId;
  if (!profileId) {
    throw new Error("memory identity admin-link requires an authenticated Gateway profile");
  }
  const scopes = Array.isArray(params.client.connect.scopes) ? params.client.connect.scopes : [];
  if (!scopes.includes("operator.admin")) {
    throw new Error("memory identity admin-link requires gateway scope: operator.admin");
  }
  return adminLinkAdmittedMemoryIdentity({
    admission: params.admission,
    authenticatedOperatorProfileId: profileId,
    targetProfileId: params.targetProfileId,
    authenticatedOperatorScopes: scopes,
    options: params.options,
  });
}
