import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { SecretRef } from "../../config/types.secrets.js";
import { validateCloudWorkerProfileSettings } from "../../config/zod-schema.cloud-workers.js";
import type { WorkerProfile, WorkerProvider } from "../../plugins/types.js";
import { verifyWorkerAdmissionHandshake } from "./admission.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import type {
  WorkerEnvironmentRecord,
  WorkerEnvironmentTransitionPatch as TransitionPatch,
} from "./environment-record.js";
import { createWorkerProviderIntent } from "./provider-intent.js";
import type { WorkerProviderLifecycleOptions } from "./provider-lifecycle.types.js";
import { createWorkerNodeProvisioning } from "./provider-node-provisioning.js";
import { createWorkerProviderOwnerLifecycle } from "./provider-owner-lifecycle.js";
import {
  requestStaleWorkerDestroy,
  retireMismatchedWorkerLease,
} from "./provider-persisted-lease.js";
import { createWorkerProvisionCancellation } from "./provider-provisioning-cancellation.js";
import { createWorkerProviderProvisioner } from "./provider-provisioning.js";
import { normalizeWorkerMachineOptions, requireWorkerLeaseStatus } from "./service-validation.js";
import { boundedWorkerError as boundedError } from "./worker-error.js";

const ORPHANED_LEASE_ERROR = "Worker provider no longer recognizes the lease";

