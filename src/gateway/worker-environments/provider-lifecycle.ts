import { isDeepStrictEqual } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { OpenClawConfig } from "../../config/types.js";
import type { SecretRef } from "../../config/types.secrets.js";
import { validateCloudWorkerProfileSettings } from "../../config/zod-schema.cloud-workers.js";
import { normalizeCapabilityProviderId } from "../../plugins/provider-registry-shared.js";
import {
  WorkerProviderError,
  type WorkerLease,
  type WorkerProfile,
  type WorkerProvider,
  type WorkerSshEndpoint,
  type WorkerSshIdentity,
} from "../../plugins/types.js";
import { STALE_WORKER_BUILD_REASON, verifyWorkerAdmissionHandshake } from "./admission.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import type { WorkerCredentialBroker } from "./credential-broker.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import { requireWorkerLease, requireWorkerLeaseStatus } from "./service-validation.js";
import type { WorkerEnvironmentState } from "./state.js";
import type {
  WorkerEnvironmentRecord,
  WorkerEnvironmentStore,
  WorkerEnvironmentTransitionPatch as TransitionPatch,
} from "./store.js";
import type { WorkerTunnelManager } from "./tunnel.js";
import { boundedWorkerError as boundedError } from "./worker-error.js";

const ORPHANED_LEASE_ERROR = "Worker provider no longer recognizes the lease";

