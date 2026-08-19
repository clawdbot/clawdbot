import { isDeepStrictEqual } from "node:util";
import { expectDefined } from "@openclaw/normalization-core";
import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { SecretRef } from "../../config/types.secrets.js";
import { validateCloudWorkerProfileSettings } from "../../config/zod-schema.cloud-workers.js";
import { normalizeCapabilityProviderId } from "../../plugins/provider-registry-shared.js";
import {
  WorkerProviderError,
  type WorkerLease,
  type WorkerProfile,
  type WorkerProvider,
} from "../../plugins/types.js";
import { verifyWorkerAdmissionHandshake } from "./admission.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import { createWorkerNodeProvisioning } from "./provider-node-provisioning.js";
import {
  requestStaleWorkerDestroy,
  retireMismatchedWorkerLease,
} from "./provider-persisted-lease.js";
import { deriveEnvironmentIntent } from "./service-contract.js";
import {
  normalizeWorkerMachineOptions,
  requireProviderProvisionTimeoutMs,
  requireWorkerLease,
  requireWorkerLeaseStatus,
  resolveWorkerLeaseModeError,
} from "./service-validation.js";
import type {
  WorkerEnvironmentRecord,
  WorkerEnvironmentTransitionPatch as TransitionPatch,
} from "./store.js";
import { boundedWorkerError as boundedError } from "./worker-error.js";

const ORPHANED_LEASE_ERROR = "Worker provider no longer recognizes the lease";

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

  const listMachineOptions = async (profileId: string) => {
    const profile = options.getConfig().cloudWorkers?.profiles?.[profileId];
    if (!profile) {
      return undefined;
    }
    const provider = options.resolveProvider(profile.provider);
    return normalizeWorkerMachineOptions(
      await provider?.listMachineOptions?.(requireWorkerProfile(profile.settings ?? {})),
    );
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

  const finishProvenDestroy = async (record: WorkerEnvironmentRecord) => {
    const destroying = beginDestroy(record);
    if (destroying.nodeSetupId) {
      await options.retireNodeEnrollment?.(destroying);
    }
    if (destroying.teardownTerminalState !== "failed") {
      return move(destroying, "destroyed");
    }
    return move(destroying, "failed", {
      leaseId: null,
      nodeDeviceId: null,
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
    failureCode: "bootstrap_failure" | "invalid_profile" = "bootstrap_failure",
    leasePatch?: TransitionPatch,
  ): Promise<never> => {
    const detail = boundedError(error);
    const failureLabel =
      failureCode === "invalid_profile"
        ? "Worker provider returned an incompatible lease"
        : "Worker bootstrap failed";
    const requested = store.requestDestroy({
      environmentId: record.environmentId,
      state: record.state,
      terminalState: "failed",
      lastError: detail,
    });
    const draining = move(requested, "draining", { ...leasePatch, lastError: detail });
    await tunnels?.stop(record.environmentId);
    const destroying = move(draining, "destroying", { lastError: detail });
    try {
      await callProvider(record.environmentId, () =>
        provider.destroy(lifecycleLease(record, leaseId)),
      );
    } catch (cleanupError: unknown) {
      // An indeterminate destroy must remain retryable; never hide a possibly-live paid lease
      // behind terminal failed state.
      saveError(
        destroying,
        new Error(`${detail}; provider teardown pending: ${boundedError(cleanupError)}`),
      );
      throw serviceError(failureCode, `${failureLabel}; teardown is pending: ${detail}`);
    }
    await finishProvenDestroy(destroying);
    throw serviceError(failureCode, `${failureLabel}: ${detail}`);
  };

  const finishNodeProvisioning = createWorkerNodeProvisioning({
    store,
    tunnels,
    ensureNodeWorkerBundle: options.ensureNodeWorkerBundle,
    commitReady,
    move,
    destroyProviderLease: async (record, leaseId, provider) =>
      await callProvider(record.environmentId, () =>
        provider.destroy(lifecycleLease(record, leaseId)),
      ),
    finishProvenDestroy,
    saveError,
    serviceError,
  });

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
      const machineClass =
        typeof record.profileSnapshot.machineClass === "string"
          ? record.profileSnapshot.machineClass
          : undefined;
      const prepareNodeEnrollment = options.prepareNodeEnrollment;
      if (provider.requiresNodeEnrollment === true && !prepareNodeEnrollment) {
        throw new Error("Worker node enrollment runtime is unavailable");
      }
      const provisionOptions =
        machineClass || provider.requiresNodeEnrollment === true
          ? {
              ...(machineClass ? { machineClass } : {}),
              ...(provider.requiresNodeEnrollment === true && prepareNodeEnrollment
                ? { beginNodeEnrollment: async () => await prepareNodeEnrollment(record) }
                : {}),
            }
          : undefined;
      lease = requireWorkerLease(
        await callProvider(
          record.environmentId,
          () => provider.provision(profile, record.provisionOperationId, provisionOptions),
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
    const leaseModeError = resolveWorkerLeaseModeError(provider, lease);
    if (leaseModeError) {
      const leasePatch = {
        ...patch,
        ...(lease.node
          ? { nodeDeviceId: lease.node.deviceId, sshEndpoint: null }
          : { nodeDeviceId: null, sshEndpoint: lease.ssh }),
      };
      return await failBootstrap(
        record,
        lease.leaseId,
        provider,
        leaseModeError,
        "invalid_profile",
        leasePatch,
      );
    }
    if (lease.node) {
      return await finishNodeProvisioning(record, lease, provider, patch);
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
        installation = await options.prepareInstallation(installFor(bootstrapping));
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
        installation = await options.prepareInstallation(installFor(record));
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
      await callProvider(r.environmentId, () => owningProvider.destroy(lifecycleLease(r, leaseId)));
    } catch (error) {
      saveError(destroying, error);
      throw serviceError("provider_failure", "Worker provider operation failed");
    }
    return await finishProvenDestroy(destroying);
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
    if (await retireMismatchedWorkerLease(record, provider, store, finishDestroy)) {
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
      await finishProvenDestroy(draining).catch((error: unknown) => {
        saveError(draining, error);
      });
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
        await finishDestroy(requestStaleWorkerDestroy(record, store), provider).catch(
          () => undefined,
        );
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
        await finishDestroy(requestStaleWorkerDestroy(record, store), provider).catch(
          () => undefined,
        );
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
    createOptions: {
      inherited?: {
        providerId: string;
        profileSnapshot: WorkerProfile;
      };
      machineClass?: string;
    } = {},
  ) => {
    const { inherited, machineClass } = createOptions;
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
              !isDeepStrictEqual(existing.profileSnapshot, {
                ...inherited.profileSnapshot,
                ...(machineClass === undefined ? {} : { machineClass }),
              }))) ||
          (inherited === undefined && existing.profileSnapshot.machineClass !== machineClass)
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
        profileSnapshot = requireWorkerProfile({
          ...inherited.profileSnapshot,
          ...(machineClass === undefined ? {} : { machineClass }),
        });
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
          ...(machineClass === undefined ? {} : { machineClass }),
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
    destroyOptions: { requireUnattached?: boolean } = {},
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

  return {
    createWithProfile,
    destroy,
    identityResolverFor,
    listMachineOptions,
    providerFor,
    reconcileRecord,
  };
}
