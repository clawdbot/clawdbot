import { stableStringify } from "@openclaw/normalization-core";
/** Core-only trusted memory access-context construction and admission. */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { sha256Hex } from "../infra/crypto-digest.js";
import {
  MEMORY_OPERATIONS,
  hasCompleteMemoryAuthorizationCapabilities,
  type AudienceRef,
  type AuthorizedMemoryMount,
  type AuthorizedMemoryPlan,
  type AuthorizedMemoryRuntime,
  type AuthorizedResourceHandle,
  type MemoryAccessContext,
  type MemoryActorEvidence,
  type MemoryAuthorizationReasonCode,
  type MemoryOperation,
  type MemoryVerifiedMembership,
  type SessionMemorySubject,
  type VerifiedPrincipalRef,
} from "../memory-host-sdk/host/authorization.js";

const memoryAccessContextBrand: unique symbol = Symbol("openclaw.memory-access-context");
const authorizedMemoryPlanBrand: unique symbol = Symbol("openclaw.authorized-memory-plan");
const authorizedMemoryRuntimeBrand: unique symbol = Symbol("openclaw.authorized-memory-runtime");

const AUDIENCE_KINDS = [
  "user",
  "conversation",
  "role",
  "agent-shared",
  "agent",
  "internal",
] as const;
const ACTOR_KINDS = ["human", "agent", "service", "system"] as const;
const ASSURANCE_KINDS = ["gateway-profile", "adapter-attested", "oidc", "service"] as const;
const SUBJECT_EVIDENCE_KINDS = [
  "gateway-profile",
  "channel-binding",
  "adapter-attested",
  "explicit-service",
] as const;
const COLLABORATION_MODES = ["shared", "read-only", "suggest", "draft"] as const;
const COLLABORATION_ROLES = ["admin", "owner", "member", "viewer"] as const;
const DELIVERY_SINK_KINDS = ["private", "channel", "session", "internal"] as const;
const AUTHORIZED_MEMORY_RUNTIME_METHODS = [
  "authorize",
  "searchAuthorized",
  "readAuthorized",
  "writeAuthorized",
  "importAuthorized",
  "syncAuthorized",
  "exportAuthorized",
  "statusAuthorized",
] as const satisfies readonly (keyof AuthorizedMemoryRuntime)[];

type MemoryAccessContextDraft = Omit<MemoryAccessContext, "contextFingerprint" | "version">;

export type MemoryAccessContextFacts = Readonly<MemoryAccessContextDraft>;

export type MemorySessionIdentitySnapshot = Readonly<{
  sessionId: string;
  sessionIdentityRevision: string;
}>;

export type MemoryAccessContextFactoryDependencies = Readonly<{
  /** Reads the canonical logical-session mapping without accepting a cached snapshot. */
  readCurrentSessionIdentity(params: {
    agentId: string;
    sessionKey: string;
    readConsistency: "latest";
  }): Promise<MemorySessionIdentitySnapshot | null>;
  now?: () => number;
}>;

/**
 * Opaque in-process handle. The normalized P0A DTO stays in a private WeakMap so model,
 * tool, plugin, and caller values cannot inspect or recreate authority-bearing facts.
 */
export type TrustedMemoryAccessContext = Readonly<{
  version: 1;
  operation: MemoryOperation;
  contextFingerprint: string;
}>;

/** Opaque in-process handle for a plugin plan admitted against one trusted context. */
export type TrustedAuthorizedMemoryPlan = Readonly<{
  version: 1;
  operation: MemoryOperation;
  contextFingerprint: string;
}>;

/** Structural-only P0B admission receipt; it intentionally exposes no runtime object. */
export type AdmittedMemoryAuthorizationRuntime = Readonly<{
  version: 1;
  operation: MemoryOperation;
  contextFingerprint: string;
}>;

export type MemoryAccessContextFailureCode = Extract<
  MemoryAuthorizationReasonCode,
  | "invalid-context"
  | "session-rebound"
  | "delivery-rebound"
  | "plan-expired"
  | "identity-revoked"
  | "membership-stale"
  | "revision-stale"
  | "outside-view"
