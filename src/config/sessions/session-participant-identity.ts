import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Compile, type Validator } from "typebox/compile";
import {
  SessionParticipantIdentitySchema,
  type SessionParticipantIdentity,
} from "../../../packages/gateway-protocol/src/schema/session-participant.js";

export type { SessionParticipantIdentity };

// Compile only decoded own-property records; raw sender objects have different inherited-key semantics.
let identityValidator:
  | Validator<Record<string, never>, typeof SessionParticipantIdentitySchema>
  | undefined;

export function participantIdentityNamespace(identity: SessionParticipantIdentity): string {
  if (identity.type === "profile" || identity.type === "agent") {
    return JSON.stringify({ type: identity.type });
  }
  if (identity.type === "remote") {
    return JSON.stringify({
      type: identity.type,
      pluginId: identity.pluginId,
      domain: identity.domain,
      idKind: identity.idKind,
    });
  }
  if (identity.type === "observation") {
    return JSON.stringify({
      type: identity.type,
      pluginId: identity.pluginId,
      accountId: identity.accountId,
      senderKind: identity.senderKind,
    });
  }
  return JSON.stringify({
    type: identity.type,
    actorType: identity.actorType,
    source: identity.source,
  });
}

export function readParticipantIdentity(namespace: string, id: string): SessionParticipantIdentity {
  const parsed: unknown = JSON.parse(namespace);
  if (isRecord(parsed)) {
    const identity = { ...parsed, id };
    if ((identityValidator ??= Compile(SessionParticipantIdentitySchema)).Check(identity)) {
      return identity;
    }
  }
  throw new Error("Session participant identity is invalid; run openclaw doctor --fix.");
}

type ParticipantAggregate = {
  contribution_count: number;
  first_prompted_at: number | null;
  last_prompted_at: number | null;
};

/** Inputs/aliases sum; retried cross-store copies retain the largest recorded aggregate. */
export function mergeParticipantAggregate(
  current: ParticipantAggregate | undefined,
  incoming: ParticipantAggregate,
  mode: "sum" | "copy",
): ParticipantAggregate {
  if (!current) {
    return incoming;
  }
  return {
    contribution_count:
      mode === "sum"
        ? current.contribution_count + incoming.contribution_count
        : Math.max(current.contribution_count, incoming.contribution_count),
    // A new observation cannot establish the first input of an ambiguous old history.
    first_prompted_at:
      current.first_prompted_at === null || incoming.first_prompted_at === null
        ? null
        : Math.min(current.first_prompted_at, incoming.first_prompted_at),
    last_prompted_at:
      current.last_prompted_at === null
        ? incoming.last_prompted_at
        : incoming.last_prompted_at === null
          ? current.last_prompted_at
          : Math.max(current.last_prompted_at, incoming.last_prompted_at),
  };
}
