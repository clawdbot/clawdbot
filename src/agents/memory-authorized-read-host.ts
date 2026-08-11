import { createHash, randomUUID } from "node:crypto";
import type { MemoryActorEvidence } from "../memory-host-sdk/host/authorization.js";
import { isMemoryIsolationCutoverAgent } from "../plugins/memory-cutover.js";
import {
  MEMORY_INVOCATION_UNAVAILABLE,
  createAuthorizedMemoryReadInvocation,
  readAuthorizedMemoryForInvocation,
  searchAuthorizedMemoryForInvocation,
  type AuthorizedMemoryReadInvocation,
} from "../plugins/memory-invocation.js";
import type { AuthorizedMemoryReadHost } from "../plugins/tool-types.js";
import {
  captureTrustedMemoryAccessFacts,
  createTrustedMemoryAccessContext,
} from "../state/memory-access-context.js";
import { recheckMemoryIdentityBinding } from "../state/memory-identity.js";
import {
  createCurrentMemorySessionContext,
  type CurrentMemorySessionContext,
} from "../state/memory-session-subject.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

function deliveryFacts(params: {
  context: CurrentMemorySessionContext;
  deliveryContext?: DeliveryContext;
  messageChannel?: string;
  agentAccountId?: string;
}) {
  const { context } = params;
  const route = {
    channel: params.deliveryContext?.channel ?? params.messageChannel ?? null,
    accountId: params.deliveryContext?.accountId ?? params.agentAccountId ?? null,
    to: params.deliveryContext?.to ?? null,
    threadId: params.deliveryContext?.threadId ?? null,
  };
  if (context.subject.kind === "user") {
    return {
      sink: "private" as const,
      audiences: [{ kind: "user" as const, id: context.subject.principalId }],
      routeRevision: `mdr1_${hash(route)}`,
      egressCapabilityIds: ["reply.final"],
      egressRegistryRevision: "mer1_reply-final",
    };
  }
  if (context.subject.kind === "conversation") {
    // The persisted transport identity, not a latest sender, is the only
    // channel audience accepted by the scoped runtime.
    if (!context.conversation) {
      return undefined;
    }
    return {
      sink: "channel" as const,
      audiences: [
        // Scoped stores are addressed to the canonical conversation principal. The transport
        // conversation id remains routing evidence; using it here would make every channel
        // store fail the subject-bound view check.
        { kind: "conversation" as const, id: context.principalId },
      ],
      routeRevision: `mdr1_${hash(route)}`,
      egressCapabilityIds: ["reply.final"],
      egressRegistryRevision: "mer1_reply-final",
    };
  }
  return {
    sink: "internal" as const,
    audiences: [{ kind: "agent" as const, id: context.agentId }],
    routeRevision: `mdr1_${hash(route)}`,
    egressCapabilityIds: ["reply.final"],
    egressRegistryRevision: "mer1_reply-final",
  };
}

/**
 * Builds the sole tool-facing handle for a cut-over run. Session identity and delivery facts are
 * reread from their owners; sender IDs, `toolsBySender`, paths, and model parameters never name a
 * memory subject or namespace here.
 */
export function createAuthorizedMemoryReadHost(params: {
  agentId: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  deliveryContext?: DeliveryContext;
  messageChannel?: string;
  agentAccountId?: string;
}): AuthorizedMemoryReadHost | undefined {
  if (
    !isMemoryIsolationCutoverAgent(params.agentId) ||
    !params.sessionKey?.trim() ||
    !params.sessionId?.trim()
  ) {
    return undefined;
  }
  const session = createCurrentMemorySessionContext({
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    options: { agentId: params.agentId },
  });
  if (session.kind !== "current") {
    return undefined;
  }
  const { context } = session;
  const delivery = deliveryFacts({
    context,
    deliveryContext: params.deliveryContext,
    messageChannel: params.messageChannel,
    agentAccountId: params.agentAccountId,
  });
  if (!delivery) {
    return undefined;
  }
  let actor: MemoryActorEvidence;
  let verifiedPrincipals: Array<{
    principalId: string;
    assurance: "gateway-profile" | "service";
    evidenceRevision: string;
    expiresAt?: string;
  }> = [];
  if (context.subject.kind === "user" && context.bindingId) {
    const binding = recheckMemoryIdentityBinding({ bindingId: context.bindingId });
    if (binding.kind !== "current" || binding.binding.principalId !== context.principalId) {
      return undefined;
    }
    const expiresAt =
      binding.binding.expiresAt === null
        ? undefined
        : new Date(binding.binding.expiresAt).toISOString();
    actor = {
      kind: "principal" as const,
      actorKind: "human" as const,
      principalId: context.principalId,
      assurance: "gateway-profile" as const,
      evidenceRevision: binding.binding.evidenceRevision,
      ...(expiresAt ? { expiresAt } : {}),
    };
    verifiedPrincipals = [
      {
        principalId: context.principalId,
        assurance: "gateway-profile",
        evidenceRevision: binding.binding.evidenceRevision,
        ...(expiresAt ? { expiresAt } : {}),
      },
    ];
  } else if (context.subject.kind === "conversation") {
    actor = {
      kind: "unattributed" as const,
      transportAuditRef: `mta1_${hash({ session: context.fingerprint })}`,
      evidenceRevision: context.authorityRevision,
    };
  } else {
    const actorKind =
      context.subject.kind === "agent"
        ? "agent"
        : context.subject.kind === "system"
          ? "system"
          : "service";
    actor = {
      kind: "principal" as const,
      actorKind,
      principalId: context.principalId,
      assurance: "service" as const,
      evidenceRevision: context.authorityRevision,
    };
    verifiedPrincipals = [
      {
        principalId: context.principalId,
        assurance: "service",
        evidenceRevision: context.authorityRevision,
      },
    ];
  }
  const facts = captureTrustedMemoryAccessFacts({
    requestId: randomUUID(),
    runId: params.runId?.trim() || `session:${context.sessionId}`,
    actor,
    verifiedPrincipals,
    collaboration: { kind: "not-applicable" },
    // Role membership is intentionally absent until a trusted membership resolver exists. This
    // keeps a group actor from selecting a role store merely because they sent the latest message.
    verifiedMemberships: [],
    delivery,
    operation: "read",
    hostFactsRevision: `mhf1_${hash({
      session: context.fingerprint,
      delivery: delivery.routeRevision,
      egress: delivery.egressRegistryRevision,
    })}`,
  });
  const trusted = createTrustedMemoryAccessContext({
    sessionKey: context.sessionKey,
    sessionId: context.sessionId,
    options: { agentId: context.agentId },
    facts,
  });
  if (trusted.kind !== "current") {
    return undefined;
  }
  let invocation:
    | Promise<AuthorizedMemoryReadInvocation | typeof MEMORY_INVOCATION_UNAVAILABLE>
    | undefined;
  const getInvocation = () =>
    (invocation ??= createAuthorizedMemoryReadInvocation({ context: trusted.context }));
  return Object.freeze({
    async search(search) {
      const active = await getInvocation();
      if ("unavailable" in active) {
        return active;
      }
      const result = await searchAuthorizedMemoryForInvocation({ invocation: active, ...search });
      return "unavailable" in result ? MEMORY_INVOCATION_UNAVAILABLE : result;
    },
    async read(read) {
      const active = await getInvocation();
      if ("unavailable" in active) {
        return active;
      }
      const result = await readAuthorizedMemoryForInvocation({ invocation: active, ...read });
      return "unavailable" in result ? MEMORY_INVOCATION_UNAVAILABLE : result;
    },
  });
}
