import { createHash } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import {
  type WorkerAdmissionHandshake,
  type WorkerConnectParams,
  type WorkerLiveEventParams,
  type WorkerProtocolCloseReason,
  type WorkerTranscriptCommitErrorReason,
  type WorkerTranscriptCommitParams,
  type WorkerTranscriptCommitResult,
  WORKER_RPC_SET_VERSION,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerInferenceCancelParams,
  WorkerInferenceCancelResult,
  WorkerInferenceErrorReason,
  WorkerInferenceStartParams,
  WorkerInferenceStartResult,
} from "../../../packages/gateway-protocol/src/schema/worker-inference.js";
import { onSessionIdentityMutation } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.js";
import type { SecretRef } from "../../config/types.secrets.js";
import { validateCloudWorkerProfileSettings } from "../../config/zod-schema.cloud-workers.js";
import { withTimeout } from "../../infra/fs-safe.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { normalizeCapabilityProviderId } from "../../plugins/provider-registry-shared.js";
import {
  WorkerProviderError,
  type WorkerLease,
  type WorkerProfile,
  type WorkerProvider,
  type WorkerSshEndpoint,
  type WorkerSshIdentity,
} from "../../plugins/types.js";
import { safeEqualSecret } from "../../security/secret-equal.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import {
  admitWorkerConnection,
  validateWorkerConnectionIdentity,
  verifyWorkerAdmissionHandshake,
  type ExpectedWorkerBuild,
  type WorkerConnectionIdentity,
} from "./admission.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import {
  createWorkerCredentialMaterial,
  WORKER_CREDENTIAL_TTL_MS,
  type MintedWorkerCredential,
  type WorkerCredentialBinding,
  type WorkerCredentialDeliveryClaim,
} from "./credential.js";
import type { WorkerInferenceStore } from "./inference-store.js";
import {
  createWorkerInferenceManager,
  type WorkerInferenceExecutor,
  type WorkerInferenceSink,
} from "./inference.js";
import type { WorkerLiveEventApplicationResult, WorkerLiveEventReceiver } from "./live-events.js";
import {
  boundedWorkerError as boundedError,
  inspectionStatus,
  requireWorkerLease,
} from "./service-validation.js";
import type { WorkerEnvironmentState } from "./state.js";
import {
  type WorkerEnvironmentRecord,
  type WorkerEnvironmentStore,
  type WorkerEnvironmentTransitionPatch as TransitionPatch,
  WorkerSessionAlreadyAttachedError,
} from "./store.js";
import type { WorkerTunnelRequest } from "./tunnel-contract.js";
import type { WorkerTunnelHandle, WorkerTunnelManager } from "./tunnel.js";

type WorkerEnvironmentServiceErrorCode =
  | "profile_not_found"
  | "provider_not_found"
  | "environment_not_found"
  | "invalid_profile"
  | "invalid_state"
  | "provider_failure"
  | "bootstrap_failure";

