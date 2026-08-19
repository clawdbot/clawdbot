import type { ExecutionIdentityAdmissionToken } from "../audit/execution-identity-admission.js";
import type { AgentRunDelegatedAuthority } from "../infra/agent-run-registry.js";
import { createAgentRuntimeOneShotHandoffRegistry } from "./agent-runtime-one-shot-handoff.js";
import type { AgentRuntimeSessionSpawnContext } from "./agent-runtime-session-spawn-context.js";

export type AgentRuntimeSessionHandoffRequester = {
  messageProvider?: string;
  senderId?: string;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
};

export type AgentRuntimeSessionHandoffContext = {
  inheritedToolPolicy: AgentRuntimeSessionSpawnContext["inheritedToolPolicy"];
  requester: AgentRuntimeSessionHandoffRequester;
  /** Internal transcript body for one target-bound bookkeeping turn. */
  transcriptMessage?: string;
};

type AgentRuntimeSessionHandoffTarget = Readonly<{
  sessionKey: string;
  idempotencyKey: string;
}>;

const AGENT_RUNTIME_SESSION_HANDOFF_REDEMPTION = Symbol("agentRuntimeSessionHandoffRedemption");

type SessionHandoffRedemption = Readonly<{
  consume: (
    target: AgentRuntimeSessionHandoffTarget,
  ) => AgentRuntimeSessionHandoffContext | undefined;
  validateConsumed: () => boolean;
}>;

type SessionHandoffRedemptionCarrier = {
  [AGENT_RUNTIME_SESSION_HANDOFF_REDEMPTION]: SessionHandoffRedemption;
};

type SessionHandoffPayload = Readonly<{
  context: AgentRuntimeSessionHandoffContext;
  executionIdentity?: ExecutionIdentityAdmissionToken;
}>;

function sameTarget(
  left: AgentRuntimeSessionHandoffTarget,
  right: AgentRuntimeSessionHandoffTarget,
): boolean {
  return left.sessionKey === right.sessionKey && left.idempotencyKey === right.idempotencyKey;
}

const sessionHandoffs = createAgentRuntimeOneShotHandoffRegistry<
  SessionHandoffPayload,
  AgentRuntimeSessionHandoffTarget
>({
  globalKey: Symbol.for("openclaw.agentRuntimeSessionHandoffs"),
  sameTarget,
  snapshotPayload: (payload) => ({
    context: {
      inheritedToolPolicy: {
        version: 1,
        allow: [...payload.context.inheritedToolPolicy.allow],
        deny: [...payload.context.inheritedToolPolicy.deny],
      },
      requester: { ...payload.context.requester },
      ...(payload.context.transcriptMessage !== undefined
        ? { transcriptMessage: payload.context.transcriptMessage }
        : {}),
    },
    ...(payload.executionIdentity ? { executionIdentity: payload.executionIdentity } : {}),
  }),
});

/** Register exact source authority for one target admission; the id is correlation only. */
export function createAgentRuntimeSessionHandoff(params: {
  agentId: string;
  sessionKey: string;
  operationalRunInstance: Readonly<{ instanceId: string; runId: string }>;
  delegatedAuthority: AgentRunDelegatedAuthority;
  context: AgentRuntimeSessionHandoffContext;
  executionIdentity?: ExecutionIdentityAdmissionToken;
  target: AgentRuntimeSessionHandoffTarget;
}): Readonly<{ id: string; revoke: () => void }> | undefined {
  if (
    params.executionIdentity !== undefined &&
    params.executionIdentity.runId !== params.operationalRunInstance.runId
  ) {
    throw new Error("session handoff execution identity disagrees with its source admission");
  }
  return sessionHandoffs.create({
    owner: {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      operationalRunInstance: params.operationalRunInstance,
      delegatedAuthority: params.delegatedAuthority,
    },
    payload: Object.freeze({
      context: params.context,
      ...(params.executionIdentity ? { executionIdentity: params.executionIdentity } : {}),
    }),
    target: params.target,
  });
}

/** Redeem against the signed source owner, then leave one target-bound use for admission. */
export function redeemAgentRuntimeSessionHandoff(params: {
  id: string;
  agentId: string;
  sessionKey: string;
  operationalRunInstance: Readonly<{ instanceId: string; runId: string }>;
  delegatedAuthority: AgentRunDelegatedAuthority;
}):
  | Readonly<{
      context: AgentRuntimeSessionHandoffContext;
      executionIdentity?: ExecutionIdentityAdmissionToken;
      redemption: SessionHandoffRedemption;
    }>
  | undefined {
  const handoff = sessionHandoffs.redeem({
    id: params.id,
    owner: {
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      operationalRunInstance: params.operationalRunInstance,
      delegatedAuthority: params.delegatedAuthority,
    },
  });
  if (!handoff) {
    return undefined;
  }
  return Object.freeze({
    context: handoff.payload.context,
    ...(handoff.payload.executionIdentity
      ? { executionIdentity: handoff.payload.executionIdentity }
      : {}),
    redemption: Object.freeze({
      consume: (target: AgentRuntimeSessionHandoffTarget) => handoff.consume(target)?.context,
      validateConsumed: handoff.validateConsumed,
    }),
  });
}

export function withAgentRuntimeSessionHandoffRedemption<T extends object>(
  identity: T,
  redemption: SessionHandoffRedemption,
): T & SessionHandoffRedemptionCarrier {
  return { ...identity, [AGENT_RUNTIME_SESSION_HANDOFF_REDEMPTION]: redemption };
}

/** Consume exactly once after the Gateway resolves the authoritative target session. */
export function consumeAgentRuntimeSessionHandoff(
  identity: object,
  target: AgentRuntimeSessionHandoffTarget,
): AgentRuntimeSessionHandoffContext | undefined {
  return AGENT_RUNTIME_SESSION_HANDOFF_REDEMPTION in identity
    ? (identity as SessionHandoffRedemptionCarrier)[
        AGENT_RUNTIME_SESSION_HANDOFF_REDEMPTION
      ].consume(target)
    : undefined;
}

/** Revalidate the consumed one-shot handoff until target admission is durable. */
export function validateConsumedAgentRuntimeSessionHandoff(identity: object): boolean {
  return (
    AGENT_RUNTIME_SESSION_HANDOFF_REDEMPTION in identity &&
    (identity as SessionHandoffRedemptionCarrier)[
      AGENT_RUNTIME_SESSION_HANDOFF_REDEMPTION
    ].validateConsumed()
  );
}
