import type { WorkerProvider } from "../../plugins/types.js";
import { STALE_WORKER_BUILD_REASON } from "./admission.js";
import { resolveWorkerLeaseTransportError } from "./service-validation.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";

export function requestStaleWorkerDestroy(
  record: WorkerEnvironmentRecord,
  store: WorkerEnvironmentStore,
): WorkerEnvironmentRecord {
  // Preserve the stale-build cause after teardown so placement recovery remains actionable.
  return record.state === "attached"
    ? store.requestDestroy({
        environmentId: record.environmentId,
        state: record.state,
        terminalState: "failed",
        lastError: STALE_WORKER_BUILD_REASON,
      })
    : record;
}

export async function retireMismatchedWorkerLease(
  record: WorkerEnvironmentRecord,
  provider: WorkerProvider,
  store: WorkerEnvironmentStore,
  finishDestroy: (
    record: WorkerEnvironmentRecord,
    provider: WorkerProvider,
  ) => Promise<WorkerEnvironmentRecord>,
): Promise<boolean> {
  const transport = record.nodeDeviceId ? "node" : record.sshEndpoint ? "ssh" : undefined;
  const modeError = transport
    ? resolveWorkerLeaseTransportError(provider, transport, record.profileSnapshot.executionMode)
    : undefined;
  if (!modeError || record.destroyRequestedAtMs !== null) {
    return false;
  }

  const requested = store.requestDestroy({
    environmentId: record.environmentId,
    state: record.state,
    terminalState: "failed",
    lastError: modeError.message,
  });
  await finishDestroy(requested, provider).catch(() => undefined);
  return true;
}