class WorkerEnvironmentServiceError extends Error {
  constructor(
    readonly code: WorkerEnvironmentServiceErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const serviceError = (code: WorkerEnvironmentServiceErrorCode, message: string) =>
  new WorkerEnvironmentServiceError(code, message);
const ORPHANED_LEASE_ERROR = "Worker provider no longer recognizes the lease";
const STALE_ATTACHED_BUNDLE_ERROR = "Attached worker build no longer matches the Gateway";

function workerEnvironmentIdempotencyDigest(idempotencyKey: string): string {
  return createHash("sha256").update(idempotencyKey).digest("hex");
}

export function workerEnvironmentIdForIdempotencyKey(idempotencyKey: string): string {
  const digest = workerEnvironmentIdempotencyDigest(idempotencyKey);
  return `worker:${digest.slice(0, 32)}`;
}

type WorkerEnvironmentServiceOptions = {
  store: WorkerEnvironmentStore;
  getConfig: () => OpenClawConfig;
  resolveProvider: (providerId: string) => WorkerProvider | undefined;
  prepareInstallation: (
    install: WorkerInstallationArtifact["install"],
  ) => Promise<WorkerInstallationArtifact>;
  bootstrapWorker: (params: {
    sshEndpoint: WorkerSshEndpoint;
    installation: WorkerInstallationArtifact;
    resolveIdentity: (keyRef: SecretRef) => Promise<WorkerSshIdentity>;
    signal: AbortSignal;
  }) => Promise<WorkerAdmissionHandshake>;
  resolveSshIdentity?: (params: {
    provider: WorkerProvider;
    leaseId: string;
    profile: WorkerProfile;
    keyRef: SecretRef;
  }) => Promise<WorkerSshIdentity>;
  tunnelManager?: WorkerTunnelManager;
  reconcileIntervalMs?: number;
  providerCallTimeoutMs?: number;
  bootstrapCallTimeoutMs?: number;
  workerCredentialTtlMs?: number;
  generateWorkerCredential?: (bytes: number) => string;
  resolveWorkerGateway?: () => { host: "127.0.0.1" | "::1"; port: number } | undefined;
  now?: () => number;
  logger?: { warn: (message: string) => void };
  applyTranscriptCommit?: (params: {
    identity: WorkerConnectionIdentity;
    request: WorkerTranscriptCommitParams;
  }) => Promise<WorkerTranscriptCommitApplicationResult>;
  liveEvents?: Pick<
    WorkerLiveEventReceiver,
    "apply" | "bindSession" | "clear" | "clearEnvironment" | "rotateCredential" | "start"
  >;
  executeInference: WorkerInferenceExecutor;
  inferenceStore?: WorkerInferenceStore;
  placementStore?: WorkerSessionPlacementGate;
};

export type WorkerPlacementTurnBinding = Readonly<{
  sessionId: string;
  environmentId: string;
  ownerEpoch: number;
  runId: string;
}>;

type WorkerProcessTurnBinding = WorkerPlacementTurnBinding & {
  credentialHash: string;
};

type WorkerTerminalTurnFence = WorkerProcessTurnBinding & {
  transcriptSeq: number;
  liveSeq: number;
};

type WorkerPendingTerminalTurnFence = WorkerProcessTurnBinding & {
  terminalLiveSeq: number;
};

type WorkerTurnRequest =
  | { kind: "inference" }
  | { kind: "live"; seq: number }
  | { kind: "transcript"; seq: number };

export type WorkerSessionPlacementGate = {
  validateWorkerTurn(binding: WorkerPlacementTurnBinding): boolean;
  updateAckCursors(
    binding: WorkerPlacementTurnBinding & {
      transcriptSeq?: number;
      liveSeq?: number;
      workspaceResultPending?: boolean;
    },
  ): void;
};

type WorkerTranscriptCommitApplicationResult =
  | { ok: true; result: WorkerTranscriptCommitResult }
  | { ok: false; reason: WorkerTranscriptCommitErrorReason };

type WorkerTranscriptCommitServiceResult =
  | WorkerTranscriptCommitApplicationResult
  | { ok: false; closeReason: WorkerProtocolCloseReason };

type WorkerLiveEventServiceResult =
  | WorkerLiveEventApplicationResult
  | { ok: false; closeReason: WorkerProtocolCloseReason };

type WorkerInferenceStartServiceResult =
  | {
      ok: true;
      result: WorkerInferenceStartResult;
      launch: () => void;
    }
  | { ok: false; reason: WorkerInferenceErrorReason }
  | { ok: false; closeReason: WorkerProtocolCloseReason };

type WorkerInferenceCancelServiceResult =
  | { ok: true; result: WorkerInferenceCancelResult }
  | { ok: false; reason: WorkerInferenceErrorReason }
  | { ok: false; closeReason: WorkerProtocolCloseReason };

function requireWorkerProfile(value: unknown): WorkerProfile {
  const error = validateCloudWorkerProfileSettings(value);
  if (error) {
    throw serviceError("invalid_profile", error);
  }
  return value as WorkerProfile;
}

export function createWorkerEnvironmentService(options: WorkerEnvironmentServiceOptions) {
  const { store } = options;
  const tunnels = options.tunnelManager;
  const warn = (message: string) => options.logger?.warn(message);
  const operations = new KeyedAsyncQueue();
  const activeOperations = new Set<Promise<unknown>>();
  const pendingCredentials = new Map<string, MintedWorkerCredential>();
  const observedAckCursors = new Map<string, WorkerTerminalTurnFence>();
  const pendingTerminalTurnFences = new Map<string, WorkerPendingTerminalTurnFence>();
  const terminalTurnFences = new Map<string, WorkerTerminalTurnFence>();
  const now = options.now ?? Date.now;
  const inference = createWorkerInferenceManager({
    execute: options.executeInference,
    getConfig: options.getConfig,
    now,
    ...(options.inferenceStore ? { store: options.inferenceStore } : {}),
  });
  let reconcileInFlight: Promise<void> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let unsubscribeSessionIdentityMutation: (() => void) | undefined;
  let stopping = false;

  const placementBinding = (
    identity: WorkerConnectionIdentity,
  ): WorkerPlacementTurnBinding | undefined => {
    if (!identity.sessionId || !identity.runId) {
      return undefined;
    }
    return {
      sessionId: identity.sessionId,
      environmentId: identity.environmentId,
      ownerEpoch: identity.ownerEpoch,
      runId: identity.runId,
    };
  };

  const processTurnBinding = (
    identity: WorkerConnectionIdentity,
  ): WorkerProcessTurnBinding | undefined => {
    const placement = placementBinding(identity);
    return placement ? { ...placement, credentialHash: identity.credentialHash } : undefined;
  };

  const matchesTurnBinding = (
    left: WorkerProcessTurnBinding,
    right: WorkerProcessTurnBinding,
  ): boolean =>
    left.sessionId === right.sessionId &&
    left.environmentId === right.environmentId &&
    left.ownerEpoch === right.ownerEpoch &&
    left.runId === right.runId &&
    safeEqualSecret(left.credentialHash, right.credentialHash);

  const recordAckCursor = (
    binding: WorkerProcessTurnBinding,
    cursor: { transcriptSeq: number } | { liveSeq: number },
  ): WorkerTerminalTurnFence => {
    const current = observedAckCursors.get(binding.sessionId);
    const currentTurn = current && matchesTurnBinding(current, binding) ? current : undefined;
    const next: WorkerTerminalTurnFence = {
      ...binding,
      transcriptSeq:
        "transcriptSeq" in cursor
          ? Math.max(currentTurn?.transcriptSeq ?? 0, cursor.transcriptSeq)
          : (currentTurn?.transcriptSeq ?? 0),
      liveSeq:
        "liveSeq" in cursor
          ? Math.max(currentTurn?.liveSeq ?? 0, cursor.liveSeq)
          : (currentTurn?.liveSeq ?? 0),
    };
    observedAckCursors.set(binding.sessionId, next);
    return next;
  };

  const observedAckCursorFor = (
    binding: WorkerProcessTurnBinding,
  ): WorkerTerminalTurnFence | undefined => {
    const observed = observedAckCursors.get(binding.sessionId);
    return observed && matchesTurnBinding(observed, binding) ? observed : undefined;
  };

  const validateWorkerPlacement = (
    identity: WorkerConnectionIdentity,
  ): { durableClaim: boolean; valid: boolean } => {
    if (!options.placementStore) {
      return { durableClaim: false, valid: true };
    }
    if (identity.sessionId === null && identity.runId === null) {
      return { durableClaim: false, valid: true };
    }
    const binding = placementBinding(identity);
    const valid = binding ? options.placementStore.validateWorkerTurn(binding) : false;
    return { durableClaim: valid, valid };
  };

  const isTerminalLiveEvent = (request: WorkerLiveEventParams): boolean =>
    request.event.kind === "lifecycle" &&
    (request.event.payload.phase === "end" ||
      (request.event.payload.phase === "error" &&
        (request.event.payload.aborted === true ||
          request.event.payload.fallbackExhaustedFailure === true)));

  const project = (record: WorkerEnvironmentRecord) => ({
    ...record,
    tunnelStatus: tunnels?.status(record.environmentId) ?? ("stopped" as const),
  });

  const move = (
    r: WorkerEnvironmentRecord,
    to: WorkerEnvironmentState,
    patch?: TransitionPatch,
  ) => {
    const next = store.transition({ environmentId: r.environmentId, from: r.state, to, patch });
    if (to !== "ready" && to !== "idle" && to !== "attached") {
      pendingCredentials.delete(r.environmentId);
    }
    if (to !== "attached") {
      inference.cancelEnvironment(r.environmentId);
      options.liveEvents?.clearEnvironment(r.environmentId);
    }
    return next;
  };

  const saveError = (r: WorkerEnvironmentRecord, error: unknown) => {
    // Once bootstrap failure owns the terminal outcome, preserve that causal error across
    // transient provider/inspection failures so the final failed row stays actionable.
    if (r.teardownTerminalState === "failed" && r.lastError) {
      return r;
    }
    return store.recordError({
      environmentId: r.environmentId,
      state: r.state,
      error: boundedError(error),
    });
  };

  const inState = (r: WorkerEnvironmentRecord, ...states: WorkerEnvironmentState[]) =>
    states.includes(r.state);
  const withLock = <T>(environmentId: string, task: () => Promise<T>) => {
    const operation = operations.enqueue(environmentId, task);
    activeOperations.add(operation);
    const release = () => activeOperations.delete(operation);
    void operation.then(release, release);
    return operation;
  };

  const callProvider = <T>(run: () => Promise<T>) =>
    withTimeout(
      Promise.resolve().then(run),
      options.providerCallTimeoutMs ?? 300_000,
      "Worker provider operation",
    );

  const callBootstrap = async <T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    const operation = Promise.resolve().then(() => run(controller.signal));
    try {
      return await withTimeout(
        operation,
        options.bootstrapCallTimeoutMs ?? 35 * 60_000,
        "Worker bootstrap operation",
      );
    } catch (error) {
      // The production runner force-kills SSH on abort and settles after child close. Await that
      // contract: provider teardown must never race a child still mutating the lease.
      controller.abort();
      await operation.catch(() => undefined);
      throw error;
    }
  };

  // Durable profile settings keep lifecycle routing stable across config edits and restarts.
  const lifecycleLease = (record: WorkerEnvironmentRecord, leaseId: string) => ({
    leaseId,
    profile: requireWorkerProfile(record.profileSnapshot.settings),
  });

  const identityResolverFor = (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    leaseId: string,
  ) => {
    const profile = requireWorkerProfile(record.profileSnapshot.settings);
    const resolveSshIdentity = options.resolveSshIdentity;
    return async (keyRef: SecretRef) => {
      if (!resolveSshIdentity) {
        throw new Error("Worker SSH identity resolution is unavailable");
      }
      return await callProvider(() => resolveSshIdentity({ provider, leaseId, profile, keyRef }));
    };
  };

  const providerFor = (providerId: string): WorkerProvider => {
    const provider = options.resolveProvider(providerId);
    if (provider) {
      return provider;
    }
    throw serviceError("provider_not_found", `Worker provider is unavailable: ${providerId}`);
  };

  const installFor = (record: WorkerEnvironmentRecord): WorkerInstallationArtifact["install"] => {
    const install = record.profileSnapshot.install;
    if (install === undefined || install === "bundle") {
      return "bundle";
    }
    if (install === "npm") {
      return "npm";
    }
    throw serviceError("invalid_profile", "Worker profile has an invalid install method");
  };

  const prepareInstallation = (record: WorkerEnvironmentRecord) =>
    options.prepareInstallation(installFor(record));

  const credentialExpiry = () => {
    const ttlMs = options.workerCredentialTtlMs ?? WORKER_CREDENTIAL_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw serviceError("invalid_state", "Worker credential lifetime is invalid");
    }
    const expiresAtMs = now() + ttlMs;
    if (!Number.isSafeInteger(expiresAtMs)) {
      throw serviceError("invalid_state", "Worker credential expiry is out of range");
    }
    return expiresAtMs;
  };

