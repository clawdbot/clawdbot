import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  listMemoryEnterpriseEvidenceTransitionImpactInputsForUserPrincipal,
  type MemoryEnterpriseEvidenceTransition,
} from "./memory-enterprise-identity.js";
import { withOpenClawAgentDatabaseReadOnly } from "./openclaw-agent-db-readonly.js";
import { listOpenClawRegisteredAgentDatabases } from "./openclaw-agent-db-registry.js";
import type { OpenClawStateDatabaseOptions } from "./openclaw-state-db.js";

const SQLITE_IN_VALUES_LIMIT = 900;

type MemoryEnterpriseExposureDatabase = {
  memory_preoutput_exposure_enterprise_memberships: {
    exposure_set_id: string;
    snapshot_id: string;
  };
};

/** A content-free, best-effort report for one immutable evidence transition. */
export type MemoryEnterpriseEvidenceTransitionImpact = Readonly<
  MemoryEnterpriseEvidenceTransition & {
    exposureCount: number;
    complete: boolean;
  }
>;

function chunks<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let offset = 0; offset < values.length; offset += size) {
    result.push(values.slice(offset, offset + size));
  }
  return result;
}

/**
 * Join immutable membership transitions to per-agent pre-output ledgers without
 * returning any durable identifier. A missing or unreadable registered agent
 * database marks the report incomplete instead of producing a false zero.
 */
export function listMemoryEnterpriseEvidenceTransitionImpactsForUserPrincipal(params: {
  userPrincipalId: string;
  providerId?: string;
  limit?: number;
  options?: OpenClawStateDatabaseOptions;
}): readonly MemoryEnterpriseEvidenceTransitionImpact[] {
  const options = params.options ?? {};
  const inputs = listMemoryEnterpriseEvidenceTransitionImpactInputsForUserPrincipal(params);
  if (inputs.length === 0) {
    return Object.freeze([]);
  }

  const transitionIndexesBySnapshotId = new Map<string, number[]>();
  for (const [index, input] of inputs.entries()) {
    for (const snapshotId of input.snapshotIds) {
      const indexes = transitionIndexesBySnapshotId.get(snapshotId) ?? [];
      indexes.push(index);
      transitionIndexesBySnapshotId.set(snapshotId, indexes);
    }
  }
  const exposuresByTransition = inputs.map(() => new Set<string>());
  let complete = true;
  for (const registered of listOpenClawRegisteredAgentDatabases({
    ...options,
    includeIncompatibleSchemaVersions: true,
  })) {
    try {
      const read = withOpenClawAgentDatabaseReadOnly(
        ({ db: database }) => {
          const exposureIds: Array<Readonly<{ exposureSetId: string; snapshotId: string }>> = [];
          const db = getNodeSqliteKysely<MemoryEnterpriseExposureDatabase>(database);
          for (const snapshotIds of chunks(
            [...transitionIndexesBySnapshotId.keys()],
            SQLITE_IN_VALUES_LIMIT,
          )) {
            for (const row of executeSqliteQuerySync(
              database,
              db
                .selectFrom("memory_preoutput_exposure_enterprise_memberships")
                .select(["exposure_set_id", "snapshot_id"])
                .where("snapshot_id", "in", snapshotIds),
            ).rows) {
              exposureIds.push(
                Object.freeze({
                  exposureSetId: row.exposure_set_id,
                  snapshotId: row.snapshot_id,
                }),
              );
            }
          }
          return exposureIds;
        },
        { agentId: registered.agentId, path: registered.path, env: options.env },
      );
      if (!read.found) {
        complete = false;
        continue;
      }
      for (const exposure of read.value) {
        for (const index of transitionIndexesBySnapshotId.get(exposure.snapshotId) ?? []) {
          exposuresByTransition[index]!.add(exposure.exposureSetId);
        }
      }
    } catch {
      complete = false;
    }
  }
  return Object.freeze(
    inputs.map((input, index) =>
      Object.freeze({
        ...input.transition,
        exposureCount: exposuresByTransition[index]!.size,
        complete,
      }),
    ),
  );
}
