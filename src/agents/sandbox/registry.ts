/**
 * Persistent sandbox registry storage.
 *
 * Tracks runtime and browser containers in the shared state DB.
 */
import type { Insertable, Selectable, Updateable } from "kysely";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { withExistingOpenClawStateDatabaseReadOnly } from "../../state/openclaw-state-db-readonly.js";
import { tableExists } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import type { SandboxContainerEngineTarget } from "./container-engine.js";

export type SandboxRegistryEntry = {
  containerName: string;
  backendId?: string;
  backendTarget?: SandboxContainerEngineTarget;
  runtimeLabel?: string;
  sessionKey: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  image: string;
  configLabelKind?: string;
  configHash?: string;
};

type SandboxRegistry = {
  entries: SandboxRegistryEntry[];
};

export type SandboxBrowserRegistryEntry = {
  containerName: string;
  sessionKey: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  image: string;
  configHash?: string;
  cdpPort: number;
  noVncPort?: number;
};

type SandboxBrowserRegistry = {
  entries: SandboxBrowserRegistryEntry[];
};

type RegistryEntryPayload = { containerName: string } & Record<string, unknown>;
type SandboxRegistryKind = "container" | "browser";
type SandboxRegistryTable = OpenClawStateKyselyDatabase["sandbox_registry_entries"];
type SandboxRegistryDatabase = Pick<OpenClawStateKyselyDatabase, "sandbox_registry_entries">;
type SandboxRegistryRow = Selectable<SandboxRegistryTable>;
type SandboxRegistryInsert = Insertable<SandboxRegistryTable>;
type SandboxRegistryUpdate = Updateable<SandboxRegistryTable>;

function getSandboxRegistryKysely(db: import("node:sqlite").DatabaseSync) {
  return getNodeSqliteKysely<SandboxRegistryDatabase>(db);
}

function parseRegistryEntryJson(row: SandboxRegistryRow): RegistryEntryPayload | null {
  try {
    const parsed = JSON.parse(row.entry_json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as RegistryEntryPayload)
      : null;
  } catch {
    return null;
  }
}

function optionalPayloadString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rowToContainerEntry(row: SandboxRegistryRow): SandboxRegistryEntry | null {
  if (row.registry_kind !== "container") {
    return null;
  }
  const payload = parseRegistryEntryJson(row);
  if (!payload) {
    return null;
  }
  return normalizeSandboxRegistryEntry({
    ...payload,
    containerName: row.container_name,
    sessionKey: row.session_key ?? optionalPayloadString(payload.sessionKey),
    createdAtMs: row.created_at_ms ?? Number(payload.createdAtMs ?? 0),
    lastUsedAtMs: row.last_used_at_ms ?? Number(payload.lastUsedAtMs ?? 0),
    image: row.image ?? optionalPayloadString(payload.image),
    ...(row.backend_id != null ? { backendId: row.backend_id } : {}),
    ...(row.runtime_label != null ? { runtimeLabel: row.runtime_label } : {}),
    ...(row.config_label_kind != null ? { configLabelKind: row.config_label_kind } : {}),
    ...(row.config_hash != null ? { configHash: row.config_hash } : {}),
  } as SandboxRegistryEntry);
}

function rowToBrowserEntry(row: SandboxRegistryRow): SandboxBrowserRegistryEntry | null {
  if (row.registry_kind !== "browser") {
    return null;
  }
  const payload = parseRegistryEntryJson(row);
  if (!payload) {
    return null;
  }
  return {
    ...payload,
    containerName: row.container_name,
    sessionKey: row.session_key ?? optionalPayloadString(payload.sessionKey),
    createdAtMs: row.created_at_ms ?? Number(payload.createdAtMs ?? 0),
    lastUsedAtMs: row.last_used_at_ms ?? Number(payload.lastUsedAtMs ?? 0),
    image: row.image ?? optionalPayloadString(payload.image),
    cdpPort: row.cdp_port ?? Number(payload.cdpPort ?? 0),
    ...(row.no_vnc_port != null ? { noVncPort: row.no_vnc_port } : {}),
    ...(row.config_hash != null ? { configHash: row.config_hash } : {}),
  } as SandboxBrowserRegistryEntry;
}

