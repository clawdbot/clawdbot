import type {
  AuthorizedMemoryPlan,
  AuthorizedMemoryResultEnvelope,
  AuthorizedResourceHandle,
  AudienceRef,
  MemoryContentAccessContext,
} from "../memory-host-sdk/host/authorization.js";
import type {
  MemoryReadResult,
  MemorySearchResult,
  MemorySource,
} from "../memory-host-sdk/host/types.js";
import {
  materializeTrustedMemoryAccessContext,
  type TrustedMemoryAccessContext,
} from "../state/memory-access-context.js";
import {
  admitMemoryAuthorizationReadRuntime,
  type AdmittedAuthorizedMemoryReadRuntime,
} from "./memory-authorization-runtime.js";
import { resolveSelectedMemoryCapabilityRegistration } from "./memory-state.js";
import type { MemoryPluginCapability } from "./registry-contribution-types.js";
import { requireActivePluginRegistry } from "./runtime.js";

export type MemoryInvocationUnavailable = Readonly<{
  disabled: true;
  unavailable: true;
  error: "memory unavailable";
}>;

export const MEMORY_INVOCATION_UNAVAILABLE: MemoryInvocationUnavailable = Object.freeze({
  disabled: true,
  unavailable: true,
  error: "memory unavailable",
});

const memoryReadInvocationBrand: unique symbol = Symbol("openclaw.memory-read-invocation");

export type AuthorizedMemoryReadInvocation = Readonly<{
  readonly [memoryReadInvocationBrand]: true;
}>;

type InvocationState = Readonly<{
  trustedContext: TrustedMemoryAccessContext;
  context: MemoryContentAccessContext<"read">;
  plan: AuthorizedMemoryPlan & Readonly<{ operation: "read" }>;
  authorizationStartedAtMs: number;
  runtime: AdmittedAuthorizedMemoryReadRuntime;
  handles: Map<string, AuthorizedResourceHandle>;
  sourcePolicySetIds: Set<string>;
  exposedRevisionHandles: Set<string>;
  exposureReceiptIds: Set<string>;
  egressReceiptIds: Set<string>;
  runExposureRevisions: Set<string>;
}>;

const invocationStates = new WeakMap<object, InvocationState>();

function sameAudiences(left: readonly AudienceRef[], right: readonly AudienceRef[]): boolean {
  const key = (audience: AudienceRef) => `${audience.kind}\u0000${audience.id}`;
  const leftKeys = [...new Set(left.map(key))].toSorted();
  const rightKeys = [...new Set(right.map(key))].toSorted();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every((value, index) => value === rightKeys[index])
  );
}

function isCurrentPlan(params: {
  context: MemoryContentAccessContext<"read">;
  plan: AuthorizedMemoryPlan & Readonly<{ operation: "read" }>;
  nowMs: number;
}): boolean {
  const { context, plan } = params;
  const expiresAt = Date.parse(plan.expiresAt);
  return (
    plan.version === 1 &&
    plan.contextFingerprint === context.contextFingerprint &&
    plan.runId === context.runId &&
    plan.agentId === context.agentId &&
    plan.sessionId === context.sessionId &&
    plan.sessionIdentityRevision === context.sessionIdentityRevision &&
    plan.subjectRevision === context.subjectRevision &&
    plan.deliveryRevision === context.delivery.deliveryRevision &&
    plan.operation === context.operation &&
    Number.isFinite(expiresAt) &&
    expiresAt > params.nowMs
  );
}

function readCurrentContext(
  state: InvocationState,
): MemoryContentAccessContext<"read"> | undefined {
  const current = materializeTrustedMemoryAccessContext(state.trustedContext);
  if (!current || current.operation !== "read") {
    return undefined;
  }
  const readContext = current as MemoryContentAccessContext<"read">;
  if (
    readContext.contextFingerprint !== state.context.contextFingerprint ||
    readContext.runId !== state.context.runId ||
    readContext.agentId !== state.context.agentId ||
    readContext.sessionId !== state.context.sessionId ||
    readContext.sessionIdentityRevision !== state.context.sessionIdentityRevision ||
    readContext.subjectRevision !== state.context.subjectRevision ||
    readContext.delivery.deliveryRevision !== state.context.delivery.deliveryRevision ||
    readContext.delivery.egressRegistryRevision !== state.context.delivery.egressRegistryRevision ||
    !sameAudiences(readContext.delivery.audiences, state.context.delivery.audiences)
  ) {
    return undefined;
  }
  return readContext;
}

