import type { MemoryReadResult, MemorySearchResult, MemorySource } from "./types.js";

/** Version shared by every serializable multiplayer-memory authorization shape. */
export const MEMORY_AUTHORIZATION_CONTRACT_VERSION = 1 as const;

type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

export type SubjectEvidenceRef = Readonly<{
  kind: "gateway-profile" | "channel-binding" | "adapter-attested" | "explicit-service";
  revision: string;
}>;

export type AudienceRef = Readonly<{
  kind: "user" | "conversation" | "role" | "agent-shared" | "agent" | "internal";
  id: string;
}>;

export type VerifiedPrincipalRef = Readonly<{
  principalId: string;
  assurance: "gateway-profile" | "adapter-attested" | "oidc" | "service";
  evidenceRevision: string;
  expiresAt?: string;
}>;

export type SessionMemorySubject =
  | Readonly<{
      version: 1;
      kind: "user";
      principalId: string;
      creationEvidence: SubjectEvidenceRef;
    }>
  | Readonly<{
      version: 1;
      kind: "conversation";
      conversationPrincipalId: string;
      channel: string;
      accountId: string;
    }>
  | Readonly<{
      version: 1;
      kind: "service" | "agent" | "system";
      principalId: string;
    }>
  | Readonly<{
      version: 1;
      kind: "ambiguous";
      reason: "shared-main" | "unbound" | "conflicting-bindings";
    }>;

export const MEMORY_OPERATIONS = [
  "retrieve",
  "read",
  "append",
  "replace",
  "derive",
  "deposit",
  "project",
  "publish",
  "import",
  "export",
  "delete",
  "sync",
  "status",
  "policy-admin",
] as const;

export type MemoryOperation = (typeof MEMORY_OPERATIONS)[number];

export type MemoryActorEvidence =
  | Readonly<{
      kind: "principal";
      actorKind: "human" | "agent" | "service" | "system";
      principalId: string;
      assurance: VerifiedPrincipalRef["assurance"];
      evidenceRevision: string;
      expiresAt?: string;
    }>
  | Readonly<{
      kind: "unattributed";
      transportAuditRef: string;
      evidenceRevision: string;
    }>;

export type MemoryVerifiedMembership = Readonly<{
  principalId: string;
  groupId: string;
  provider: string;
  evidenceRevision: string;
  observedAt: string;
  expiresAt: string;
}>;

export type MemoryAccessContext = DeepReadonly<{
  version: 1;
  contextId: string;
  contextFingerprint: string;
  requestId: string;
  runId: string;
  agentId: string;
  sessionKey: string;
  sessionId: string;
  sessionIdentityRevision: string;
  subjectRevision: string;
  subject: SessionMemorySubject;
  actor: MemoryActorEvidence;
  verifiedPrincipals: readonly VerifiedPrincipalRef[];
  conversation?: {
    conversationPrincipalId: string;
    channel: string;
    accountId: string;
    evidenceRevision: string;
  };
  delivery: {
    sinkKind: "private" | "channel" | "session" | "internal";
    audiences: readonly AudienceRef[];
    egressCapabilityIds: readonly string[];
    egressRegistryRevision: string;
    deliveryRevision: string;
  };
  collaboration:
    | {
        kind: "gateway-session";
        mode: "shared" | "read-only" | "suggest" | "draft";
        role: "admin" | "owner" | "member" | "viewer";
        decisionRevision: string;
      }
    | { kind: "not-applicable" };
  verifiedMemberships: readonly MemoryVerifiedMembership[];
  delegation?: {
    rootPrincipalId: string;
    rootContextId: string;
    parentContextId: string;
    parentMemoryPlanId: string;
    capabilitySnapshotId: string;
    allowedOperations: readonly MemoryOperation[];
    maximumAudiences: readonly AudienceRef[];
    storeCapToken: string;
    depth: number;
  };
  operation: MemoryOperation;
  hostFactsRevision: string;
}>;

/** Operations whose authorized results may carry memory content outside broker-internal selection. */
export type MemoryContentAccessOperation = Extract<MemoryOperation, "read" | "derive">;

/** A context narrowed to an operation that may receive content-bearing memory results. */
export type MemoryContentAccessContext<
  Operation extends MemoryContentAccessOperation = MemoryContentAccessOperation,
> = MemoryAccessContext &
  Readonly<{
    operation: Operation;
  }>;

