import type { WorkerProfile, WorkerProvider } from "../../plugins/types.js";
import { STALE_WORKER_BUILD_REASON, verifyWorkerAdmissionHandshake } from "./admission.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import type { WorkerCredentialBroker } from "./credential-broker.js";
import { requireWorkerLeaseStatus } from "./service-validation.js";
import type { WorkerEnvironmentState } from "./state.js";
import type {
  WorkerEnvironmentRecord,
  WorkerEnvironmentStore,
  WorkerEnvironmentTransitionPatch,
} from "./store.js";
import type { WorkerTunnelManager } from "./tunnel.js";

const ORPHANED_LEASE_ERROR = "Worker provider no longer recognizes the lease";

type WorkerProviderReconciliationOptions = {
  store: WorkerEnvironmentStore;
  prepareInstallation: (
    install: WorkerInstallationArtifact["install"],
  ) => Promise<WorkerInstallationArtifact>;
  ensurePendingCredential: WorkerCredentialBroker["ensurePendingCredential"];
  providerFor: (providerId: string) => WorkerProvider;
  resumeProvision: (
    record: WorkerEnvironmentRecord,
    provider?: WorkerProvider,
  ) => Promise<WorkerEnvironmentRecord>;
  finishDestroy: (
    record: WorkerEnvironmentRecord,
    provider?: WorkerProvider,
  ) => Promise<WorkerEnvironmentRecord>;
  cancelRequested: (record: WorkerEnvironmentRecord) => WorkerEnvironmentRecord;
  callProvider: <T>(environmentId: string, run: () => Promise<T>) => Promise<T>;
  lifecycleLease: (
    record: WorkerEnvironmentRecord,
    leaseId: string,
  ) => {
    leaseId: string;
    profile: WorkerProfile;
  };
  beginDrain: (record: WorkerEnvironmentRecord) => WorkerEnvironmentRecord;
  finishProvenDestroy: (record: WorkerEnvironmentRecord) => Promise<WorkerEnvironmentRecord>;
  saveError: (record: WorkerEnvironmentRecord, error: unknown) => WorkerEnvironmentRecord;
  move: (
    record: WorkerEnvironmentRecord,
    to: WorkerEnvironmentState,
    patch?: WorkerEnvironmentTransitionPatch,
  ) => WorkerEnvironmentRecord;
  inState: (record: WorkerEnvironmentRecord, ...states: WorkerEnvironmentState[]) => boolean;
  tunnels?: Pick<WorkerTunnelManager, "stop">;
  failBootstrap: (
    record: WorkerEnvironmentRecord,
    leaseId: string,
    provider: WorkerProvider,
    error: unknown,
  ) => Promise<never>;
  installFor: (record: WorkerEnvironmentRecord) => WorkerInstallationArtifact["install"];
  finishBootstrap: (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
    installation: WorkerInstallationArtifact,
  ) => Promise<WorkerEnvironmentRecord>;
};