  const credentialMaterial = () => createWorkerCredentialMaterial(options.generateWorkerCredential);

  const grantFrom = (params: {
    credential: string;
    record: ReturnType<WorkerEnvironmentStore["getCredential"]>;
  }): MintedWorkerCredential => {
    const record = params.record;
    if (!record) {
      throw serviceError("invalid_state", "Worker credential persistence failed");
    }
    return {
      credential: params.credential,
      deliveryId: record.credentialHash,
      environmentId: record.environmentId,
      bundleHash: record.bundleHash,
      sessionId: record.sessionId,
      rpcSetVersion: record.rpcSetVersion,
      ownerEpoch: record.ownerEpoch,
      expiresAtMs: record.expiresAtMs,
    };
  };

  const mintCredentialLocked = (
    request: WorkerCredentialBinding,
  ): { credentialHash: string; grant: MintedWorkerCredential } => {
    const previous = store.getCredential(request.environmentId);
    if (previous) {
      inference.cancelEnvironment(request.environmentId);
    }
    const material = credentialMaterial();
    const credential = {
      environmentId: request.environmentId,
      expectedOwnerEpoch: request.ownerEpoch,
      credentialHash: material.credentialHash,
      sessionId: request.sessionId,
      rpcSetVersion: WORKER_RPC_SET_VERSION,
      expiresAtMs: credentialExpiry(),
    };
    const record = store.renewCredential(credential);
    return {
      credentialHash: material.credentialHash,
      grant: grantFrom({ credential: material.credential, record }),
    };
  };

  const stageCredential = (grant: MintedWorkerCredential): MintedWorkerCredential => {
    pendingCredentials.set(grant.environmentId, grant);
    return grant;
  };

  const finishProvenDestroy = (record: WorkerEnvironmentRecord) => {
    const destroying = beginDestroy(record);
    if (destroying.teardownTerminalState !== "failed") {
      return move(destroying, "destroyed");
    }
    return move(destroying, "failed", {
      leaseId: null,
      sshEndpoint: null,
      lastError: destroying.lastError ?? "Worker bootstrap failed after provider teardown",
    });
  };

  const failBootstrap = async (
    record: WorkerEnvironmentRecord,
    leaseId: string,
    provider: WorkerProvider,
    error: unknown,
  ): Promise<never> => {
    const detail = boundedError(error);
    const requested = store.requestDestroy({
      environmentId: record.environmentId,
      state: record.state,
      terminalState: "failed",
      lastError: detail,
    });
    const draining = move(requested, "draining", { lastError: detail });
    await tunnels?.stop(record.environmentId);
    const destroying = move(draining, "destroying", { lastError: detail });
    try {
      await callProvider(() => provider.destroy(lifecycleLease(record, leaseId)));
    } catch (cleanupError) {
      // An indeterminate destroy must remain retryable; never hide a possibly-live paid lease
      // behind terminal failed state.
      saveError(
        destroying,
        new Error(`${detail}; provider teardown pending: ${boundedError(cleanupError)}`),
      );
      throw serviceError("bootstrap_failure", "Worker bootstrap failed; teardown is pending");
    }
    finishProvenDestroy(destroying);
    throw serviceError("bootstrap_failure", "Worker bootstrap failed");
  };

  const finishBootstrap = async (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    installation: WorkerInstallationArtifact,
  ) => {
    if (record.state !== "bootstrapping" || !record.leaseId || !record.sshEndpoint) {
      throw serviceError("invalid_state", "Worker bootstrap requires a provisioned SSH lease");
    }
    let receipt: WorkerAdmissionHandshake;
    try {
      receipt = await callBootstrap((signal) =>
        options.bootstrapWorker({
          sshEndpoint: record.sshEndpoint,
          installation,
          resolveIdentity: identityResolverFor(record, provider, record.leaseId),
          signal,
        }),
      );
      if (!verifyWorkerAdmissionHandshake(receipt, installation)) {
        throw new Error("Worker bootstrap receipt does not match the expected build identity");
      }
    } catch (error) {
      return await failBootstrap(record, record.leaseId, provider, error);
    }
    const material = credentialMaterial();
    // Receipt, owner epoch, and credential hash commit together. A failed write leaves the
    // durable lease bootstrapping so reconcile can retry without admitting a partial identity.
    const ready = move(record, "ready", {
      bootstrapReceipt: receipt,
      credential: {
        credentialHash: material.credentialHash,
        sessionId: null,
        rpcSetVersion: WORKER_RPC_SET_VERSION,
        expiresAtMs: credentialExpiry(),
      },
    });
    const grant = grantFrom({
      credential: material.credential,
      record: store.getCredential(record.environmentId),
    });
    stageCredential(grant);
    return ready;
  };