export const MEMORY_AUTHORIZATION_CAPABILITY_NAMES = Object.freeze([
  "scopedCandidates",
  "exactReadByAuthorizedHandle",
  "scopedSync",
  "scopedWrite",
  "scopedImport",
  "scopedExport",
  "scopedStatus",
  "exposureReceipts",
  "egressReceipts",
] as const);

export type MemoryAuthorizationCapabilityName =
  (typeof MEMORY_AUTHORIZATION_CAPABILITY_NAMES)[number];

export type MemoryAuthorizationCapabilities = Readonly<
  {
    version: 1;
  } & Record<MemoryAuthorizationCapabilityName, boolean>
>;

/**
 * Reads own data descriptors so plugin capability claims cannot run getters or inherit authority.
 */
function readMemoryAuthorizationCapabilityValues(
  value: unknown,
): Readonly<Record<MemoryAuthorizationCapabilityName, boolean>> | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return undefined;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const expectedKeys = ["version", ...MEMORY_AUTHORIZATION_CAPABILITY_NAMES] as const;
    if (
      Object.getOwnPropertySymbols(value).length > 0 ||
      Object.keys(descriptors).length !== expectedKeys.length ||
      !expectedKeys.every((key) => {
        const descriptor = descriptors[key];
        return descriptor?.enumerable === true && "value" in descriptor;
      })
    ) {
      return undefined;
    }
    if (descriptors.version?.value !== MEMORY_AUTHORIZATION_CONTRACT_VERSION) {
      return undefined;
    }

    const capabilities: Partial<Record<MemoryAuthorizationCapabilityName, boolean>> = {};
    for (const name of MEMORY_AUTHORIZATION_CAPABILITY_NAMES) {
      const capability = descriptors[name]?.value;
      if (typeof capability !== "boolean") {
        return undefined;
      }
      capabilities[name] = capability;
    }
    return capabilities as Readonly<Record<MemoryAuthorizationCapabilityName, boolean>>;
  } catch {
    // Capability declarations are plugin-controlled input; a proxy trap is nonconforming, not fatal.
    return undefined;
  }
}

export function isMemoryAuthorizationCapabilities(
  value: unknown,
): value is MemoryAuthorizationCapabilities {
  return readMemoryAuthorizationCapabilityValues(value) !== undefined;
}

/** Declaration used by a context-free backend during the shadow-only rollout. */
export const LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES = Object.freeze({
  version: MEMORY_AUTHORIZATION_CONTRACT_VERSION,
  scopedCandidates: false,
  exactReadByAuthorizedHandle: false,
  scopedSync: false,
  scopedWrite: false,
  scopedImport: false,
  scopedExport: false,
  scopedStatus: false,
  exposureReceipts: false,
  egressReceipts: false,
}) satisfies MemoryAuthorizationCapabilities;

/** Full capability declaration required before a backend can enter enforced mode. */
export const COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES = Object.freeze({
  version: MEMORY_AUTHORIZATION_CONTRACT_VERSION,
  scopedCandidates: true,
  exactReadByAuthorizedHandle: true,
  scopedSync: true,
  scopedWrite: true,
  scopedImport: true,
  scopedExport: true,
  scopedStatus: true,
  exposureReceipts: true,
  egressReceipts: true,
}) satisfies MemoryAuthorizationCapabilities;

export function listMissingMemoryAuthorizationCapabilities(
  capabilities: unknown,
): MemoryAuthorizationCapabilityName[] {
  const values = readMemoryAuthorizationCapabilityValues(capabilities);
  if (!values) {
    return [...MEMORY_AUTHORIZATION_CAPABILITY_NAMES];
  }
  return MEMORY_AUTHORIZATION_CAPABILITY_NAMES.filter((name) => !values[name]);
}

export function hasCompleteMemoryAuthorizationCapabilities(
  capabilities: unknown,
): capabilities is MemoryAuthorizationCapabilities {
  return listMissingMemoryAuthorizationCapabilities(capabilities).length === 0;
}

export type AuthorizedMemoryMount = DeepReadonly<{
  version: 1;
  agentId: string;
  mountHandle: string;
  capabilities: readonly MemoryOperation[];
  audienceRevision: string;
}>;

/** Plugin-issued, revision-bound reference. It is not a bearer grant or a raw path. */
export type AuthorizedResourceHandle = DeepReadonly<{
  version: 1;
  handleId: string;
  planId: string;
  contextFingerprint: string;
  resourceRevision: string;
  policyRevision: string;
  expiresAt: string;
}>;

