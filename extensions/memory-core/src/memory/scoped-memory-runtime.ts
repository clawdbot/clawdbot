import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AudienceRef,
  AuthorizedMemoryMutation,
  AuthorizedMemoryPlan,
  AuthorizedTranscriptDerivationSource,
  AuthorizedMemoryReadParams,
  AuthorizedMemoryResultEnvelope,
  AuthorizedMemoryRuntime,
  AuthorizedSealedCompactionArtifact,
  AuthorizedSealedCompactionStageParams,
  AuthorizedMemorySearchParams,
  AuthorizedMemorySearchResult,
  AuthorizedMemoryStatus,
  MemoryExportResult,
  MemorySyncResult,
  MemoryWriteResult,
  AuthorizedResourceHandle,
  AuthorizedMemoryVirtualView,
  MemoryAccessContext,
  MemoryContentAccessContext,
} from "openclaw/plugin-sdk/memory-authorization";
import type {
  MemoryReadResult,
  MemorySource,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { MemoryEnterpriseAccessAuditReporter } from "openclaw/plugin-sdk/memory-enterprise-audit-runtime";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
  runSqliteImmediateTransactionSync,
  writeMemoryAccessAudit,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { readScopedMemoryFtsCandidatePage } from "./scoped-memory-candidates.js";
import {
  resolveScopedMemoryArtifactBase,
  type ScopedMemoryDatabase,
  withScopedMemoryDatabase,
} from "./scoped-memory-db.js";
import { evaluateBuiltinScopedMemoryPolicy } from "./scoped-memory-policy.js";
import {
  isBuiltinScopedMemoryRevisionLineageCurrent,
  readBuiltinScopedMemoryRevisionSnapshot,
  resolveBuiltinScopedMemoryArtifactPath,
} from "./scoped-memory-resources.js";
import {
  createBuiltinMemoryProjection,
  expireBuiltinMemoryProjections,
} from "./scoped-memory-sharing.js";
import { createScopedMemorySourcePolicySetId } from "./scoped-memory-store.js";

const PLAN_TTL_MS = 60_000;
const MAXIMUM_CANDIDATES_PER_RESULT = 12;

type AuthorizedStore = Readonly<{
  storeId: string;
  policyRevisionId: string;
  audienceRevision: string;
}>;

type AuthorizedStoreSelection = Readonly<{
  stores: readonly AuthorizedStore[];
  enterpriseRoleDecisions: readonly {
    groupId: string;
    policyId: string;
    decision: "allowed" | "denied";
    reasonCode: string;
    policyRevision: string;
  }[];
}>;

type PlanState = Readonly<{
  contextFingerprint: string;
  context: MemoryAccessContext;
  expiresAtMs: number;
  plan: AuthorizedMemoryPlan;
  stores: readonly AuthorizedStore[];
  handles: Map<string, AuthorizedResourceHandle>;
  exposureRevision: number;
}>;

const plans = new Map<string, PlanState>();
type VirtualViewAllocation = Readonly<{
  planId: string;
  revision: string;
  expiresAtMs: number;
  /** View paths bind the exact revision selected at materialization time. */
  revisionByVirtualPath: ReadonlyMap<string, string>;
}>;

const virtualViews = new Map<string, VirtualViewAllocation>();

function pruneExpiredVirtualViews(nowMs = Date.now()): void {
  for (const [viewId, allocation] of virtualViews) {
    if (allocation.expiresAtMs <= nowMs) {
      virtualViews.delete(viewId);
    }
  }
}

function hash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("base64url");
}

function audienceKey(audience: AudienceRef): string {
  return `${audience.kind}\0${audience.id}`;
}

function hasAudience(context: MemoryAccessContext, kind: AudienceRef["kind"], id: string): boolean {
  return context.delivery.audiences.some(
    (audience) => audience.kind === kind && audience.id === id,
  );
}

function hasCurrentRoleMembership(params: {
  context: MemoryAccessContext;
  groupId: string;
  nowMs: number;
}): boolean {
  if (params.context.subject.kind !== "user") {
    return false;
  }
  return params.context.verifiedMemberships.some((membership) => {
    if (
      membership.principalId !== params.context.subject.principalId ||
      membership.groupId !== params.groupId ||
      Date.parse(membership.observedAt) > params.nowMs ||
      Date.parse(membership.expiresAt) <= params.nowMs
    ) {
      return false;
    }
    // The user remains the memory subject. The group proof must instead name a
    // current enterprise principal: without this two-principal binding, a caller
    // could replay another user's enterprise snapshot into a valid user context.
    return params.context.verifiedPrincipals.some(
      (principal) =>
        principal.principalId === membership.sourcePrincipalId &&
        principal.evidenceRevision === membership.evidenceRevision &&
        (principal.expiresAt === undefined || Date.parse(principal.expiresAt) > params.nowMs),
    );
  });
}

function canViewStoreAudience(params: {
  context: MemoryAccessContext;
  audienceKind: AudienceRef["kind"];
  audienceId: string;
  nowMs: number;
}): boolean {
  const { context } = params;
  if (!hasAudience(context, params.audienceKind, params.audienceId)) {
    return false;
  }
  switch (params.audienceKind) {
    case "user":
      return context.subject.kind === "user" && context.subject.principalId === params.audienceId;
    case "conversation":
      return (
        context.subject.kind === "conversation" &&
        context.subject.conversationPrincipalId === params.audienceId
      );
    case "role":
      // A group sender is never its owner. Role stores require a user-scoped context and an
      // explicit role audience prepared by the host, never a latest-actor field.
      return hasCurrentRoleMembership({
        context,
        groupId: params.audienceId,
        nowMs: params.nowMs,
      });
    case "agent-shared":
      return params.audienceId === context.agentId;
    case "agent":
      return context.delivery.sinkKind === "internal" && params.audienceId === context.agentId;
    case "internal":
      return context.delivery.sinkKind === "internal" && params.audienceId === context.agentId;
  }
}

function listAuthorizedStores(params: {
  context: MemoryAccessContext;
  nowMs: number;
}): AuthorizedStoreSelection {
  // Expiry owns a durable tombstone and prior-exposure impact. Run it before every new
  // authorization snapshot so a clock-only filter cannot leave an expired projection active.
  expireBuiltinMemoryProjections({ agentId: params.context.agentId, nowMs: params.nowMs });
  return withScopedMemoryDatabase(params.context.agentId, (database) => {
    const rows = database
      .prepare(
        `SELECT store.store_id, store.audience_kind, store.audience_id, policy.policy_id,
                policy.current_revision_id, policy.revocation_epoch
           FROM memory_stores AS store
           JOIN memory_policies AS policy ON policy.policy_id = store.policy_id
           JOIN memory_storage_roots AS root ON root.storage_root_id = store.storage_root_id
          WHERE store.agent_id = ?
            AND store.lifecycle_state = 'active'
            AND policy.lifecycle_state = 'active'
            AND root.lifecycle_state = 'active'
            AND root.backend_kind = 'builtin'
          ORDER BY store.store_id`,
      )
      .all(params.context.agentId) as Array<{
      store_id: string;
      audience_kind: AudienceRef["kind"];
      audience_id: string;
      policy_id: string;
      current_revision_id: string;
      revocation_epoch: number;
    }>;
    const principalIds =
      params.context.subject.kind === "user"
        ? [params.context.subject.principalId]
        : params.context.verifiedPrincipals.map((principal) => principal.principalId);
    const enterpriseRoleDecisions: AuthorizedStoreSelection["enterpriseRoleDecisions"][number][] =
      [];
    const stores = rows.flatMap((row) => {
      const roleMembership =
        row.audience_kind === "role" && params.context.subject.kind === "user"
          ? params.context.verifiedMemberships.find(
              (membership) =>
                membership.principalId === params.context.subject.principalId &&
                membership.groupId === row.audience_id &&
                Date.parse(membership.observedAt) <= params.nowMs &&
                Date.parse(membership.expiresAt) > params.nowMs,
            )
          : undefined;
      if (
        !canViewStoreAudience({
          context: params.context,
          audienceKind: row.audience_kind,
          audienceId: row.audience_id,
          nowMs: params.nowMs,
        })
      ) {
        if (roleMembership) {
          enterpriseRoleDecisions.push({
            groupId: roleMembership.groupId,
            policyId: row.policy_id,
            decision: "denied",
            reasonCode: "role-membership-unavailable",
            policyRevision: row.current_revision_id,
          });
        }
        return [];
      }
      const decision = evaluateBuiltinScopedMemoryPolicy({
        agentId: params.context.agentId,
        storeId: row.store_id,
        principalIds,
        deliveryAudiences: params.context.delivery.audiences,
        operation: params.context.operation,
        nowMs: params.nowMs,
      });
      if (!decision.allowed || decision.policyRevisionId !== row.current_revision_id) {
        if (roleMembership) {
          enterpriseRoleDecisions.push({
            groupId: roleMembership.groupId,
            policyId: row.policy_id,
            decision: "denied",
            reasonCode: decision.reasonCode,
            policyRevision: row.current_revision_id,
          });
        }
        return [];
      }
      if (roleMembership) {
        enterpriseRoleDecisions.push({
          groupId: roleMembership.groupId,
          policyId: row.policy_id,
          decision: "allowed",
          reasonCode: decision.reasonCode,
          policyRevision: row.current_revision_id,
        });
      }
      return [
        Object.freeze({
          storeId: row.store_id,
          policyRevisionId: row.current_revision_id,
          audienceRevision: `mar1_${hash([
            row.store_id,
            row.audience_kind,
            row.audience_id,
            row.current_revision_id,
            String(row.revocation_epoch),
          ])}`,
        }),
      ];
    });
    return Object.freeze({
      stores: Object.freeze(stores),
      enterpriseRoleDecisions: Object.freeze(enterpriseRoleDecisions),
    });
  });
}

function deleteExpiredPlans(nowMs: number): void {
  for (const [planId, state] of plans) {
    if (state.expiresAtMs <= nowMs) {
      plans.delete(planId);
    }
  }
}

function createPlan(
  context: MemoryAccessContext,
  enterpriseAccessAuditReporter: MemoryEnterpriseAccessAuditReporter | undefined,
): PlanState {
  const nowMs = Date.now();
  deleteExpiredPlans(nowMs);
  const authorization = listAuthorizedStores({ context, nowMs });
  enterpriseAccessAuditReporter?.recordRoleAccessDecisions({
    context,
    decisions: authorization.enterpriseRoleDecisions,
    now: nowMs,
  });
  const stores = authorization.stores;
  const expiresAtMs = nowMs + PLAN_TTL_MS;
  const planId = `mplan1_${randomUUID()}`;
  const policyRevision = `mpr1_${hash(stores.map((store) => store.policyRevisionId))}`;
  const plan = Object.freeze({
    version: 1 as const,
    planId,
    contextFingerprint: context.contextFingerprint,
    runId: context.runId,
    agentId: context.agentId,
    sessionId: context.sessionId,
    sessionIdentityRevision: context.sessionIdentityRevision,
    subjectRevision: context.subjectRevision,
    memoryPolicyRevision: policyRevision,
    deliveryRevision: context.delivery.deliveryRevision,
    operation: context.operation,
    mounts: Object.freeze(
      stores.map((store) =>
        Object.freeze({
          version: 1 as const,
          agentId: context.agentId,
          mountHandle: `mmount1_${randomUUID()}`,
          capabilities: Object.freeze(
            context.operation === "read"
              ? (["retrieve", "read"] as const)
              : context.operation === "derive"
                ? (["retrieve", "read", "derive"] as const)
                : ([context.operation] as const),
          ),
          audienceRevision: store.audienceRevision,
        }),
      ),
    ),
    bootstrapResourceHandles: Object.freeze([]),
    allowedEgressAudiences: Object.freeze([...context.delivery.audiences]),
    expiresAt: new Date(expiresAtMs).toISOString(),
  }) satisfies AuthorizedMemoryPlan;
  return Object.freeze({
    contextFingerprint: context.contextFingerprint,
    context,
    expiresAtMs,
    plan,
    stores,
    handles: new Map(),
    exposureRevision: 0,
  });
}