  const finishProvision = async (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    preparedInstallation?: WorkerInstallationArtifact,
  ) => {
    let lease: WorkerLease;
    try {
      const profile = requireWorkerProfile(record.profileSnapshot.settings);
      lease = requireWorkerLease(
        await callProvider(() => provider.provision(profile, record.provisionOperationId)),
      );
    } catch (error) {
      if (
        error instanceof WorkerProviderError ||
        (error instanceof WorkerEnvironmentServiceError && error.code === "invalid_profile")
      ) {
        move(record, "failed", { lastError: boundedError(error) });
        throw serviceError("invalid_profile", "Worker provider rejected profile");
      }
      saveError(record, error);
      throw serviceError("provider_failure", "Worker provider operation failed");
    }
    // A timeout can happen after allocation; retain the same operation id for safe replay.
    const patch = { leaseId: lease.leaseId, sshEndpoint: lease.ssh };
    const bootstrapping = move(record, "bootstrapping", patch);
    if (record.destroyRequestedAtMs !== null) {
      return bootstrapping;
    }
    let installation = preparedInstallation;
    if (!installation) {
      try {
        // A persisted provisioning row can represent an allocation whose response was lost.
        // Replay the idempotent provider operation before packaging can terminalize that lease.
        installation = await prepareInstallation(bootstrapping);
      } catch (error) {
        return await failBootstrap(bootstrapping, lease.leaseId, provider, error);
      }
    }
    return finishBootstrap(bootstrapping, provider, installation);
  };

  const resumeProvision = async (
    record: WorkerEnvironmentRecord,
    provider = providerFor(record.providerId),
  ) => {
    let installation: WorkerInstallationArtifact | undefined;
    if (record.state === "requested" && record.destroyRequestedAtMs === null) {
      try {
        // Fresh requests package before allocation. Once provisioning is durable, provider replay
        // must happen first because the previous response may have been lost after allocation.
        installation = await prepareInstallation(record);
      } catch (error) {
        move(record, "failed", { lastError: boundedError(error) });
        throw serviceError("bootstrap_failure", "Worker installation preparation failed");
      }
    }
    const provisioning = record.state === "requested" ? move(record, "provisioning") : record;
    return finishProvision(provisioning, provider, installation);
  };

  const cancelRequested = (record: WorkerEnvironmentRecord) =>
    move(record, "failed", { lastError: "Provisioning canceled before provider allocation" });

  const beginDrain = (record: WorkerEnvironmentRecord) => {
    const failurePatch =
      record.teardownTerminalState === "failed" ? { lastError: record.lastError } : undefined;
    return inState(record, "bootstrapping", "ready", "attached", "idle")
      ? move(record, "draining", failurePatch)
      : record;
  };

  const beginDestroy = (record: WorkerEnvironmentRecord) => {
    const failurePatch =
      record.teardownTerminalState === "failed" ? { lastError: record.lastError } : undefined;
    const draining = beginDrain(record);
    if (draining.state === "draining") {
      return move(draining, "destroying", failurePatch);
    }
    if (draining.state === "destroying") {
      return draining;
    }
    throw serviceError("invalid_state", `Cannot destroy worker in state: ${record.state}`);
  };

  const finishDestroy = async (r: WorkerEnvironmentRecord, provider?: WorkerProvider) => {
    if (!r.leaseId) {
      throw serviceError("invalid_state", "Worker environment has no lease");
    }
    const leaseId = r.leaseId;
    const draining = beginDrain(r);
    await tunnels?.stop(r.environmentId);
    const owningProvider = provider ?? providerFor(r.providerId);
    const destroying = beginDestroy(draining);
    try {
      await callProvider(() => owningProvider.destroy(lifecycleLease(r, leaseId)));
    } catch (error) {
      saveError(destroying, error);
      throw serviceError("provider_failure", "Worker provider operation failed");
    }
    return finishProvenDestroy(destroying);
  };

  const ensurePendingCredential = (record: WorkerEnvironmentRecord, sessionId: string | null) => {
    const credential = store.getCredential(record.environmentId);
    const pending = pendingCredentials.get(record.environmentId);
    const credentialIsCurrent =
      credential?.ownerEpoch === record.ownerEpoch &&
      credential.sessionId === sessionId &&
      credential.expiresAtMs > now();
    const pendingIsCurrent =
      credentialIsCurrent &&
      pending?.deliveryId === credential.credentialHash &&
      pending.ownerEpoch === record.ownerEpoch &&
      pending.sessionId === sessionId;
    if (credentialIsCurrent && credential.deliveredAtMs !== null) {
      pendingCredentials.delete(record.environmentId);
      return;
    }
    if (pendingIsCurrent) {
      return;
    }
    pendingCredentials.delete(record.environmentId);
    const minted = mintCredentialLocked({
      environmentId: record.environmentId,
      ownerEpoch: record.ownerEpoch,
      sessionId,
    });
    stageCredential(minted.grant);
    if (sessionId && credential?.ownerEpoch === record.ownerEpoch) {
      options.liveEvents?.rotateCredential({
        credentialHash: minted.credentialHash,
        environmentId: record.environmentId,
        previousCredentialHash: credential.credentialHash,
        runEpoch: record.ownerEpoch,
        sessionId,
      });
    }
  };

