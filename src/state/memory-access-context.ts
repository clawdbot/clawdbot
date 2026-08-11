import { createHash } from "node:crypto";
import {
  MEMORY_OPERATIONS,
  type AudienceRef,
  type MemoryAccessContext,
  type MemoryActorEvidence,
  type MemoryOperation,
  type MemoryVerifiedMembership,
  type SessionMemorySubject,
  type VerifiedPrincipalRef,
} from "../memory-host-sdk/host/authorization.js";
import { recheckMemoryIdentityBinding } from "./memory-identity.js";
import {
  createCurrentMemorySessionContext,
  isCurrentMemorySessionContext,
  type CurrentMemorySessionContext,
  type MemorySessionContextCheck,
} from "./memory-session-subject.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db.js";

const trustedMemoryAccessFactsBrand: unique symbol = Symbol("openclaw.memory-access-facts");
const trustedMemoryAccessContextBrand: unique symbol = Symbol("openclaw.memory-access-context");

type StoredFacts = Readonly<{
  requestId: string;
  runId: string;
  actor: MemoryActorEvidence;
  verifiedPrincipals: readonly VerifiedPrincipalRef[];
  collaboration: MemoryAccessContext["collaboration"];
  verifiedMemberships: readonly MemoryVerifiedMembership[];
  delivery: MemoryAccessContext["delivery"];
  delegation?: MemoryAccessContext["delegation"];
  operation: MemoryOperation;
  hostFactsRevision: string;
}>;

/**
 * Opaque host-fact receipt. Core runtime owners create it before calling the
 * factory; serializable caller/model data and lookalikes cannot mint one.
 */
export type TrustedMemoryAccessFacts = Readonly<{
  readonly [trustedMemoryAccessFactsBrand]: true;
}>;

/** A frozen, process-local authorization context for a single protected operation. */
export type TrustedMemoryAccessContext = Readonly<{
  readonly [trustedMemoryAccessContextBrand]: true;
  operation: MemoryOperation;
  fingerprint: string;
}>;

export type MemoryAccessContextCheck =
  | Readonly<{ kind: "current"; context: TrustedMemoryAccessContext }>
  | Exclude<MemorySessionContextCheck, { kind: "current" }>
  | Readonly<{ kind: "invalid-context" }>;

const factsByReceipt = new WeakMap<object, StoredFacts>();
const trustedContexts = new WeakSet<object>();
const sourceContexts = new WeakMap<
  object,
  Readonly<{
    sessionKey: string;
    sessionId: string;
    options: OpenClawAgentDatabaseOptions;
  }>
>();
const factsByContext = new WeakMap<object, StoredFacts>();

const MEMORY_AUDIENCE_KINDS = new Set<AudienceRef["kind"]>([
  "user",
  "conversation",
  "role",
  "agent-shared",
  "agent",
  "internal",
]);