function readPlan(params: {
  context: MemoryAccessContext;
  plan: AuthorizedMemoryPlan;
}): PlanState | undefined {
  const state = plans.get(params.plan.planId);
  const nowMs = Date.now();
  if (
    !state ||
    state.plan !== params.plan ||
    state.expiresAtMs <= nowMs ||
    state.contextFingerprint !== params.context.contextFingerprint ||
    state.context.agentId !== params.context.agentId ||
    state.context.sessionId !== params.context.sessionId ||
    state.context.sessionIdentityRevision !== params.context.sessionIdentityRevision ||
    state.context.subjectRevision !== params.context.subjectRevision ||
    state.context.delivery.deliveryRevision !== params.context.delivery.deliveryRevision ||
    state.context.delivery.egressRegistryRevision !==
      params.context.delivery.egressRegistryRevision ||
    state.context.operation !== params.context.operation ||
    [...state.context.delivery.audiences].map(audienceKey).toSorted().join("\0") !==
      [...params.context.delivery.audiences].map(audienceKey).toSorted().join("\0")
  ) {
    return undefined;
  }
  const currentStores = listAuthorizedStores({ context: params.context, nowMs }).stores;
  if (
    currentStores.length !== state.stores.length ||
    currentStores.some(
      (store, index) =>
        store.storeId !== state.stores[index]?.storeId ||
        store.policyRevisionId !== state.stores[index]?.policyRevisionId,
    )
  ) {
    return undefined;
  }
  return state;
}

function materializeAuthorizedVirtualView(params: {
  context: MemoryContentAccessContext<"read">;
  plan: AuthorizedMemoryPlan & Readonly<{ operation: "read" }>;
}): AuthorizedMemoryVirtualView | undefined {
  pruneExpiredVirtualViews();
  const state = readPlan(params);
  if (!state || state.stores.length !== state.plan.mounts.length) {
    return undefined;
  }
  const revision = `mviewr1_${hash(state.stores.map((store) => store.policyRevisionId))}`;
  const roots = state.stores.map((_, index) =>
    Object.freeze({
      version: 1 as const,
      mountHandle: state.plan.mounts[index]!.mountHandle,
      virtualRoot: `projections-${index + 1}`,
      access: "read" as const,
    }),
  );
  const revisionByVirtualPath = new Map<string, string>();
  const files = state.stores.flatMap((store, index) => {
    const root = roots[index]!;
    const rows = withScopedMemoryDatabase(
      params.context.agentId,
      (database) =>
        database
          .prepare(
            `SELECT revision.revision_id
             FROM memory_resources AS resource
             JOIN memory_resource_revisions AS revision
               ON revision.resource_id = resource.resource_id
             WHERE resource.agent_id = ?
               AND resource.store_id = ?
               AND revision.lifecycle_state = 'active'
               AND (revision.expires_at IS NULL OR revision.expires_at > ?)
             ORDER BY resource.resource_id`,
          )
          .all(params.context.agentId, store.storeId, Date.now()) as Array<{
          revision_id: string;
        }>,
    );
    return rows.flatMap((row, ordinal) => {
      const virtualPath = `${root.virtualRoot}/${ordinal + 1}.md`;
      revisionByVirtualPath.set(virtualPath, row.revision_id);
      return [
        Object.freeze({
          version: 1 as const,
          mountHandle: root.mountHandle,
          virtualPath,
        }),
      ];
    });
  });
  const view = Object.freeze({
    version: 1 as const,
    viewId: `mview1_${randomUUID()}`,
    planId: state.plan.planId,
    contextFingerprint: state.contextFingerprint,
    revision,
    roots: Object.freeze(roots),
    files: Object.freeze(files),
    expiresAt: state.plan.expiresAt,
  });
  virtualViews.set(
    view.viewId,
    Object.freeze({
      planId: view.planId,
      revision: view.revision,
      expiresAtMs: state.expiresAtMs,
      revisionByVirtualPath,
    }),
  );
  return view;
}

function readAuthorizedVirtualFile(params: {
  context: MemoryContentAccessContext<"read">;
  plan: AuthorizedMemoryPlan & Readonly<{ operation: "read" }>;
  view: AuthorizedMemoryVirtualView;
  virtualPath: string;
}): AuthorizedMemoryResultEnvelope<MemoryReadResult> {
  pruneExpiredVirtualViews();
  const state = readPlan(params);
  const allocation = virtualViews.get(params.view.viewId);
  const normalized = params.virtualPath.normalize("NFC");
  const parts = normalized.split("/");
  const revisionId = allocation?.revisionByVirtualPath.get(normalized);
  if (
    !state ||
    !allocation ||
    allocation.expiresAtMs <= Date.now() ||
    allocation.planId !== params.plan.planId ||
    allocation.revision !== params.view.revision ||
    params.view.planId !== params.plan.planId ||
    params.view.contextFingerprint !== params.context.contextFingerprint ||
    normalized !== params.virtualPath ||
    parts.length !== 2 ||
    !revisionId
  ) {
    throw new Error("authorized memory virtual view is unavailable");
  }
  const snapshot = readBuiltinScopedMemoryRevisionSnapshot({
    agentId: params.context.agentId,
    storeIds: state.stores.map((store) => store.storeId),
    revisionId,
  });
  if (!snapshot) {
    throw new Error("authorized memory virtual view is unavailable");
  }
  return createEnvelope({
    state,
    context: params.context,
    value: Object.freeze({
      text: snapshot.content,
      path: `memory/${snapshot.logicalLocator}`,
      from: 1,
      lines: snapshot.content.split("\n").length,
    }),
    revisions: [snapshot.revisionId],
    sourcePolicySetIds: [`mps1_${snapshot.policyRevisionId}`],
  });
}

function createHandle(params: {
  plan: PlanState;
  revisionId: string;
  policyRevision: string;
}): AuthorizedResourceHandle {
  const handle = Object.freeze({
    version: 1 as const,
    handleId: `mhandle1_${randomUUID()}`,
    planId: params.plan.plan.planId,
    contextFingerprint: params.plan.contextFingerprint,
    resourceRevision: params.revisionId,
    policyRevision: params.policyRevision,
    expiresAt: params.plan.plan.expiresAt,
  });
  params.plan.handles.set(handle.handleId, handle);
  return handle;
}

/** A projection accepts only an opaque handle minted by a still-live authorized content view. */
function resolveProjectionSourceHandle(params: {
  agentId: string;
  handle: AuthorizedResourceHandle;
}): string | undefined {
  for (const state of plans.values()) {
    if (state.expiresAtMs <= Date.now() || state.context.agentId !== params.agentId) {
      continue;
    }
    const stored = state.handles.get(params.handle.handleId);
    if (
      stored &&
      stored.planId === params.handle.planId &&
      stored.contextFingerprint === params.handle.contextFingerprint &&
      stored.resourceRevision === params.handle.resourceRevision &&
      stored.policyRevision === params.handle.policyRevision &&
      stored.expiresAt === params.handle.expiresAt
    ) {
      return stored.resourceRevision;
    }
  }
  return undefined;
}

function createEnvelope<T>(params: {
  state: PlanState;
  context: MemoryAccessContext;
  value: T;
  revisions: readonly string[];
  sourcePolicySetIds: readonly string[];
}): AuthorizedMemoryResultEnvelope<T> {
  const exposureRevision = params.state.exposureRevision + 1;
  const sourcePolicySetId = `mpset1_${hash(params.sourcePolicySetIds.toSorted())}`;
  const recordedAt = new Date().toISOString();
  const value = Object.freeze({
    version: 1 as const,
    value: params.value,
    exposureReceipt: Object.freeze({
      version: 1 as const,
      receiptId: `mexp1_${randomUUID()}`,
      contextFingerprint: params.context.contextFingerprint,
      planId: params.state.plan.planId,
      runId: params.context.runId,
      runExposureRevision: `mrun1_${exposureRevision}`,
      sourcePolicySetId,
      exposedRevisionHandles: Object.freeze([...new Set(params.revisions)].toSorted()),
      recordedAt,
    }),
    egressReceipt: Object.freeze({
      version: 1 as const,
      receiptId: `megr1_${randomUUID()}`,
      contextFingerprint: params.context.contextFingerprint,
      planId: params.state.plan.planId,
      runId: params.context.runId,
      runExposureRevision: `mrun1_${exposureRevision}`,
      sourcePolicySetId,
      allowedAudiences: Object.freeze([...params.context.delivery.audiences]),
      deliveryRevision: params.context.delivery.deliveryRevision,
      egressRegistryRevision: params.context.delivery.egressRegistryRevision,
      expiresAt: params.state.plan.expiresAt,
    }),
  }) as AuthorizedMemoryResultEnvelope<T>;
  plans.set(params.state.plan.planId, Object.freeze({ ...params.state, exposureRevision }));
  return value;
}

function toSearchResult(params: {
  candidate: { score: number; textScore?: number; vectorScore?: number };
  snapshot: ReturnType<typeof readBuiltinScopedMemoryRevisionSnapshot>;
  handle: AuthorizedResourceHandle;
}): AuthorizedMemorySearchResult | undefined {
  const snapshot = params.snapshot;
  if (!snapshot) {
    return undefined;
  }
  const snippet = snapshot.content.split("\n", 1)[0]?.trim() ?? "";
  if (!snippet) {
    return undefined;
  }
  return Object.freeze({
    path: `memory/${snapshot.logicalLocator}`,
    startLine: 1,
    endLine: Math.max(1, snapshot.content.split("\n").length),
    score: params.candidate.score,
    ...(params.candidate.vectorScore !== undefined
      ? { vectorScore: params.candidate.vectorScore }
      : {}),
    ...(params.candidate.textScore !== undefined ? { textScore: params.candidate.textScore } : {}),
    snippet,
    source: snapshot.source,
    resourceHandle: params.handle,
  });
}

const CALLER_SELECTED_DESTINATION_FIELDS = new Set([
  "artifactLocator",
  "audience",
  "audienceId",
  "destinationAudience",
  "destinationHandle",
  "destinationOwnerId",
  "destinationStoreId",
  "logicalLocator",
  "owner",
  "ownerId",
  "path",
  "placementHandle",
  "root",
  "rootId",
  "store",
  "storeId",
]);

type MutableScopedRevision = Readonly<{
  resourceId: string;
  revisionId: string;
  artifactLocator: string;
  contentHash: string;
  contentBytes: number;
}>;

type DerivationSource = Readonly<{
  revisionId: string;
  policyRevisionId: string;
  audience: AudienceRef;
  policyRequirements: readonly Readonly<{
    policyId: string;
    expectedRevisionId: string;
    expectedRevocationEpoch: number;
  }>[];
}>;

type TranscriptDerivationSource = Readonly<{
  sourcePolicySetId: string;
  sourceRevisionIds: readonly string[];
  policyRequirements: readonly Readonly<{
    policyId: string;
    expectedRevisionId: string;
    expectedRevocationEpoch: number;
  }>[];
}>;

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function auditActorRef(context: MemoryAccessContext): string {
  const source =
    context.actor.kind === "principal"
      ? `${context.actor.actorKind}\0${context.actor.principalId}\0${context.actor.evidenceRevision}`
      : `unattributed\0${context.actor.transportAuditRef}\0${context.actor.evidenceRevision}`;
  return `sha256:${contentHash(source)}`;
}