  const reconcileRecord = async (initialRecord: WorkerEnvironmentRecord): Promise<void> => {
    let record = initialRecord;
    if (record.state === "requested" && record.destroyRequestedAtMs !== null) {
      return void cancelRequested(record);
    }
    let currentBundle: WorkerInstallationArtifact | undefined;
    if (record.destroyRequestedAtMs === null && inState(record, "ready", "idle", "attached")) {
      try {
        currentBundle = await options.prepareInstallation("bundle");
        if (
          record.bootstrapReceipt &&
          verifyWorkerAdmissionHandshake(record.bootstrapReceipt, currentBundle)
        ) {
          const sessionId = record.state === "attached" ? record.attachedSessionIds[0] : null;
          if (record.state !== "attached" || sessionId) {
            ensurePendingCredential(record, sessionId ?? null);
            record = store.get(record.environmentId) ?? record;
          }
        }
      } catch {
        // Provider inspection and the state-specific path below retain their existing retry policy.
      }
    }
    let provider: WorkerProvider;
    try {
      provider = providerFor(record.providerId);
    } catch (error) {
      saveError(record, error);
      return;
    }
    const leaseId = record.leaseId;
    if (!leaseId) {
      const provisioned = await resumeProvision(record, provider).catch(() => undefined);
      if (provisioned?.state === "bootstrapping") {
        await finishDestroy(provisioned, provider).catch(() => undefined);
      }
      return;
    }
    const status = await callProvider(() => provider.inspect(lifecycleLease(record, leaseId)))
      .then(inspectionStatus)
      .catch((error: unknown) => {
        saveError(record, error);
        return undefined;
      });
    if (!status) {
      return;
    }
    const teardownExpected = record.destroyRequestedAtMs !== null || record.state === "destroying";
    if (status === "destroyed" || (status === "unknown" && teardownExpected)) {
      const requested =
        record.destroyRequestedAtMs === null
          ? store.requestDestroy({ environmentId: record.environmentId, state: record.state })
          : record;
      const draining = beginDrain(requested);
      await tunnels?.stop(record.environmentId);
      finishProvenDestroy(draining);
      return;
    }
    if (status === "unknown") {
      const draining =
        record.state === "draining"
          ? record
          : move(record, "draining", { lastError: ORPHANED_LEASE_ERROR });
      await tunnels?.stop(record.environmentId);
      move(draining, "orphaned", { lastError: ORPHANED_LEASE_ERROR });
      return;
    }
    if (record.destroyRequestedAtMs !== null) {
      await finishDestroy(record, provider).catch(() => undefined);
      return;
    }
    if (record.state === "attached") {
      if (
        currentBundle &&
        (!record.bootstrapReceipt ||
          !verifyWorkerAdmissionHandshake(record.bootstrapReceipt, currentBundle))
      ) {
        // A new Gateway build rejects the old worker at admission. Tear it down now so placement
        // reconciliation can fail-stop cleanly instead of reporting active until the next turn.
        await failBootstrap(
          record,
          leaseId,
          provider,
          new Error(STALE_ATTACHED_BUNDLE_ERROR),
        ).catch(() => undefined);
      }
      return;
    }
    if (record.state === "draining" && record.destroyRequestedAtMs === null) {
      // Draining without destroy intent is durable provider-loss cleanup.
      await tunnels?.stop(record.environmentId);
      move(record, "orphaned", { lastError: record.lastError ?? ORPHANED_LEASE_ERROR });
      return;
    }
    if (inState(record, "bootstrapping", "ready", "idle")) {
      let installation = currentBundle;
      try {
        // Bundle identity is local and canonical for both install channels. A matching admitted
        // receipt must not depend on npm registry availability during routine reconciliation.
        installation ??= await options.prepareInstallation("bundle");
      } catch (error) {
        if (record.bootstrapReceipt && inState(record, "ready", "idle")) {
          saveError(record, error);
          return;
        }
        await failBootstrap(record, leaseId, provider, error).catch(() => undefined);
        return;
      }
      if (
        record.bootstrapReceipt &&
        verifyWorkerAdmissionHandshake(record.bootstrapReceipt, installation)
      ) {
        ensurePendingCredential(record, null);
        return;
      }
      if (installFor(record) === "npm") {
        try {
          installation = await options.prepareInstallation("npm");
        } catch (error) {
          await failBootstrap(record, leaseId, provider, error).catch(() => undefined);
          return;
        }
      }
      const bootstrapping =
        record.state === "bootstrapping" ? record : move(record, "bootstrapping");
      await tunnels?.stop(record.environmentId, record.ownerEpoch);
      await finishBootstrap(bootstrapping, provider, installation).catch(() => undefined);
      return;
    }
    if (inState(record, "draining", "destroying")) {
      await finishDestroy(record, provider).catch(() => undefined);
    }
  };

  const create = async (profileId: string, idempotencyKey: string) => {
    if (stopping) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    const normalizedProfileId = profileId.trim();
    if (!normalizedProfileId || normalizedProfileId !== profileId) {
      throw serviceError("invalid_profile", "Worker profile id must be non-empty and trimmed");
    }
    const digest = workerEnvironmentIdempotencyDigest(idempotencyKey);
    const environmentId = `worker:${digest.slice(0, 32)}`;
    return withLock(environmentId, async () => {
      if (stopping) {
        throw serviceError("invalid_state", "Worker environment service is stopping");
      }
      const existing = store.get(environmentId);
      if (existing) {
        if (existing.profileId !== normalizedProfileId) {
          throw serviceError("invalid_profile", "Idempotency key belongs to another profile");
        }
        if (existing.destroyRequestedAtMs !== null) {
          return existing;
        }
        if (!existing.leaseId && inState(existing, "requested", "provisioning")) {
          return resumeProvision(existing);
        }
        return existing;
      }
      const profiles = options.getConfig().cloudWorkers?.profiles;
      if (!profiles || !Object.hasOwn(profiles, normalizedProfileId)) {
        throw serviceError("profile_not_found", `Unknown worker profile: ${normalizedProfileId}`);
      }
      const profile = expectDefined(
        profiles[normalizedProfileId],
        "profiles entry at normalized profile id",
      );
      const provider = providerFor(profile.provider);
      const settings = requireWorkerProfile(profile.settings ?? {});
      const intent = store.createIntent({
        environmentId,
        providerId: normalizeCapabilityProviderId(provider.id) ?? provider.id,
        profileId: normalizedProfileId,
        profileSnapshot: requireWorkerProfile({
          install: profile.install ?? "bundle",
          settings,
          ...(profile.lifetime ? { lifetime: profile.lifetime } : {}),
        }),
        provisionOperationId: `provision:${digest}`,
      });
      return resumeProvision(intent, provider);
    });
  };

  const destroy = async (
    environmentId: string,
    destroyOptions: { requireUnattached?: boolean } = {},
  ) => {
    if (stopping) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    return withLock(environmentId, async () => {
      let record = store.get(environmentId);
      if (!record) {
        throw serviceError("environment_not_found", `Unknown worker environment: ${environmentId}`);
      }
      if (inState(record, "destroyed", "failed", "orphaned")) {
        return record;
      }
      if (destroyOptions.requireUnattached && record.attachedSessionIds.length > 0) {
        throw serviceError(
          "invalid_state",
          "Attached cloud workers must be stopped through sessions.reclaim",
        );
      }
      record = store.requestDestroy({ environmentId, state: record.state });
      if (record.state === "requested") {
        return cancelRequested(record);
      }
      if (record.leaseId) {
        record = beginDrain(record);
      }
      if (!record.leaseId) {
        const provider = providerFor(record.providerId);
        record = await resumeProvision(record, provider);
        return finishDestroy(record, provider);
      }
      return finishDestroy(record);
    });
  };