>;

type MemoryRuntimeAdmissionFailureCode = Extract<
  MemoryAuthorizationReasonCode,
  "invalid-context" | "backend-nonconforming"
>;

const trustedMemoryAccessContexts = new WeakSet<TrustedMemoryAccessContext>();
const privateMemoryAccessContextDtos = new WeakMap<
  TrustedMemoryAccessContext,
  MemoryAccessContext
>();
const trustedAuthorizedMemoryPlans = new WeakSet<TrustedAuthorizedMemoryPlan>();
const privateAuthorizedMemoryPlanDtos = new WeakMap<
  TrustedAuthorizedMemoryPlan,
  AuthorizedMemoryPlan
>();
const admittedMemoryAuthorizationRuntimes = new WeakSet<AdmittedMemoryAuthorizationRuntime>();

class MemoryAccessContextFailure extends Error {
  readonly code: MemoryAccessContextFailureCode;

  constructor(code: MemoryAccessContextFailureCode) {
    super(code);
    this.code = code;
  }
}

function fail(code: MemoryAccessContextFailureCode = "invalid-context"): never {
  throw new MemoryAccessContextFailure(code);
}

function failureCode(error: unknown): MemoryAccessContextFailureCode {
  return error instanceof MemoryAccessContextFailure ? error.code : "invalid-context";
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    fail();
  }
  return value;
}

function requireText(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail();
  }
  return value;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail();
  }
  return value as T;
}

function requireNow(value: number): number {
  if (!Number.isFinite(value)) {
    fail();
  }
  return value;
}