const MEMORY_ASSURANCES = new Set<VerifiedPrincipalRef["assurance"]>([
  "gateway-profile",
  "adapter-attested",
  "oidc",
  "service",
]);

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must not be empty`);
  }
  return value.trim();
}

function normalizeAudience(value: unknown): AudienceRef {
  if (!value || typeof value !== "object") {
    throw new TypeError("delivery audience must be an object");
  }
  const record = value as { kind?: unknown; id?: unknown };
  const kind = requireText(record.kind, "audience.kind") as AudienceRef["kind"];
  if (!MEMORY_AUDIENCE_KINDS.has(kind)) {
    throw new TypeError("audience.kind is unsupported");
  }
  return Object.freeze({
    kind,
    id: requireText(record.id, "audience.id"),
  });
}

function normalizeAudiences(value: readonly unknown[]): readonly AudienceRef[] {
  if (!Array.isArray(value)) {
    throw new TypeError("delivery.audiences must be an array");
  }
  const unique = new Map<string, AudienceRef>();
  for (const entry of value) {
    const audience = normalizeAudience(entry);
    unique.set(`${audience.kind}\u0000${audience.id}`, audience);
  }
  return Object.freeze(
    [...unique.values()].toSorted((a, b) => {
      const left = `${a.kind}\u0000${a.id}`;
      const right = `${b.kind}\u0000${b.id}`;
      return left < right ? -1 : left > right ? 1 : 0;
    }),
  );
}

function normalizeOptionalIsoDate(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = requireText(value, label);
  if (!Number.isFinite(Date.parse(normalized))) {
    throw new TypeError(`${label} must be an ISO date`);
  }
  return normalized;
}

function normalizeActor(value: MemoryActorEvidence): MemoryActorEvidence {
  if (value.kind === "principal") {
    if (!(["human", "agent", "service", "system"] as const).includes(value.actorKind)) {
      throw new TypeError("actor.actorKind is unsupported");
    }
    if (!MEMORY_ASSURANCES.has(value.assurance)) {
      throw new TypeError("actor.assurance is unsupported");
    }
    const expiresAt = normalizeOptionalIsoDate(value.expiresAt, "actor.expiresAt");
    return Object.freeze({
      kind: "principal",
      actorKind: value.actorKind,
      principalId: requireText(value.principalId, "actor.principalId"),
      assurance: value.assurance,
      evidenceRevision: requireText(value.evidenceRevision, "actor.evidenceRevision"),
      ...(expiresAt ? { expiresAt } : {}),
    });
  }
  return Object.freeze({
    kind: "unattributed",
    transportAuditRef: requireText(value.transportAuditRef, "actor.transportAuditRef"),
    evidenceRevision: requireText(value.evidenceRevision, "actor.evidenceRevision"),
  });
}

function normalizeVerifiedPrincipals(
  values: readonly VerifiedPrincipalRef[],
): readonly VerifiedPrincipalRef[] {
  const unique = new Map<string, VerifiedPrincipalRef>();
  for (const value of values) {
    if (!MEMORY_ASSURANCES.has(value.assurance)) {
      throw new TypeError("verified principal assurance is unsupported");
    }
    const expiresAt = normalizeOptionalIsoDate(value.expiresAt, "verifiedPrincipal.expiresAt");
    const principal = Object.freeze({
      principalId: requireText(value.principalId, "verifiedPrincipal.principalId"),
      assurance: value.assurance,
      evidenceRevision: requireText(value.evidenceRevision, "verifiedPrincipal.evidenceRevision"),
      ...(expiresAt ? { expiresAt } : {}),
    }) satisfies VerifiedPrincipalRef;
    unique.set(`${principal.principalId}\u0000${principal.evidenceRevision}`, principal);
  }
  return Object.freeze(
    [...unique.values()].toSorted((left, right) =>
      `${left.principalId}\u0000${left.evidenceRevision}`.localeCompare(
        `${right.principalId}\u0000${right.evidenceRevision}`,
      ),
    ),
  );
}

function normalizeMemberships(
  values: readonly MemoryVerifiedMembership[],
): readonly MemoryVerifiedMembership[] {
  const unique = new Map<string, MemoryVerifiedMembership>();
  for (const value of values) {
    const membership = Object.freeze({
      principalId: requireText(value.principalId, "membership.principalId"),
      groupId: requireText(value.groupId, "membership.groupId"),
      provider: requireText(value.provider, "membership.provider"),
      evidenceRevision: requireText(value.evidenceRevision, "membership.evidenceRevision"),
      observedAt: requireText(value.observedAt, "membership.observedAt"),
      expiresAt: requireText(value.expiresAt, "membership.expiresAt"),
    }) satisfies MemoryVerifiedMembership;
    if (
      !Number.isFinite(Date.parse(membership.observedAt)) ||
      !Number.isFinite(Date.parse(membership.expiresAt))
    ) {
      throw new TypeError("membership timestamps must be ISO dates");
    }
    unique.set(
      `${membership.principalId}\u0000${membership.groupId}\u0000${membership.provider}`,
      membership,
    );
  }
  return Object.freeze(
    [...unique.values()].toSorted((left, right) =>
      `${left.principalId}\u0000${left.groupId}\u0000${left.provider}`.localeCompare(
        `${right.principalId}\u0000${right.groupId}\u0000${right.provider}`,
      ),
    ),
  );
}

function normalizeCollaboration(
  value: MemoryAccessContext["collaboration"],
): MemoryAccessContext["collaboration"] {
  if (value.kind === "not-applicable") {
    return Object.freeze({ kind: "not-applicable" as const });
  }
  if (
    !(["shared", "read-only", "suggest", "draft"] as const).includes(value.mode) ||
    !(["admin", "owner", "member", "viewer"] as const).includes(value.role)
  ) {
    throw new TypeError("collaboration decision is unsupported");
  }
  return Object.freeze({
    kind: "gateway-session" as const,
    mode: value.mode,
    role: value.role,
    decisionRevision: requireText(value.decisionRevision, "collaboration.decisionRevision"),
  });
}

function normalizeOperations(
  value: readonly MemoryOperation[],
  label: string,
): readonly MemoryOperation[] {
  return Object.freeze(
    [...new Set(value.map((operation) => requireText(operation, label) as MemoryOperation))]
      .filter((operation) => MEMORY_OPERATIONS.includes(operation))
      .toSorted(),
  );
}

function normalizeDelegation(
  value: NonNullable<MemoryAccessContext["delegation"]>,
): NonNullable<MemoryAccessContext["delegation"]> {
  const operations = normalizeOperations(value.allowedOperations, "delegation.allowedOperation");
  if (operations.length !== value.allowedOperations.length) {
    throw new TypeError("delegation.allowedOperations contains an unsupported operation");
  }
  if (!Number.isSafeInteger(value.depth) || value.depth < 0) {
    throw new TypeError("delegation.depth must be a nonnegative integer");
  }
  return Object.freeze({
    rootPrincipalId: requireText(value.rootPrincipalId, "delegation.rootPrincipalId"),
    rootContextId: requireText(value.rootContextId, "delegation.rootContextId"),
    parentContextId: requireText(value.parentContextId, "delegation.parentContextId"),
    parentMemoryPlanId: requireText(value.parentMemoryPlanId, "delegation.parentMemoryPlanId"),
    capabilitySnapshotId: requireText(
      value.capabilitySnapshotId,
      "delegation.capabilitySnapshotId",
    ),
    allowedOperations: operations,
    maximumAudiences: normalizeAudiences(value.maximumAudiences),
    storeCapToken: requireText(value.storeCapToken, "delegation.storeCapToken"),
    depth: value.depth,
  });
}

function isCurrentEvidenceExpiry(expiresAt: string | undefined, nowMs: number): boolean {
  return expiresAt === undefined || Date.parse(expiresAt) > nowMs;
}

function hasCurrentPrincipalEvidence(params: {
  principalId: string;
  evidenceRevision: string;
  principals: readonly VerifiedPrincipalRef[];
  nowMs: number;
}): boolean {
  return params.principals.some(
    (principal) =>
      principal.principalId === params.principalId &&
      principal.evidenceRevision === params.evidenceRevision &&
      isCurrentEvidenceExpiry(principal.expiresAt, params.nowMs),
  );
}

function readSessionMemorySubject(params: {
  session: CurrentMemorySessionContext;
  facts: StoredFacts;
  options: OpenClawAgentDatabaseOptions;
}): SessionMemorySubject | undefined {
  const { session } = params;
  const nowMs = Date.now();
  if (
    params.facts.actor.kind === "principal" &&
    !isCurrentEvidenceExpiry(params.facts.actor.expiresAt, nowMs)
  ) {
    return undefined;
  }
  if (session.subject.kind === "user") {
    if (!session.bindingId) {
      return undefined;
    }
    const binding = recheckMemoryIdentityBinding({
      bindingId: session.bindingId,
      options: params.options,
    });
    if (binding.kind !== "current" || binding.binding.principalId !== session.principalId) {
      return undefined;
    }
    if (
      !hasCurrentPrincipalEvidence({
        principalId: session.principalId,
        evidenceRevision: binding.binding.evidenceRevision,
        principals: params.facts.verifiedPrincipals,
        nowMs,
      })
    ) {
      return undefined;
    }
    return Object.freeze({
      version: 1 as const,
      kind: "user" as const,
      principalId: session.principalId,
      creationEvidence: Object.freeze({
        kind: "channel-binding" as const,
        revision: binding.binding.evidenceRevision,
      }),
    });
  }
  if (session.subject.kind === "conversation") {
    const conversation = session.conversation;
    if (!conversation) {
      return undefined;
    }
    // The subject owner is the persisted conversation principal. Sender fields never enter this
    // projection, so the latest group actor cannot acquire a role or private store through it.
    return Object.freeze({
      version: 1 as const,
      kind: "conversation" as const,
      conversationPrincipalId: session.principalId,
      channel: conversation.channel,
      accountId: conversation.accountId,
    });
  }
  if (
    session.subject.kind === "service" ||
    session.subject.kind === "agent" ||
    session.subject.kind === "system"
  ) {
    if (
      !hasCurrentPrincipalEvidence({
        principalId: session.principalId,
        evidenceRevision: session.authorityRevision,
        principals: params.facts.verifiedPrincipals,
        nowMs,
      })
    ) {
      return undefined;
    }
    return Object.freeze({
      version: 1 as const,
      kind: session.subject.kind,
      principalId: session.principalId,
    });
  }
  return undefined;
}

/**
 * This narrow capture point is core-only. It validates and freezes the facts
 * before they cross into the protected-memory path, rather than accepting a
 * caller-assembled DTO at the factory boundary.
 */
export function captureTrustedMemoryAccessFacts(params: {
  requestId: string;
  runId: string;
  actor: MemoryActorEvidence;
  verifiedPrincipals: readonly VerifiedPrincipalRef[];
  collaboration: MemoryAccessContext["collaboration"];
  verifiedMemberships: readonly MemoryVerifiedMembership[];
  delivery: {
    sink: "private" | "channel" | "session" | "internal";
    audiences: readonly AudienceRef[];
    routeRevision: string;
    egressCapabilityIds: readonly string[];
    egressRegistryRevision: string;
  };
  delegation?: MemoryAccessContext["delegation"];
  operation: MemoryOperation;
  hostFactsRevision: string;
}): TrustedMemoryAccessFacts {
  if (!MEMORY_OPERATIONS.includes(params.operation)) {
    throw new TypeError("operation must be a supported memory operation");
  }
  if (!(["private", "channel", "session", "internal"] as const).includes(params.delivery.sink)) {
    throw new TypeError("delivery.sink must be a supported sink");
  }
  const facts: StoredFacts = Object.freeze({
    requestId: requireText(params.requestId, "requestId"),
    runId: requireText(params.runId, "runId"),
    actor: normalizeActor(params.actor),
    verifiedPrincipals: normalizeVerifiedPrincipals(params.verifiedPrincipals),
    collaboration: normalizeCollaboration(params.collaboration),
    verifiedMemberships: normalizeMemberships(params.verifiedMemberships),
    delivery: Object.freeze({
      sinkKind: params.delivery.sink,
      audiences: normalizeAudiences(params.delivery.audiences),
      egressCapabilityIds: Object.freeze(
        [
          ...new Set(
            params.delivery.egressCapabilityIds.map((id) =>
              requireText(id, "delivery.egressCapabilityId"),
            ),
          ),
        ].toSorted(),
      ),
      egressRegistryRevision: requireText(
        params.delivery.egressRegistryRevision,
        "delivery.egressRegistryRevision",
      ),
      deliveryRevision: requireText(params.delivery.routeRevision, "delivery.routeRevision"),
    }),
    ...(params.delegation ? { delegation: normalizeDelegation(params.delegation) } : {}),
    operation: params.operation,
    hostFactsRevision: requireText(params.hostFactsRevision, "hostFactsRevision"),
  });
  const receipt = Object.freeze(
    Object.defineProperty(Object.create(null), trustedMemoryAccessFactsBrand, {
      value: true,
      enumerable: false,
    }),
  ) as TrustedMemoryAccessFacts;
  factsByReceipt.set(receipt, facts);
  return receipt;
}

function fingerprint(session: CurrentMemorySessionContext, facts: StoredFacts): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        session: {
          fingerprint: session.fingerprint,
        },
        facts,
      }),
    )
    .digest("base64url");
}

/**
 * The sole protected-context factory. It rechecks the current node mapping and
 * identity binding immediately before minting, and accepts only an opaque
 * core-captured fact receipt.
 */
export function createTrustedMemoryAccessContext(params: {
  sessionKey: string;
  sessionId: string;
  options: OpenClawAgentDatabaseOptions;
  facts: TrustedMemoryAccessFacts;
}): MemoryAccessContextCheck {
  const facts = factsByReceipt.get(params.facts);
  if (!facts) {
    return { kind: "invalid-context" };
  }
  const session = createCurrentMemorySessionContext({
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    options: params.options,
  });
  if (session.kind !== "current") {
    return session;
  }
  if (!isCurrentMemorySessionContext(session.context)) {
    return { kind: "invalid-context" };
  }
  const context = Object.freeze({
    [trustedMemoryAccessContextBrand]: true,
    operation: facts.operation,
    fingerprint: fingerprint(session.context, facts),
  }) as TrustedMemoryAccessContext;
  trustedContexts.add(context);
  factsByContext.set(context, facts);
  sourceContexts.set(
    context,
    Object.freeze({
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      options: params.options,
    }),
  );
  return { kind: "current", context };
}

export function isTrustedMemoryAccessContext(value: unknown): value is TrustedMemoryAccessContext {
  return Boolean(value && typeof value === "object" && trustedContexts.has(value));
}

/** Internal bridge for the selected protected-memory consumer; never an SDK export. */
export function readTrustedMemoryAccessSessionContext(
  context: TrustedMemoryAccessContext,
): CurrentMemorySessionContext | undefined {
  const source = sourceContexts.get(context);
  if (!source) {
    return undefined;
  }
  const current = createCurrentMemorySessionContext(source);
  return current.kind === "current" ? current.context : undefined;
}

/**
 * Core-only materialization for the selected authorization runtime. The opaque input is the
 * authority boundary: callers cannot supply principal, audience, or delivery claims here.
 */
export function materializeTrustedMemoryAccessContext(
  context: TrustedMemoryAccessContext,
): MemoryAccessContext | undefined {
  const facts = factsByContext.get(context);
  const source = sourceContexts.get(context);
  const session = readTrustedMemoryAccessSessionContext(context);
  if (!facts || !source || !session) {
    return undefined;
  }
  const subject = readSessionMemorySubject({ session, facts, options: source.options });
  if (!subject) {
    return undefined;
  }
  const conversation = session.subject.kind === "conversation" ? session.conversation : undefined;
  if (!conversation && session.subject.kind === "conversation") {
    return undefined;
  }
  return Object.freeze({
    version: 1 as const,
    contextId: `mctx1_${context.fingerprint}`,
    contextFingerprint: context.fingerprint,
    requestId: facts.requestId,
    runId: facts.runId,
    agentId: session.agentId,
    sessionKey: session.sessionKey,
    sessionId: session.sessionId,
    sessionIdentityRevision: session.sessionIdentityRevision,
    subjectRevision: session.subjectRevision,
    subject,
    actor: facts.actor,
    verifiedPrincipals: facts.verifiedPrincipals,
    ...(conversation
      ? {
          conversation: Object.freeze({
            conversationPrincipalId: session.principalId,
            channel: conversation.channel,
            accountId: conversation.accountId,
            evidenceRevision: session.authorityRevision,
          }),
        }
      : {}),
    delivery: facts.delivery,
    collaboration: facts.collaboration,
    verifiedMemberships: facts.verifiedMemberships,
    ...(facts.delegation ? { delegation: facts.delegation } : {}),
    operation: facts.operation,
    hostFactsRevision: facts.hostFactsRevision,
  });
}