/** Content-bearing search hit whose exact-read continuation is bound to the current plan and revision. */
export type AuthorizedMemorySearchResult = DeepReadonly<
  MemorySearchResult & {
    resourceHandle: AuthorizedResourceHandle;
  }
>;

export type AuthorizedMemoryPlan = DeepReadonly<{
  version: 1;
  planId: string;
  contextFingerprint: string;
  runId: string;
  agentId: string;
  sessionId: string;
  sessionIdentityRevision: string;
  subjectRevision: string;
  memoryPolicyRevision: string;
  deliveryRevision: string;
  operation: MemoryOperation;
  mounts: readonly AuthorizedMemoryMount[];
  bootstrapResourceHandles: readonly AuthorizedResourceHandle[];
  allowedEgressAudiences: readonly AudienceRef[];
  expiresAt: string;
}>;

/** A plan narrowed to an operation that may receive content-bearing memory results. */
export type AuthorizedMemoryContentPlan<
  Operation extends MemoryContentAccessOperation = MemoryContentAccessOperation,
> = AuthorizedMemoryPlan &
  Readonly<{
    operation: Operation;
  }>;

type AuthorizedMemoryPlanForOperation<Operation extends MemoryOperation> =
  Operation extends MemoryContentAccessOperation
    ? AuthorizedMemoryContentPlan<Operation>
    : AuthorizedMemoryPlan & Readonly<{ operation: Operation }>;

/** Preserves a context's operation when its plan crosses the SDK boundary. */
export type AuthorizedMemoryPlanForContext<Context extends MemoryAccessContext> =
  Context extends MemoryAccessContext &
    Readonly<{ operation: infer Operation extends MemoryOperation }>
    ? AuthorizedMemoryPlanForOperation<Operation>
    : never;

export type AuthorizedMemorySearchParams<Operation extends MemoryContentAccessOperation> =
  Readonly<{
    context: MemoryContentAccessContext<Operation>;
    plan: AuthorizedMemoryContentPlan<Operation>;
    query: string;
    subjectHandles?: readonly string[];
    sources?: readonly MemorySource[];
    limit: number;
    signal?: AbortSignal;
  }>;

export type AuthorizedMemoryReadParams<Operation extends MemoryContentAccessOperation> = Readonly<{
  context: MemoryContentAccessContext<Operation>;
  plan: AuthorizedMemoryContentPlan<Operation>;
  handle: AuthorizedResourceHandle;
  from?: number;
  lines?: number;
}>;

/** Every authorized method is bound to the operation that produced its plan. */
type AuthorizedMemoryOperationParams<Operation extends MemoryOperation> = Readonly<{
  context: MemoryAccessContext & Readonly<{ operation: Operation }>;
  plan: AuthorizedMemoryPlan & Readonly<{ operation: Operation }>;
}>;

type AuthorizedMemoryContentMutation = Readonly<{
  version: 1;
  mutationId: string;
  idempotencyKey: string;
  content: string;
  contentType: "markdown" | "text" | "json";
}>;

export type AuthorizedMemoryMutation =
  | (AuthorizedMemoryContentMutation &
      Readonly<{
        kind: "append" | "replace";
        target: AuthorizedResourceHandle;
      }>)
  | (AuthorizedMemoryContentMutation &
      Readonly<{
        kind: "import" | "deposit";
      }>)
  | (AuthorizedMemoryContentMutation &
      Readonly<{
        kind: "derive";
        sourceHandles: readonly AuthorizedResourceHandle[];
        sourcePolicySetId: string;
      }>)
  | (AuthorizedMemoryContentMutation &
      Readonly<{
        kind: "project" | "publish";
        sourceHandles: readonly AuthorizedResourceHandle[];
      }>)
  | Readonly<{
      version: 1;
      kind: "delete";
      mutationId: string;
      idempotencyKey: string;
      target: AuthorizedResourceHandle;
    }>;

/** Narrows a grouped mutation discriminant without losing its operation-specific fields. */
type AuthorizedMemoryMutationForOperation<Operation extends AuthorizedMemoryMutation["kind"]> =
  AuthorizedMemoryMutation & Readonly<{ kind: Operation }>;

/** Keep mutation kind, context operation, and plan operation correlated at the SDK boundary. */
type AuthorizedMemoryWriteParams = {
  [Operation in AuthorizedMemoryMutation["kind"]]: AuthorizedMemoryOperationParams<Operation> &
    Readonly<{
      mutation: AuthorizedMemoryMutationForOperation<Operation>;
    }>;
}[AuthorizedMemoryMutation["kind"]];