function containerEntryToRow(entry: SandboxRegistryEntry, existing?: SandboxRegistryEntry | null) {
  const next: SandboxRegistryEntry = {
    ...entry,
    backendId: entry.backendId ?? existing?.backendId,
    backendTarget: entry.backendTarget ?? existing?.backendTarget,
    runtimeLabel: entry.runtimeLabel ?? existing?.runtimeLabel,
    createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
    image: existing?.image ?? entry.image,
    configLabelKind: entry.configLabelKind ?? existing?.configLabelKind,
    configHash: entry.configHash ?? existing?.configHash,
  };
  return {
    registry_kind: "container",
    container_name: next.containerName,
    session_key: next.sessionKey,
    backend_id: next.backendId ?? null,
    runtime_label: next.runtimeLabel ?? null,
    image: next.image,
    created_at_ms: next.createdAtMs,
    last_used_at_ms: next.lastUsedAtMs,
    config_label_kind: next.configLabelKind ?? null,
    config_hash: next.configHash ?? null,
    cdp_port: null,
    no_vnc_port: null,
    entry_json: JSON.stringify(next),
    updated_at: Date.now(),
  } satisfies SandboxRegistryInsert;
}

function browserEntryToRow(
  entry: SandboxBrowserRegistryEntry,
  existing?: SandboxBrowserRegistryEntry | null,
) {
  const next: SandboxBrowserRegistryEntry = {
    ...entry,
    createdAtMs: existing?.createdAtMs ?? entry.createdAtMs,
    image: existing?.image ?? entry.image,
    configHash: entry.configHash ?? existing?.configHash,
  };
  return {
    registry_kind: "browser",
    container_name: next.containerName,
    session_key: next.sessionKey,
    backend_id: null,
    runtime_label: null,
    image: next.image,
    created_at_ms: next.createdAtMs,
    last_used_at_ms: next.lastUsedAtMs,
    config_label_kind: null,
    config_hash: next.configHash ?? null,
    cdp_port: next.cdpPort,
    no_vnc_port: next.noVncPort ?? null,
    entry_json: JSON.stringify(next),
    updated_at: Date.now(),
  } satisfies SandboxRegistryInsert;
}

function rowToUpdate(row: SandboxRegistryInsert): SandboxRegistryUpdate {
  const { registry_kind: _registryKind, container_name: _containerName, ...update } = row;
  return update;
}

function readRegistryRows(
  kind: SandboxRegistryKind,
  filter?: { backendId: string; scopeKey: string },
): SandboxRegistryRow[] {
  // CLI reads must not join the Gateway's writable SQLite lifecycle (#101290).
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      if (!tableExists(db, "sandbox_registry_entries")) {
        return [];
      }
      const stateDb = getSandboxRegistryKysely(db);
      let query = stateDb
        .selectFrom("sandbox_registry_entries")
        .selectAll()
        .where("registry_kind", "=", kind);
      if (filter) {
        query = query
          .where("session_key", "=", filter.scopeKey)
          .where("backend_id", "=", filter.backendId);
      }
      return executeSqliteQuerySync(
        db,
        filter
          ? query.orderBy("last_used_at_ms", "desc").orderBy("container_name", "asc")
          : query.orderBy("container_name", "asc"),
      ).rows;
    }) ?? []
  );
}

function readRegistryRow(
  kind: SandboxRegistryKind,
  containerName: string,
): SandboxRegistryRow | null {
  // CLI reads must not join the Gateway's writable SQLite lifecycle (#101290).
  return (
    withExistingOpenClawStateDatabaseReadOnly(({ db }) => {
      if (!tableExists(db, "sandbox_registry_entries")) {
        return null;
      }
      const stateDb = getSandboxRegistryKysely(db);
      return (
        executeSqliteQuerySync(
          db,
          stateDb
            .selectFrom("sandbox_registry_entries")
            .selectAll()
            .where("registry_kind", "=", kind)
            .where("container_name", "=", containerName)
            .limit(1),
        ).rows[0] ?? null
      );
    }) ?? null
  );
}

function insertRegistryRowIfMissing(row: SandboxRegistryInsert): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getSandboxRegistryKysely(db);
    executeSqliteQuerySync(
      db,
      stateDb
        .insertInto("sandbox_registry_entries")
        .values(row)
        .onConflict((conflict) =>
          conflict.columns(["registry_kind", "container_name"]).doNothing(),
        ),
    );
  });
}

function insertRegistryRow(
  db: import("node:sqlite").DatabaseSync,
  row: SandboxRegistryInsert,
): void {
  const stateDb = getSandboxRegistryKysely(db);
  executeSqliteQuerySync(
    db,
    stateDb
      .insertInto("sandbox_registry_entries")
      .values(row)
      .onConflict((conflict) =>
        conflict.columns(["registry_kind", "container_name"]).doUpdateSet(rowToUpdate(row)),
      ),
  );
}