function auditSubjectRef(context: MemoryAccessContext): string {
  return `sha256:${contentHash(JSON.stringify(context.subject))}`;
}

function syncDirectory(directory: string): void {
  try {
    const descriptor = fs.openSync(directory, "r");
    try {
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  } catch (error) {
    // Directory fsync is unsupported on Windows. The revision file itself is
    // always fsynced before rename, which remains the durability boundary.
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "EPERM" && code !== "EISDIR") {
      throw error;
    }
  }
}

function readVerifiedFile(params: {
  pathname: string;
  contentHash: string;
  contentBytes: number;
}): string | undefined {
  try {
    const content = fs.readFileSync(params.pathname, "utf8");
    return Buffer.byteLength(content) === params.contentBytes &&
      contentHash(content) === params.contentHash
      ? content
      : undefined;
  } catch {
    return undefined;
  }
}

function requireExactlyOneAffected(
  result: Readonly<{ numAffectedRows?: bigint }>,
  operation: string,
): void {
  if (result.numAffectedRows !== 1n) {
    throw new Error(`authorized memory ${operation} lost its authoritative row`);
  }
}

/** Remove an untrusted artifact from every store root before a later recovery can inspect it. */
function quarantineArtifact(params: { directory: string; pathname: string }): void {
  if (!fs.existsSync(params.pathname)) {
    return;
  }
  const quarantine = path.join(path.dirname(params.directory), ".quarantine");
  fs.mkdirSync(quarantine, { recursive: true, mode: 0o700 });
  fs.renameSync(params.pathname, path.join(quarantine, `orphan_${randomUUID()}`));
  syncDirectory(quarantine);
  syncDirectory(params.directory);
}

function chunkContent(content: string): readonly {
  ordinal: number;
  startLine: number;
  endLine: number;
  text: string;
}[] {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const chunks: Array<{ ordinal: number; startLine: number; endLine: number; text: string }> = [];
  for (let start = 0; start < lines.length; start += 48) {
    const text = lines
      .slice(start, start + 48)
      .join("\n")
      .trim();
    if (text) {
      chunks.push({
        ordinal: chunks.length,
        startLine: start + 1,
        endLine: Math.min(lines.length, start + 48),
        text,
      });
    }
  }
  return chunks;
}

function mutationOperation(mutation: AuthorizedMemoryMutation): MemoryAccessContext["operation"] {
  switch (mutation.kind) {
    case "remember":
    case "append":
      return "append";
    case "replace":
      return "replace";
    case "delete":
    case "tombstone":
      return "delete";
    case "admin-reclassify":
      return "policy-admin";
    default:
      return mutation.kind;
  }
}

function assertMutationShape(mutation: AuthorizedMemoryMutation): void {
  if (
    Object.keys(mutation).some((key) => CALLER_SELECTED_DESTINATION_FIELDS.has(key)) ||
    !mutation.mutationId.trim() ||
    !mutation.idempotencyKey.trim()
  ) {
    throw new Error("authorized memory mutation is unavailable");
  }
  if ("content" in mutation && !mutation.content.trim()) {
    throw new Error("authorized memory mutation is unavailable");
  }
}

function defaultAudience(context: MemoryAccessContext): AudienceRef | undefined {
  switch (context.subject.kind) {
    case "user":
      return { kind: "user", id: context.subject.principalId };
    case "conversation":
      return { kind: "conversation", id: context.subject.conversationPrincipalId };
    case "service":
    case "agent":
    case "system":
      return { kind: "agent", id: context.agentId };
    case "ambiguous":
      return undefined;
  }
}

function sameAudience(left: AudienceRef, right: AudienceRef): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function selectWriteStore(params: {
  database: Parameters<typeof getNodeSqliteKysely<ScopedMemoryDatabase>>[0];
  agentId: string;
  state: PlanState;
}): {
  storeId: string;
  pathKey: string;
  policyId: string;
  policyRevisionId: string;
  policyRevocationEpoch: number;
  audience: AudienceRef;
} {
  const audience = defaultAudience(params.state.context);
  if (!audience) {
    throw new Error("authorized memory mutation is unavailable");
  }
  const db = getNodeSqliteKysely<ScopedMemoryDatabase>(params.database);
  const row = executeSqliteQueryTakeFirstSync(
    params.database,
    db
      .selectFrom("memory_stores as store")
      .innerJoin("memory_storage_roots as root", "root.storage_root_id", "store.storage_root_id")
      .innerJoin("memory_policies as policy", "policy.policy_id", "store.policy_id")
      .select([
        "store.store_id",
        "store.audience_kind",
        "store.audience_id",
        "root.path_key",
        "policy.policy_id",
        "policy.current_revision_id",
        "policy.revocation_epoch",
      ])
      .where("store.agent_id", "=", params.agentId)
      .where("store.audience_kind", "=", audience.kind)
      .where("store.audience_id", "=", audience.id)
      .where("store.lifecycle_state", "=", "active")
      .where("root.backend_kind", "=", "builtin")
      .where("root.lifecycle_state", "=", "active")
      .where("policy.lifecycle_state", "=", "active"),
  );
  const planned = params.state.stores.find((store) => store.storeId === row?.store_id);
  if (!row?.path_key || !planned || planned.policyRevisionId !== row.current_revision_id) {
    throw new Error("authorized memory mutation is unavailable");
  }
  return {
    storeId: row.store_id,
    pathKey: row.path_key,
    policyId: row.policy_id,
    policyRevisionId: row.current_revision_id,
    policyRevocationEpoch: row.revocation_epoch,
    audience: { kind: row.audience_kind, id: row.audience_id },
  };
}

/** A derive mutation can only retain exact same-audience sources; mixed sets are denied, not widened. */
function resolveDerivationSources(params: {
  database: Parameters<typeof getNodeSqliteKysely<ScopedMemoryDatabase>>[0];
  agentId: string;
  state: PlanState;
  targetAudience: AudienceRef;
  sourceHandles: readonly AuthorizedResourceHandle[];
  sourcePolicySetId: string;
}): readonly DerivationSource[] {
  if (params.sourceHandles.length === 0 || !params.sourcePolicySetId.trim()) {
    throw new Error("authorized memory derivation is unavailable");
  }
  const db = getNodeSqliteKysely<ScopedMemoryDatabase>(params.database);
  const sources: DerivationSource[] = [];
  for (const handle of params.sourceHandles) {
    const stored = params.state.handles.get(handle.handleId);
    if (
      !stored ||
      stored.planId !== params.state.plan.planId ||
      stored.contextFingerprint !== params.state.contextFingerprint ||
      stored.resourceRevision !== handle.resourceRevision ||
      stored.policyRevision !== handle.policyRevision ||
      stored.expiresAt !== handle.expiresAt
    ) {
      throw new Error("authorized memory derivation is unavailable");
    }
    const snapshot = readBuiltinScopedMemoryRevisionSnapshot({
      agentId: params.agentId,
      storeIds: params.state.stores.map((store) => store.storeId),
      revisionId: stored.resourceRevision,
    });
    if (!snapshot || snapshot.policyRevisionId !== stored.policyRevision) {
      throw new Error("authorized memory derivation is unavailable");
    }
    const source = executeSqliteQueryTakeFirstSync(
      params.database,
      db
        .selectFrom("memory_resource_revisions as revision")
        .innerJoin("memory_resources as resource", "resource.resource_id", "revision.resource_id")
        .innerJoin("memory_stores as store", "store.store_id", "resource.store_id")
        .select(["store.audience_kind", "store.audience_id"])
        .where("revision.revision_id", "=", stored.resourceRevision)
        .where("resource.agent_id", "=", params.agentId),
    );
    const audience = source && { kind: source.audience_kind, id: source.audience_id };
    if (!audience || !sameAudience(audience, params.targetAudience)) {
      throw new Error("authorized memory derivation has no representable audience");
    }
    const policyRequirements = executeSqliteQuerySync(
      params.database,
      db
        .selectFrom("memory_revision_policy_requirements")
        .select(["policy_id", "expected_revision_id", "expected_revocation_epoch"])
        .where("revision_id", "=", stored.resourceRevision)
        .orderBy("policy_id"),
    ).rows.map((requirement) =>
      Object.freeze({
        policyId: requirement.policy_id,
        expectedRevisionId: requirement.expected_revision_id,
        expectedRevocationEpoch: requirement.expected_revocation_epoch,
      }),
    );
    if (policyRequirements.length === 0) {
      throw new Error("authorized memory derivation is unavailable");
    }
    sources.push(
      Object.freeze({
        revisionId: stored.resourceRevision,
        policyRevisionId: snapshot.policyRevisionId,
        audience,
        policyRequirements: Object.freeze(policyRequirements),
      }),
    );
  }
  if (new Set(sources.map((source) => source.revisionId)).size !== sources.length) {
    throw new Error("authorized memory derivation is unavailable");
  }
  const expectedPolicySetId = `mpset1_${hash(
    sources.map((source) => `mps1_${source.policyRevisionId}`).toSorted(),
  )}`;
  if (params.sourcePolicySetId !== expectedPolicySetId) {
    throw new Error("authorized memory derivation is unavailable");
  }
  return Object.freeze(sources);
}