export type MemoryExposureReceipt = DeepReadonly<{
  version: 1;
  receiptId: string;
  contextFingerprint: string;
  planId: string;
  runId: string;
  runExposureRevision: string;
  sourcePolicySetId: string;
  exposedRevisionHandles: readonly string[];
  recordedAt: string;
}>;

export type MemoryEgressAuthorizationReceipt = DeepReadonly<{
  version: 1;
  receiptId: string;
  contextFingerprint: string;
  planId: string;
  runId: string;
  runExposureRevision: string;
  sourcePolicySetId: string;
  allowedAudiences: readonly AudienceRef[];
  deliveryRevision: string;
  egressRegistryRevision: string;
  expiresAt: string;
}>;

export type AuthorizedMemoryResultEnvelope<T> = DeepReadonly<{
  version: 1;
  value: T;
  exposureReceipt: MemoryExposureReceipt;
  egressReceipt: MemoryEgressAuthorizationReceipt;
}>;

export type MemoryWriteResult = DeepReadonly<{
  version: 1;
  mutationId: string;
  status: "committed" | "unchanged";
  resourceHandle?: AuthorizedResourceHandle;
  policyRevision: string;
  committedAt: string;
}>;

export type MemorySyncResult = DeepReadonly<{
  version: 1;
  status: "completed" | "unchanged";
  synchronizedHandles: readonly AuthorizedResourceHandle[];
}>;

export type MemoryExportResult = DeepReadonly<{
  version: 1;
  exportId: string;
  contentType: "application/json" | "application/x-ndjson" | "text/markdown" | "text/plain";
  encoding: "utf8" | "base64";
  payload: string;
  exportedHandles: readonly AuthorizedResourceHandle[];
}>;

/**
 * Backend-neutral, serializable status projection returned through the authorized runtime.
 * Host-manager diagnostics remain private to their owning backend.
 */
export type AuthorizedMemoryStatus = DeepReadonly<{
  version: 1;
  backend: string;
  provider?: string;
  model?: string;
  files?: number;
  chunks?: number;
  dirty?: boolean;
}>;

export interface AuthorizedMemoryRuntime {
  authorize<Context extends MemoryAccessContext>(
    context: Context,
  ): Promise<AuthorizedMemoryPlanForContext<Context>>;
  searchAuthorized(
    params: AuthorizedMemorySearchParams<"read">,
  ): Promise<AuthorizedMemoryResultEnvelope<readonly AuthorizedMemorySearchResult[]>>;
  searchAuthorized(
    params: AuthorizedMemorySearchParams<"derive">,
  ): Promise<AuthorizedMemoryResultEnvelope<readonly AuthorizedMemorySearchResult[]>>;
  readAuthorized(
    params: AuthorizedMemoryReadParams<"read">,
  ): Promise<AuthorizedMemoryResultEnvelope<MemoryReadResult>>;
  readAuthorized(
    params: AuthorizedMemoryReadParams<"derive">,
  ): Promise<AuthorizedMemoryResultEnvelope<MemoryReadResult>>;
  writeAuthorized(params: AuthorizedMemoryWriteParams): Promise<MemoryWriteResult>;
  importAuthorized(
    params: AuthorizedMemoryOperationParams<"import"> &
      Readonly<{
        mutation: AuthorizedMemoryMutationForOperation<"import">;
      }>,
  ): Promise<MemoryWriteResult>;
  syncAuthorized(
    params: AuthorizedMemoryOperationParams<"sync">,
  ): Promise<AuthorizedMemoryResultEnvelope<MemorySyncResult>>;
  exportAuthorized(
    params: AuthorizedMemoryOperationParams<"export"> &
      Readonly<{
        handles: readonly AuthorizedResourceHandle[];
      }>,
  ): Promise<AuthorizedMemoryResultEnvelope<MemoryExportResult>>;
  statusAuthorized(
    params: AuthorizedMemoryOperationParams<"status">,
  ): Promise<AuthorizedMemoryResultEnvelope<AuthorizedMemoryStatus>>;
}

export type MemoryAuthorizationReasonCode =
  | "invalid-context"
  | "session-rebound"
  | "delivery-rebound"
  | "plan-expired"
  | "identity-revoked"
  | "membership-stale"
  | "outside-view"
  | "revision-stale"
  | "explicit-deny"
  | "default-deny"
  | "lineage-deny"
  | "backend-nonconforming";