export function createWorkerProviderReconciler(options: WorkerProviderReconciliationOptions) {
  const recordStaleBuildDestroy = (record: WorkerEnvironmentRecord) => {
    // Attached sessions need the build cause after teardown so placement reconciliation can
    // persist an actionable terminal reason instead of inferring from destroyed environment state.
    return record.state === "attached"
      ? options.store.requestDestroy({
          environmentId: record.environmentId,
          state: record.state,
          terminalState: "failed",
          lastError: STALE_WORKER_BUILD_REASON,
        })
      : record;
  };

  return async (initialRecord: WorkerEnvironmentRecord): Promise<void> => {
    let record = initialRecord;
    if (record.state === "requested" && record.destroyRequestedAtMs !== null) {
      return void options.cancelRequested(record);
    }
    let currentBundle: WorkerInstallationArtifact | undefined;
    if (
      record.destroyRequestedAtMs === null &&
      options.inState(record, "ready", "idle", "attached")
    ) {
      try {
        currentBundle = await options.prepareInstallation("bundle");
        if (
          record.bootstrapReceipt &&
          verifyWorkerAdmissionHandshake(record.bootstrapReceipt, currentBundle)
        ) {
          const sessionId = record.state === "attached" ? record.attachedSessionIds[0] : null;
          if (record.state !== "attached" || sessionId) {
            options.ensurePendingCredential(record, sessionId ?? null);
            record = options.store.get(record.environmentId) ?? record;
          }
        }
      } catch {
        // Provider inspection and the state-specific path below retain their existing retry policy.
      }
    }
    let provider: WorkerProvider;
    try {
      provider = options.providerFor(record.providerId);
    } catch (error) {
      options.saveError(record, error);
      return;
    }
    const leaseId = record.leaseId;
    if (!leaseId) {
      const provisioned = await options.resumeProvision(record, provider).catch(() => undefined);
      if (provisioned?.leaseId && provisioned.destroyRequestedAtMs !== null) {
        await options.finishDestroy(provisioned, provider).catch(() => undefined);
      }
      return;
    }
    const inspection = await options
      .callProvider(record.environmentId, () =>
        provider.inspect(options.lifecycleLease(record, leaseId)),
      )
      .then(requireWorkerLeaseStatus)
      .catch((error: unknown) => {
        options.saveError(record, error);
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
          ? options.store.requestDestroy({
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
      const draining = options.beginDrain(requested);
      await options.tunnels?.stop(record.environmentId);
      await options.finishProvenDestroy(draining).catch((error: unknown) => {
        options.saveError(draining, error);
      });
      return;
    }
    if (status === "unknown") {
      const draining =
        record.state === "draining"
          ? record
          : options.move(record, "draining", { lastError: ORPHANED_LEASE_ERROR });
      await options.tunnels?.stop(record.environmentId);
      options.move(draining, "orphaned", { lastError: ORPHANED_LEASE_ERROR });
      return;
    }
    if (status === "dormant") {
      if (teardownExpected) {
        await options.finishDestroy(record, provider).catch(() => undefined);
      }
      // A paired device may be offline without losing its lease. Keep that authoritative
      // holding state out of the unknown/orphan path until pairing itself is removed.
      return;
    }
    const inspectedSharedHost = inspection.sharedHost === true;
    if (record.sharedHost !== null && record.sharedHost !== inspectedSharedHost) {
      // Workspace actions capture isolation at tunnel creation. Fence the old actions before
      // committing a provider-owned change so no reconciliation can use stale host scope.
      await options.tunnels?.stop(record.environmentId);
    }
    record = options.store.reconcileSharedHost({
      environmentId: record.environmentId,
      state: record.state,
      leaseId,
      sharedHost: inspectedSharedHost,
    });
    if (record.destroyRequestedAtMs !== null) {
      await options.finishDestroy(record, provider).catch(() => undefined);
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
        await options
          .finishDestroy(recordStaleBuildDestroy(record), provider)
          .catch(() => undefined);
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
        await options
          .finishDestroy(recordStaleBuildDestroy(record), provider)
          .catch(() => undefined);
      }
      return;
    }
    if (record.state === "draining" && record.destroyRequestedAtMs === null) {
      // Draining without destroy intent is durable provider-loss cleanup.
      await options.tunnels?.stop(record.environmentId);
      options.move(record, "orphaned", {
        lastError: record.lastError ?? ORPHANED_LEASE_ERROR,
      });
      return;
    }
    if (options.inState(record, "bootstrapping", "ready", "idle")) {
      let installation = currentBundle;
      try {
        // Bundle identity is local and canonical for both install channels. A matching admitted
        // receipt must not depend on npm registry availability during routine reconciliation.
        installation ??= await options.prepareInstallation("bundle");
      } catch (error) {
        if (record.bootstrapReceipt && options.inState(record, "ready", "idle")) {
          options.saveError(record, error);
          return;
        }
        await options.failBootstrap(record, leaseId, provider, error).catch(() => undefined);
        return;
      }
      if (
        record.bootstrapReceipt &&
        verifyWorkerAdmissionHandshake(record.bootstrapReceipt, installation)
      ) {
        options.ensurePendingCredential(record, null);
        return;
      }
      if (options.installFor(record) === "npm") {
        try {
          installation = await options.prepareInstallation("npm");
        } catch (error) {
          await options.failBootstrap(record, leaseId, provider, error).catch(() => undefined);
          return;
        }
      }
      const bootstrapping =
        record.state === "bootstrapping" ? record : options.move(record, "bootstrapping");
      await options.tunnels?.stop(record.environmentId, record.ownerEpoch);
      await options.finishBootstrap(bootstrapping, provider, installation).catch(() => undefined);
      return;
    }
    if (options.inState(record, "draining", "destroying")) {
      await options.finishDestroy(record, provider).catch(() => undefined);
    }
  };
}
