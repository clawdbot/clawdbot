import type { DatabaseSync } from "node:sqlite";
import {
  assertOpenClawStateDatabaseOwner,
  resolveDatabasePath,
} from "../state/openclaw-state-db-maintenance.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db-readonly.js";
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
  | {
      kind: "state-error";
      error: unknown;
      knownAgentIds: ReadonlySet<string>;
      ownershipUnknown: boolean;
    }
  | { kind: "uninitialized" };

// Refresh on every runtime config snapshot because another process may mutate Claw provenance.
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
    return {
      kind: "state-error",
      error,
      knownAgentIds: new Set(),
      ownershipUnknown: true,
    };
  }
}

function knownAgentIds(
  snapshot: ClawInstallSchemaVersionSnapshot | undefined,
): ReadonlySet<string> {
  if (snapshot?.kind === "ready") {
    return new Set(snapshot.schemaVersions.keys());
  }
  return snapshot?.kind === "state-error" ? snapshot.knownAgentIds : new Set();
}

function isOwnershipUnknown(snapshot: ClawInstallSchemaVersionSnapshot | undefined): boolean {
  return (
    !snapshot ||
    snapshot.kind === "uninitialized" ||
    (snapshot.kind === "state-error" && snapshot.ownershipUnknown)
  );
}

registerOpenClawStateDatabaseLifecycleListener((event) => {
  const previous = snapshotsByPath.get(event.kind === "opened" ? event.database.path : event.path);
  if (event.kind === "opened") {
    const snapshot = readSchemaVersions(event.database.db);
    snapshotsByPath.set(
      event.database.path,
      snapshot.kind === "state-error"
        ? {
            ...snapshot,
            knownAgentIds: knownAgentIds(previous),
            ownershipUnknown: isOwnershipUnknown(previous),
          }
        : snapshot,
    );
  } else if (event.kind === "open-error") {
    snapshotsByPath.set(event.path, {
      kind: "state-error",
      error: event.error,
      knownAgentIds: knownAgentIds(previous),
      ownershipUnknown: isOwnershipUnknown(previous),
    });
  } else {
    snapshotsByPath.set(event.path, {
      kind: "state-error",
      error: new Error("OpenClaw state database closed before consent provenance verification."),
      knownAgentIds: knownAgentIds(previous),
      ownershipUnknown: isOwnershipUnknown(previous),
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

export function initializeCachedClawInstallSchemaVersions(
  options: OpenClawStateDatabaseOptions = {},
): void {
  const path = resolveSnapshotPath(options);
  const previous = snapshotsByPath.get(path);
  try {
    const snapshot = withExistingOpenClawStateDatabaseReadOnly(({ db, path: pathname }) => {
      assertOpenClawStateDatabaseOwner(db, { pathname });
      return readSchemaVersions(db);
    }, options);
    if (snapshot) {
      snapshotsByPath.set(path, snapshot);
    } else {
      const previousAgentIds = knownAgentIds(previous);
      snapshotsByPath.set(
        path,
        previousAgentIds.size > 0 || (previous !== undefined && isOwnershipUnknown(previous))
          ? {
              kind: "state-error",
              error: new Error(
                "OpenClaw state database disappeared after Claw ownership was observed.",
              ),
              knownAgentIds: previousAgentIds,
              ownershipUnknown: true,
            }
          : { kind: "ready", schemaVersions: new Map() },
      );
    }
  } catch (error) {
    snapshotsByPath.set(path, {
      kind: "state-error",
      error,
      knownAgentIds: knownAgentIds(previous),
      ownershipUnknown: true,
    });
  }
  notifySnapshotListeners();
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
