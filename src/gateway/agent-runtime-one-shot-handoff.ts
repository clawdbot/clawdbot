import { randomUUID } from "node:crypto";
import {
  validateAgentRunDelegatedAuthority,
  type AgentRunDelegatedAuthority,
} from "../infra/agent-run-registry.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";

type HandoffOwner = Readonly<{
  agentId: string;
  sessionKey: string;
  operationalRunInstance: Readonly<{ instanceId: string; runId: string }>;
  delegatedAuthority: AgentRunDelegatedAuthority;
}>;

type StoredHandoff<Payload, Target> = Readonly<{
  owner: HandoffOwner;
  payload: Payload;
  target: Target;
  expiresAtMs: number;
}>;

function sameOwner(left: HandoffOwner, right: HandoffOwner): boolean {
  return (
    left.agentId === right.agentId &&
    left.sessionKey === right.sessionKey &&
    left.operationalRunInstance.instanceId === right.operationalRunInstance.instanceId &&
    left.operationalRunInstance.runId === right.operationalRunInstance.runId &&
    left.delegatedAuthority.claimId === right.delegatedAuthority.claimId &&
    left.delegatedAuthority.lifecycleGeneration === right.delegatedAuthority.lifecycleGeneration
  );
}

/** Process-local, owner-validated handoff registry for one target-bound admission. */
export function createAgentRuntimeOneShotHandoffRegistry<Payload, Target>(options: {
  globalKey: symbol;
  ttlMs?: number;
  maxEntries?: number;
  snapshotPayload: (payload: Payload) => Payload;
  sameTarget: (left: Target, right: Target) => boolean;
}) {
  const ttlMs = options.ttlMs ?? 60_000;
  const maxEntries = options.maxEntries ?? 256;
  const handoffs = resolveGlobalMap<string, StoredHandoff<Payload, Target>>(
    options.globalKey,
    (entries) => entries.clear(),
  );

  const prune = (nowMs: number) => {
    for (const [id, handoff] of handoffs) {
      if (
        handoff.expiresAtMs <= nowMs ||
        !validateAgentRunDelegatedAuthority(handoff.owner.delegatedAuthority)
      ) {
        handoffs.delete(id);
      }
    }
    while (handoffs.size >= maxEntries) {
      const oldest = handoffs.keys().next().value;
      if (typeof oldest !== "string") {
        break;
      }
      handoffs.delete(oldest);
    }
  };

  return {
    create(params: {
      owner: HandoffOwner;
      payload: Payload;
      target: Target;
    }): Readonly<{ id: string; revoke: () => void }> | undefined {
      if (
        !validateAgentRunDelegatedAuthority(params.owner.delegatedAuthority) ||
        params.owner.operationalRunInstance.instanceId !==
          params.owner.delegatedAuthority.operationalRunInstance.instanceId ||
        params.owner.operationalRunInstance.runId !==
          params.owner.delegatedAuthority.operationalRunInstance.runId
      ) {
        return undefined;
      }
      const nowMs = Date.now();
      prune(nowMs);
      const id = randomUUID();
      handoffs.set(
        id,
        Object.freeze({
          owner: params.owner,
          payload: options.snapshotPayload(params.payload),
          target: params.target,
          expiresAtMs: nowMs + ttlMs,
        }),
      );
      return Object.freeze({ id, revoke: () => handoffs.delete(id) });
    },

    redeem(params: { id: string; owner: HandoffOwner }):
      | Readonly<{
          payload: Payload;
          consume: (target: Target) => Payload | undefined;
        }>
      | undefined {
      const handoff = handoffs.get(params.id);
      if (
        !handoff ||
        handoff.expiresAtMs <= Date.now() ||
        !sameOwner(handoff.owner, params.owner) ||
        !validateAgentRunDelegatedAuthority(handoff.owner.delegatedAuthority)
      ) {
        handoffs.delete(params.id);
        return undefined;
      }
      return Object.freeze({
        payload: handoff.payload,
        consume: (target: Target) => {
          if (
            handoffs.get(params.id) !== handoff ||
            !options.sameTarget(handoff.target, target) ||
            !validateAgentRunDelegatedAuthority(handoff.owner.delegatedAuthority)
          ) {
            return undefined;
          }
          // Authentication may reconnect before admission. Delete only at this
          // synchronous target check so exactly one admitted consumer can win.
          handoffs.delete(params.id);
          return handoff.payload;
        },
      });
    },
  };
}
