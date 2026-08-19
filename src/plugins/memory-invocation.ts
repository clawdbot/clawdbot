import { logWarn } from "../logger.js";
import type {
  AuthorizedMemoryVirtualView,
  AuthorizedMemoryMutation,
  AuthorizedMemoryPlan,
  AuthorizedMemoryResultEnvelope,
  AuthorizedResourceHandle,
  AudienceRef,
  MemoryContentAccessContext,
  MemoryAccessContext,
  MemoryWriteResult,
  AuthorizedMemoryRuntime,
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
  admitMemoryAuthorizationRuntime,
  type AdmittedAuthorizedMemoryReadRuntime,
} from "./memory-authorization-runtime.js";
import {
  hydrateMemoryRunExposureFromLedger,
  persistMemoryRunExposureBeforeContent,
} from "./memory-run-exposure-ledger.js";
import {
  captureDurableMemoryAuthorizationFacts,
  prepareMemoryRunExposure,
  publishMemoryRunExposure,
} from "./memory-run-exposure.js";
import { resolveSelectedMemoryCapabilityRegistration } from "./memory-state.js";
import type {
  MemoryPluginCapability,
  MemoryPluginVirtualViewProvider,
} from "./registry-contribution-types.js";
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
const memoryWriteInvocationBrand: unique symbol = Symbol("openclaw.memory-write-invocation");

export type AuthorizedMemoryReadInvocation = Readonly<{
  readonly [memoryReadInvocationBrand]: true;
}>;

/** Opaque host-owned write continuation; a caller cannot supply context or a selected runtime. */
export type AuthorizedMemoryWriteInvocation = Readonly<{
  readonly [memoryWriteInvocationBrand]: true;
}>;

type InvocationState = Readonly<{
  trustedContext: TrustedMemoryAccessContext;
  context: MemoryContentAccessContext<"read">;
  plan: AuthorizedMemoryPlan & Readonly<{ operation: "read" }>;
  authorizationStartedAtMs: number;
  runtime: AdmittedAuthorizedMemoryReadRuntime;
  /** Bound at admission; registry changes cannot replace this run's provider. */
  virtualView?: MemoryPluginVirtualViewProvider;
  /** Canonical broker-issued views for this invocation; caller-shaped lookalikes never authorize reads. */
  virtualViews: Map<string, AuthorizedMemoryVirtualView>;
  handles: Map<string, AuthorizedResourceHandle>;
  sourcePolicySetIds: Set<string>;
  exposedRevisionHandles: Set<string>;
  exposureReceiptIds: Set<string>;
  egressReceiptIds: Set<string>;
  runExposureRevisions: Set<string>;
}>;

const VIRTUAL_ROOT_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;

const invocationStates = new WeakMap<object, InvocationState>();

type WriteInvocationState = Readonly<{
  trustedContext: TrustedMemoryAccessContext;
  context: MemoryAccessContext;
  plan: AuthorizedMemoryPlan;
  runtime: Readonly<AuthorizedMemoryRuntime>;
}>;

const writeInvocationStates = new WeakMap<object, WriteInvocationState>();

type MemoryInvocationDiagnostic =
  | "admission-rejected"
  | "authorization-failed"
  | "invalid-plan"
  | "materialization-rejected"
  | "search-failed";

function logMemoryInvocationDiagnostic(diagnostic: MemoryInvocationDiagnostic): void {
  // Memory content, access facts, capability metadata, plans, and backend errors are all sensitive.
  // Keep the emitted diagnostic low-cardinality and content-free; the unavailable result is intentional.
  logWarn(`memory invocation unavailable: ${diagnostic}`);
}

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
  context: MemoryAccessContext;
  plan: AuthorizedMemoryPlan;
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