/** Transcript companions are an immutable source set, not a mutable session-path permission. */
function resolveTranscriptDerivationSource(params: {
  database: Parameters<typeof getNodeSqliteKysely<ScopedMemoryDatabase>>[0];
  source: AuthorizedTranscriptDerivationSource;
  sourcePolicySetId: string;
  targetAudience: AudienceRef;
}): TranscriptDerivationSource {
  const source = params.source;
  if (
    !source ||
    source.kind !== "transcript" ||
    source.sourcePolicySetId !== params.sourcePolicySetId ||
    !source.sessionId.trim() ||
    source.eventSeqs.length === 0
  ) {
    throw new Error("authorized transcript derivation is unavailable");
  }
  const eventSeqs = [...source.eventSeqs];
  if (
    eventSeqs.some((eventSeq) => !Number.isSafeInteger(eventSeq) || eventSeq < 0) ||
    new Set(eventSeqs).size !== eventSeqs.length ||
    eventSeqs.some((eventSeq, index) => index > 0 && eventSeqs[index - 1]! >= eventSeq)
  ) {
    throw new Error("authorized transcript derivation is unavailable");
  }
  let audiences: unknown;
  try {
    audiences = JSON.parse(source.deliveryAudiencesJson);
  } catch {
    throw new Error("authorized transcript derivation is unavailable");
  }
  if (
    !Array.isArray(audiences) ||
    audiences.length !== 1 ||
    typeof audiences[0] !== "object" ||
    audiences[0] === null ||
    (audiences[0] as AudienceRef).kind !== params.targetAudience.kind ||
    (audiences[0] as AudienceRef).id !== params.targetAudience.id
  ) {
    throw new Error("authorized memory derivation has no representable audience");
  }
  const db = getNodeSqliteKysely<ScopedMemoryDatabase>(params.database);
  const subject = executeSqliteQueryTakeFirstSync(
    params.database,
    db
      .selectFrom("session_memory_subject_snapshots")
      .select(["session_identity_revision", "subject_revision"])
      .where("session_id", "=", source.sessionId)
      .limit(1),
  );
  if (!subject) {
    throw new Error("authorized transcript derivation is unavailable");
  }
  const events = executeSqliteQuerySync(
    params.database,
    db
      .selectFrom("transcript_events as event")
      .innerJoin("transcript_event_memory_policies as policy", (join) =>
        join
          .onRef("policy.session_id", "=", "event.session_id")
          .onRef("policy.event_seq", "=", "event.seq"),
      )
      .innerJoin("transcript_event_memory_policy_details as detail", (join) =>
        join
          .onRef("detail.session_id", "=", "policy.session_id")
          .onRef("detail.event_seq", "=", "policy.event_seq"),
      )
      .select([
        "event.seq",
        "policy.delivery_audiences_json",
        "policy.run_exposure_set_id",
        "policy.session_identity_revision",
        "policy.subject_revision",
      ])
      .where("event.session_id", "=", source.sessionId)
      .where("event.seq", "in", eventSeqs)
      .where("policy.authorization_status", "=", "authorized")
      .where("policy.source_policy_set_id", "=", source.sourcePolicySetId)
      .where("policy.delivery_audiences_json", "=", source.deliveryAudiencesJson)
      .where("detail.retention_state", "=", "retained")
      .where("detail.normalized_audience_intersection_json", "=", source.deliveryAudiencesJson)
      .where("detail.finalized_delivery_audiences_json", "=", source.deliveryAudiencesJson)
      .orderBy("event.seq"),
  ).rows;
  if (
    events.length !== eventSeqs.length ||
    events.some(
      (event, index) =>
        event.seq !== eventSeqs[index] ||
        event.run_exposure_set_id === null ||
        event.session_identity_revision !== subject.session_identity_revision ||
        event.subject_revision !== subject.subject_revision,
    )
  ) {
    throw new Error("authorized transcript derivation is unavailable");
  }
  const requirements = executeSqliteQuerySync(
    params.database,
    db
      .selectFrom("memory_policy_set_members")
      .select(["policy_id", "expected_revision_id", "expected_revocation_epoch", "retention_state"])
      .where("policy_set_id", "=", source.sourcePolicySetId)
      .orderBy("policy_id"),
  ).rows;
  if (
    requirements.length === 0 ||
    requirements.some((requirement) => requirement.retention_state !== "retained")
  ) {
    throw new Error("authorized transcript derivation is unavailable");
  }
  for (const requirement of requirements) {
    const current = executeSqliteQueryTakeFirstSync(
      params.database,
      db
        .selectFrom("memory_policies as policy")
        .innerJoin(
          "memory_policy_revisions as revision",
          "revision.revision_id",
          "policy.current_revision_id",
        )
        .select([
          "policy.lifecycle_state",
          "policy.revocation_epoch",
          "revision.lifecycle_state as revision_state",
        ])
        .where("policy.policy_id", "=", requirement.policy_id)
        .where("policy.current_revision_id", "=", requirement.expected_revision_id)
        .where("policy.revocation_epoch", "=", requirement.expected_revocation_epoch)
        .limit(1),
    );
    if (current?.lifecycle_state !== "active" || current.revision_state !== "active") {
      throw new Error("authorized transcript derivation is unavailable");
    }
  }
  const exposureSetIds = [...new Set(events.map((event) => event.run_exposure_set_id!))];
  const exposures = executeSqliteQuerySync(
    params.database,
    db
      .selectFrom("memory_run_exposure_resources as exposure")
      .innerJoin(
        "memory_resource_revisions as revision",
        "revision.revision_id",
        "exposure.resource_revision_id",
      )
      .select([
        "exposure.exposure_set_id",
        "exposure.resource_revision_id",
        "revision.expires_at",
        "revision.lifecycle_state",
      ])
      .where("exposure.exposure_set_id", "in", exposureSetIds),
  ).rows;
  const nowMs = Date.now();
  if (
    exposureSetIds.some(
      (exposureSetId) => !exposures.some((row) => row.exposure_set_id === exposureSetId),
    ) ||
    exposures.some(
      (exposure) =>
        exposure.lifecycle_state !== "active" ||
        (exposure.expires_at !== null && exposure.expires_at <= nowMs),
    )
  ) {
    throw new Error("authorized transcript derivation is unavailable");
  }
  return Object.freeze({
    sourcePolicySetId: source.sourcePolicySetId,
    sourceRevisionIds: Object.freeze(
      [...new Set(exposures.map((exposure) => exposure.resource_revision_id))].toSorted(),
    ),
    policyRequirements: Object.freeze(
      requirements.map((requirement) =>
        Object.freeze({
          policyId: requirement.policy_id,
          expectedRevisionId: requirement.expected_revision_id,
          expectedRevocationEpoch: requirement.expected_revocation_epoch,
        }),
      ),
    ),
  });
}

function resolveWriteTarget(params: {
  database: Parameters<typeof getNodeSqliteKysely<ScopedMemoryDatabase>>[0];
  agentId: string;
  state: PlanState;
  storeId: string;
  target: AuthorizedResourceHandle;
}): MutableScopedRevision {
  const sourceState = plans.get(params.target.planId);
  const stored = sourceState?.handles.get(params.target.handleId);
  if (
    !stored ||
    !sourceState ||
    sourceState.expiresAtMs <= Date.now() ||
    sourceState.contextFingerprint !== params.state.contextFingerprint ||
    sourceState.context.agentId !== params.state.context.agentId ||
    sourceState.context.sessionId !== params.state.context.sessionId ||
    stored.contextFingerprint !== params.state.contextFingerprint ||
    stored.resourceRevision !== params.target.resourceRevision ||
    stored.policyRevision !== params.target.policyRevision
  ) {
    throw new Error("authorized memory mutation is unavailable");
  }
  const db = getNodeSqliteKysely<ScopedMemoryDatabase>(params.database);
  const row = executeSqliteQueryTakeFirstSync(
    params.database,
    db
      .selectFrom("memory_resource_revisions as revision")
      .innerJoin("memory_resources as resource", "resource.resource_id", "revision.resource_id")
      .select([
        "resource.resource_id",
        "revision.revision_id",
        "revision.artifact_locator",
        "revision.content_hash",
        "revision.content_bytes",
      ])
      .where("resource.agent_id", "=", params.agentId)
      .where("resource.store_id", "=", params.storeId)
      .where("revision.revision_id", "=", stored.resourceRevision)
      .where("revision.lifecycle_state", "=", "active"),
  );
  if (!row) {
    throw new Error("authorized memory mutation is unavailable");
  }
  return {
    resourceId: row.resource_id,
    revisionId: row.revision_id,
    artifactLocator: row.artifact_locator,
    contentHash: row.content_hash,
    contentBytes: row.content_bytes,
  };
}

function drainMemoryAuditOutbox(agentId: string): void {
  try {
    withScopedMemoryDatabase(agentId, (database) => {
      const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
      const events = executeSqliteQuerySync(
        database,
        db
          .selectFrom("memory_audit_outbox")
          .selectAll()
          .where("agent_id", "=", agentId)
          .where("state", "=", "pending")
          .orderBy("created_at")
          .orderBy("event_id")
          .limit(100),
      ).rows;
      for (const event of events) {
        try {
          writeMemoryAccessAudit({
            eventId: event.event_id,
            agentId: event.agent_id,
            requestId: event.request_id,
            runId: event.run_id,
            actorRef: event.actor_ref,
            subjectRef: event.subject_ref,
            operation: event.operation,
            decision: event.decision === "pending" ? "quarantined" : event.decision,
            reasonCode: event.reason_code,
            resourceRevisionId: event.resource_revision_id,
            contentHash: event.content_hash,
            occurredAt: event.created_at,
            receivedAt: Date.now(),
          });
          runSqliteImmediateTransactionSync(database, () => {
            executeSqliteQuerySync(
              database,
              db
                .updateTable("memory_audit_outbox")
                .set({
                  state: "delivered",
                  attempts: event.attempts + 1,
                  delivered_at: Date.now(),
                  updated_at: Date.now(),
                })
                .where("event_id", "=", event.event_id)
                .where("state", "=", "pending"),
            );
          });
        } catch {
          // The local lifecycle is durable already. Audit delivery remains retryable
          // and must never become a write authorization dependency.
        }
      }
    });
  } catch {
    // The next authorized operation retries the persisted outbox.
  }
}

function quarantineWriteIntent(params: {
  database: Parameters<typeof getNodeSqliteKysely<ScopedMemoryDatabase>>[0];
  intentId: string;
  revisionId: string | null;
  nowMs: number;
  reasonCode: string;
}): void {
  const db = getNodeSqliteKysely<ScopedMemoryDatabase>(params.database);
  runSqliteImmediateTransactionSync(params.database, () => {
    if (params.revisionId) {
      executeSqliteQuerySync(
        params.database,
        db
          .updateTable("memory_resource_revisions")
          .set({ lifecycle_state: "quarantined", retired_at: params.nowMs })
          .where("revision_id", "=", params.revisionId)
          .where("lifecycle_state", "in", ["pending", "active"]),
      );
    }
    executeSqliteQuerySync(
      params.database,
      db
        .updateTable("memory_write_intents")
        .set({ state: "quarantined", updated_at: params.nowMs })
        .where("intent_id", "=", params.intentId)
        .where("state", "in", ["pending", "renamed", "active", "tombstoned"]),
    );
    executeSqliteQuerySync(
      params.database,
      db
        .updateTable("memory_audit_outbox")
        .set({ decision: "quarantined", reason_code: params.reasonCode, updated_at: params.nowMs })
        .where("intent_id", "=", params.intentId)
        .where("state", "=", "pending"),
    );
  });
}

function indexRecoveredRevision(params: {
  database: Parameters<typeof getNodeSqliteKysely<ScopedMemoryDatabase>>[0];
  intentId: string;
  revisionId: string;
  content: string;
  nowMs: number;
}): void {
  const db = getNodeSqliteKysely<ScopedMemoryDatabase>(params.database);
  runSqliteImmediateTransactionSync(params.database, () => {
    const current = executeSqliteQueryTakeFirstSync(
      params.database,
      db
        .selectFrom("memory_resource_revisions")
        .select("lifecycle_state")
        .where("revision_id", "=", params.revisionId),
    );
    if (current?.lifecycle_state !== "active") {
      return;
    }
    const existing = executeSqliteQueryTakeFirstSync(
      params.database,
      db
        .selectFrom("memory_scoped_chunks")
        .select("chunk_id")
        .where("revision_id", "=", params.revisionId)
        .limit(1),
    );
    if (!existing) {
      const chunks = chunkContent(params.content);
      if (chunks.length > 0) {
        executeSqliteQuerySync(
          params.database,
          db.insertInto("memory_scoped_chunks").values(
            chunks.map((chunk) => ({
              chunk_id: randomUUID(),
              revision_id: params.revisionId,
              chunk_ordinal: chunk.ordinal,
              start_line: chunk.startLine,
              end_line: chunk.endLine,
              text: chunk.text,
              content_hash: contentHash(chunk.text),
              model: "builtin-markdown-v1",
              updated_at: params.nowMs,
            })),
          ),
        );
      }
    }
    executeSqliteQuerySync(
      params.database,
      db
        .updateTable("memory_write_intents")
        .set({ indexed_at: params.nowMs, updated_at: params.nowMs })
        .where("intent_id", "=", params.intentId)
        .where("state", "=", "active"),
    );
  });
}

