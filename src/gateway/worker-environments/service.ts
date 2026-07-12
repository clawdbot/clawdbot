import { createHash } from "node:crypto";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  type WorkerAdmissionHandshake,
  type WorkerConnectParams,
  type WorkerProtocolCloseReason,
  type WorkerTranscriptCommitErrorReason,
  type WorkerTranscriptCommitParams,
  type WorkerTranscriptCommitResult,
  WORKER_RPC_SET_VERSION,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { OpenClawConfig } from "../../config/types.js";
import type { SecretRef } from "../../config/types.secrets.js";
import { validateCloudWorkerProfileSettings } from "../../config/zod-schema.cloud-workers.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { withTimeout } from "../../infra/fs-safe.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { normalizeCapabilityProviderId } from "../../plugins/provider-registry-shared.js";
import {
  WorkerProviderError,
  type WorkerLease,
  type WorkerLeaseStatus,
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
import type { WorkerEnvironmentState } from "./state.js";
import {
  normalizeWorkerSshEndpoint,
  type WorkerEnvironmentRecord,
  type WorkerEnvironmentStore,
  type WorkerEnvironmentTransitionPatch as TransitionPatch,
} from "./store.js";
import type { WorkerTunnelRequest } from "./tunnel-contract.js";
import type { WorkerTunnelHandle, WorkerTunnelManager } from "./tunnel.js";

export type WorkerEnvironmentServiceErrorCode =
  | "profile_not_found"
  | "provider_not_found"
  | "environment_not_found"
  | "invalid_profile"
  | "invalid_state"
  | "provider_failure"
  | "bootstrap_failure";

export class WorkerEnvironmentServiceError extends Error {
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

export type WorkerEnvironmentServiceOptions = {
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
};

export type WorkerTranscriptCommitApplicationResult =
  | { ok: true; result: WorkerTranscriptCommitResult }
  | { ok: false; reason: WorkerTranscriptCommitErrorReason };

export type WorkerTranscriptCommitServiceResult =
  | WorkerTranscriptCommitApplicationResult
  | { ok: false; closeReason: WorkerProtocolCloseReason };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireWorkerProfile(value: unknown): WorkerProfile {
  const error = validateCloudWorkerProfileSettings(value);
  if (error) {
    throw serviceError("invalid_profile", error);
  }
  return value as WorkerProfile;
}

function inspectionStatus(value: unknown): WorkerLeaseStatus["status"] {
  if (!isRecord(value)) {
    throw new Error("Worker provider returned an invalid inspection result");
  }
  const status = value.status;
  if (status !== "active" && status !== "destroyed" && status !== "unknown") {
    throw new Error("Worker provider returned an invalid inspection status");
  }
  return status;
}

function requireWorkerLease(value: unknown): WorkerLease {
  if (
    !isRecord(value) ||
    typeof value.leaseId !== "string" ||
    !value.leaseId.trim() ||
    !isRecord(value.ssh)
  ) {
    throw new Error("Worker provider returned an invalid provision result");
  }
  return {
    leaseId: value.leaseId.trim(),
    ssh: normalizeWorkerSshEndpoint(value.ssh as WorkerSshEndpoint),
  };
}

function boundedError(error: unknown): string {
  const redacted = redactSensitiveText(formatErrorMessage(error), { mode: "tools" })
    .replace(/\s+/g, " ")
    .trim();
  return truncateUtf16Safe(redacted || "unknown error", 1_024);
}

export function createWorkerEnvironmentService(options: WorkerEnvironmentServiceOptions) {
  const { store } = options;
  const tunnels = options.tunnelManager;
  const warn = (message: string) => options.logger?.warn(message);
  const operations = new KeyedAsyncQueue();
  const activeOperations = new Set<Promise<unknown>>();
  const pendingCredentials = new Map<string, MintedWorkerCredential>();
  const now = options.now ?? Date.now;
  let reconcileInFlight: Promise<void> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let stopping = false;

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

  const mintCredentialLocked = (request: WorkerCredentialBinding): MintedWorkerCredential => {
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
    return grantFrom({ credential: material.credential, record });
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
    stageCredential(
      mintCredentialLocked({
        environmentId: record.environmentId,
        ownerEpoch: record.ownerEpoch,
        sessionId,
      }),
    );
  };

  const reconcileRecord = async (initialRecord: WorkerEnvironmentRecord): Promise<void> => {
    let record = initialRecord;
    if (record.state === "requested" && record.destroyRequestedAtMs !== null) {
      return void cancelRequested(record);
    }
    let currentBundle: WorkerInstallationArtifact | undefined;
    if (
      record.destroyRequestedAtMs === null &&
      record.bootstrapReceipt &&
      inState(record, "ready", "idle", "attached")
    ) {
      try {
        currentBundle = await options.prepareInstallation("bundle");
        if (verifyWorkerAdmissionHandshake(record.bootstrapReceipt, currentBundle)) {
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
      // Milestone 2 owns session draining; never replace a build beneath a live worker.
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
    const digest = createHash("sha256").update(idempotencyKey).digest("hex");
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
      const profile = profiles[normalizedProfileId];
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

  const destroy = async (environmentId: string) => {
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
      store.transition({
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
    interval = setInterval(
      () => void reconcileOnce().catch(() => warn("Worker environment reconcile sweep failed")),
      options.reconcileIntervalMs ?? 60_000,
    );
    interval.unref?.();
    void reconcileOnce().catch(() => warn("Worker environment startup reconcile failed"));
  };

  const stop = async () => {
    stopping = true;
    pendingCredentials.clear();
    clearInterval(interval);
    interval = undefined;
    await tunnels?.stopAll();
    const reconciliation = reconcileInFlight;
    if (reconciliation) {
      await Promise.allSettled([reconciliation]);
    }
    while (activeOperations.size > 0) {
      await Promise.allSettled(activeOperations);
    }
    pendingCredentials.clear();
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

  const commitTranscript = (
    identity: WorkerConnectionIdentity,
    request: WorkerTranscriptCommitParams,
  ): Promise<WorkerTranscriptCommitServiceResult> =>
    withLock(identity.environmentId, async () => {
      if (stopping) {
        return { ok: false, closeReason: "environment-unavailable" };
      }
      const credential = store.getCredential(identity.environmentId);
      if (!credential || !safeEqualSecret(credential.credentialHash, identity.credentialHash)) {
        return { ok: false, closeReason: "credential-replaced" };
      }
      if (now() >= credential.expiresAtMs) {
        return { ok: false, closeReason: "credential-expired" };
      }
      const environment = store.get(identity.environmentId);
      if (!environment || environment.destroyRequestedAtMs !== null) {
        return { ok: false, closeReason: "environment-unavailable" };
      }
      if (
        request.runEpoch !== identity.ownerEpoch ||
        request.runEpoch !== credential.ownerEpoch ||
        request.runEpoch !== environment.ownerEpoch
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
      if (!options.applyTranscriptCommit) {
        return { ok: false, closeReason: "gateway-unavailable" };
      }
      return await options.applyTranscriptCommit({ identity, request });
    });

  return {
    list: () => store.list().map(project),
    get: (environmentId: string) => {
      const record = store.get(environmentId);
      return record ? project(record) : undefined;
    },
    create: async (profileId: string, idempotencyKey: string) =>
      project(await create(profileId, idempotencyKey)),
    destroy: async (environmentId: string) => project(await destroy(environmentId)),
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
      return admitWorkerConnection({ store, admission, expectedBuild, nowMs: now() });
    },
    validateWorkerConnection: (identity: WorkerConnectionIdentity) =>
      stopping
        ? ("environment-unavailable" as const)
        : validateWorkerConnectionIdentity({ store, identity, nowMs: now() }),
    commitTranscript,
    attachSession,
    takeMintedCredential: (binding: WorkerCredentialBinding) =>
      readPendingCredential(binding)?.grant,
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