type WorkerProviderLifecycleOptions = {
  store: WorkerEnvironmentStore;
  getConfig: () => OpenClawConfig;
  resolveProvider: (providerId: string) => WorkerProvider | undefined;
  prepareInstallation: (
    install: WorkerInstallationArtifact["install"],
  ) => Promise<WorkerInstallationArtifact>;
  bootstrapWorker: (params: {
    operationId: string;
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
  ensureNodeWorkerBundle?: (deviceId: string) => Promise<WorkerAdmissionHandshake>;
  providerCallTimeoutMs?: number;
  tunnelManager?: Pick<WorkerTunnelManager, "stop">;
  placementStore?: {
    isEnvironmentTeardownFenced(environmentId: string): boolean;
  };
  credentialBroker: WorkerCredentialBroker;
  callBootstrap: <T>(
    installation: WorkerInstallationArtifact,
    run: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
  callProvider: <T>(environmentId: string, run: () => Promise<T>, timeoutMs?: number) => Promise<T>;
  inState: (record: WorkerEnvironmentRecord, ...states: WorkerEnvironmentState[]) => boolean;
  isServiceError: (error: unknown, code: string) => boolean;
  isStopping: () => boolean;
  move: (
    record: WorkerEnvironmentRecord,
    to: WorkerEnvironmentState,
    patch?: TransitionPatch,
  ) => WorkerEnvironmentRecord;
  saveError: (record: WorkerEnvironmentRecord, error: unknown) => WorkerEnvironmentRecord;
  serviceError: (
    code:
      | "bootstrap_failure"
      | "environment_not_found"
      | "invalid_profile"
      | "invalid_state"
      | "profile_not_found"
      | "provider_failure"
      | "provider_not_found",
    message: string,
  ) => Error;
  withLock: <T>(environmentId: string, task: () => Promise<T>) => Promise<T>;
};

export type WorkerEnvironmentTeardownAuthorization = () => boolean;

function requireProviderProvisionTimeoutMs(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) {
    return undefined;
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_TIMEOUT_MS) {
    throw new WorkerProviderError(
      `Worker provider provision timeout must be an integer from 1 through ${MAX_TIMER_TIMEOUT_MS}ms`,
    );
  }
  return timeoutMs;
}

export function createWorkerProviderLifecycle(options: WorkerProviderLifecycleOptions) {
  const { store } = options;
  const tunnels = options.tunnelManager;
  const callBootstrap = options.callBootstrap;
  const callProvider = options.callProvider;
  const inState = options.inState;
  const move = options.move;
  const saveError = options.saveError;
  const serviceError = options.serviceError;
  const withLock = options.withLock;
  const { commitReady, ensurePendingCredential } = options.credentialBroker;

  function requireWorkerProfile(value: unknown): WorkerProfile {
    const error = validateCloudWorkerProfileSettings(value);
    if (error) {
      throw serviceError("invalid_profile", error);
    }
    return value as WorkerProfile;
  }

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
      return await callProvider(record.environmentId, () =>
        resolveSshIdentity({ provider, leaseId, profile, keyRef }),
      );
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

  const finishProvenDestroy = (record: WorkerEnvironmentRecord) => {
    const destroying = beginDestroy(record);
    if (destroying.teardownTerminalState !== "failed") {
      return move(destroying, "destroyed");
    }
    return move(destroying, "failed", {
      leaseId: null,
      sshEndpoint: null,
      sharedHost: false,
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
      await callProvider(record.environmentId, () =>
        provider.destroy(lifecycleLease(record, leaseId)),
      );
    } catch (cleanupError) {
      // An indeterminate destroy must remain retryable; never hide a possibly-live paid lease
      // behind terminal failed state.
      saveError(
        destroying,
        new Error(`${detail}; provider teardown pending: ${boundedError(cleanupError)}`),
      );
      throw serviceError(
        "bootstrap_failure",
        `Worker bootstrap failed; teardown is pending: ${detail}`,
      );
    }
    finishProvenDestroy(destroying);
    throw serviceError("bootstrap_failure", `Worker bootstrap failed: ${detail}`);
  };

  const finishBootstrap = async (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    installation: WorkerInstallationArtifact,
  ) => {
    if (record.state !== "bootstrapping" || !record.leaseId || !record.sshEndpoint) {
      throw serviceError("invalid_state", "Worker bootstrap requires a provisioned SSH lease");
    }
    const leaseId = record.leaseId;
    const sshEndpoint = record.sshEndpoint;
    let receipt: WorkerAdmissionHandshake;
    try {
      receipt = await callBootstrap(installation, (signal) =>
        options.bootstrapWorker({
          operationId: record.provisionOperationId,
          sshEndpoint,
          installation,
          resolveIdentity: identityResolverFor(record, provider, leaseId),
          signal,
        }),
      );
      if (!verifyWorkerAdmissionHandshake(receipt, installation)) {
        throw new Error("Worker bootstrap receipt does not match the expected build identity");
      }
    } catch (error) {
      return await failBootstrap(record, leaseId, provider, error);
    }
    return commitReady(record, { ...receipt, installKind: "bundle" });
  };

  const finishProvision = async (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    preparedInstallation?: WorkerInstallationArtifact,
  ) => {
    let lease: WorkerLease;
    try {
      const profile = requireWorkerProfile(record.profileSnapshot.settings);
      const providerTimeoutMs =
        options.providerCallTimeoutMs === undefined
          ? requireProviderProvisionTimeoutMs(provider.resolveProvisionTimeoutMs?.(profile))
          : undefined;
      lease = requireWorkerLease(
        await callProvider(
          record.environmentId,
          () => provider.provision(profile, record.provisionOperationId),
          providerTimeoutMs,
        ),
      );
    } catch (error) {
      const detail = boundedError(error);
      if (
        error instanceof WorkerProviderError ||
        options.isServiceError(error, "invalid_profile")
      ) {
        move(record, "failed", { lastError: detail });
        throw serviceError("invalid_profile", `Worker provider rejected profile: ${detail}`);
      }
      saveError(record, error);
      throw serviceError("provider_failure", `Worker provider operation failed: ${detail}`);
    }
    // A timeout can happen after allocation; retain the same operation id for safe replay.
    const patch = {
      leaseId: lease.leaseId,
      sharedHost: lease.sharedHost === true,
      desktop: lease.desktop ?? null,
    };
    if (lease.node) {
      let nodeBuild: WorkerAdmissionHandshake;
      try {
        if (!options.ensureNodeWorkerBundle) {
          throw new Error("Device worker bundle installer is unavailable");
        }
        nodeBuild = await options.ensureNodeWorkerBundle(lease.node.deviceId);
      } catch (error) {
        const detail = boundedError(error);
        move(record, "failed", { lastError: detail });
        throw serviceError("bootstrap_failure", `Device worker bootstrap failed: ${detail}`);
      }
      return commitReady(
        record,
        { ...nodeBuild, installKind: "bundle" },
        { ...patch, sshEndpoint: null },
      );
    }
    const bootstrapping = move(record, "bootstrapping", {
      ...patch,
      sshEndpoint: lease.ssh,
    });
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
    if (
      record.state === "requested" &&
      record.destroyRequestedAtMs === null &&
      provider.provisionBeforeInstallation !== true
    ) {
      try {
        // Fresh requests package before allocation. Once provisioning is durable, provider replay
        // must happen first because the previous response may have been lost after allocation.
        installation = await prepareInstallation(record);
      } catch (error) {
        const detail = boundedError(error);
        move(record, "failed", { lastError: detail });
        throw serviceError(
          "bootstrap_failure",
          `Worker installation preparation failed: ${detail}`,
        );
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

  const assertTeardownAllowed = (
    environmentId: string,
    authorizeTeardown?: WorkerEnvironmentTeardownAuthorization,
  ): void => {
    const allowed = authorizeTeardown
      ? authorizeTeardown()
      : !options.placementStore?.isEnvironmentTeardownFenced(environmentId);
    if (!allowed) {
      throw serviceError(
        "invalid_state",
        "Worker environment teardown is fenced by a pending workspace result",
      );
    }
  };

  const finishDestroy = async (
    r: WorkerEnvironmentRecord,
    provider?: WorkerProvider,
    authorizeTeardown?: WorkerEnvironmentTeardownAuthorization,
  ) => {
    if (!r.leaseId) {
      throw serviceError("invalid_state", "Worker environment has no lease");
    }
    assertTeardownAllowed(r.environmentId, authorizeTeardown);
    const leaseId = r.leaseId;
    await tunnels?.stop(r.environmentId);
    // Authorization is operational authority, not a bearer token. Re-read its
    // exact SQLite owner after the awaited tunnel stop before provider teardown.
    assertTeardownAllowed(r.environmentId, authorizeTeardown);
    const owningProvider = provider ?? providerFor(r.providerId);
    const destroying = beginDestroy(r);
    try {
      await callProvider(r.environmentId, () => owningProvider.destroy(lifecycleLease(r, leaseId)));
    } catch (error) {
      saveError(destroying, error);
      throw serviceError("provider_failure", "Worker provider operation failed");
    }
    return finishProvenDestroy(destroying);
  };

  const recordStaleBuildDestroy = (record: WorkerEnvironmentRecord) => {
    // Attached sessions need the build cause after teardown so placement reconciliation can
    // persist an actionable terminal reason instead of inferring from destroyed environment state.
    return record.state === "attached"
      ? store.requestDestroy({
          environmentId: record.environmentId,
          state: record.state,
          terminalState: "failed",
          lastError: STALE_WORKER_BUILD_REASON,
        })
      : record;
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
        if (record.bootstrapReceipt) {
          if (verifyWorkerAdmissionHandshake(record.bootstrapReceipt, currentBundle)) {
            const sessionId = record.state === "attached" ? record.attachedSessionIds[0] : null;
            if (record.state !== "attached" || sessionId) {
              ensurePendingCredential(record, sessionId ?? null);
              record = store.get(record.environmentId) ?? record;
            }
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
      if (provisioned?.leaseId && provisioned.destroyRequestedAtMs !== null) {
        await finishDestroy(provisioned, provider).catch(() => undefined);
      }
      return;
    }
    const inspection = await callProvider(record.environmentId, () =>
      provider.inspect(lifecycleLease(record, leaseId)),
    )
      .then(requireWorkerLeaseStatus)
      .catch((error: unknown) => {
        saveError(record, error);
        return undefined;
      });
    if (!inspection) {
      return;
    }
    // Provider inspection is authoritative observation, not teardown authority. Project
    // provider-proven loss even while a workspace result fences the mutation paths below.
    const { status } = inspection;
    const teardownExpected = record.destroyRequestedAtMs !== null || record.state === "destroying";
    if (status === "destroyed" || (status === "unknown" && teardownExpected)) {
      const requested =
        record.destroyRequestedAtMs === null
          ? store.requestDestroy({
              environmentId: record.environmentId,
              state: record.state,
              ...(status === "destroyed" && !teardownExpected
                ? {
                    terminalState: "failed",
                    lastError: "Worker environment disappeared before teardown was requested",
                  }
                : {}),
            })
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
    if (status === "dormant") {
      if (teardownExpected) {
        await finishDestroy(record, provider).catch(() => undefined);
      }
      // A paired device may be offline without losing its lease. Keep that authoritative
      // holding state out of the unknown/orphan path until pairing itself is removed.
      return;
    }
    const inspectedSharedHost = inspection.sharedHost === true;
    if (record.sharedHost !== null && record.sharedHost !== inspectedSharedHost) {
      // Workspace actions capture isolation at tunnel creation. Fence the old actions before
      // committing a provider-owned change so no reconciliation can use stale host scope.
      await tunnels?.stop(record.environmentId);
    }
    record = store.reconcileSharedHost({
      environmentId: record.environmentId,
      state: record.state,
      leaseId,
      sharedHost: inspectedSharedHost,
    });
    if (record.destroyRequestedAtMs !== null) {
      await finishDestroy(record, provider).catch(() => undefined);
      return;
    }
    if (!record.sshEndpoint) {
      if (
        currentBundle &&
        (!record.bootstrapReceipt ||
          !verifyWorkerAdmissionHandshake(record.bootstrapReceipt, currentBundle))
      ) {
        // A stale node environment cannot be upgraded in place because its credential and
        // placement ownership bind the old build. Retire it; reprovisioning reuses the installed
        // content-addressed bundle without another transfer.
        await finishDestroy(recordStaleBuildDestroy(record), provider).catch(() => undefined);
      }
      return;
    }
    if (record.state === "attached") {
      if (
        currentBundle &&
        (!record.bootstrapReceipt ||
          !verifyWorkerAdmissionHandshake(record.bootstrapReceipt, currentBundle))
      ) {
        // A new Gateway build rejects the old worker at admission. This is expected lifecycle
        // teardown, not a bootstrap failure. `leaseId` above came from this record, so provider
        // inspection and destruction share the same durable lease identity.
        await finishDestroy(recordStaleBuildDestroy(record), provider).catch(() => undefined);
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

  const createWithProfile = async (
    profileId: string,
    idempotencyKey: string,
    inherited?: {
      providerId: string;
      profileSnapshot: WorkerProfile;
    },
  ) => {
    let stopping = options.isStopping();
    if (stopping) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    const normalizedProfileId = profileId.trim();
    if (!normalizedProfileId || normalizedProfileId !== profileId) {
      throw serviceError("invalid_profile", "Worker profile id must be non-empty and trimmed");
    }
    const { environmentId, provisionOperationId } = deriveEnvironmentIntent(idempotencyKey);
    return withLock(environmentId, async () => {
      stopping = options.isStopping();
      if (stopping) {
        throw serviceError("invalid_state", "Worker environment service is stopping");
      }
      const existing = store.get(environmentId);
      if (existing) {
        if (
          existing.profileId !== normalizedProfileId ||
          (inherited !== undefined &&
            (existing.providerId !== inherited.providerId ||
              !isDeepStrictEqual(existing.profileSnapshot, inherited.profileSnapshot)))
        ) {
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
      let provider: WorkerProvider;
      let providerId: string;
      let profileSnapshot: WorkerProfile;
      if (inherited) {
        providerId = normalizeCapabilityProviderId(inherited.providerId) ?? inherited.providerId;
        if (providerId !== inherited.providerId) {
          throw serviceError("invalid_profile", "Inherited worker provider id is not canonical");
        }
        provider = providerFor(providerId);
        const resolvedProviderId = normalizeCapabilityProviderId(provider.id) ?? provider.id;
        if (resolvedProviderId !== providerId) {
          throw serviceError("invalid_profile", "Inherited worker provider identity changed");
        }
        profileSnapshot = requireWorkerProfile(inherited.profileSnapshot);
      } else {
        const profiles = options.getConfig().cloudWorkers?.profiles;
        if (!profiles || !Object.hasOwn(profiles, normalizedProfileId)) {
          throw serviceError("profile_not_found", `Unknown worker profile: ${normalizedProfileId}`);
        }
        const profile = expectDefined(
          profiles[normalizedProfileId],
          "profiles entry at normalized profile id",
        );
        provider = providerFor(profile.provider);
        providerId = normalizeCapabilityProviderId(provider.id) ?? provider.id;
        const settings = requireWorkerProfile(profile.settings ?? {});
        profileSnapshot = requireWorkerProfile({
          install: profile.install ?? "bundle",
          settings,
        });
      }
      const intent = store.createIntent({
        environmentId,
        providerId,
        profileId: normalizedProfileId,
        profileSnapshot,
        provisionOperationId,
      });
      return resumeProvision(intent, provider);
    });
  };

  const destroy = async (
    environmentId: string,
    destroyOptions: {
      requireUnattached?: boolean;
      authorizeTeardown?: WorkerEnvironmentTeardownAuthorization;
    } = {},
  ) => {
    const stopping = options.isStopping();
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
      assertTeardownAllowed(environmentId, destroyOptions.authorizeTeardown);
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
        return finishDestroy(record, provider, destroyOptions.authorizeTeardown);
      }
      return finishDestroy(record, undefined, destroyOptions.authorizeTeardown);
    });
  };

  return {
    createWithProfile,
    destroy,
    identityResolverFor,
    providerFor,
    reconcileRecord,
  };
}