/** Complete a verified write or quarantine its evidence before any read plan is issued. */
function recoverPendingWrites(agentId: string): void {
  withScopedMemoryDatabase(agentId, (database, databasePath) => {
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const knownByDirectory = new Map<string, Set<string>>(
      executeSqliteQuerySync(
        database,
        db
          .selectFrom("memory_storage_roots")
          .select("path_key")
          .where("agent_id", "=", agentId)
          .where("backend_kind", "=", "builtin")
          .where("lifecycle_state", "=", "active")
          .where("path_key", "is not", null),
      ).rows.flatMap((root) =>
        root.path_key
          ? [
              [
                path.join(resolveScopedMemoryArtifactBase(databasePath), root.path_key),
                new Set<string>(),
              ] as const,
            ]
          : [],
      ),
    );
    // Catalogued revisions from pre-write migration and legacy creation flows are not
    // write-intent orphans. Keep every catalogued locator out of the filesystem sweep;
    // visibility still requires its active revision and current policy at read time.
    for (const revision of executeSqliteQuerySync(
      database,
      db
        .selectFrom("memory_resource_revisions as revision")
        .innerJoin("memory_resources as resource", "resource.resource_id", "revision.resource_id")
        .innerJoin("memory_stores as store", "store.store_id", "resource.store_id")
        .innerJoin("memory_storage_roots as root", "root.storage_root_id", "store.storage_root_id")
        .select(["root.path_key", "revision.artifact_locator"])
        .where("resource.agent_id", "=", agentId)
        .where("root.backend_kind", "=", "builtin")
        .where("root.lifecycle_state", "=", "active")
        .where("root.path_key", "is not", null),
    ).rows) {
      if (!revision.path_key) {
        continue;
      }
      const directory = path.join(resolveScopedMemoryArtifactBase(databasePath), revision.path_key);
      const known = knownByDirectory.get(directory) ?? new Set<string>();
      known.add(revision.artifact_locator);
      knownByDirectory.set(directory, known);
    }
    const intents = executeSqliteQuerySync(
      database,
      db
        .selectFrom("memory_write_intents as intent")
        .innerJoin("memory_stores as store", "store.store_id", "intent.store_id")
        .innerJoin("memory_storage_roots as root", "root.storage_root_id", "store.storage_root_id")
        .innerJoin("memory_policies as policy", "policy.policy_id", "store.policy_id")
        .select([
          "intent.intent_id",
          "intent.pending_revision_id",
          "intent.staged_locator",
          "intent.final_locator",
          "intent.content_hash",
          "intent.content_bytes",
          "intent.state",
          "intent.indexed_at",
          "root.path_key",
          "policy.current_revision_id",
          "policy.revocation_epoch",
        ])
        .where("intent.agent_id", "=", agentId)
        .where("intent.state", "in", ["pending", "renamed", "active"])
        .orderBy("intent.created_at")
        .orderBy("intent.intent_id"),
    ).rows;
    for (const intent of intents) {
      if (!intent.path_key || !intent.pending_revision_id || !intent.final_locator) {
        quarantineWriteIntent({
          database,
          intentId: intent.intent_id,
          revisionId: intent.pending_revision_id,
          nowMs: Date.now(),
          reasonCode: "recovery-incomplete-intent",
        });
        continue;
      }
      // The recovery transaction closes over this value. Keep the validated
      // revision immutable so it cannot become an absent intent reference.
      const revisionId = intent.pending_revision_id;
      const directory = path.join(resolveScopedMemoryArtifactBase(databasePath), intent.path_key);
      const known = knownByDirectory.get(directory) ?? new Set<string>();
      known.add(intent.final_locator);
      if (intent.staged_locator) {
        known.add(intent.staged_locator);
      }
      knownByDirectory.set(directory, known);
      const finalPath = resolveBuiltinScopedMemoryArtifactPath({
        databasePath,
        pathKey: intent.path_key,
        artifactLocator: intent.final_locator,
      });
      const stagePath = intent.staged_locator
        ? path.join(directory, intent.staged_locator)
        : undefined;
      if (
        intent.state === "pending" &&
        !fs.existsSync(finalPath) &&
        stagePath &&
        fs.existsSync(stagePath)
      ) {
        fs.renameSync(stagePath, finalPath);
        syncDirectory(directory);
        runSqliteImmediateTransactionSync(database, () => {
          requireExactlyOneAffected(
            executeSqliteQuerySync(
              database,
              db
                .updateTable("memory_write_intents")
                .set({ state: "renamed", updated_at: Date.now() })
                .where("intent_id", "=", intent.intent_id)
                .where("state", "=", "pending"),
            ),
            "recovery rename",
          );
        });
        intent.state = "renamed";
      }
      const content = readVerifiedFile({
        pathname: finalPath,
        contentHash: intent.content_hash ?? "",
        contentBytes: intent.content_bytes ?? -1,
      });
      if (content === undefined) {
        quarantineWriteIntent({
          database,
          intentId: intent.intent_id,
          revisionId,
          nowMs: Date.now(),
          reasonCode: "recovery-artifact-mismatch",
        });
        quarantineArtifact({ directory, pathname: finalPath });
        if (stagePath) {
          quarantineArtifact({ directory, pathname: stagePath });
        }
        continue;
      }
      if (intent.state === "pending" || intent.state === "renamed") {
        let policyChanged = false;
        runSqliteImmediateTransactionSync(database, () => {
          const revision = executeSqliteQueryTakeFirstSync(
            database,
            db
              .selectFrom("memory_resource_revisions as revision")
              .innerJoin(
                "memory_resources as resource",
                "resource.resource_id",
                "revision.resource_id",
              )
              .innerJoin("memory_stores as store", "store.store_id", "resource.store_id")
              .innerJoin("memory_policies as policy", "policy.policy_id", "store.policy_id")
              .select([
                "revision.resource_id",
                "revision.policy_revision_id",
                "revision.policy_revocation_epoch",
                "policy.current_revision_id",
                "policy.revocation_epoch",
              ])
              .where("revision.revision_id", "=", revisionId)
              .where("resource.agent_id", "=", agentId)
              .where("store.lifecycle_state", "=", "active")
              .where("policy.lifecycle_state", "=", "active"),
          );
          if (
            !revision ||
            revision.policy_revision_id !== revision.current_revision_id ||
            revision.policy_revocation_epoch !== revision.revocation_epoch ||
            !isBuiltinScopedMemoryRevisionLineageCurrent({
              agentId,
              revisionId,
            })
          ) {
            policyChanged = true;
            requireExactlyOneAffected(
              executeSqliteQuerySync(
                database,
                db
                  .updateTable("memory_resource_revisions")
                  .set({ lifecycle_state: "quarantined", retired_at: Date.now() })
                  .where("revision_id", "=", revisionId)
                  .where("lifecycle_state", "=", "pending"),
              ),
              "recovery policy quarantine revision",
            );
            requireExactlyOneAffected(
              executeSqliteQuerySync(
                database,
                db
                  .updateTable("memory_write_intents")
                  .set({ state: "quarantined", updated_at: Date.now() })
                  .where("intent_id", "=", intent.intent_id)
                  .where("state", "in", ["pending", "renamed"]),
              ),
              "recovery policy quarantine intent",
            );
            executeSqliteQuerySync(
              database,
              db
                .updateTable("memory_audit_outbox")
                .set({
                  decision: "quarantined",
                  reason_code: "recovery-policy-changed",
                  updated_at: Date.now(),
                })
                .where("intent_id", "=", intent.intent_id)
                .where("state", "=", "pending"),
            );
            return;
          }
          requireExactlyOneAffected(
            executeSqliteQuerySync(
              database,
              db
                .updateTable("memory_resource_revisions")
                .set({ lifecycle_state: "active", activated_at: Date.now() })
                .where("revision_id", "=", revisionId)
                .where("lifecycle_state", "=", "pending"),
            ),
            "recovery activation revision",
          );
          requireExactlyOneAffected(
            executeSqliteQuerySync(
              database,
              db
                .updateTable("memory_write_intents")
                .set({ state: "active", activated_at: Date.now(), updated_at: Date.now() })
                .where("intent_id", "=", intent.intent_id)
                .where("state", "in", ["pending", "renamed"]),
            ),
            "recovery activation intent",
          );
          executeSqliteQuerySync(
            database,
            db
              .updateTable("memory_audit_outbox")
              .set({
                decision: "committed",
                reason_code: "recovered-write",
                updated_at: Date.now(),
              })
              .where("intent_id", "=", intent.intent_id)
              .where("state", "=", "pending"),
          );
        });
        if (policyChanged) {
          quarantineArtifact({ directory, pathname: finalPath });
          continue;
        }
      }
      if (intent.indexed_at === null) {
        indexRecoveredRevision({
          database,
          intentId: intent.intent_id,
          revisionId,
          content,
          nowMs: Date.now(),
        });
      }
    }
    for (const [directory, known] of knownByDirectory) {
      try {
        for (const entry of fs.readdirSync(directory)) {
          if (known.has(entry) || entry === ".quarantine") {
            continue;
          }
          const quarantine = path.join(path.dirname(directory), ".quarantine");
          fs.mkdirSync(quarantine, { recursive: true, mode: 0o700 });
          fs.renameSync(
            path.join(directory, entry),
            path.join(quarantine, `orphan_${randomUUID()}`),
          );
          syncDirectory(quarantine);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
      }
    }
  });
}

async function writeAuthorizedMutation(params: {
  context: MemoryAccessContext;
  plan: AuthorizedMemoryPlan;
  mutation: AuthorizedMemoryMutation;
}): Promise<MemoryWriteResult> {
  assertMutationShape(params.mutation);
  if (params.context.operation !== mutationOperation(params.mutation)) {
    throw new Error("authorized memory mutation is unavailable");
  }
  recoverPendingWrites(params.context.agentId);
  const state = readPlan(params);
  if (!state) {
    throw new Error("authorized memory mutation is unavailable");
  }
  const nowMs = Date.now();
  const agentId = params.context.agentId;
  if (params.mutation.kind === "sync") {
    drainMemoryAuditOutbox(agentId);
    return Object.freeze({
      version: 1,
      mutationId: params.mutation.mutationId,
      status: "unchanged",
      policyRevision: params.plan.memoryPolicyRevision,
      committedAt: new Date(nowMs).toISOString(),
    });
  }

  if (params.mutation.kind === "project") {
    if (params.context.actor.kind !== "principal" || params.mutation.sourceHandles.length !== 1) {
      throw new Error("authorized memory projection is unavailable");
    }
    const sourceRevisionId = resolveProjectionSourceHandle({
      agentId,
      handle: params.mutation.sourceHandles[0]!,
    });
    if (!sourceRevisionId) {
      throw new Error("authorized memory projection is unavailable");
    }
    const expiry =
      params.mutation.target.expiry.kind === "expires"
        ? (() => {
            const expiresAt = Date.parse(params.mutation.target.expiry.expiresAt);
            if (!Number.isSafeInteger(expiresAt)) {
              throw new Error("authorized memory projection is unavailable");
            }
            return { kind: "expires" as const, expiresAt };
          })()
        : {
            kind: "no-expiry" as const,
            auditReason: params.mutation.target.expiry.auditReason,
          };
    const projection = createBuiltinMemoryProjection({
      agentId,
      sourceRevisionId,
      target: params.mutation.target.audience,
      publisherPrincipalId: params.context.actor.principalId,
      reviewedByPrincipalId: params.context.actor.principalId,
      purpose: params.mutation.target.purpose,
      preview: params.mutation.target.preview,
      content: params.mutation.content,
      expiry,
      nowMs,
    });
    const targetSnapshot = withScopedMemoryDatabase(agentId, (database) => {
      const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
      return executeSqliteQueryTakeFirstSync(
        database,
        db
          .selectFrom("memory_resource_revisions")
          .select("policy_revision_id")
          .where("revision_id", "=", projection.copyRevisionId),
      );
    });
    if (!targetSnapshot) {
      throw new Error("authorized memory projection is unavailable");
    }
    const handle = createHandle({
      plan: state,
      revisionId: projection.copyRevisionId,
      policyRevision: targetSnapshot.policy_revision_id,
    });
    return Object.freeze({
      version: 1,
      mutationId: params.mutation.mutationId,
      status: "committed" as const,
      resourceHandle: handle,
      policyRevision: targetSnapshot.policy_revision_id,
      committedAt: new Date(nowMs).toISOString(),
    });
  }

  const result = withScopedMemoryDatabase(agentId, (database, databasePath) => {
    const store = selectWriteStore({ database, agentId, state });
    const db = getNodeSqliteKysely<ScopedMemoryDatabase>(database);
    const derivationSources =
      params.mutation.kind === "derive" && "sourceHandles" in params.mutation
        ? resolveDerivationSources({
            database,
            agentId,
            state,
            targetAudience: store.audience,
            sourceHandles: params.mutation.sourceHandles,
            sourcePolicySetId: params.mutation.sourcePolicySetId,
          })
        : [];
    const transcriptDerivationSource =
      params.mutation.kind === "derive" && "transcriptSource" in params.mutation
        ? resolveTranscriptDerivationSource({
            database,
            source: params.mutation.transcriptSource,
            sourcePolicySetId: params.mutation.sourcePolicySetId,
            targetAudience: store.audience,
          })
        : undefined;
    const transcriptDerivationPurpose =
      params.mutation.kind === "derive" && "transcriptSource" in params.mutation
        ? params.mutation.derivationPurpose
        : undefined;
    const existing =
      (params.mutation.kind === "append" ||
        params.mutation.kind === "replace" ||
        params.mutation.kind === "delete" ||
        params.mutation.kind === "tombstone") &&
      "target" in params.mutation
        ? resolveWriteTarget({
            database,
            agentId,
            state,
            storeId: store.storeId,
            target: params.mutation.target,
          })
        : undefined;
    const existingIntent = executeSqliteQueryTakeFirstSync(
      database,
      db
        .selectFrom("memory_write_intents")
        .select(["mutation_id", "state", "pending_revision_id", "updated_at"])
        .where("agent_id", "=", agentId)
        .where("idempotency_key", "=", params.mutation.idempotencyKey),
    );
    if (existingIntent) {
      if (existingIntent.mutation_id !== params.mutation.mutationId) {
        throw new Error("authorized memory mutation idempotency conflict");
      }
      return Object.freeze({
        version: 1,
        mutationId: params.mutation.mutationId,
        status:
          existingIntent.state === "active" || existingIntent.state === "tombstoned"
            ? "unchanged"
            : "committed",
        policyRevision: store.policyRevisionId,
        committedAt: new Date(existingIntent.updated_at).toISOString(),
      });
    }

    if (
      (params.mutation.kind === "delete" || params.mutation.kind === "tombstone") &&
      "target" in params.mutation
    ) {
      const mutation = params.mutation;
      if (!existing) {
        throw new Error("authorized memory mutation is unavailable");
      }
      const intentId = randomUUID();
      runSqliteImmediateTransactionSync(database, () => {
        const current = resolveWriteTarget({
          database,
          agentId,
          state,
          storeId: store.storeId,
          target: mutation.target,
        });
        requireExactlyOneAffected(
          executeSqliteQuerySync(
            database,
            db
              .updateTable("memory_resource_revisions")
              .set({ lifecycle_state: "tombstoned", retired_at: nowMs })
              .where("revision_id", "=", current.revisionId)
              .where("lifecycle_state", "=", "active"),
          ),
          "tombstone revision",
        );
        // Removing chunks removes FTS/vector eligibility synchronously with the
        // tombstone. The immutable revision row retains the audit evidence only.
        executeSqliteQuerySync(
          database,
          db.deleteFrom("memory_scoped_chunks").where("revision_id", "=", current.revisionId),
        );
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_write_intents").values({
            intent_id: intentId,
            idempotency_key: mutation.idempotencyKey,
            mutation_id: mutation.mutationId,
            agent_id: agentId,
            request_id: params.context.requestId,
            run_id: params.context.runId,
            context_fingerprint: params.context.contextFingerprint,
            plan_id: params.plan.planId,
            mutation_kind: mutation.kind,
            store_id: store.storeId,
            resource_id: current.resourceId,
            pending_revision_id: current.revisionId,
            staged_locator: null,
            final_locator: current.artifactLocator,
            content_hash: current.contentHash,
            content_bytes: current.contentBytes,
            state: "tombstoned",
            created_at: nowMs,
            updated_at: nowMs,
            activated_at: nowMs,
            indexed_at: nowMs,
          }),
        );
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_audit_outbox").values({
            event_id: randomUUID(),
            intent_id: intentId,
            agent_id: agentId,
            request_id: params.context.requestId,
            run_id: params.context.runId,
            actor_ref: auditActorRef(params.context),
            subject_ref: auditSubjectRef(params.context),
            operation: params.context.operation,
            resource_revision_id: current.revisionId,
            content_hash: current.contentHash,
            decision: "tombstoned",
            reason_code: "authorized-tombstone",
            state: "pending",
            attempts: 0,
            created_at: nowMs,
            updated_at: nowMs,
            delivered_at: null,
          }),
        );
      });
      const pathname = resolveBuiltinScopedMemoryArtifactPath({
        databasePath,
        pathKey: store.pathKey,
        artifactLocator: existing.artifactLocator,
      });
      try {
        fs.unlinkSync(pathname);
        syncDirectory(path.dirname(pathname));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          // The catalog is already tombstoned. Retain the failed unlink as a
          // quarantined artifact instead of leaving it in a selected root.
          quarantineArtifact({ directory: path.dirname(pathname), pathname });
          runSqliteImmediateTransactionSync(database, () => {
            requireExactlyOneAffected(
              executeSqliteQuerySync(
                database,
                db
                  .updateTable("memory_write_intents")
                  .set({ state: "quarantined", updated_at: Date.now() })
                  .where("intent_id", "=", intentId)
                  .where("state", "=", "tombstoned"),
              ),
              "tombstone artifact quarantine",
            );
            executeSqliteQuerySync(
              database,
              db
                .updateTable("memory_audit_outbox")
                .set({
                  decision: "quarantined",
                  reason_code: "tombstone-artifact-quarantined",
                  updated_at: Date.now(),
                })
                .where("intent_id", "=", intentId)
                .where("state", "=", "pending"),
            );
          });
        }
      }
      return Object.freeze({
        version: 1,
        mutationId: mutation.mutationId,
        status: "committed",
        policyRevision: store.policyRevisionId,
        committedAt: new Date(nowMs).toISOString(),
      });
    }

    if (!("content" in params.mutation)) {
      throw new Error("authorized memory mutation is unavailable");
    }
    const input = params.mutation.content;
    const prior =
      params.mutation.kind === "append" && existing
        ? readVerifiedFile({
            pathname: resolveBuiltinScopedMemoryArtifactPath({
              databasePath,
              pathKey: store.pathKey,
              artifactLocator: existing.artifactLocator,
            }),
            contentHash: existing.contentHash,
            contentBytes: existing.contentBytes,
          })
        : undefined;
    if (params.mutation.kind === "append" && existing && prior === undefined) {
      throw new Error("authorized memory mutation is unavailable");
    }
    const content = prior === undefined ? input : `${prior}${input}`;
    if (!content.trim()) {
      throw new Error("authorized memory mutation is unavailable");
    }
    const revisionId = randomUUID();
    const intentId = randomUUID();
    const finalLocator = `r1_${revisionId}.md`;
    const stageLocator = `mwst1_${intentId}.tmp`;
    const directory = path.join(resolveScopedMemoryArtifactBase(databasePath), store.pathKey);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stagePath = path.join(directory, stageLocator);
    const finalPath = resolveBuiltinScopedMemoryArtifactPath({
      databasePath,
      pathKey: store.pathKey,
      artifactLocator: finalLocator,
    });
    const hash = contentHash(content);
    const bytes = Buffer.byteLength(content);
    const descriptor = fs.openSync(stagePath, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, content, "utf8");
      fs.fchmodSync(descriptor, 0o600);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    syncDirectory(directory);
    const resourceId = existing?.resourceId ?? randomUUID();
    try {
      runSqliteImmediateTransactionSync(database, () => {
        const currentStore = selectWriteStore({ database, agentId, state });
        if (
          currentStore.storeId !== store.storeId ||
          currentStore.policyRevisionId !== store.policyRevisionId ||
          currentStore.policyRevocationEpoch !== store.policyRevocationEpoch
        ) {
          throw new Error("authorized memory mutation is unavailable");
        }
        if (!existing) {
          executeSqliteQuerySync(
            database,
            db.insertInto("memory_resources").values({
              resource_id: resourceId,
              agent_id: agentId,
              store_id: store.storeId,
              logical_locator: `memory/${revisionId}.md`,
              source: "memory",
              created_at: nowMs,
            }),
          );
        }
        const previous = executeSqliteQueryTakeFirstSync(
          database,
          db
            .selectFrom("memory_resource_revisions")
            .select("revision_number")
            .where("resource_id", "=", resourceId)
            .orderBy("revision_number", "desc")
            .limit(1),
        );
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_resource_revisions").values({
            revision_id: revisionId,
            resource_id: resourceId,
            revision_number: (previous?.revision_number ?? 0) + 1,
            artifact_locator: finalLocator,
            content_hash: hash,
            content_bytes: bytes,
            policy_revision_id: store.policyRevisionId,
            policy_revocation_epoch: store.policyRevocationEpoch,
            source_policy_set_id: createScopedMemorySourcePolicySetId(store.policyRevisionId),
            lifecycle_state: "pending",
            actor_kind:
              params.context.actor.kind === "principal"
                ? params.context.actor.actorKind
                : "unattributed",
            actor_id:
              params.context.actor.kind === "principal" ? params.context.actor.principalId : null,
            expires_at: null,
            created_at: nowMs,
            activated_at: null,
            retired_at: null,
          }),
        );
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_revision_policy_requirements").values({
            revision_id: revisionId,
            policy_id: store.policyId,
            expected_revision_id: store.policyRevisionId,
            expected_revocation_epoch: store.policyRevocationEpoch,
            requirement_kind: "output-policy",
            created_at: nowMs,
          }),
        );
        for (const source of derivationSources) {
          for (const requirement of source.policyRequirements) {
            executeSqliteQuerySync(
              database,
              db
                .insertInto("memory_revision_policy_requirements")
                .values({
                  revision_id: revisionId,
                  policy_id: requirement.policyId,
                  expected_revision_id: requirement.expectedRevisionId,
                  expected_revocation_epoch: requirement.expectedRevocationEpoch,
                  requirement_kind: "source-policy",
                  created_at: nowMs,
                })
                .onConflict((conflict) =>
                  conflict.columns(["revision_id", "policy_id"]).doNothing(),
                ),
            );
          }
          executeSqliteQuerySync(
            database,
            db.insertInto("memory_lineage_edges").values({
              child_revision_id: revisionId,
              parent_kind: "resource-revision",
              parent_id: source.revisionId,
              relation_kind: "derived-from",
              created_at: nowMs,
            }),
          );
        }
        if (transcriptDerivationSource && transcriptDerivationPurpose) {
          for (const requirement of transcriptDerivationSource.policyRequirements) {
            executeSqliteQuerySync(
              database,
              db
                .insertInto("memory_revision_policy_requirements")
                .values({
                  revision_id: revisionId,
                  policy_id: requirement.policyId,
                  expected_revision_id: requirement.expectedRevisionId,
                  expected_revocation_epoch: requirement.expectedRevocationEpoch,
                  requirement_kind: "source-policy",
                  created_at: nowMs,
                })
                .onConflict((conflict) =>
                  conflict.columns(["revision_id", "policy_id"]).doNothing(),
                ),
            );
          }
          for (const sourceRevisionId of transcriptDerivationSource.sourceRevisionIds) {
            executeSqliteQuerySync(
              database,
              db.insertInto("memory_lineage_edges").values({
                child_revision_id: revisionId,
                parent_kind: "resource-revision",
                parent_id: sourceRevisionId,
                relation_kind: "derived-from",
                created_at: nowMs,
              }),
            );
          }
          executeSqliteQuerySync(
            database,
            db.insertInto("memory_lineage_edges").values({
              child_revision_id: revisionId,
              parent_kind: "transcript-policy-set",
              parent_id: transcriptDerivationSource.sourcePolicySetId,
              relation_kind:
                transcriptDerivationPurpose === "compaction" ? "compacted-from" : "flushed-from",
              created_at: nowMs,
            }),
          );
        }
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_write_intents").values({
            intent_id: intentId,
            idempotency_key: params.mutation.idempotencyKey,
            mutation_id: params.mutation.mutationId,
            agent_id: agentId,
            request_id: params.context.requestId,
            run_id: params.context.runId,
            context_fingerprint: params.context.contextFingerprint,
            plan_id: params.plan.planId,
            mutation_kind: params.mutation.kind,
            store_id: store.storeId,
            resource_id: resourceId,
            pending_revision_id: revisionId,
            staged_locator: stageLocator,
            final_locator: finalLocator,
            content_hash: hash,
            content_bytes: bytes,
            state: "pending",
            created_at: nowMs,
            updated_at: nowMs,
            activated_at: null,
            indexed_at: null,
          }),
        );
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_audit_outbox").values({
            event_id: randomUUID(),
            intent_id: intentId,
            agent_id: agentId,
            request_id: params.context.requestId,
            run_id: params.context.runId,
            actor_ref: auditActorRef(params.context),
            subject_ref: auditSubjectRef(params.context),
            operation: params.context.operation,
            resource_revision_id: revisionId,
            content_hash: hash,
            decision: "pending",
            reason_code: "authorized-write-pending",
            state: "pending",
            attempts: 0,
            created_at: nowMs,
            updated_at: nowMs,
            delivered_at: null,
          }),
        );
      });
    } catch (error) {
      try {
        fs.unlinkSync(stagePath);
      } catch {}
      throw error;
    }
    fs.renameSync(stagePath, finalPath);
    syncDirectory(directory);
    const verified = readVerifiedFile({
      pathname: finalPath,
      contentHash: hash,
      contentBytes: bytes,
    });
    if (verified === undefined) {
      throw new Error("authorized memory finalized artifact is unavailable");
    }
    runSqliteImmediateTransactionSync(database, () => {
      const currentStore = selectWriteStore({ database, agentId, state });
      if (
        currentStore.storeId !== store.storeId ||
        currentStore.policyRevisionId !== store.policyRevisionId ||
        currentStore.policyRevocationEpoch !== store.policyRevocationEpoch
      ) {
        throw new Error("authorized memory mutation is unavailable");
      }
      if (params.mutation.kind === "derive") {
        // The model work and artifact rename already happened; this final synchronous reread is
        // the authority boundary that prevents a revoke or parent tombstone from activating it.
        if ("sourceHandles" in params.mutation) {
          resolveDerivationSources({
            database,
            agentId,
            state,
            targetAudience: currentStore.audience,
            sourceHandles: params.mutation.sourceHandles,
            sourcePolicySetId: params.mutation.sourcePolicySetId,
          });
        } else if ("transcriptSource" in params.mutation) {
          resolveTranscriptDerivationSource({
            database,
            source: params.mutation.transcriptSource,
            sourcePolicySetId: params.mutation.sourcePolicySetId,
            targetAudience: currentStore.audience,
          });
        } else {
          throw new Error("authorized memory derivation is unavailable");
        }
      }
      if (existing) {
        executeSqliteQuerySync(
          database,
          db
            .updateTable("memory_resource_revisions")
            .set({ lifecycle_state: "tombstoned", retired_at: Date.now() })
            .where("resource_id", "=", resourceId)
            .where("lifecycle_state", "=", "active"),
        );
      }
      requireExactlyOneAffected(
        executeSqliteQuerySync(
          database,
          db
            .updateTable("memory_resource_revisions")
            .set({ lifecycle_state: "active", activated_at: Date.now() })
            .where("revision_id", "=", revisionId)
            .where("lifecycle_state", "=", "pending"),
        ),
        "activation revision",
      );
      requireExactlyOneAffected(
        executeSqliteQuerySync(
          database,
          db
            .updateTable("memory_write_intents")
            .set({ state: "active", activated_at: Date.now(), updated_at: Date.now() })
            .where("intent_id", "=", intentId)
            .where("state", "=", "pending"),
        ),
        "activation intent",
      );
      executeSqliteQuerySync(
        database,
        db
          .updateTable("memory_audit_outbox")
          .set({
            decision: "committed",
            reason_code: "authorized-write-committed",
            updated_at: Date.now(),
          })
          .where("intent_id", "=", intentId)
          .where("state", "=", "pending"),
      );
    });
    runSqliteImmediateTransactionSync(database, () => {
      const chunks = chunkContent(verified);
      if (chunks.length > 0) {
        executeSqliteQuerySync(
          database,
          db.insertInto("memory_scoped_chunks").values(
            chunks.map((chunk) => ({
              chunk_id: randomUUID(),
              revision_id: revisionId,
              chunk_ordinal: chunk.ordinal,
              start_line: chunk.startLine,
              end_line: chunk.endLine,
              text: chunk.text,
              content_hash: contentHash(chunk.text),
              model: "builtin-markdown-v1",
              updated_at: Date.now(),
            })),
          ),
        );
      }
      executeSqliteQuerySync(
        database,
        db
          .updateTable("memory_write_intents")
          .set({ indexed_at: Date.now(), updated_at: Date.now() })
          .where("intent_id", "=", intentId)
          .where("state", "=", "active"),
      );
    });
    const handle = createHandle({
      plan: state,
      revisionId,
      policyRevision: store.policyRevisionId,
    });
    return Object.freeze({
      version: 1,
      mutationId: params.mutation.mutationId,
      status: "committed",
      resourceHandle: handle,
      policyRevision: store.policyRevisionId,
      committedAt: new Date(Date.now()).toISOString(),
    });
  });
  drainMemoryAuditOutbox(agentId);
  return result;
}