function readRegistryRowFromDb(
  db: import("node:sqlite").DatabaseSync,
  kind: SandboxRegistryKind,
  containerName: string,
): SandboxRegistryRow | null {
  const stateDb = getSandboxRegistryKysely(db);
  return (
    executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("sandbox_registry_entries")
        .selectAll()
        .where("registry_kind", "=", kind)
        .where("container_name", "=", containerName)
        .limit(1),
    ).rows[0] ?? null
  );
}

function removeRegistryRow(kind: SandboxRegistryKind, containerName: string): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getSandboxRegistryKysely(db);
    executeSqliteQuerySync(
      db,
      stateDb
        .deleteFrom("sandbox_registry_entries")
        .where("registry_kind", "=", kind)
        .where("container_name", "=", containerName),
    );
  });
}

function normalizeSandboxRegistryEntry(entry: SandboxRegistryEntry): SandboxRegistryEntry {
  return {
    ...entry,
    backendId: entry.backendId?.trim() || "docker",
    runtimeLabel: entry.runtimeLabel?.trim() || entry.containerName,
    configLabelKind: entry.configLabelKind?.trim() || "Image",
  };
}

/** Reads all registered sandbox runtime containers from SQLite. */
export async function readRegistry(): Promise<SandboxRegistry> {
  const entries = readRegistryRows("container")
    .map((row) => rowToContainerEntry(row))
    .filter((entry): entry is SandboxRegistryEntry => entry != null);
  return {
    entries: entries.map((entry) => normalizeSandboxRegistryEntry(entry)),
  };
}

/** Reads one registered sandbox runtime container by container name. */
export async function readRegistryEntry(
  containerName: string,
): Promise<SandboxRegistryEntry | null> {
  const row = readRegistryRow("container", containerName);
  const entry = row ? rowToContainerEntry(row) : null;
  return entry ? normalizeSandboxRegistryEntry(entry) : null;
}

/** Reads registered runtime IDs for one backend-owned sandbox scope, newest first. */
export async function readRegisteredSandboxRuntimeIds(params: {
  backendId: string;
  scopeKey: string;
}): Promise<string[]> {
  return readRegistryRows("container", params)
    .map((row) => rowToContainerEntry(row))
    .filter((entry): entry is SandboxRegistryEntry => entry != null)
    .map((entry) => entry.containerName);
}

/** Inserts one sandbox runtime registry entry without replacing an existing entry. */
export function insertSandboxRegistryEntryIfMissing(entry: SandboxRegistryEntry): void {
  insertRegistryRowIfMissing(containerEntryToRow(entry));
}

/** Creates or updates one sandbox runtime registry entry, preserving immutable creation fields. */
export async function updateRegistry(entry: SandboxRegistryEntry) {
  runOpenClawStateWriteTransaction(({ db }) => {
    const existingRow = readRegistryRowFromDb(db, "container", entry.containerName);
    const existing = existingRow ? rowToContainerEntry(existingRow) : null;
    insertRegistryRow(db, containerEntryToRow(entry, existing));
  });
}

/** Removes one sandbox runtime registry entry by container name. */
export async function removeRegistryEntry(containerName: string) {
  removeRegistryRow("container", containerName);
}

/** Reads all registered browser sandbox containers from SQLite. */
export async function readBrowserRegistry(): Promise<SandboxBrowserRegistry> {
  return {
    entries: readRegistryRows("browser")
      .map((row) => rowToBrowserEntry(row))
      .filter((entry): entry is SandboxBrowserRegistryEntry => entry != null),
  };
}

/** Inserts one browser sandbox registry entry without replacing an existing entry. */
export function insertSandboxBrowserRegistryEntryIfMissing(
  entry: SandboxBrowserRegistryEntry,
): void {
  insertRegistryRowIfMissing(browserEntryToRow(entry));
}

/** Creates or updates one browser sandbox registry entry, preserving immutable creation fields. */
export async function updateBrowserRegistry(entry: SandboxBrowserRegistryEntry) {
  runOpenClawStateWriteTransaction(({ db }) => {
    const existingRow = readRegistryRowFromDb(db, "browser", entry.containerName);
    const existing = existingRow ? rowToBrowserEntry(existingRow) : null;
    insertRegistryRow(db, browserEntryToRow(entry, existing));
  });
}

/** Removes one browser sandbox registry entry by container name. */
export async function removeBrowserRegistryEntry(containerName: string) {
  removeRegistryRow("browser", containerName);
}
