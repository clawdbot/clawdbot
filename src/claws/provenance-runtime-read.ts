import type { DatabaseSync } from "node:sqlite";
import { resolveDatabasePath } from "../state/openclaw-state-db-maintenance.js";
import {
  registerOpenClawStateDatabaseLifecycleListener,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { parseClawInstallRecordSchemaVersion } from "./provenance-schema-version.js";

type ClawInstallSchemaVersionRead =
  | {
      kind: "ok";
      schemaVersion: ReturnType<typeof parseClawInstallRecordSchemaVersion>;
      agentConfigDigest: string;
    }
  | { kind: "error"; error: unknown };

type ClawInstallSchemaVersionSnapshot =
  | { kind: "ready"; schemaVersions: Map<string, ClawInstallSchemaVersionRead> }
  | { kind: "state-error"; error: unknown }
  | { kind: "uninitialized" };

// Install provenance is process-stable; only the state lifecycle and Claw mutations refresh it.
const snapshotsByPath = new Map<string, ClawInstallSchemaVersionSnapshot>();
const snapshotListeners = new Set<() => void>();

function notifySnapshotListeners(): void {
  for (const listener of snapshotListeners) {
    listener();
  }
}

function readSchemaVersions(db: DatabaseSync): ClawInstallSchemaVersionSnapshot {
  try {
    const hasInstallTable = db /* sqlite-allow-raw: lifecycle-owned state cache initialization. */
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claw_installs'")
      .get();
    if (!hasInstallTable) {
      return { kind: "ready", schemaVersions: new Map() };
    }
    const rows = db /* sqlite-allow-raw: lifecycle-owned state cache initialization. */
      .prepare("SELECT agent_id, schema_version, agent_config_digest FROM claw_installs")
      .all() as Array<{
      agent_id: string;
      schema_version: string;
      agent_config_digest: string;
    }>;
    const schemaVersions = new Map<string, ClawInstallSchemaVersionRead>();
    for (const row of rows) {
      try {
        schemaVersions.set(row.agent_id, {
          kind: "ok",
          schemaVersion: parseClawInstallRecordSchemaVersion(row.schema_version),
          agentConfigDigest: row.agent_config_digest,
        });
      } catch (error) {
        schemaVersions.set(row.agent_id, { kind: "error", error });
      }
    }
    return {
      kind: "ready",
      schemaVersions,
    };
  } catch (error) {
    return { kind: "state-error", error };
  }
}

registerOpenClawStateDatabaseLifecycleListener((event) => {
  if (event.kind === "opened") {
    snapshotsByPath.set(event.database.path, readSchemaVersions(event.database.db));
  } else if (event.kind === "open-error") {
    snapshotsByPath.set(event.path, { kind: "state-error", error: event.error });
  } else {
    snapshotsByPath.set(event.path, {
      kind: "state-error",
      error: new Error("OpenClaw state database closed before consent provenance verification."),
    });
  }
  notifySnapshotListeners();
});

function resolveSnapshotPath(options: OpenClawStateDatabaseOptions): string {
  return options.database?.path ?? resolveDatabasePath(options);
}

export function readCachedClawInstallSchemaVersions(
  options: OpenClawStateDatabaseOptions = {},
): ClawInstallSchemaVersionSnapshot {
  return snapshotsByPath.get(resolveSnapshotPath(options)) ?? { kind: "uninitialized" };
}

export function registerClawInstallSchemaVersionSnapshotListener(listener: () => void): () => void {
  snapshotListeners.add(listener);
  return () => snapshotListeners.delete(listener);
}

export function cacheClawInstallSchemaVersion(
  agentId: string,
  schemaVersion: ReturnType<typeof parseClawInstallRecordSchemaVersion>,
  agentConfigDigest: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  const snapshot = snapshotsByPath.get(resolveSnapshotPath(options));
  if (snapshot?.kind !== "ready") {
    return;
  }
  snapshot.schemaVersions.set(agentId, { kind: "ok", schemaVersion, agentConfigDigest });
  notifySnapshotListeners();
}

export function deleteCachedClawInstallSchemaVersion(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  const snapshot = snapshotsByPath.get(resolveSnapshotPath(options));
  if (snapshot?.kind !== "ready" || !snapshot.schemaVersions.delete(agentId)) {
    return;
  }
  notifySnapshotListeners();
}