/**
 * Files are finalized before the core transaction starts. A crash before commit
 * leaves only an uncatalogued artifact, which recovery quarantines; a committed
 * revision never needs a filesystem operation to become readable.
 */
async function stageSealedCompaction(
  params: AuthorizedSealedCompactionStageParams,
): Promise<AuthorizedSealedCompactionArtifact> {
  if (!params.content.trim()) {
    throw new Error("sealed compaction content is unavailable");
  }
  const state = readPlan({ context: params.context, plan: params.plan });
  if (!state || state.expiresAtMs <= Date.now()) {
    throw new Error("sealed compaction authorization is unavailable");
  }
  const agentId = params.context.agentId;
  return withScopedMemoryDatabase(agentId, (database, databasePath) => {
    const store = selectWriteStore({ database, agentId, state });
    const source = resolveTranscriptDerivationSource({
      database,
      source: params.transcriptSource,
      sourcePolicySetId: params.transcriptSource.sourcePolicySetId,
      targetAudience: store.audience,
    });
    const revisionId = randomUUID();
    const resourceId = randomUUID();
    const intentId = randomUUID();
    const finalLocator = `r1_${revisionId}.md`;
    const stageLocator = `scst1_${intentId}.tmp`;
    const directory = path.join(resolveScopedMemoryArtifactBase(databasePath), store.pathKey);
    const finalPath = resolveBuiltinScopedMemoryArtifactPath({
      databasePath,
      pathKey: store.pathKey,
      artifactLocator: finalLocator,
    });
    const stagePath = path.join(directory, stageLocator);
    const hash = contentHash(params.content);
    const bytes = Buffer.byteLength(params.content);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const descriptor = fs.openSync(stagePath, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, params.content, "utf8");
      fs.fchmodSync(descriptor, 0o600);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    syncDirectory(directory);
    fs.renameSync(stagePath, finalPath);
    syncDirectory(directory);
    const verified = readVerifiedFile({
      pathname: finalPath,
      contentHash: hash,
      contentBytes: bytes,
    });
    if (verified === undefined) {
      throw new Error("sealed compaction artifact is unavailable");
    }
    return Object.freeze({
      resourceRevisionId: revisionId,
      commitInTransaction({ database: transactionDatabase, compactionPolicyId, eventSeq }) {
        if (state.expiresAtMs <= Date.now()) {
          throw new Error("sealed compaction authorization is unavailable");
        }
        const currentStore = selectWriteStore({
          database: transactionDatabase,
          agentId,
          state,
        });
        if (
          currentStore.storeId !== store.storeId ||
          currentStore.policyRevisionId !== store.policyRevisionId ||
          currentStore.policyRevocationEpoch !== store.policyRevocationEpoch
        ) {
          throw new Error("sealed compaction authorization is unavailable");
        }
        const currentSource = resolveTranscriptDerivationSource({
          database: transactionDatabase,
          source: params.transcriptSource,
          sourcePolicySetId: params.transcriptSource.sourcePolicySetId,
          targetAudience: currentStore.audience,
        });
        if (
          currentSource.sourcePolicySetId !== source.sourcePolicySetId ||
          currentSource.sourceRevisionIds.length !== source.sourceRevisionIds.length ||
          currentSource.sourceRevisionIds.some(
            (revision, index) => revision !== source.sourceRevisionIds[index],
          )
        ) {
          throw new Error("sealed compaction source is unavailable");
        }
        const db = getNodeSqliteKysely<ScopedMemoryDatabase>(transactionDatabase);
        const nowMs = Date.now();
        executeSqliteQuerySync(
          transactionDatabase,
          db.insertInto("memory_resources").values({
            resource_id: resourceId,
            agent_id: agentId,
            store_id: store.storeId,
            logical_locator: `memory/${revisionId}.md`,
            source: "memory",
            created_at: nowMs,
          }),
        );
        executeSqliteQuerySync(
          transactionDatabase,
          db.insertInto("memory_resource_revisions").values({
            revision_id: revisionId,
            resource_id: resourceId,
            revision_number: 1,
            artifact_locator: finalLocator,
            content_hash: hash,
            content_bytes: bytes,
            policy_revision_id: store.policyRevisionId,
            policy_revocation_epoch: store.policyRevocationEpoch,
            source_policy_set_id: createScopedMemorySourcePolicySetId(store.policyRevisionId),
            lifecycle_state: "active",
            actor_kind:
              params.context.actor.kind === "principal"
                ? params.context.actor.actorKind
                : "unattributed",
            actor_id:
              params.context.actor.kind === "principal" ? params.context.actor.principalId : null,
            expires_at: null,
            created_at: nowMs,
            activated_at: nowMs,
            retired_at: null,
          }),
        );
        executeSqliteQuerySync(
          transactionDatabase,
          db.insertInto("memory_revision_policy_requirements").values({
            revision_id: revisionId,
            policy_id: store.policyId,
            expected_revision_id: store.policyRevisionId,
            expected_revocation_epoch: store.policyRevocationEpoch,
            requirement_kind: "output-policy",
            created_at: nowMs,
          }),
        );
        for (const requirement of source.policyRequirements) {
          executeSqliteQuerySync(
            transactionDatabase,
            db
              .insertInto("memory_revision_policy_requirements")
              .values({
                revision_id: revisionId,
                policy_id: requirement.policyId,
                expected_revision_id: requirement.expectedRevisionId,
                expected_revocation_epoch: requirement.expectedRevocationEpoch,
                requirement_kind: "source-policy",
                created_at: nowMs,
              })
              .onConflict((conflict) => conflict.columns(["revision_id", "policy_id"]).doNothing()),
          );
        }
        const lineage = [
          ...source.sourceRevisionIds.map((parentId) => ({
            parent_kind: "resource-revision" as const,
            parent_id: parentId,
            relation_kind: "derived-from" as const,
          })),
          {
            parent_kind: "transcript-policy-set" as const,
            parent_id: source.sourcePolicySetId,
            relation_kind: "compacted-from" as const,
          },
          {
            parent_kind: "compaction-policy" as const,
            parent_id: compactionPolicyId,
            relation_kind: "compacted-from" as const,
          },
        ];
        for (const parent of lineage) {
          executeSqliteQuerySync(
            transactionDatabase,
            db.insertInto("memory_lineage_edges").values({
              child_revision_id: revisionId,
              ...parent,
              created_at: nowMs,
            }),
          );
        }
        const chunks = chunkContent(verified);
        if (chunks.length > 0) {
          executeSqliteQuerySync(
            transactionDatabase,
            db.insertInto("memory_scoped_chunks").values(
              chunks.map((chunk) => ({
                chunk_id: randomUUID(),
                revision_id: revisionId,
                chunk_ordinal: chunk.ordinal,
                start_line: chunk.startLine,
                end_line: chunk.endLine,
                text: chunk.text,
                content_hash: contentHash(chunk.text),
                model: "builtin-markdown-v1",
                updated_at: nowMs,
              })),
            ),
          );
        }
        executeSqliteQuerySync(
          transactionDatabase,
          db.insertInto("memory_write_intents").values({
            intent_id: intentId,
            idempotency_key: `sealed-compaction:${compactionPolicyId}`,
            mutation_id: compactionPolicyId,
            agent_id: agentId,
            request_id: params.context.requestId,
            run_id: params.context.runId,
            context_fingerprint: params.context.contextFingerprint,
            plan_id: params.plan.planId,
            mutation_kind: "derive",
            store_id: store.storeId,
            resource_id: resourceId,
            pending_revision_id: revisionId,
            staged_locator: stageLocator,
            final_locator: finalLocator,
            content_hash: hash,
            content_bytes: bytes,
            state: "active",
            created_at: nowMs,
            updated_at: nowMs,
            activated_at: nowMs,
            indexed_at: nowMs,
          }),
        );
        executeSqliteQuerySync(
          transactionDatabase,
          db.insertInto("memory_audit_outbox").values({
            event_id: randomUUID(),
            intent_id: intentId,
            agent_id: agentId,
            request_id: params.context.requestId,
            run_id: params.context.runId,
            actor_ref: auditActorRef(params.context),
            subject_ref: auditSubjectRef(params.context),
            operation: params.context.operation,
            resource_revision_id: revisionId,
            content_hash: hash,
            decision: "committed",
            reason_code: `sealed-compaction:${eventSeq}`,
            state: "pending",
            attempts: 0,
            created_at: nowMs,
            updated_at: nowMs,
            delivered_at: null,
          }),
        );
      },
    });
  });
}