  const attachSession = async (
    request: WorkerCredentialBinding & { sessionId: string },
  ): Promise<MintedWorkerCredential> => {
    if (stopping) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    return withLock(request.environmentId, async () => {
      if (stopping) {
        throw serviceError("invalid_state", "Worker environment service is stopping");
      }
      const current = store.get(request.environmentId);
      if (!current) {
        throw serviceError(
          "environment_not_found",
          `Unknown worker environment: ${request.environmentId}`,
        );
      }
      if (current.state !== "ready" && current.state !== "idle") {
        throw serviceError("invalid_state", `Cannot attach worker in state: ${current.state}`);
      }
      let currentBuild: WorkerInstallationArtifact;
      try {
        currentBuild = await options.prepareInstallation("bundle");
      } catch {
        throw serviceError("invalid_state", "Current worker build identity is unavailable");
      }
      if (
        !current.bootstrapReceipt ||
        !verifyWorkerAdmissionHandshake(current.bootstrapReceipt, currentBuild)
      ) {
        throw serviceError(
          "invalid_state",
          "Worker must bootstrap the current build before attach",
        );
      }
      const material = credentialMaterial();
      let attached: WorkerEnvironmentRecord;
      try {
        attached = store.transition({
          environmentId: request.environmentId,
          from: current.state,
          to: "attached",
          expectedOwnerEpoch: request.ownerEpoch,
          patch: {
            attachedSessionIds: [request.sessionId],
            credential: {
              credentialHash: material.credentialHash,
              sessionId: request.sessionId,
              rpcSetVersion: WORKER_RPC_SET_VERSION,
              expiresAtMs: credentialExpiry(),
            },
          },
        });
      } catch (error) {
        if (error instanceof WorkerSessionAlreadyAttachedError) {
          throw serviceError("invalid_state", error.message);
        }
        throw error;
      }
      if (options.liveEvents) {
        let liveSessionBound: boolean;
        try {
          liveSessionBound = options.liveEvents.bindSession({
            environmentId: attached.environmentId,
            runEpoch: attached.ownerEpoch,
            sessionId: request.sessionId,
          });
        } catch {
          liveSessionBound = false;
        }
        if (!liveSessionBound) {
          move(attached, "idle");
          // Preserve the bounded attachment error after rollback fences the old worker.
          await tunnels?.stop(request.environmentId, current.ownerEpoch).catch(() => undefined);
          throw serviceError("invalid_state", "Attached session target is unavailable");
        }
      }
      pendingCredentials.delete(request.environmentId);
      await tunnels?.stop(request.environmentId, current.ownerEpoch);
      return stageCredential(
        grantFrom({
          credential: material.credential,
          record: store.getCredential(request.environmentId),
        }),
      );
    });
  };

  const startTunnel = async (request: WorkerTunnelRequest): Promise<WorkerTunnelHandle> => {
    if (stopping) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    if (!tunnels) {
      throw serviceError("invalid_state", "Worker tunnel runtime is unavailable");
    }
    let startup: Promise<WorkerTunnelHandle> | undefined;
    await withLock(request.environmentId, async () => {
      if (stopping) {
        throw serviceError("invalid_state", "Worker environment service is stopping");
      }
      const record = store.get(request.environmentId);
      if (!record) {
        throw serviceError(
          "environment_not_found",
          `Unknown worker environment: ${request.environmentId}`,
        );
      }
      if (
        !inState(record, "ready", "idle", "attached") ||
        record.destroyRequestedAtMs !== null ||
        !record.leaseId ||
        !record.sshEndpoint
      ) {
        throw serviceError("invalid_state", `Cannot start tunnel in state: ${record.state}`);
      }
      const credential = store.getCredential(request.environmentId);
      if (
        !credential ||
        credential.ownerEpoch !== request.ownerEpoch ||
        credential.expiresAtMs <= now()
      ) {
        throw serviceError("invalid_state", "Worker tunnel owner credential is not current");
      }
      const gateway = options.resolveWorkerGateway?.();
      if (!gateway) {
        throw serviceError("invalid_state", "Worker gateway ingress is unavailable");
      }
      const provider = providerFor(record.providerId);
      // Tunnel ownership is registered synchronously by the manager. Release the durable-state
      // lock while SSH connects so drain/destroy can fence an indefinitely reconnecting start.
      startup = tunnels.start({
        ...request,
        gateway,
        ssh: record.sshEndpoint,
        resolveIdentity: identityResolverFor(record, provider, record.leaseId),
      });
    });
    if (!startup) {
      throw serviceError("invalid_state", "Worker tunnel failed to start");
    }
    return await startup;
  };

  const stopTunnel = async (environmentId: string, ownerEpoch?: number): Promise<void> => {
    await withLock(environmentId, async () => {
      await tunnels?.stop(environmentId, ownerEpoch);
    });
  };

  const reconcilePass = async () => {
    const tasks = store.listForReconcile().map(
      (candidate) => () =>
        withLock(candidate.environmentId, async () => {
          const current = store.get(candidate.environmentId);
          if (!current || inState(current, "destroyed", "failed")) {
            return;
          }
          await reconcileRecord(current).catch(() =>
            warn(
              `Worker environment reconcile failed (${current.environmentId}, ${current.providerId})`,
            ),
          );
        }),
    );
    await runTasksWithConcurrency({ tasks, limit: 8 });
  };

  const reconcileOnce = () => {
    if (stopping) {
      return Promise.resolve();
    }
    return (reconcileInFlight ??= reconcilePass().finally(() => {
      reconcileInFlight = undefined;
    }));
  };

  const start = () => {
    if (interval || stopping) {
      return;
    }
    unsubscribeSessionIdentityMutation = onSessionIdentityMutation((mutation) => {
      const currentSessionId = "current" in mutation ? mutation.current.sessionId : undefined;
      if (mutation.previous.sessionId && mutation.previous.sessionId !== currentSessionId) {
        inference.cancelSession(mutation.previous.sessionId);
      }
    });
    options.liveEvents?.start();
    interval = setInterval(
      () => void reconcileOnce().catch(() => warn("Worker environment reconcile sweep failed")),
      options.reconcileIntervalMs ?? 60_000,
    );
    interval.unref?.();
    void reconcileOnce().catch(() => warn("Worker environment startup reconcile failed"));
  };

  const stop = async () => {
    stopping = true;
    clearInterval(interval);
    interval = undefined;
    unsubscribeSessionIdentityMutation?.();
    unsubscribeSessionIdentityMutation = undefined;
    await inference.stop();
    pendingCredentials.clear();
    options.liveEvents?.clear();
    await tunnels?.stopAll();
    const reconciliation = reconcileInFlight;
    if (reconciliation) {
      await Promise.allSettled([reconciliation]);
    }
    while (activeOperations.size > 0) {
      await Promise.allSettled(activeOperations);
    }
    pendingCredentials.clear();
    observedAckCursors.clear();
    pendingTerminalTurnFences.clear();
    terminalTurnFences.clear();
    options.liveEvents?.clear();
  };

  const readPendingCredential = (binding: WorkerCredentialBinding) => {
    if (stopping) {
      return undefined;
    }
    const grant = pendingCredentials.get(binding.environmentId);
    if (
      !grant ||
      grant.ownerEpoch !== binding.ownerEpoch ||
      grant.sessionId !== binding.sessionId
    ) {
      return undefined;
    }
    const environment = store.get(binding.environmentId);
    const credential = store.getCredential(binding.environmentId);
    const credentialHash = grant.deliveryId;
    const checkedAtMs = now();
    if (
      !environment ||
      !inState(environment, "ready", "idle", "attached") ||
      environment.destroyRequestedAtMs !== null ||
      environment.ownerEpoch !== binding.ownerEpoch ||
      !credential ||
      credential.credentialHash !== credentialHash ||
      credential.ownerEpoch !== binding.ownerEpoch ||
      credential.sessionId !== binding.sessionId ||
      credential.deliveredAtMs !== null ||
      credential.expiresAtMs <= checkedAtMs
    ) {
      return undefined;
    }
    return { checkedAtMs, credentialHash, grant };
  };

