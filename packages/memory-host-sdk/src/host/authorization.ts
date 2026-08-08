import type {
  MemoryProviderStatus,
  MemoryReadResult,
  MemorySearchResult,
  MemorySource,
} from "./types.js";

/** Version shared by every serializable multiplayer-memory authorization shape. */
export const MEMORY_AUTHORIZATION_CONTRACT_VERSION = 1 as const;

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
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

export const MEMORY_AUTHORIZATION_CAPABILITY_NAMES = [
  "scopedCandidates",
  "exactReadByAuthorizedHandle",
  "scopedSync",
  "scopedWrite",
  "scopedImport",
  "scopedExport",
  "scopedStatus",
  "exposureReceipts",
  "egressReceipts",
] as const;

export type MemoryAuthorizationCapabilityName =
  (typeof MEMORY_AUTHORIZATION_CAPABILITY_NAMES)[number];

export type MemoryAuthorizationCapabilities = Readonly<
  {
    version: 1;
  } & Record<MemoryAuthorizationCapabilityName, boolean>
>;

export function isMemoryAuthorizationCapabilities(
  value: unknown,
): value is MemoryAuthorizationCapabilities {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.version === MEMORY_AUTHORIZATION_CONTRACT_VERSION &&
    MEMORY_AUTHORIZATION_CAPABILITY_NAMES.every((name) => typeof record[name] === "boolean")
  );
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
  if (!isMemoryAuthorizationCapabilities(capabilities)) {
    return [...MEMORY_AUTHORIZATION_CAPABILITY_NAMES];
  }
  return MEMORY_AUTHORIZATION_CAPABILITY_NAMES.filter((name) => !capabilities[name]);
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
        placementHandle: string;
      }>)
  | (AuthorizedMemoryContentMutation &
      Readonly<{
        kind: "derive";
        placementHandle: string;
        sourceHandles: readonly AuthorizedResourceHandle[];
        sourcePolicySetId: string;
      }>)
  | Readonly<{
      version: 1;
      kind: "project" | "publish";
      mutationId: string;
      idempotencyKey: string;
      sourceHandles: readonly AuthorizedResourceHandle[];
      destinationHandle: string;
    }>
  | Readonly<{
      version: 1;
      kind: "delete";
      mutationId: string;
      idempotencyKey: string;
      target: AuthorizedResourceHandle;
    }>;

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

export interface AuthorizedMemoryRuntime {
  readonly authorization: MemoryAuthorizationCapabilities;
  authorize(context: MemoryAccessContext): Promise<AuthorizedMemoryPlan>;
  searchAuthorized(params: {
    context: MemoryAccessContext;
    plan: AuthorizedMemoryPlan;
    query: string;
    subjectHandles?: readonly string[];
    sources?: readonly MemorySource[];
    limit: number;
    signal?: AbortSignal;
  }): Promise<AuthorizedMemoryResultEnvelope<readonly MemorySearchResult[]>>;
  readAuthorized(params: {
    context: MemoryAccessContext;
    plan: AuthorizedMemoryPlan;
    handle: AuthorizedResourceHandle;
    from?: number;
    lines?: number;
  }): Promise<AuthorizedMemoryResultEnvelope<MemoryReadResult>>;
  writeAuthorized(params: {
    context: MemoryAccessContext;
    plan: AuthorizedMemoryPlan;
    mutation: AuthorizedMemoryMutation;
  }): Promise<MemoryWriteResult>;
  importAuthorized(params: {
    context: MemoryAccessContext;
    plan: AuthorizedMemoryPlan;
    mutation: Extract<AuthorizedMemoryMutation, { kind: "import" }>;
  }): Promise<MemoryWriteResult>;
  syncAuthorized(params: {
    context: MemoryAccessContext;
    plan: AuthorizedMemoryPlan;
  }): Promise<AuthorizedMemoryResultEnvelope<MemorySyncResult>>;
  exportAuthorized(params: {
    context: MemoryAccessContext;
    plan: AuthorizedMemoryPlan;
    handles: readonly AuthorizedResourceHandle[];
  }): Promise<AuthorizedMemoryResultEnvelope<MemoryExportResult>>;
  statusAuthorized(params: {
    context: MemoryAccessContext;
    plan: AuthorizedMemoryPlan;
  }): Promise<AuthorizedMemoryResultEnvelope<MemoryProviderStatus>>;
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