function mergeAndValidateEnvelope<T>(params: {
  state: InvocationState;
  context: MemoryContentAccessContext<"read">;
  expectedRevisionHandles: readonly string[];
  envelope: AuthorizedMemoryResultEnvelope<T>;
}): boolean {
  const { state, context, envelope } = params;
  const { exposureReceipt, egressReceipt } = envelope;
  const nowMs = Date.now();
  const exposureRecordedAt = Date.parse(exposureReceipt.recordedAt);
  const egressExpiry = Date.parse(egressReceipt.expiresAt);
  if (
    exposureReceipt.version !== 1 ||
    egressReceipt.version !== 1 ||
    exposureReceipt.contextFingerprint !== context.contextFingerprint ||
    egressReceipt.contextFingerprint !== context.contextFingerprint ||
    exposureReceipt.planId !== state.plan.planId ||
    egressReceipt.planId !== state.plan.planId ||
    exposureReceipt.runId !== context.runId ||
    egressReceipt.runId !== context.runId ||
    exposureReceipt.runExposureRevision !== egressReceipt.runExposureRevision ||
    exposureReceipt.sourcePolicySetId !== egressReceipt.sourcePolicySetId ||
    !exposureReceipt.receiptId ||
    !egressReceipt.receiptId ||
    !exposureReceipt.sourcePolicySetId ||
    !Number.isFinite(exposureRecordedAt) ||
    exposureRecordedAt < state.authorizationStartedAtMs ||
    exposureRecordedAt > nowMs ||
    !Number.isFinite(egressExpiry) ||
    egressExpiry <= nowMs ||
    exposureRecordedAt > egressExpiry ||
    egressReceipt.deliveryRevision !== context.delivery.deliveryRevision ||
    egressReceipt.egressRegistryRevision !== context.delivery.egressRegistryRevision ||
    !sameAudiences(egressReceipt.allowedAudiences, context.delivery.audiences) ||
    state.exposureReceiptIds.has(exposureReceipt.receiptId) ||
    state.egressReceiptIds.has(egressReceipt.receiptId) ||
    state.exposureReceiptIds.has(egressReceipt.receiptId) ||
    state.egressReceiptIds.has(exposureReceipt.receiptId) ||
    state.runExposureRevisions.has(exposureReceipt.runExposureRevision)
  ) {
    return false;
  }
  const exposed = new Set(exposureReceipt.exposedRevisionHandles);
  if (
    exposed.size !== exposureReceipt.exposedRevisionHandles.length ||
    !params.expectedRevisionHandles.every((revision) => exposed.has(revision))
  ) {
    return false;
  }
  state.sourcePolicySetIds.add(exposureReceipt.sourcePolicySetId);
  for (const revision of exposureReceipt.exposedRevisionHandles) {
    state.exposedRevisionHandles.add(revision);
  }
  state.exposureReceiptIds.add(exposureReceipt.receiptId);
  state.egressReceiptIds.add(egressReceipt.receiptId);
  state.runExposureRevisions.add(exposureReceipt.runExposureRevision);
  return true;
}

function readState(invocation: AuthorizedMemoryReadInvocation): InvocationState | undefined {
  return invocationStates.get(invocation);
}

/**
 * Creates a process-local, opaque read invocation. No caller can inject a serializable identity,
 * audience, plan, or continuation: all of those come from the trusted context and selected backend.
 */