function readCurrentWriteContext(state: WriteInvocationState): MemoryAccessContext | undefined {
  const current = materializeTrustedMemoryAccessContext(state.trustedContext);
  if (
    !current ||
    current.operation !== state.context.operation ||
    current.contextFingerprint !== state.context.contextFingerprint ||
    current.runId !== state.context.runId ||
    current.agentId !== state.context.agentId ||
    current.sessionId !== state.context.sessionId ||
    current.sessionIdentityRevision !== state.context.sessionIdentityRevision ||
    current.subjectRevision !== state.context.subjectRevision ||
    current.delivery.deliveryRevision !== state.context.delivery.deliveryRevision ||
    current.delivery.egressRegistryRevision !== state.context.delivery.egressRegistryRevision ||
    !sameAudiences(current.delivery.audiences, state.context.delivery.audiences)
  ) {
    return undefined;
  }
  return current;
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

function validateEnvelope<T>(params: {
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
    envelope.version !== 1 ||
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
  return true;
}

function mergeEnvelope(
  state: InvocationState,
  envelope: AuthorizedMemoryResultEnvelope<unknown>,
): void {
  const { exposureReceipt, egressReceipt } = envelope;
  state.sourcePolicySetIds.add(exposureReceipt.sourcePolicySetId);
  for (const revision of exposureReceipt.exposedRevisionHandles) {
    state.exposedRevisionHandles.add(revision);
  }
  state.exposureReceiptIds.add(exposureReceipt.receiptId);
  state.egressReceiptIds.add(egressReceipt.receiptId);
  state.runExposureRevisions.add(exposureReceipt.runExposureRevision);
}

function readTranscriptExposure(params: {
  state: InvocationState;
  context: MemoryContentAccessContext<"read">;
  pendingEnvelope?: AuthorizedMemoryResultEnvelope<unknown>;
}) {
  const { state, context, pendingEnvelope } = params;
  const sourcePolicySetIds = new Set(state.sourcePolicySetIds);
  const exposedResourceRevisions = new Set(state.exposedRevisionHandles);
  const exposureReceiptIds = new Set(state.exposureReceiptIds);
  const egressReceiptIds = new Set(state.egressReceiptIds);
  if (pendingEnvelope) {
    const { exposureReceipt, egressReceipt } = pendingEnvelope;
    sourcePolicySetIds.add(exposureReceipt.sourcePolicySetId);
    for (const revision of exposureReceipt.exposedRevisionHandles) {
      exposedResourceRevisions.add(revision);
    }
    exposureReceiptIds.add(exposureReceipt.receiptId);
    egressReceiptIds.add(egressReceipt.receiptId);
  }
  return Object.freeze({
    agentId: context.agentId,
    sessionId: context.sessionId,
    sessionKey: context.sessionKey,
    runId: context.runId,
    contextFingerprint: context.contextFingerprint,
    planId: state.plan.planId,
    memoryPolicyRevision: state.plan.memoryPolicyRevision,
    sourcePolicySetIds: Object.freeze([...sourcePolicySetIds].toSorted()),
    exposedResourceRevisions: Object.freeze([...exposedResourceRevisions].toSorted()),
    exposureReceiptIds: Object.freeze([...exposureReceiptIds].toSorted()),
    egressReceiptIds: Object.freeze([...egressReceiptIds].toSorted()),
    deliveryAudiences: Object.freeze([...context.delivery.audiences]),
    deliveryRevision: context.delivery.deliveryRevision,
    egressRegistryRevision: context.delivery.egressRegistryRevision,
    sessionIdentityRevision: context.sessionIdentityRevision,
    subjectRevision: context.subjectRevision,
    ...captureDurableMemoryAuthorizationFacts(context),
  });
}

/**
 * Records the next immutable exposure revision before the selected plugin's content can leave
 * this broker. A recording failure leaves the invocation state unchanged and fails the read closed.
 */
function recordEnvelopeExposure(params: {
  state: InvocationState;
  context: MemoryContentAccessContext<"read">;
  envelope: AuthorizedMemoryResultEnvelope<unknown>;
}): void {
  if (
    !hydrateMemoryRunExposureFromLedger({
      agentId: params.context.agentId,
      sessionId: params.context.sessionId,
      runId: params.context.runId,
    })
  ) {
    throw new Error("memory exposure ledger could not restore its durable tail");
  }
  const snapshot = prepareMemoryRunExposure(
    readTranscriptExposure({
      state: params.state,
      context: params.context,
      pendingEnvelope: params.envelope,
    }),
  );
  if (!persistMemoryRunExposureBeforeContent(snapshot) || !publishMemoryRunExposure(snapshot)) {
    throw new Error("memory exposure ledger did not commit before content release");
  }
  mergeEnvelope(params.state, params.envelope);
}

function readState(invocation: AuthorizedMemoryReadInvocation): InvocationState | undefined {
  return invocationStates.get(invocation);
}

function canonicalizeAuthorizedVirtualView(params: {
  view: AuthorizedMemoryVirtualView;
  context: MemoryContentAccessContext<"read">;
  plan: AuthorizedMemoryPlan & Readonly<{ operation: "read" }>;
}): AuthorizedMemoryVirtualView | undefined {
  const { view, context, plan } = params;
  const mountHandles = new Set(plan.mounts.map((mount) => mount.mountHandle));
  const rootNames = new Map<string, string>();
  const rootHandles = new Set<string>();
  const virtualPaths = new Set<string>();
  const expiresAt = Date.parse(view.expiresAt);
  const valid =
    view.version === 1 &&
    view.planId === plan.planId &&
    view.contextFingerprint === context.contextFingerprint &&
    typeof view.viewId === "string" &&
    view.viewId.trim().length > 0 &&
    typeof view.revision === "string" &&
    view.revision.trim().length > 0 &&
    Number.isFinite(expiresAt) &&
    expiresAt > Date.now() &&
    view.roots.length > 0 &&
    view.roots.every((root) => {
      const normalized = root.virtualRoot.normalize("NFC");
      const rootKey = normalized.toLocaleLowerCase("en-US");
      if (
        root.version !== 1 ||
        root.access !== "read" ||
        !mountHandles.has(root.mountHandle) ||
        !normalized ||
        !VIRTUAL_ROOT_PATTERN.test(normalized) ||
        normalized !== root.virtualRoot ||
        rootNames.has(rootKey) ||
        rootHandles.has(root.mountHandle)
      ) {
        return false;
      }
      rootNames.set(rootKey, root.mountHandle);
      rootHandles.add(root.mountHandle);
      return true;
    }) &&
    view.files.every((file) => {
      const normalized = file.virtualPath.normalize("NFC");
      const parts = normalized.split("/");
      const root = parts[0]!;
      const pathKey = normalized.toLocaleLowerCase("en-US");
      return file.version === 1 &&
        typeof file.mountHandle === "string" &&
        file.mountHandle.trim().length > 0 &&
        normalized === file.virtualPath &&
        parts.length === 2 &&
        Boolean(root) &&
        Boolean(parts[1]) &&
        parts[1] !== "." &&
        parts[1] !== ".." &&
        !parts[1]!.includes("\\") &&
        rootNames.get(root.toLocaleLowerCase("en-US")) === file.mountHandle &&
        !virtualPaths.has(pathKey)
        ? (virtualPaths.add(pathKey), true)
        : false;
    });
  if (!valid) {
    return undefined;
  }
  // Keep the exact opaque revision and manifest that the admitted provider issued.
  // Shallow-freezing provider data would let a later caller retarget a broker read.
  return Object.freeze({
    version: 1 as const,
    viewId: view.viewId,
    planId: view.planId,
    contextFingerprint: view.contextFingerprint,
    revision: view.revision,
    roots: Object.freeze(view.roots.map((root) => Object.freeze({ ...root }))),
    files: Object.freeze(view.files.map((file) => Object.freeze({ ...file }))),
    expiresAt: view.expiresAt,
  });
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
    logMemoryInvocationDiagnostic("materialization-rejected");
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  const context = materialized as MemoryContentAccessContext<"read">;
  const capability =
    params.capability ??
    resolveSelectedMemoryCapabilityRegistration(requireActivePluginRegistry())?.capability;
  const admission = await admitMemoryAuthorizationReadRuntime(capability);
  if (!admission.ok) {
    logMemoryInvocationDiagnostic("admission-rejected");
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  try {
    const authorizationStartedAtMs = Date.now();
    const plan = (await admission.runtime.authorize(context)) as AuthorizedMemoryPlan &
      Readonly<{ operation: "read" }>;
    if (!isCurrentPlan({ context, plan, nowMs: Date.now() })) {
      logMemoryInvocationDiagnostic("invalid-plan");
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
        ...(admission.runtime.virtualView ? { virtualView: admission.runtime.virtualView } : {}),
        virtualViews: new Map(),
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
    logMemoryInvocationDiagnostic("authorization-failed");
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
}

/**
 * Creates a process-local write invocation from host-minted facts. This is separate from read
 * exposure because a write is a resource lifecycle decision, never a continuation of a search hit.
 */
export async function createAuthorizedMemoryWriteInvocation(params: {
  context: TrustedMemoryAccessContext;
  capability?: MemoryPluginCapability;
}): Promise<AuthorizedMemoryWriteInvocation | MemoryInvocationUnavailable> {
  const context = materializeTrustedMemoryAccessContext(params.context);
  if (!context || context.operation === "read") {
    logMemoryInvocationDiagnostic("materialization-rejected");
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  const capability =
    params.capability ??
    resolveSelectedMemoryCapabilityRegistration(requireActivePluginRegistry())?.capability;
  const admission = await admitMemoryAuthorizationRuntime(capability);
  if (!admission.ok) {
    logMemoryInvocationDiagnostic("admission-rejected");
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  try {
    const plan = await admission.runtime.authorize(context);
    if (!isCurrentPlan({ context, plan, nowMs: Date.now() })) {
      logMemoryInvocationDiagnostic("invalid-plan");
      return MEMORY_INVOCATION_UNAVAILABLE;
    }
    const invocation = Object.freeze({}) as AuthorizedMemoryWriteInvocation;
    writeInvocationStates.set(
      invocation,
      Object.freeze({
        trustedContext: params.context,
        context,
        plan,
        runtime: admission.runtime,
      }),
    );
    return invocation;
  } catch {
    logMemoryInvocationDiagnostic("authorization-failed");
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
}

/**
 * The host supplies the opaque invocation and mutation identity. Runtime arguments remain limited
 * to a closed mutation DTO, so content cannot retarget a store, owner, root, or broader audience.
 */
export async function writeAuthorizedMemoryForInvocation(params: {
  invocation: AuthorizedMemoryWriteInvocation;
  mutation: AuthorizedMemoryMutation;
}): Promise<MemoryWriteResult | MemoryInvocationUnavailable> {
  const state = writeInvocationStates.get(params.invocation);
  const context = state ? readCurrentWriteContext(state) : undefined;
  if (!state || !context || !isCurrentPlan({ context, plan: state.plan, nowMs: Date.now() })) {
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  try {
    return await state.runtime.writeAuthorized({
      context,
      plan: state.plan,
      mutation: params.mutation,
    } as never);
  } catch {
    logMemoryInvocationDiagnostic("authorization-failed");
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
}

/**
 * Obtains a selected-plugin projection for generic FS and sandbox consumers.
 * It is deliberately separate from search/read: no tool argument can turn a
 * host path, artifact locator, or mount handle into a projection request.
 */
export async function materializeAuthorizedMemoryVirtualView(params: {
  invocation: AuthorizedMemoryReadInvocation;
}): Promise<AuthorizedMemoryVirtualView | MemoryInvocationUnavailable> {
  const state = readState(params.invocation);
  const context = state ? readCurrentContext(state) : undefined;
  if (!state || !context || !state.virtualView) {
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  try {
    const view = await state.virtualView.materializeAuthorizedVirtualView({
      context,
      plan: state.plan,
    });
    const canonical = view
      ? canonicalizeAuthorizedVirtualView({ view, context, plan: state.plan })
      : undefined;
    if (!canonical) {
      return MEMORY_INVOCATION_UNAVAILABLE;
    }
    state.virtualViews.set(canonical.viewId, canonical);
    return canonical;
  } catch {
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
}

/**
 * Reads one broker-addressed file from an opaque virtual view. The selected
 * plugin never gives core a storage path, and the durable exposure receipt is
 * committed before its content becomes visible to a generic file tool.
 */
export async function readAuthorizedMemoryVirtualFile(params: {
  invocation: AuthorizedMemoryReadInvocation;
  view: AuthorizedMemoryVirtualView;
  virtualPath: string;
}): Promise<MemoryReadResult | MemoryInvocationUnavailable> {
  const state = readState(params.invocation);
  const context = state ? readCurrentContext(state) : undefined;
  if (
    !state ||
    !context ||
    !state.virtualView ||
    !isCurrentPlan({ context, plan: state.plan, nowMs: Date.now() }) ||
    state.virtualViews.get(params.view.viewId) !== params.view ||
    !params.view.files.some((file) => file.virtualPath === params.virtualPath)
  ) {
    return MEMORY_INVOCATION_UNAVAILABLE;
  }
  try {
    const envelope = await state.virtualView.readAuthorizedVirtualFile({
      context,
      plan: state.plan,
      view: params.view,
      virtualPath: params.virtualPath,
    });
    if (
      !validateEnvelope({
        state,
        context,
        expectedRevisionHandles: envelope.exposureReceipt.exposedRevisionHandles,
        envelope,
      })
    ) {
      return MEMORY_INVOCATION_UNAVAILABLE;
    }
    recordEnvelopeExposure({ state, context, envelope });
    return Object.freeze({ ...envelope.value });
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
      !validateEnvelope({
        state,
        context,
        expectedRevisionHandles: revisionHandles,
        envelope,
      })
    ) {
      return MEMORY_INVOCATION_UNAVAILABLE;
    }
    recordEnvelopeExposure({ state, context, envelope });
    const results = envelope.value.map((result) => {
      state.handles.set(result.resourceHandle.handleId, result.resourceHandle);
      const { resourceHandle: _resourceHandle, ...safe } = result;
      return Object.freeze({ ...safe, handleId: result.resourceHandle.handleId });
    });
    return Object.freeze({ results: Object.freeze(results) });
  } catch {
    logMemoryInvocationDiagnostic("search-failed");
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
      !validateEnvelope({
        state,
        context,
        expectedRevisionHandles: [handle.resourceRevision],
        envelope,
      })
    ) {
      return MEMORY_INVOCATION_UNAVAILABLE;
    }
    recordEnvelopeExposure({ state, context, envelope });
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
  return readTranscriptExposure({ state, context });
}
