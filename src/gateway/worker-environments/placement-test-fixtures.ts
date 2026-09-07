import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as StateDatabase } from "../../state/openclaw-state-db.generated.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import type { WorkerEnvironmentRecord } from "./environment-record.js";

type PlacementEnvironmentFixture = Pick<
  WorkerEnvironmentRecord,
  "environmentId" | "state" | "ownerEpoch" | "attachedSessionIds"
> &
  Partial<WorkerEnvironmentRecord>;

// Mock providers still publish the durable ownership read by placement activation.
// Updating a fixture must preserve activation history recorded by the real store.
export function writePlacementEnvironmentFixture(
  database: OpenClawStateDatabase,
  environment: PlacementEnvironmentFixture,
): void {
  const values = {
    environment_id: environment.environmentId,
    provider_id: environment.providerId ?? "fake",
    profile_id: environment.profileId ?? "development",
    profile_snapshot_json: JSON.stringify(environment.profileSnapshot ?? { settings: {} }),
    provision_operation_id:
      environment.provisionOperationId ?? `provision:${environment.environmentId}`,
    lease_id:
      environment.leaseId === undefined
        ? `lease:${environment.environmentId}`
        : environment.leaseId,
    node_setup_id: environment.nodeSetupId ?? null,
    node_device_id: environment.nodeDeviceId ?? null,
    shared_host: environment.sharedHost == null ? null : Number(environment.sharedHost),
    ssh_host: environment.sshEndpoint?.host ?? null,
    ssh_port: environment.sshEndpoint?.port ?? null,
    ssh_user: environment.sshEndpoint?.user ?? null,
    ssh_host_key: environment.sshEndpoint?.hostKey ?? null,
    ssh_key_ref_json: environment.sshEndpoint
      ? JSON.stringify(environment.sshEndpoint.keyRef)
      : null,
    desktop_json: environment.desktop ? JSON.stringify(environment.desktop) : null,
    bootstrap_bundle_hash: environment.bootstrapReceipt?.bundleHash ?? null,
    bootstrap_openclaw_version: environment.bootstrapReceipt?.openclawVersion ?? null,
    bootstrap_protocol_features_json: environment.bootstrapReceipt
      ? JSON.stringify(environment.bootstrapReceipt.protocolFeatures)
      : null,
    bootstrap_install_kind: environment.bootstrapReceipt?.installKind ?? null,
    owner_epoch: environment.ownerEpoch,
    teardown_terminal_state: environment.teardownTerminalState ?? null,
    state: environment.state,
    attached_session_ids_json: JSON.stringify(environment.attachedSessionIds),
    updated_at_ms: environment.updatedAtMs ?? 1_000,
    state_changed_at_ms: environment.stateChangedAtMs ?? 1_000,
    idle_since_at_ms: environment.idleSinceAtMs ?? null,
    destroy_requested_at_ms: environment.destroyRequestedAtMs ?? null,
    last_error: environment.lastError ?? null,
  };
  executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely<Pick<StateDatabase, "worker_environments">>(database.db)
      .insertInto("worker_environments")
      .values({
        ...values,
        created_at_ms: environment.createdAtMs ?? 1_000,
        last_activated_at_ms: null,
        preparation_key: null,
        preparation_demand_at_ms: null,
        preparation_expires_at_ms: null,
        preparation_consumed_at_ms: null,
      })
      .onConflict((oc) =>
        oc.column("environment_id").doUpdateSet({
          state: environment.state,
          owner_epoch: environment.ownerEpoch,
          attached_session_ids_json: JSON.stringify(environment.attachedSessionIds),
          ...(environment.providerId !== undefined ? { provider_id: environment.providerId } : {}),
          ...(environment.profileId !== undefined ? { profile_id: environment.profileId } : {}),
          ...(environment.nodeDeviceId !== undefined
            ? { node_device_id: environment.nodeDeviceId }
            : {}),
        }),
      ),
  );
}

export function seedAttachedPlacementEnvironment(
  database: OpenClawStateDatabase,
  params: {
    environmentId: string;
    sessionId: string;
    ownerEpoch: number;
    providerId?: string;
    profileId?: string;
    nodeDeviceId?: string | null;
  },
): void {
  writePlacementEnvironmentFixture(database, {
    ...params,
    state: "attached",
    attachedSessionIds: [params.sessionId],
  });
}