export function createBuiltinScopedMemoryAuthorizedRuntime(
  enterpriseAccessAuditReporter?: MemoryEnterpriseAccessAuditReporter,
): AuthorizedMemoryRuntime {
  const builtinScopedMemoryRuntime = {
    async authorize(context: MemoryAccessContext): Promise<AuthorizedMemoryPlan> {
      recoverPendingWrites(context.agentId);
      drainMemoryAuditOutbox(context.agentId);
      const state = createPlan(context, enterpriseAccessAuditReporter);
      plans.set(state.plan.planId, state);
      return state.plan;
    },

    async searchAuthorized(
      params: AuthorizedMemorySearchParams<"read"> | AuthorizedMemorySearchParams<"derive">,
    ): Promise<AuthorizedMemoryResultEnvelope<readonly AuthorizedMemorySearchResult[]>> {
      if (params.context.operation !== "read" && params.context.operation !== "derive") {
        throw new Error("authorized memory search is unavailable");
      }
      const state = readPlan(params);
      if (!state || !params.query.trim()) {
        throw new Error("authorized memory search is unavailable");
      }
      const limit = Math.max(1, Math.min(100, Math.trunc(params.limit)));
      const storeIds = state.stores.map((store) => store.storeId);
      const sources = params.sources?.length ? params.sources : (["memory", "sessions"] as const);
      const candidates = withScopedMemoryDatabase(params.context.agentId, (database) =>
        readScopedMemoryFtsCandidatePage({
          database,
          query: params.query,
          storeIds,
          sources: sources as readonly MemorySource[],
          limit: limit * MAXIMUM_CANDIDATES_PER_RESULT,
          offset: 0,
        }),
      );
      const results: AuthorizedMemorySearchResult[] = [];
      const sourcePolicySetIds: string[] = [];
      for (const candidate of candidates) {
        if (results.length >= limit) {
          break;
        }
        const snapshot = readBuiltinScopedMemoryRevisionSnapshot({
          agentId: params.context.agentId,
          storeIds,
          revisionId: candidate.revisionId,
        });
        if (!snapshot) {
          continue;
        }
        const handle = createHandle({
          plan: state,
          revisionId: snapshot.revisionId,
          policyRevision: snapshot.policyRevisionId,
        });
        const result = toSearchResult({ candidate, snapshot, handle });
        if (!result) {
          continue;
        }
        results.push(result);
        sourcePolicySetIds.push(`mps1_${snapshot.policyRevisionId}`);
      }
      return createEnvelope({
        state,
        context: params.context,
        value: Object.freeze(results),
        revisions: results.map((result) => result.resourceHandle.resourceRevision),
        sourcePolicySetIds:
          sourcePolicySetIds.length > 0 ? sourcePolicySetIds : [state.plan.memoryPolicyRevision],
      });
    },

    async readAuthorized(
      params: AuthorizedMemoryReadParams<"read"> | AuthorizedMemoryReadParams<"derive">,
    ): Promise<AuthorizedMemoryResultEnvelope<MemoryReadResult>> {
      if (params.context.operation !== "read" && params.context.operation !== "derive") {
        throw new Error("authorized memory read is unavailable");
      }
      const state = readPlan(params);
      const storedHandle = state?.handles.get(params.handle.handleId);
      if (
        !state ||
        !storedHandle ||
        storedHandle.planId !== params.handle.planId ||
        storedHandle.contextFingerprint !== params.handle.contextFingerprint ||
        storedHandle.resourceRevision !== params.handle.resourceRevision ||
        storedHandle.policyRevision !== params.handle.policyRevision ||
        storedHandle.expiresAt !== params.handle.expiresAt
      ) {
        throw new Error("authorized memory read is unavailable");
      }
      const snapshot = readBuiltinScopedMemoryRevisionSnapshot({
        agentId: params.context.agentId,
        storeIds: state.stores.map((store) => store.storeId),
        revisionId: storedHandle.resourceRevision,
      });
      if (!snapshot || snapshot.policyRevisionId !== storedHandle.policyRevision) {
        throw new Error("authorized memory read is unavailable");
      }
      const lines = snapshot.content.split("\n");
      const from = Math.max(1, Math.trunc(params.from ?? 1));
      const lineCount = Math.max(1, Math.min(1000, Math.trunc(params.lines ?? 200)));
      const selected = lines.slice(from - 1, from - 1 + lineCount);
      const value: MemoryReadResult = Object.freeze({
        text: selected.join("\n"),
        path: `memory/${snapshot.logicalLocator}`,
        from,
        lines: selected.length,
        ...(from - 1 + selected.length < lines.length
          ? { truncated: true, nextFrom: from + selected.length }
          : {}),
      });
      return createEnvelope({
        state,
        context: params.context,
        value,
        revisions: [snapshot.revisionId],
        sourcePolicySetIds: [`mps1_${snapshot.policyRevisionId}`],
      });
    },

    async writeAuthorized(params: {
      context: MemoryAccessContext;
      plan: AuthorizedMemoryPlan;
      mutation: AuthorizedMemoryMutation;
    }): Promise<MemoryWriteResult> {
      if (params.mutation.kind === "admin-reclassify") {
        throw new Error("authorized memory reclassification is unavailable");
      }
      return await writeAuthorizedMutation(params);
    },

    async stageSealedCompaction(params: AuthorizedSealedCompactionStageParams) {
      return await stageSealedCompaction(params);
    },

    async importAuthorized(params: {
      context: MemoryAccessContext;
      plan: AuthorizedMemoryPlan;
      mutation: Extract<AuthorizedMemoryMutation, { kind: "import" }>;
    }): Promise<MemoryWriteResult> {
      return await writeAuthorizedMutation(params);
    },

    async syncAuthorized(params: {
      context: MemoryAccessContext;
      plan: AuthorizedMemoryPlan;
    }): Promise<AuthorizedMemoryResultEnvelope<MemorySyncResult>> {
      if (params.context.operation !== "sync") {
        throw new Error("authorized memory sync is unavailable");
      }
      const state = readPlan(params);
      if (!state) {
        throw new Error("authorized memory sync is unavailable");
      }
      drainMemoryAuditOutbox(params.context.agentId);
      return createEnvelope({
        state,
        context: params.context,
        value: Object.freeze({ version: 1, status: "completed" as const, synchronizedHandles: [] }),
        revisions: [],
        sourcePolicySetIds: [params.plan.memoryPolicyRevision],
      });
    },

    async exportAuthorized(params: {
      context: MemoryAccessContext;
      plan: AuthorizedMemoryPlan;
      handles: readonly AuthorizedResourceHandle[];
    }): Promise<AuthorizedMemoryResultEnvelope<MemoryExportResult>> {
      if (params.context.operation !== "export") {
        throw new Error("authorized memory export is unavailable");
      }
      const state = readPlan(params);
      if (!state || params.handles.length > 0) {
        // Export is deliberately unavailable until a caller has an export-specific
        // scoped handle flow; never broaden a read handle into an artifact route.
        throw new Error("authorized memory export is unavailable");
      }
      return createEnvelope({
        state,
        context: params.context,
        value: Object.freeze({
          version: 1,
          exportId: randomUUID(),
          contentType: "application/json" as const,
          encoding: "utf8" as const,
          payload: "[]",
          exportedHandles: [],
        }),
        revisions: [],
        sourcePolicySetIds: [params.plan.memoryPolicyRevision],
      });
    },

    async statusAuthorized(params: {
      context: MemoryAccessContext;
      plan: AuthorizedMemoryPlan;
    }): Promise<AuthorizedMemoryResultEnvelope<AuthorizedMemoryStatus>> {
      if (params.context.operation !== "status") {
        throw new Error("authorized memory status is unavailable");
      }
      const state = readPlan(params);
      if (!state) {
        throw new Error("authorized memory status is unavailable");
      }
      return createEnvelope({
        state,
        context: params.context,
        value: Object.freeze({ version: 1, backend: "builtin", provider: "scoped-memory" }),
        revisions: [],
        sourcePolicySetIds: [params.plan.memoryPolicyRevision],
      });
    },
  };
  return Object.freeze(builtinScopedMemoryRuntime) as unknown as AuthorizedMemoryRuntime;
}

export const builtinScopedMemoryAuthorizedRuntime = createBuiltinScopedMemoryAuthorizedRuntime();

export const builtinScopedMemoryVirtualView = Object.freeze({
  async materializeAuthorizedVirtualView(params: {
    context: MemoryContentAccessContext<"read">;
    plan: AuthorizedMemoryPlan & Readonly<{ operation: "read" }>;
  }): Promise<AuthorizedMemoryVirtualView | undefined> {
    return materializeAuthorizedVirtualView(params);
  },
  async readAuthorizedVirtualFile(params: {
    context: MemoryContentAccessContext<"read">;
    plan: AuthorizedMemoryPlan & Readonly<{ operation: "read" }>;
    view: AuthorizedMemoryVirtualView;
    virtualPath: string;
  }): Promise<AuthorizedMemoryResultEnvelope<MemoryReadResult>> {
    return readAuthorizedVirtualFile(params);
  },
});

export function resetBuiltinScopedMemoryAuthorizedRuntimeForTest(): void {
  plans.clear();
  virtualViews.clear();
}