  const validateAttachedWorkerRequest = (
    identity: WorkerConnectionIdentity,
    runEpoch: number,
    request: WorkerTurnRequest,
  ):
    | { ok: true }
    | { ok: false; closeReason: WorkerProtocolCloseReason }
    | { ok: false; reason: "epoch-mismatch" | "session-not-attached" } => {
    if (stopping) {
      return { ok: false, closeReason: "environment-unavailable" };
    }
    const placement = validateWorkerPlacement(identity);
    if (!placement.valid) {
      return { ok: false, closeReason: "placement-mismatch" };
    }
    const turnBinding = processTurnBinding(identity);
    const terminalFence = identity.sessionId
      ? terminalTurnFences.get(identity.sessionId)
      : undefined;
    if (turnBinding && terminalFence && matchesTurnBinding(terminalFence, turnBinding)) {
      const isReplay =
        (request.kind === "transcript" && request.seq <= terminalFence.transcriptSeq) ||
        (request.kind === "live" && request.seq <= terminalFence.liveSeq);
      if (!isReplay) {
        return { ok: false, closeReason: "placement-mismatch" };
      }
    }
    const credential = store.getCredential(identity.environmentId);
    if (!credential || !safeEqualSecret(credential.credentialHash, identity.credentialHash)) {
      return { ok: false, closeReason: "credential-replaced" };
    }
    // TTL limits admission and reconnect. An already-admitted exact durable
    // turn stays usable until its terminal ACK or placement fence.
    if (now() >= credential.expiresAtMs && !placement.durableClaim) {
      return { ok: false, closeReason: "credential-expired" };
    }
    const environment = store.get(identity.environmentId);
    if (!environment || environment.destroyRequestedAtMs !== null) {
      return { ok: false, closeReason: "environment-unavailable" };
    }
    if (
      runEpoch !== identity.ownerEpoch ||
      runEpoch !== credential.ownerEpoch ||
      runEpoch !== environment.ownerEpoch
    ) {
      return { ok: false, reason: "epoch-mismatch" };
    }
    if (
      environment.state !== "attached" ||
      !identity.sessionId ||
      credential.sessionId !== identity.sessionId ||
      environment.attachedSessionIds.length !== 1 ||
      environment.attachedSessionIds[0] !== identity.sessionId
    ) {
      return { ok: false, reason: "session-not-attached" };
    }
    if (turnBinding && terminalFence && !matchesTurnBinding(terminalFence, turnBinding)) {
      // Credential rotation identifies a new process turn even when a caller
      // intentionally reuses its durable run id (for example, cron sessions).
      terminalTurnFences.delete(turnBinding.sessionId);
    }
    return { ok: true };
  };

  const commitTranscript = (
    identity: WorkerConnectionIdentity,
    request: WorkerTranscriptCommitParams,
  ): Promise<WorkerTranscriptCommitServiceResult> =>
    withLock(identity.environmentId, async () => {
      const binding = validateAttachedWorkerRequest(identity, request.runEpoch, {
        kind: "transcript",
        seq: request.seq,
      });
      if (!binding.ok) {
        return binding;
      }
      if (!options.applyTranscriptCommit) {
        return { ok: false, closeReason: "gateway-unavailable" };
      }
      const result = await options.applyTranscriptCommit({ identity, request });
      // Transcript persistence awaits outside the placement transaction. Revalidate the durable
      // claim before exposing an ACK so reclamation cannot admit both owners for one session.
      const currentBinding = validateAttachedWorkerRequest(identity, request.runEpoch, {
        kind: "transcript",
        seq: request.seq,
      });
      if (!currentBinding.ok) {
        return currentBinding;
      }
      // Stale base is a terminal sequenced outcome. Advance its durable cursor
      // so the next worker commit cannot reuse the consumed sequence number.
      if (result.ok || result.reason === "stale-base-leaf") {
        const placement = placementBinding(identity);
        const processTurn = processTurnBinding(identity);
        if (!placement || !processTurn) {
          return { ok: false, closeReason: "placement-mismatch" };
        }
        options.placementStore?.updateAckCursors({ ...placement, transcriptSeq: request.seq });
        recordAckCursor(processTurn, { transcriptSeq: request.seq });
      }
      return result;
    });

  const applyLiveEvent = (
    identity: WorkerConnectionIdentity,
    request: WorkerLiveEventParams,
  ): WorkerLiveEventServiceResult => {
    const binding = validateAttachedWorkerRequest(identity, request.runEpoch, {
      kind: "live",
      seq: request.seq,
    });
    if (!binding.ok) {
      if ("closeReason" in binding) {
        return binding;
      }
      return { ok: false, details: { reason: binding.reason } };
    }
    if (request.runId !== identity.runId) {
      return { ok: false, closeReason: "placement-mismatch" };
    }
    if (!options.liveEvents) {
      return { ok: false, closeReason: "gateway-unavailable" };
    }
    // The caller holds the environment lock, preserving order with transcript
    // commits and the terminal mutation fence while this synchronous receiver runs.
    const result = options.liveEvents.apply({ identity, request });
    if (result.ok) {
      const placement = placementBinding(identity);
      const processTurn = processTurnBinding(identity);
      if (!placement || !processTurn) {
        return { ok: false, closeReason: "placement-mismatch" };
      }
      options.placementStore?.updateAckCursors({
        ...placement,
        liveSeq: result.result.ackedSeq,
        ...(isTerminalLiveEvent(request) ? { workspaceResultPending: true } : {}),
      });
      recordAckCursor(processTurn, { liveSeq: result.result.ackedSeq });
    }
    return result;
  };

  const pushLiveEvent = async (
    identity: WorkerConnectionIdentity,
    request: WorkerLiveEventParams,
  ): Promise<WorkerLiveEventServiceResult> => {
    return await withLock(identity.environmentId, async () => {
      const placement = placementBinding(identity);
      const processTurn = processTurnBinding(identity);
      const observed = processTurn ? observedAckCursorFor(processTurn) : undefined;
      const wasNewSequence = request.seq > (observed?.liveSeq ?? 0);
      const result = applyLiveEvent(identity, request);
      if (!result.ok || !placement || !processTurn) {
        return result;
      }
      const pending = pendingTerminalTurnFences.get(placement.sessionId);
      if (pending && !matchesTurnBinding(pending, processTurn)) {
        pendingTerminalTurnFences.delete(placement.sessionId);
      }
      if (isTerminalLiveEvent(request) && wasNewSequence) {
        pendingTerminalTurnFences.set(placement.sessionId, {
          ...processTurn,
          terminalLiveSeq: request.seq,
        });
      }
      const terminal = pendingTerminalTurnFences.get(placement.sessionId);
      if (
        terminal &&
        matchesTurnBinding(terminal, processTurn) &&
        result.result.ackedSeq >= terminal.terminalLiveSeq
      ) {
        // A gap fill can ACK a previously buffered terminal event. Fence from
        // the observed high-water marks, not only from the request carrying it.
        terminalTurnFences.set(
          placement.sessionId,
          observedAckCursorFor(processTurn) ??
            recordAckCursor(processTurn, { liveSeq: result.result.ackedSeq }),
        );
        pendingTerminalTurnFences.delete(placement.sessionId);
      }
      return result;
    });
  };