function normalizeTimestamp(
  value: unknown,
  nowMs?: number,
  code?: MemoryAccessContextFailureCode,
): string {
  const text = requireText(value);
  const milliseconds = Date.parse(text);
  if (!Number.isFinite(milliseconds)) {
    fail();
  }
  if (nowMs !== undefined && milliseconds <= nowMs) {
    fail(code);
  }
  return new Date(milliseconds).toISOString();
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function audienceKey(value: AudienceRef): string {
  return `${value.kind}\0${value.id}`;
}

function normalizeSet<T>(values: readonly T[], key: (value: T) => string): T[] {
  const unique = new Map<string, T>();
  for (const value of values) {
    unique.set(key(value), value);
  }
  return [...unique.entries()]
    .toSorted(([left], [right]) => compareText(left, right))
    .map(([, value]) => value);
}

/** Host identity facts are authoritative claims, so an ambiguous duplicate must not be merged. */
function normalizeUniqueSet<T>(values: readonly T[], key: (value: T) => string): T[] {
  const unique = new Map<string, T>();
  for (const value of values) {
    const valueKey = key(value);
    if (unique.has(valueKey)) {
      fail();
    }
    unique.set(valueKey, value);
  }
  return [...unique.entries()]
    .toSorted(([left], [right]) => compareText(left, right))
    .map(([, value]) => value);
}

function normalizeAudience(value: unknown): AudienceRef {
  const record = requireRecord(value);
  return {
    kind: requireEnum(record.kind, AUDIENCE_KINDS),
    id: requireText(record.id),
  };
}

function normalizeAudiences(value: unknown): AudienceRef[] {
  if (!Array.isArray(value)) {
    fail();
  }
  return normalizeSet(value.map(normalizeAudience), audienceKey);
}

function normalizeOperations(value: unknown): MemoryOperation[] {
  if (!Array.isArray(value)) {
    fail();
  }
  return normalizeSet(
    value.map((entry) => requireEnum(entry, MEMORY_OPERATIONS)),
    (operation) => operation,
  );
}

function normalizeStringSet(value: unknown): string[] {
  if (!Array.isArray(value)) {
    fail();
  }
  return normalizeSet(value.map(requireText), (entry) => entry);
}

function normalizeSubject(value: unknown): SessionMemorySubject {
  const record = requireRecord(value);
  if (record.version !== 1) {
    fail();
  }
  switch (record.kind) {
    case "user": {
      const creationEvidence = requireRecord(record.creationEvidence);
      return {
        version: 1,
        kind: "user",
        principalId: requireText(record.principalId),
        creationEvidence: {
          kind: requireEnum(creationEvidence.kind, SUBJECT_EVIDENCE_KINDS),
          revision: requireText(creationEvidence.revision),
        },
      };
    }
    case "conversation":
      return {
        version: 1,
        kind: "conversation",
        conversationPrincipalId: requireText(record.conversationPrincipalId),
        channel: requireText(record.channel),
        accountId: requireText(record.accountId),
      };
    case "service":
    case "agent":
    case "system":
      return {
        version: 1,
        kind: record.kind,
        principalId: requireText(record.principalId),
      };
    // A durable subject is a prerequisite for a trusted access context. An unattributed actor
    // may accompany it, but it must never turn an ambiguous session into a private principal.
    case "ambiguous":
      return fail();
    default:
      return fail();
  }
}

function normalizeActor(value: unknown, nowMs: number): MemoryActorEvidence {
  const record = requireRecord(value);
  if (record.kind === "unattributed") {
    return {
      kind: "unattributed",
      transportAuditRef: requireText(record.transportAuditRef),
      evidenceRevision: requireText(record.evidenceRevision),
    };
  }
  if (record.kind !== "principal") {
    fail();
  }
  const expiresAt =
    record.expiresAt === undefined
      ? undefined
      : normalizeTimestamp(record.expiresAt, nowMs, "identity-revoked");
  return {
    kind: "principal",
    actorKind: requireEnum(record.actorKind, ACTOR_KINDS),
    principalId: requireText(record.principalId),
    assurance: requireEnum(record.assurance, ASSURANCE_KINDS),
    evidenceRevision: requireText(record.evidenceRevision),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
}

function normalizeVerifiedPrincipals(value: unknown, nowMs: number): VerifiedPrincipalRef[] {
  if (!Array.isArray(value)) {
    fail();
  }
  const principals = value.map((entry) => {
    const record = requireRecord(entry);
    const expiresAt =
      record.expiresAt === undefined
        ? undefined
        : normalizeTimestamp(record.expiresAt, nowMs, "identity-revoked");
    return {
      principalId: requireText(record.principalId),
      assurance: requireEnum(record.assurance, ASSURANCE_KINDS),
      evidenceRevision: requireText(record.evidenceRevision),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    } satisfies VerifiedPrincipalRef;
  });
  return normalizeUniqueSet(
    principals,
    // A context principal maps to exactly one current host fact. Different evidence revisions
    // for the same principal are ambiguous rather than a priority order the caller may choose.
    (principal) => principal.principalId,
  );
}

function normalizeConversation(value: unknown): MemoryAccessContext["conversation"] {
  if (value === undefined) {
    return undefined;
  }
  const record = requireRecord(value);
  return {
    conversationPrincipalId: requireText(record.conversationPrincipalId),
    channel: requireText(record.channel),
    accountId: requireText(record.accountId),
    evidenceRevision: requireText(record.evidenceRevision),
  };
}

function normalizeDelivery(value: unknown): MemoryAccessContext["delivery"] {
  const record = requireRecord(value);
  return {
    sinkKind: requireEnum(record.sinkKind, DELIVERY_SINK_KINDS),
    audiences: normalizeAudiences(record.audiences),
    egressCapabilityIds: normalizeStringSet(record.egressCapabilityIds),
    egressRegistryRevision: requireText(record.egressRegistryRevision),
    deliveryRevision: requireText(record.deliveryRevision),
  };
}

function normalizeCollaboration(value: unknown): MemoryAccessContext["collaboration"] {
  const record = requireRecord(value);
  if (record.kind === "not-applicable") {
    return { kind: "not-applicable" };
  }
  if (record.kind !== "gateway-session") {
    fail();
  }
  return {
    kind: "gateway-session",
    mode: requireEnum(record.mode, COLLABORATION_MODES),
    role: requireEnum(record.role, COLLABORATION_ROLES),
    decisionRevision: requireText(record.decisionRevision),
  };
}

function normalizeMemberships(value: unknown, nowMs: number): MemoryVerifiedMembership[] {
  if (!Array.isArray(value)) {
    fail();
  }
  const memberships: MemoryVerifiedMembership[] = [];
  for (const entry of value) {
    const record = requireRecord(entry);
    const expiresAt = normalizeTimestamp(record.expiresAt);
    // Only a selected mount can know whether membership is required. Remove stale facts here so
    // an unrelated expired group does not deny the whole context; a required missing fact denies
    // later in policy evaluation.
    if (Date.parse(expiresAt) <= nowMs) {
      continue;
    }
    memberships.push({
      principalId: requireText(record.principalId),
      groupId: requireText(record.groupId),
      provider: requireText(record.provider),
      evidenceRevision: requireText(record.evidenceRevision),
      observedAt: normalizeTimestamp(record.observedAt),
      expiresAt,
    });
  }
  return normalizeUniqueSet(
    memberships,
    // A selected mount matches membership by principal, group, and provider, not by a caller's
    // preferred evidence revision. Keep that exact one-fact invariant at the core boundary.
    (membership) => [membership.principalId, membership.groupId, membership.provider].join("\0"),
  );
}

function normalizeDelegation(value: unknown): MemoryAccessContext["delegation"] {
  if (value === undefined) {
    return undefined;
  }
  const record = requireRecord(value);
  const depth = record.depth;
  if (!Number.isInteger(depth) || depth < 1) {
    fail();
  }
  return {
    rootPrincipalId: requireText(record.rootPrincipalId),
    rootContextId: requireText(record.rootContextId),
    parentContextId: requireText(record.parentContextId),
    parentMemoryPlanId: requireText(record.parentMemoryPlanId),
    capabilitySnapshotId: requireText(record.capabilitySnapshotId),
    allowedOperations: normalizeOperations(record.allowedOperations),
    maximumAudiences: normalizeAudiences(record.maximumAudiences),
    storeCapToken: requireText(record.storeCapToken),
    depth,
  };
}

function normalizeMemoryAccessContext(
  facts: unknown,
  nowMs: number,
): Omit<MemoryAccessContext, "contextFingerprint"> {
  const record = requireRecord(facts);
  const conversation = normalizeConversation(record.conversation);
  const delegation = normalizeDelegation(record.delegation);
  return {
    version: 1,
    contextId: requireText(record.contextId),
    requestId: requireText(record.requestId),
    runId: requireText(record.runId),
    agentId: requireText(record.agentId),
    sessionKey: requireText(record.sessionKey),
    sessionId: requireText(record.sessionId),
    sessionIdentityRevision: requireText(record.sessionIdentityRevision),
    subjectRevision: requireText(record.subjectRevision),
    subject: normalizeSubject(record.subject),
    actor: normalizeActor(record.actor, nowMs),
    // These are independently supplied, verified facts. Do not derive principals from actor,
    // subject, roles, membership rows, or any caller-provided extra field.
    verifiedPrincipals: normalizeVerifiedPrincipals(record.verifiedPrincipals, nowMs),
    ...(conversation === undefined ? {} : { conversation }),
    delivery: normalizeDelivery(record.delivery),
    collaboration: normalizeCollaboration(record.collaboration),
    verifiedMemberships: normalizeMemberships(record.verifiedMemberships, nowMs),
    ...(delegation === undefined ? {} : { delegation }),
    operation: requireEnum(record.operation, MEMORY_OPERATIONS),
    hostFactsRevision: requireText(record.hostFactsRevision),
  };
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) {
    return value;
  }
  seen.add(value);
  for (const nested of Object.values(value)) {
    deepFreeze(nested, seen);
  }
  return Object.freeze(value);
}

function brandAndFreeze<T extends object>(value: T, brand: symbol, trustedValues: WeakSet<T>): T {
  Object.defineProperty(value, brand, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  trustedValues.add(value);
  return deepFreeze(value);
}

function hasTrustedBrand<T extends object>(
  value: unknown,
  brand: symbol,
  trustedValues: WeakSet<T>,
): value is T {
  return (
    typeof value === "object" &&
    value !== null &&
    trustedValues.has(value as T) &&
    (value as Record<PropertyKey, unknown>)[brand] === true &&
    Object.isFrozen(value)
  );
}

function currentIdentityEvidenceExpiryMs(
  context: MemoryAccessContext,
  nowMs: number,
): number | undefined {
  let earliest: number | undefined;
  const include = (expiresAt: string | undefined): void => {
    if (expiresAt === undefined) {
      return;
    }
    const milliseconds = Date.parse(expiresAt);
    if (!Number.isFinite(milliseconds) || milliseconds <= nowMs) {
      fail("identity-revoked");
    }
    earliest = earliest === undefined ? milliseconds : Math.min(earliest, milliseconds);
  };
  if (context.actor.kind === "principal") {
    include(context.actor.expiresAt);
  }
  for (const principal of context.verifiedPrincipals) {
    include(principal.expiresAt);
  }
  return earliest;
}

function normalizeMount(value: unknown, context: MemoryAccessContext): AuthorizedMemoryMount {
  const record = requireRecord(value);
  if (record.version !== 1) {
    fail();
  }
  const agentId = requireText(record.agentId);
  if (agentId !== context.agentId) {
    fail("outside-view");
  }
  return {
    version: 1,
    agentId,
    mountHandle: requireText(record.mountHandle),
    capabilities: normalizeOperations(record.capabilities),
    audienceRevision: requireText(record.audienceRevision),
  };
}

function normalizeResourceHandle(params: {
  value: unknown;
  planId: string;
  contextFingerprint: string;
  policyRevision: string;
  planExpiresAtMs: number;
  nowMs: number;
}): AuthorizedResourceHandle {
  const { contextFingerprint, nowMs, planExpiresAtMs, planId, policyRevision, value } = params;
  const record = requireRecord(value);
  if (record.version !== 1) {
    fail();
  }
  const handlePlanId = requireText(record.planId);
  const handleFingerprint = requireText(record.contextFingerprint);
  const handlePolicyRevision = requireText(record.policyRevision);
  if (
    handlePlanId !== planId ||
    handleFingerprint !== contextFingerprint ||
    handlePolicyRevision !== policyRevision
  ) {
    fail();
  }
  const expiresAt = normalizeTimestamp(record.expiresAt);
  const expiresAtMs = Date.parse(expiresAt);
  if (expiresAtMs <= nowMs || expiresAtMs > planExpiresAtMs) {
    fail("plan-expired");
  }
  return {
    version: 1,
    handleId: requireText(record.handleId),
    planId: handlePlanId,
    contextFingerprint: handleFingerprint,
    resourceRevision: requireText(record.resourceRevision),
    policyRevision: handlePolicyRevision,
    expiresAt,
  };
}

function normalizeAuthorizedMemoryPlan(params: {
  context: MemoryAccessContext;
  plan: unknown;
  nowMs: number;
}): AuthorizedMemoryPlan {
  const { context, nowMs } = params;
  const record = requireRecord(params.plan);
  if (record.version !== 1) {
    fail();
  }
  const contextFingerprint = requireText(record.contextFingerprint);
  const runId = requireText(record.runId);
  if (contextFingerprint !== context.contextFingerprint || runId !== context.runId) {
    // hostFactsRevision is intentionally part of the private context fingerprint. Reusing a plan
    // after current host facts change therefore fails this exact binding comparison.
    fail();
  }
  const agentId = requireText(record.agentId);
  const sessionId = requireText(record.sessionId);
  const operation = requireEnum(record.operation, MEMORY_OPERATIONS);
  if (agentId !== context.agentId || operation !== context.operation) {
    fail("outside-view");
  }
  if (sessionId !== context.sessionId) {
    fail("session-rebound");
  }
  if (
    requireText(record.sessionIdentityRevision) !== context.sessionIdentityRevision ||
    requireText(record.subjectRevision) !== context.subjectRevision
  ) {
    fail("revision-stale");
  }
  if (requireText(record.deliveryRevision) !== context.delivery.deliveryRevision) {
    fail("delivery-rebound");
  }
  const planId = requireText(record.planId);
  const memoryPolicyRevision = requireText(record.memoryPolicyRevision);
  const expiresAt = normalizeTimestamp(record.expiresAt);
  const planExpiresAtMs = Date.parse(expiresAt);
  if (planExpiresAtMs <= nowMs) {
    fail("plan-expired");
  }
  // Membership is mount-specific. This admission boundary has no selected mount requirement, so
  // an unrelated membership must neither deny nor shorten a plan; the selected evaluator checks it.
  const evidenceExpiryMs = currentIdentityEvidenceExpiryMs(context, nowMs);
  if (evidenceExpiryMs !== undefined && planExpiresAtMs > evidenceExpiryMs) {
    fail("plan-expired");
  }
  const allowedEgressAudiences = normalizeAudiences(record.allowedEgressAudiences);
  const contextAudienceKeys = new Set(context.delivery.audiences.map(audienceKey));
  if (allowedEgressAudiences.some((audience) => !contextAudienceKeys.has(audienceKey(audience)))) {
    fail("outside-view");
  }
  if (!Array.isArray(record.mounts) || !Array.isArray(record.bootstrapResourceHandles)) {
    fail();
  }
  const mounts = normalizeSet(
    record.mounts.map((mount) => normalizeMount(mount, context)),
    (mount) =>
      [mount.agentId, mount.mountHandle, mount.capabilities.join(","), mount.audienceRevision].join(
        "\0",
      ),
  );
  const bootstrapResourceHandles = normalizeSet(
    record.bootstrapResourceHandles.map((handle) =>
      normalizeResourceHandle({
        value: handle,
        planId,
        contextFingerprint,
        policyRevision: memoryPolicyRevision,
        planExpiresAtMs,
        nowMs,
      }),
    ),
    (handle) =>
      [
        handle.handleId,
        handle.planId,
        handle.contextFingerprint,
        handle.resourceRevision,
        handle.policyRevision,
        handle.expiresAt,
      ].join("\0"),
  );
  return {
    version: 1,
    planId,
    contextFingerprint,
    runId,
    agentId,
    sessionId,
    sessionIdentityRevision: context.sessionIdentityRevision,
    subjectRevision: context.subjectRevision,
    memoryPolicyRevision,
    deliveryRevision: context.delivery.deliveryRevision,
    operation,
    mounts,
    bootstrapResourceHandles,
    allowedEgressAudiences,
    expiresAt,
  };
}

function hasCompleteAuthorizedMemoryRuntime(value: unknown): value is AuthorizedMemoryRuntime {
  if (!isRecord(value) || !hasCompleteMemoryAuthorizationCapabilities(value.authorization)) {
    return false;
  }
  return AUTHORIZED_MEMORY_RUNTIME_METHODS.every((method) => typeof value[method] === "function");
}

function privateContext(value: unknown): MemoryAccessContext | undefined {
  if (!isTrustedMemoryAccessContext(value)) {
    return undefined;
  }
  return privateMemoryAccessContextDtos.get(value);
}

/**
 * Creates an opaque context only after rereading the canonical session-key mapping at latest
 * consistency. The P0A DTO is normalized and retained only as module-private core state.
 */
export function createMemoryAccessContextFactory(
  dependencies: MemoryAccessContextFactoryDependencies,
): (
  facts: MemoryAccessContextFacts,
) => Promise<Result<TrustedMemoryAccessContext, MemoryAccessContextFailureCode>> {
  return async (facts) => {
    try {
      if (typeof dependencies?.readCurrentSessionIdentity !== "function") {
        fail();
      }
      const nowMs = requireNow(dependencies.now?.() ?? Date.now());
      const normalized = normalizeMemoryAccessContext(facts, nowMs);
      const current = await dependencies.readCurrentSessionIdentity({
        agentId: normalized.agentId,
        sessionKey: normalized.sessionKey,
        readConsistency: "latest",
      });
      if (
        !current ||
        current.sessionId !== normalized.sessionId ||
        current.sessionIdentityRevision !== normalized.sessionIdentityRevision
      ) {
        fail("session-rebound");
      }
      const contextFingerprint = `sha256:${sha256Hex(stableStringify(normalized))}`;
      const dto = deepFreeze({
        ...normalized,
        contextFingerprint,
      } satisfies MemoryAccessContext);
      const context = brandAndFreeze(
        {
          version: 1 as const,
          operation: dto.operation,
          contextFingerprint,
        },
        memoryAccessContextBrand,
        trustedMemoryAccessContexts,
      );
      privateMemoryAccessContextDtos.set(context, dto);
      return ok(context);
    } catch (error) {
      return err(failureCode(error));
    }
  };
}

/** True only for an exact in-process context created by this core-only factory. */
export function isTrustedMemoryAccessContext(value: unknown): value is TrustedMemoryAccessContext {
  return hasTrustedBrand(value, memoryAccessContextBrand, trustedMemoryAccessContexts);
}

/**
 * Core-only plan admission. It copies only declared P0A fields into a private DTO and returns
 * an opaque branded handle, so a plugin-issued JSON object never becomes a host grant by shape.
 */
export function admitAuthorizedMemoryPlan(params: {
  context: unknown;
  plan: unknown;
  now?: () => number;
}): Result<TrustedAuthorizedMemoryPlan, MemoryAccessContextFailureCode> {
  try {
    const context = privateContext(params?.context);
    if (!context) {
      fail();
    }
    const nowMs = requireNow(params.now?.() ?? Date.now());
    const plan = normalizeAuthorizedMemoryPlan({ context, plan: params.plan, nowMs });
    const trustedPlan = brandAndFreeze(
      {
        version: 1 as const,
        operation: plan.operation,
        contextFingerprint: plan.contextFingerprint,
      },
      authorizedMemoryPlanBrand,
      trustedAuthorizedMemoryPlans,
    );
    privateAuthorizedMemoryPlanDtos.set(trustedPlan, deepFreeze(plan));
    return ok(trustedPlan);
  } catch (error) {
    return err(failureCode(error));
  }
}

/** True only for a plan admitted against an exact in-process trusted context. */
export function isTrustedAuthorizedMemoryPlan(
  value: unknown,
): value is TrustedAuthorizedMemoryPlan {
  return hasTrustedBrand(value, authorizedMemoryPlanBrand, trustedAuthorizedMemoryPlans);
}

/**
 * P0B performs a structural runtime check only. It does not call a method, retain the runtime,
 * install a proxy, or wire selected-runtime acquisition into the legacy manager path.
 */
export function admitAuthorizedMemoryRuntime(params: {
  context: unknown;
  runtime: unknown;
}): Result<AdmittedMemoryAuthorizationRuntime, MemoryRuntimeAdmissionFailureCode> {
  const context = privateContext(params?.context);
  if (!context) {
    return err("invalid-context");
  }
  try {
    if (!hasCompleteAuthorizedMemoryRuntime(params.runtime)) {
      return err("backend-nonconforming");
    }
  } catch {
    return err("backend-nonconforming");
  }
  const admission = brandAndFreeze(
    {
      version: 1 as const,
      operation: context.operation,
      contextFingerprint: context.contextFingerprint,
    },
    authorizedMemoryRuntimeBrand,
    admittedMemoryAuthorizationRuntimes,
  );
  return ok(admission);
}

/** True only for an exact in-process structural runtime-admission receipt. */
export function isAdmittedMemoryAuthorizationRuntime(
  value: unknown,
): value is AdmittedMemoryAuthorizationRuntime {
  return hasTrustedBrand(value, authorizedMemoryRuntimeBrand, admittedMemoryAuthorizationRuntimes);
}
