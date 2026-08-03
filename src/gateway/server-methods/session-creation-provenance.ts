import type {
  SessionCreatedActor,
  SessionCreatedVia,
} from "../../config/sessions/session-entry-provenance.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";

export type TrustedSessionCreation = {
  via: SessionCreatedVia;
  actor?: SessionCreatedActor;
  /** Immutable completion recipient for a spawn-owned visible session. */
  completionOwnerSessionKey?: string;
  /** Effective caller tool-policy snapshot for an in-process visible spawn. */
  inheritedToolPolicy?: {
    version: 1;
    allow: string[];
    deny: string[];
  };
};

/**
 * Structural subset of GatewayClient; a leaf contract so shared-types.ts can
 * import TrustedSessionCreation without a type cycle back through this module.
 */
type SessionCreationClient = {
  authenticatedUserProfile?: { profileId?: string } | null;
  internal?: {
    syntheticClient?: true;
    sessionCreation?: TrustedSessionCreation;
    agentRuntimeIdentity?: AgentRuntimeIdentity;
  };
};

export function resolveOperatorSessionCreation(
  client: SessionCreationClient | null | undefined,
  options: { allowTrustedHint?: boolean } = {},
): TrustedSessionCreation {
  if (options.allowTrustedHint && client?.internal?.sessionCreation) {
    return client.internal.sessionCreation;
  }
  const agentRuntimeIdentity = client?.internal?.agentRuntimeIdentity;
  if (options.allowTrustedHint && agentRuntimeIdentity?.sessionSpawnContext) {
    return {
      via: "spawn",
      actor: { type: "agent", id: agentRuntimeIdentity.sessionKey },
      ...(agentRuntimeIdentity.sessionSpawnContext.completionOwnerSessionKey
        ? {
            completionOwnerSessionKey:
              agentRuntimeIdentity.sessionSpawnContext.completionOwnerSessionKey,
          }
        : {}),
      inheritedToolPolicy: agentRuntimeIdentity.sessionSpawnContext.inheritedToolPolicy,
    };
  }
  const profileId = client?.authenticatedUserProfile?.profileId;
  // Actor only when proven: a profile-less wire connection may be an agent-tool
  // client on a remote topology, so claiming a human actor would misattribute
  // agent-caused creations. Absent actor means unknown, never inferred.
  return {
    via: "operator",
    ...(profileId ? { actor: { type: "human" as const, id: profileId } } : {}),
  };
}

export function resolveAgentRunSessionCreation(
  client: SessionCreationClient | null | undefined,
): TrustedSessionCreation {
  const actor = resolveOperatorSessionCreation(client).actor;
  return { via: "run", ...(actor ? { actor } : {}) };
}