  const revalidateInference = (
    identity: WorkerConnectionIdentity,
    request: WorkerInferenceStartParams | WorkerInferenceCancelParams,
  ): "epoch-mismatch" | "session-not-attached" | null => {
    if (request.sessionId !== identity.sessionId) {
      return "session-not-attached";
    }
    const binding = validateAttachedWorkerRequest(identity, request.runEpoch, {
      kind: "inference",
    });
    return binding.ok ? null : "reason" in binding ? binding.reason : "session-not-attached";
  };

  const startInference = (
    identity: WorkerConnectionIdentity,
    request: WorkerInferenceStartParams,
    sink: WorkerInferenceSink,
  ): WorkerInferenceStartServiceResult => {
    if (request.sessionId !== identity.sessionId || request.runId !== identity.runId) {
      return { ok: false, reason: "session-not-attached" };
    }
    const binding = validateAttachedWorkerRequest(identity, request.runEpoch, {
      kind: "inference",
    });
    if (!binding.ok) {
      return binding;
    }
    return inference.start({
      identity,
      request,
      sink,
      revalidate: () => revalidateInference(identity, request),
    });
  };

  const cancelInference = (
    identity: WorkerConnectionIdentity,
    request: WorkerInferenceCancelParams,
  ): WorkerInferenceCancelServiceResult => {
    if (request.sessionId !== identity.sessionId || request.runId !== identity.runId) {
      return { ok: false, reason: "session-not-attached" };
    }
    const binding = validateAttachedWorkerRequest(identity, request.runEpoch, {
      kind: "inference",
    });
    if (!binding.ok) {
      return binding;
    }
    return inference.cancel({
      identity,
      request,
      revalidate: () => revalidateInference(identity, request),
    });
  };

  return {
    list: () => store.list().map(project),
    get: (environmentId: string) => {
      const record = store.get(environmentId);
      return record ? project(record) : undefined;
    },
    create: async (profileId: string, idempotencyKey: string) =>
      project(await create(profileId, idempotencyKey)),
    destroy: async (environmentId: string) => project(await destroy(environmentId)),
    destroyUnattached: async (environmentId: string) =>
      project(await destroy(environmentId, { requireUnattached: true })),
    admitWorker: async (admission: WorkerConnectParams["admission"]) => {
      if (stopping) {
        return { ok: false, reason: "environment-unavailable" } as const;
      }
      const preflight = admitWorkerConnection({
        store,
        admission,
        expectedBuild: admission.handshake,
        nowMs: now(),
      });
      if (!preflight.ok) {
        return preflight;
      }
      let expectedBuild: ExpectedWorkerBuild;
      try {
        expectedBuild = await options.prepareInstallation("bundle");
      } catch {
        return { ok: false, reason: "environment-unavailable" } as const;
      }
      if (stopping) {
        return { ok: false, reason: "environment-unavailable" } as const;
      }
      const admitted = admitWorkerConnection({ store, admission, expectedBuild, nowMs: now() });
      if (
        !admitted.ok ||
        !options.placementStore ||
        (admitted.identity.sessionId === null && admitted.identity.runId === null)
      ) {
        return admitted;
      }
      const placement = placementBinding(admitted.identity);
      if (!placement || !options.placementStore.validateWorkerTurn(placement)) {
        return { ok: false, reason: "placement-mismatch" } as const;
      }
      return admitted;
    },
    validateWorkerConnection: (identity: WorkerConnectionIdentity) => {
      if (stopping) {
        return "environment-unavailable" as const;
      }
      const placement = validateWorkerPlacement(identity);
      if (!placement.valid) {
        return "placement-mismatch" as const;
      }
      const environmentFailure = validateWorkerConnectionIdentity({
        store,
        identity,
        nowMs: now(),
      });
      if (
        environmentFailure &&
        !(environmentFailure === "credential-expired" && placement.durableClaim)
      ) {
        return environmentFailure;
      }
      return null;
    },
    commitTranscript,
    pushLiveEvent,
    startInference,
    cancelInference,
    cancelInferenceForSession: (params: { sessionId: string; runId?: string }): string[] =>
      inference.cancelSession(params.sessionId, params.runId),
    hasInferenceForSession: (sessionId: string, runId?: string): boolean =>
      inference.hasSession(sessionId, runId),
    resolveInferenceSessionForRunId: (runId: string): string | undefined =>
      inference.resolveSessionIdForRunId(runId),
    attachSession,
    takeMintedCredential: (binding: WorkerCredentialBinding) =>
      readPendingCredential(binding)?.grant,
    acquireTurnCredential: (binding: WorkerCredentialBinding & { sessionId: string }) =>
      withLock(binding.environmentId, async () => {
        const pending = readPendingCredential(binding)?.grant;
        if (pending) {
          return pending;
        }
        const environment = store.get(binding.environmentId);
        if (
          !environment ||
          environment.state !== "attached" ||
          environment.ownerEpoch !== binding.ownerEpoch ||
          environment.attachedSessionIds.length !== 1 ||
          environment.attachedSessionIds[0] !== binding.sessionId
        ) {
          throw serviceError("invalid_state", "Worker session credential owner is not attached");
        }
        const previous = store.getCredential(binding.environmentId);
        const minted = mintCredentialLocked(binding);
        const grant = stageCredential(minted.grant);
        if (previous?.sessionId === binding.sessionId) {
          options.liveEvents?.rotateCredential({
            credentialHash: minted.credentialHash,
            environmentId: binding.environmentId,
            previousCredentialHash: previous.credentialHash,
            runEpoch: binding.ownerEpoch,
            sessionId: binding.sessionId,
          });
        }
        return grant;
      }),
    acknowledgeCredentialDelivery: (claim: WorkerCredentialDeliveryClaim): boolean => {
      const pending = readPendingCredential(claim);
      if (!pending || pending.grant.deliveryId !== claim.deliveryId) {
        return false;
      }
      store.markCredentialDelivered({
        ...claim,
        credentialHash: pending.credentialHash,
        deliveredAtMs: pending.checkedAtMs,
      });
      pendingCredentials.delete(claim.environmentId);
      return true;
    },
    startTunnel,
    stopTunnel,
    reconcileOnce,
    start,
    stop,
  };
}

export type WorkerEnvironmentService = ReturnType<typeof createWorkerEnvironmentService>;
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
