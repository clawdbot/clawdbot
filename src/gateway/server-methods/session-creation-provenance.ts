import type {
  SessionCreatedActor,
  SessionCreatedVia,
} from "../../config/sessions/session-entry-provenance.js";
import type { AgentRuntimeIdentity } from "../agent-runtime-identity-token.js";

export type TrustedSessionCreation = {
  via: SessionCreatedVia;
  actor?: SessionCreatedActor;
  /** Creator-owned isolation requirement resolved only by the trusted Gateway boundary. */
  sandbox?: "required";
  /** Exact spawning session retained separately from the stable actor identity. */
  requesterSessionKey?: string;
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
      actor: { type: "agent", id: agentRuntimeIdentity.agentId },
      requesterSessionKey: agentRuntimeIdentity.sessionKey,
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
  // Profile linking can canonicalize this id after connection attach, so session
  // ownership follows the live trusted profile while audit keeps its frozen facts.
  return {
    via: "operator",
    ...(profileId
      ? { actor: { type: "human" as const, source: "profile" as const, id: profileId } }
      : {}),
  };
}

export function resolveAgentRunSessionCreation(
  client: SessionCreationClient | null | undefined,
): TrustedSessionCreation {
  const actor = resolveOperatorSessionCreation(client).actor;
  return { via: "run", ...(actor ? { actor } : {}) };
}