export function createWorkerProviderLifecycle(options: WorkerProviderLifecycleOptions) {
  const { store, callBootstrap, callProvider, inState, move, saveError, serviceError, withLock } =
    options;
  const now = options.now ?? Date.now;
  const { commitReady, ensurePendingCredential } = options.credentialBroker;

  function requireWorkerProfile(value: unknown): WorkerProfile {
    const error = validateCloudWorkerProfileSettings(value);
    if (error) {
      throw serviceError("invalid_profile", error);
    }
    return value as WorkerProfile;
  }

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

  const {
    requireCurrentOwner,
    stopOwner,
    destroyLease,
    beginDrain,
    finishProvenDestroy,
    lifecycleLease,
    finishDestroy,
    destroy,
  } = createWorkerProviderOwnerLifecycle({ ...options, providerFor, requireWorkerProfile });

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
        : leasePatch?.nodeDeviceId
          ? "Worker node bootstrap failed"
          : "Worker bootstrap failed";
    const requested = store.requestDestroy({
      environmentId: record.environmentId,
      state: record.state,
      terminalState: "failed",
      lastError: detail,
    });
    const stopped = await stopOwner(requested);
    const draining = move(stopped, "draining", { ...leasePatch, lastError: detail });
    const destroying = move(draining, "destroying", { lastError: detail });
    try {
      await destroyLease(destroying, provider, lifecycleLease(destroying, leaseId));
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

  const nodeProvisioning = createWorkerNodeProvisioning({
    ...options,
    commitReady,
    failBootstrap: async (record, leaseId, provider, error, patch) =>
      await failBootstrap(record, leaseId, provider, error, "bootstrap_failure", patch),
  });

  const finishBootstrap = async (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    installation: WorkerInstallationArtifact,
    cancellation?: ReturnType<typeof createWorkerProvisionCancellation>,
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
          signal: cancellation ? AbortSignal.any([signal, cancellation.signal]) : signal,
        }),
      );
      cancellation?.assertActive();
      if (!verifyWorkerAdmissionHandshake(receipt, installation)) {
        throw new Error("Worker bootstrap receipt does not match the expected build identity");
      }
    } catch (error) {
      return await failBootstrap(record, leaseId, provider, error);
    }
    return commitReady(record, { ...receipt, installKind: "bundle" });
  };

  const finishProvision = createWorkerProviderProvisioner({
    ...options,
    nodeProvisioning,
    requireWorkerProfile,
    requireCurrentOwner,
    installFor,
    finishBootstrap,
    failBootstrap,
  });

  const resumeProvision = async (
    record: WorkerEnvironmentRecord,
    provider = providerFor(record.providerId),
    signal?: AbortSignal,
    retainProviderSettlement?: (settled: Promise<void>) => void,
    beforeProvision?: () => void,
  ) => {
    const pending = store.get(record.environmentId);
    if (pending?.preparation?.consumedAtMs === null && pending.preparation.expiresAtMs <= now()) {
      const requested = store.requestDestroy({
        environmentId: pending.environmentId,
        state: pending.state,
        lastError: "Unused prepared worker expired",
      });
      return finishDestroy(requested, provider);
    }
    const cancellation = signal
      ? createWorkerProvisionCancellation(store, record, signal)
      : undefined;
    if (cancellation) {
      retainProviderSettlement?.(cancellation.settled);
    }
    try {
      let installation: WorkerInstallationArtifact | undefined;
      await nodeProvisioning.prepare(record, provider, signal);
      cancellation?.assertActive();
      if (
        record.state === "requested" &&
        record.destroyRequestedAtMs === null &&
        provider.provisionBeforeInstallation !== true
      ) {
        try {
          // Fresh requests package before allocation. Once provisioning is durable, provider replay
          // must happen first because the previous response may have been lost after allocation.
          installation = await options.prepareInstallation(installFor(record), signal);
        } catch (error) {
          cancellation?.assertActive();
          const detail = boundedError(error);
          move(record, "failed", { lastError: detail });
          throw serviceError(
            "bootstrap_failure",
            `Worker installation preparation failed: ${detail}`,
          );
        }
        cancellation?.assertActive();
      }
      const current = requireCurrentOwner(record);
      if (current.preparation?.consumedAtMs === null && current.preparation.expiresAtMs <= now()) {
        return finishDestroy(
          store.requestDestroy({
            environmentId: current.environmentId,
            state: current.state,
            lastError: "Unused prepared worker expired before allocation",
          }),
          provider,
        );
      }
      return await finishProvision(current, provider, installation, cancellation, beforeProvision);
    } finally {
      cancellation?.close();
    }
  };

  const reconcileRecord = async (
    initialRecord: WorkerEnvironmentRecord,
    signal?: AbortSignal,
    retainProviderSettlement?: (settled: Promise<void>) => void,
    beforeProvision?: () => void,
  ): Promise<void> => {
    let record = initialRecord;
    if (record.state === "requested" && record.destroyRequestedAtMs !== null) {
      return void (await finishDestroy(record));
    }
    let currentBundle: WorkerInstallationArtifact | undefined;
    if (record.destroyRequestedAtMs === null && inState(record, "ready", "idle", "attached")) {
      try {
        currentBundle = await options.prepareInstallation("bundle", signal);
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
        signal?.throwIfAborted();
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
      await (
        record.destroyRequestedAtMs !== null
          ? finishDestroy(record, provider)
          : resumeProvision(record, provider, signal, retainProviderSettlement, beforeProvision)
      ).catch(() => undefined);
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
    if (status === "destroyed") {
      requireCurrentOwner(record);
      const requested =
        record.destroyRequestedAtMs === null
          ? store.requestDestroy({
              environmentId: record.environmentId,
              state: record.state,
              ...(!teardownExpected
                ? {
                    terminalState: "failed",
                    lastError: "Worker environment disappeared before teardown was requested",
                  }
                : {}),
            })
          : record;
      const stopped = await stopOwner(requested, "provider-destroyed");
      const draining = beginDrain(stopped);
      await finishProvenDestroy(draining).catch((error: unknown) => {
        saveError(draining, error);
      });
      return;
    }
    if (status === "unknown") {
      requireCurrentOwner(record);
      // Provider loss fences placement authority before remote cleanup, which may remain
      // unreachable after node revocation. Preserve its exact attachment until stop is proven.
      const requested = teardownExpected
        ? record
        : store.requestDestroy({
            environmentId: record.environmentId,
            state: record.state,
            terminalState: "failed",
            lastError: ORPHANED_LEASE_ERROR,
          });
      await finishDestroy(requested, provider).catch(() => undefined);
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
      record = await stopOwner(record);
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
    if (!record.sshEndpoint || record.state === "attached") {
      if (
        currentBundle &&
        (!record.bootstrapReceipt ||
          !verifyWorkerAdmissionHandshake(record.bootstrapReceipt, currentBundle))
      ) {
        // Attached and node-backed environments bind placement authority to the admitted build.
        // Retire stale owners; only unattached SSH leases can bootstrap a replacement in place.
        await finishDestroy(requestStaleWorkerDestroy(record, store), provider).catch(
          () => undefined,
        );
      }
      return;
    }
    if (record.state === "draining" && record.destroyRequestedAtMs === null) {
      // Draining without destroy intent is durable provider-loss cleanup.
      record = await stopOwner(record);
      move(record, "orphaned", { lastError: record.lastError ?? ORPHANED_LEASE_ERROR });
      return;
    }
    if (inState(record, "bootstrapping", "ready", "idle")) {
      let cancellation = signal
        ? createWorkerProvisionCancellation(store, record, signal)
        : undefined;
      if (cancellation) {
        retainProviderSettlement?.(cancellation.settled);
      }
      try {
        cancellation?.assertActive();
        let installation = currentBundle;
        try {
          // Bundle identity is local and canonical for both install channels. A matching admitted
          // receipt must not depend on npm registry availability during routine reconciliation.
          installation ??= await options.prepareInstallation("bundle", signal);
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
            installation = await options.prepareInstallation("npm", signal);
          } catch (error) {
            await failBootstrap(record, leaseId, provider, error).catch(() => undefined);
            return;
          }
        }
        record = await stopOwner(record);
        cancellation?.assertActive();
        const bootstrapping =
          record.state === "bootstrapping" ? record : move(record, "bootstrapping");
        if (cancellation && bootstrapping.ownerEpoch !== record.ownerEpoch) {
          // Rebootstrap retires the admitted owner. Transfer cancellation synchronously
          // to the committed epoch before a child can run under that new authority.
          cancellation.close();
          cancellation = createWorkerProvisionCancellation(
            store,
            bootstrapping,
            cancellation.signal,
          );
          retainProviderSettlement?.(cancellation.settled);
          cancellation.assertActive();
        }
        await finishBootstrap(bootstrapping, provider, installation, cancellation).catch(
          () => undefined,
        );
        return;
      } finally {
        cancellation?.close();
      }
    }
    if (inState(record, "draining", "destroying")) {
      await finishDestroy(record, provider).catch(() => undefined);
    }
  };

  const { createWithProfile, prepareIntent, assertPreparedIntentCurrent } =
    createWorkerProviderIntent({
      ...options,
      providerFor,
      requireWorkerProfile,
      resumeProvision,
    });

  return {
    createWithProfile,
    prepareIntent,
    assertPreparedIntentCurrent,
    resumePrepared: (
      record: WorkerEnvironmentRecord,
      signal?: AbortSignal,
      beforeReconcile?: () => void,
    ) =>
      withLock(record.environmentId, async () => {
        beforeReconcile?.();
        let current = store.get(record.environmentId);
        if (!current || !current.preparation || current.preparation.consumedAtMs !== null) {
          return current;
        }
        if (current.preparation.expiresAtMs <= now() && current.destroyRequestedAtMs === null) {
          current = store.requestDestroy({
            environmentId: current.environmentId,
            state: current.state,
            lastError: "Unused prepared worker expired",
          });
        }
        if (current.destroyRequestedAtMs !== null) {
          return finishDestroy(current);
        }
        // Ready/leased rows use their normal state-specific reconciliation. Never
        // replay allocation or enrollment merely to maintain an unused ready node.
        const providerSettlements: Promise<void>[] = [];
        try {
          await reconcileRecord(
            current,
            signal ?? new AbortController().signal,
            (settled) => {
              providerSettlements.push(settled);
            },
            beforeReconcile,
          );
        } finally {
          // A foreground provider timeout does not settle its raw allocation. Keep
          // the reserve concurrency slot and environment lock until that owner exits.
          await Promise.all(providerSettlements);
        }
        return store.get(record.environmentId);
      }),
    destroy,
    identityResolverFor,
    listMachineOptions,
    providerFor,
    reconcileRecord,
  };
}