export async function createAuthorizedMemoryReadInvocation(params: {
  context: TrustedMemoryAccessContext;
  capability?: MemoryPluginCapability;
}): Promise<AuthorizedMemoryReadInvocation | MemoryInvocationUnavailable> {
  const materialized = materializeTrustedMemoryAccessContext(params.context);
  if (!materialized || materialized.operation !== "read") {
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  const context = materialized as MemoryContentAccessContext<"read">;
  const capability =
    params.capability ??
    resolveSelectedMemoryCapabilityRegistration(requireActivePluginRegistry())?.capability;
  const admission = await admitMemoryAuthorizationReadRuntime(capability);
  if (!admission.ok) {
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  try {
    const authorizationStartedAtMs = Date.now();
    const plan = (await admission.runtime.authorize(context)) as AuthorizedMemoryPlan &
      Readonly<{ operation: "read" }>;
    if (!isCurrentPlan({ context, plan, nowMs: Date.now() })) {
      return MEMORY_INVOCATION_UNAVAILABLE;
    }
    const invocation = Object.freeze({}) as AuthorizedMemoryReadInvocation;
    invocationStates.set(
      invocation,
      Object.freeze({
        trustedContext: params.context,
        context,
        plan,
        authorizationStartedAtMs,
        runtime: admission.runtime,
        handles: new Map(),
        sourcePolicySetIds: new Set<string>(),
        exposedRevisionHandles: new Set<string>(),
        exposureReceiptIds: new Set<string>(),
        egressReceiptIds: new Set<string>(),
        runExposureRevisions: new Set<string>(),
      }),
    );
    return invocation;
  } catch {
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
}

export async function searchAuthorizedMemoryForInvocation(params: {
  invocation: AuthorizedMemoryReadInvocation;
  query: string;
  sources?: readonly MemorySource[];
  limit?: number;
  signal?: AbortSignal;
}): Promise<
  | Readonly<{
      results: readonly (MemorySearchResult & Readonly<{ handleId: string }>)[];
    }>
  | MemoryInvocationUnavailable
> {
  const state = readState(params.invocation);
  const context = state ? readCurrentContext(state) : undefined;
  if (!state || !context || !isCurrentPlan({ context, plan: state.plan, nowMs: Date.now() })) {
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  try {
    const envelope = await state.runtime.searchAuthorized({
      context,
      plan: state.plan,
      query: params.query,
      ...(params.sources ? { sources: params.sources } : {}),
      limit: Math.max(1, Math.min(100, Math.trunc(params.limit ?? 10))),
      ...(params.signal ? { signal: params.signal } : {}),
    });
    const revisionHandles = envelope.value.map((result) => result.resourceHandle.resourceRevision);
    if (
      !mergeAndValidateEnvelope({
        state,
        context,
        expectedRevisionHandles: revisionHandles,
        envelope,
      })
    ) {
      return MEMORY_INVOCATION_UNAVAILABLE;
    }
    const results = envelope.value.map((result) => {
      state.handles.set(result.resourceHandle.handleId, result.resourceHandle);
      const { resourceHandle: _resourceHandle, ...safe } = result;
      return Object.freeze({ ...safe, handleId: result.resourceHandle.handleId });
    });
    return Object.freeze({ results: Object.freeze(results) });
  } catch {
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
}

export async function readAuthorizedMemoryForInvocation(params: {
  invocation: AuthorizedMemoryReadInvocation;
  handleId: string;
  from?: number;
  lines?: number;
}): Promise<MemoryReadResult | MemoryInvocationUnavailable> {
  const state = readState(params.invocation);
  const context = state ? readCurrentContext(state) : undefined;
  const handle = state?.handles.get(params.handleId);
  if (
    !state ||
    !context ||
    !handle ||
    !isCurrentPlan({ context, plan: state.plan, nowMs: Date.now() })
  ) {
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  try {
    const envelope = await state.runtime.readAuthorized({
      context,
      plan: state.plan,
      handle,
      ...(params.from !== undefined ? { from: params.from } : {}),
      ...(params.lines !== undefined ? { lines: params.lines } : {}),
    });
    if (
      !mergeAndValidateEnvelope({
        state,
        context,
        expectedRevisionHandles: [handle.resourceRevision],
        envelope,
      })
    ) {
      return MEMORY_INVOCATION_UNAVAILABLE;
    }
    return Object.freeze({ ...envelope.value });
  } catch {
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
}

/** Snapshot prepared for transcript persistence; it has no content or display path fields. */
export function readAuthorizedMemoryRunExposure(invocation: AuthorizedMemoryReadInvocation):
  | Readonly<{
      sourcePolicySetIds: readonly string[];
      exposedRevisionHandles: readonly string[];
      exposureReceiptIds: readonly string[];
      egressReceiptIds: readonly string[];
    }>
  | undefined {
  const state = readState(invocation);
  if (!state || !readCurrentContext(state)) {
    return undefined;
  }
  return Object.freeze({
    sourcePolicySetIds: Object.freeze([...state.sourcePolicySetIds].toSorted()),
    exposedRevisionHandles: Object.freeze([...state.exposedRevisionHandles].toSorted()),
    exposureReceiptIds: Object.freeze([...state.exposureReceiptIds].toSorted()),
    egressReceiptIds: Object.freeze([...state.egressReceiptIds].toSorted()),
  });
}

/** Returns the immutable facts needed to persist the current run exposure with a transcript row. */
export function readAuthorizedMemoryTranscriptExposure(invocation: AuthorizedMemoryReadInvocation):
  | Readonly<{
      agentId: string;
      sessionId: string;
      sessionKey: string;
      runId: string;
      contextFingerprint: string;
      planId: string;
      memoryPolicyRevision: string;
      sourcePolicySetIds: readonly string[];
      exposedResourceRevisions: readonly string[];
      exposureReceiptIds: readonly string[];
      egressReceiptIds: readonly string[];
      deliveryAudiences: readonly AudienceRef[];
      deliveryRevision: string;
      egressRegistryRevision: string;
      sessionIdentityRevision: string;
      subjectRevision: string;
    }>
  | undefined {
  const state = readState(invocation);
  const context = state ? readCurrentContext(state) : undefined;
  if (!state || !context || !isCurrentPlan({ context, plan: state.plan, nowMs: Date.now() })) {
    return undefined;
  }
  return Object.freeze({
    agentId: context.agentId,
    sessionId: context.sessionId,
    sessionKey: context.sessionKey,
    runId: context.runId,
    contextFingerprint: context.contextFingerprint,
    planId: state.plan.planId,
    memoryPolicyRevision: state.plan.memoryPolicyRevision,
    sourcePolicySetIds: Object.freeze([...state.sourcePolicySetIds].toSorted()),
    exposedResourceRevisions: Object.freeze([...state.exposedRevisionHandles].toSorted()),
    exposureReceiptIds: Object.freeze([...state.exposureReceiptIds].toSorted()),
    egressReceiptIds: Object.freeze([...state.egressReceiptIds].toSorted()),
    deliveryAudiences: Object.freeze([...context.delivery.audiences]),
    deliveryRevision: context.delivery.deliveryRevision,
    egressRegistryRevision: context.delivery.egressRegistryRevision,
    sessionIdentityRevision: context.sessionIdentityRevision,
    subjectRevision: context.subjectRevision,
  });
}
