import { createHash } from "node:crypto";
import { MEMORY_OPERATIONS, type MemoryOperation } from "../memory-host-sdk/host/authorization.js";
import {
  createCurrentMemorySessionContext,
  isCurrentMemorySessionContext,
  type CurrentMemorySessionContext,
  type MemorySessionContextCheck,
} from "./memory-session-subject.js";
import type { OpenClawAgentDatabaseOptions } from "./openclaw-agent-db.js";

const trustedMemoryAccessFactsBrand: unique symbol = Symbol("openclaw.memory-access-facts");
const trustedMemoryAccessContextBrand: unique symbol = Symbol("openclaw.memory-access-context");

type Audience = Readonly<{ kind: string; id: string }>;
type StoredFacts = Readonly<{
  requestId: string;
  runId: string;
  actorEvidenceRevision: string;
  verifiedPrincipalRevisions: readonly string[];
  collaborationDecisionRevision: string;
  deliverySink: "private" | "channel" | "session" | "internal";
  deliveryAudiences: readonly Audience[];
  deliveryRouteRevision: string;
  delegationSnapshotRevision: string;
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

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must not be empty`);
  }
  return value.trim();
}

function normalizeAudience(value: unknown): Audience {
  if (!value || typeof value !== "object") {
    throw new TypeError("delivery audience must be an object");
  }
  const record = value as { kind?: unknown; id?: unknown };
  return Object.freeze({
    kind: requireText(record.kind, "audience.kind"),
    id: requireText(record.id, "audience.id"),
  });
}

function normalizeAudiences(value: readonly unknown[]): readonly Audience[] {
  if (!Array.isArray(value)) {
    throw new TypeError("delivery.audiences must be an array");
  }
  const unique = new Map<string, Audience>();
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

function normalizeRevisions(value: readonly unknown[], label: string): readonly string[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label}s must be an array`);
  }
  return Object.freeze([...new Set(value.map((entry) => requireText(entry, label)))].toSorted());
}

/**
 * This narrow capture point is core-only. It validates and freezes the facts
 * before they cross into the protected-memory path, rather than accepting a
 * caller-assembled DTO at the factory boundary.
 */
export function captureTrustedMemoryAccessFacts(params: {
  requestId: string;
  runId: string;
  actorEvidenceRevision: string;
  verifiedPrincipalRevisions: readonly string[];
  collaborationDecisionRevision: string;
  delivery: {
    sink: "private" | "channel" | "session" | "internal";
    audiences: readonly Audience[];
    routeRevision: string;
  };
  delegationSnapshotRevision: string;
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
    actorEvidenceRevision: requireText(params.actorEvidenceRevision, "actorEvidenceRevision"),
    verifiedPrincipalRevisions: normalizeRevisions(
      params.verifiedPrincipalRevisions,
      "verifiedPrincipalRevision",
    ),
    collaborationDecisionRevision: requireText(
      params.collaborationDecisionRevision,
      "collaborationDecisionRevision",
    ),
    deliverySink: params.delivery.sink,
    deliveryAudiences: normalizeAudiences(params.delivery.audiences),
    deliveryRouteRevision: requireText(params.delivery.routeRevision, "delivery.routeRevision"),
    delegationSnapshotRevision: requireText(
      params.delegationSnapshotRevision,
      "delegationSnapshotRevision",
    ),
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
