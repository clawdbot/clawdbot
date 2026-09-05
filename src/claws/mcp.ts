import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { coerceErrorMessage, stableStringify } from "@openclaw/normalization-core";
import type { Selectable } from "kysely";
import { setConfiguredMcpServer } from "../agents/mcp-config-mutation.js";
import { withClawMcpLifecycleLease } from "../agents/mcp-lifecycle-lease.js";
import { canonicalizeConfiguredMcpServer } from "../config/mcp-config-normalize.js";
import { listConfiguredMcpServers } from "../config/mcp-config.js";
import {
  compileSqliteQueryBindings,
  executeSqliteQuerySync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { coerceRequiredSqliteNumber as sqliteNumber } from "../infra/sqlite-number.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import type { ClawReferencedCleanup } from "./package-remove.js";
import type { ClawAddPlan, ClawMcpServer } from "./types.js";

export const CLAW_MCP_REF_SCHEMA_VERSION = "openclaw.clawMcpServerRef.v1" as const;

export type PersistedClawMcpServerRef = {
  schemaVersion: typeof CLAW_MCP_REF_SCHEMA_VERSION;
  agentId: string;
  name: string;
  configDigest: string;
  relationship: "managed" | "referenced";
  origin: "claw-introduced" | "pre-existing";
  independentOwner: boolean;
  status: "pending" | "complete" | "failed";
  error?: string;
  createdAtMs: number;
  updatedAtMs: number;
};

type McpDatabase = Pick<DB, "claw_mcp_server_refs">;
type McpRefRow = Selectable<DB["claw_mcp_server_refs"]>;

function selectMcpRefs(db: DatabaseSync) {
  return getNodeSqliteKysely<McpDatabase>(db)
    .selectFrom("claw_mcp_server_refs")
    .select([
      "schema_version",
      "agent_id",
      "name",
      "config_digest",
      "relationship",
      "origin",
      "independent_owner",
      "status",
      "error",
      "created_at_ms",
      "updated_at_ms",
    ]);
}

function refToRow(ref: PersistedClawMcpServerRef): McpRefRow {
  return {
    agent_id: ref.agentId,
    name: ref.name,
    schema_version: ref.schemaVersion,
    config_digest: ref.configDigest,
    relationship: ref.relationship,
    origin: ref.origin,
    independent_owner: ref.independentOwner ? 1 : 0,
    status: ref.status,
    error: ref.error ?? null,
    created_at_ms: ref.createdAtMs,
    updated_at_ms: ref.updatedAtMs,
  };
}

export class ClawMcpInstallError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly mcpServers: PersistedClawMcpServerRef[],
  ) {
    super(message);
    this.name = "ClawMcpInstallError";
  }
}

function mcpServerFromActionDetails(details: Record<string, unknown>): ClawMcpServer | undefined {
  const { expectedState: _expectedState, prerequisites: _prerequisites, ...server } = details;
  return "command" in server || "url" in server ? (server as ClawMcpServer) : undefined;
}

function rowToRef(row: McpRefRow): PersistedClawMcpServerRef {
  return {
    schemaVersion: CLAW_MCP_REF_SCHEMA_VERSION,
    agentId: row.agent_id,
    name: row.name,
    configDigest: row.config_digest,
    // SAFETY: The canonical table constrains relationship to these two values.
    relationship: row.relationship as PersistedClawMcpServerRef["relationship"],
    // SAFETY: The canonical table constrains origin to these two values.
    origin: row.origin as PersistedClawMcpServerRef["origin"],
    independentOwner: sqliteNumber(row.independent_owner) === 1,
    // SAFETY: Existing inventory exposes stored status without additional validation.
    status: row.status as PersistedClawMcpServerRef["status"],
    ...(row.error ? { error: row.error } : {}),
    createdAtMs: sqliteNumber(row.created_at_ms),
    updatedAtMs: sqliteNumber(row.updated_at_ms),
  };
}

export function digestClawMcpServer(server: Record<string, unknown>): string {
  const canonical = canonicalizeConfiguredMcpServer(server);
  return `sha256:${createHash("sha256").update(stableStringify(canonical)).digest("hex")}`;
}

function persistPendingRef(
  plan: ClawAddPlan,
  name: string,
  server: ClawMcpServer,
  ownership: Pick<PersistedClawMcpServerRef, "relationship" | "origin" | "independentOwner">,
  options: OpenClawStateDatabaseOptions & { nowMs?: number },
): { ref: PersistedClawMcpServerRef; existing: boolean } {
  const nowMs = options.nowMs ?? Date.now();
  const configDigest = digestClawMcpServer(server);
  const database = openOpenClawStateDatabase(options);
  const { compiled, bind } = compileSqliteQueryBindings<{ agentId: string; name: string }>(
    (parameter) =>
      selectMcpRefs(database.db)
        .where(
          "agent_id",
          "=",
          parameter((value) => value.agentId),
        )
        .where(
          "name",
          "=",
          parameter((value) => value.name),
        ),
  );
  const existing =
    database.db /* sqlite-allow-raw: preserve native point-read errors outside the write transaction. */
      .prepare(compiled.sql)
      // SAFETY: The canonical table and explicit projection provide this generated row shape.
      .get(...bind({ agentId: plan.agent.finalId, name })) as McpRefRow | undefined;
  if (existing) {
    const ref = rowToRef(existing);
    if (ref.configDigest !== configDigest || ref.status === "failed") {
      throw new ClawMcpInstallError(
        "mcp_provenance_conflict",
        `MCP server ${JSON.stringify(name)} differs from its ownership record.`,
        [ref],
      );
    }
    return { ref, existing: true };
  }
  const ref: PersistedClawMcpServerRef = {
    schemaVersion: CLAW_MCP_REF_SCHEMA_VERSION,
    agentId: plan.agent.finalId,
    name,
    configDigest,
    ...ownership,
    status: "pending",
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<McpDatabase>(db).insertInto("claw_mcp_server_refs").values(refToRow(ref)),
    );
  }, options);
  return { ref, existing: false };
}

function updateRef(
  ref: PersistedClawMcpServerRef,
  update: { status: PersistedClawMcpServerRef["status"]; error?: string },
  options: OpenClawStateDatabaseOptions & { nowMs?: number },
): PersistedClawMcpServerRef {
  const updated = { ...ref, ...update, updatedAtMs: options.nowMs ?? Date.now() };
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<McpDatabase>(db)
        .updateTable("claw_mcp_server_refs")
        .set({
          status: update.status,
          error: update.error ?? null,
          updated_at_ms: updated.updatedAtMs,
        })
        .where("agent_id", "=", ref.agentId)
        .where("name", "=", ref.name),
    );
  }, options);
  return updated;
}

export async function installClawMcpServers(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions & {
    setMcpServer?: (params: {
      name: string;
      server: ClawMcpServer;
      createOnly?: boolean;
    }) => ReturnType<typeof setConfiguredMcpServer>;
    listMcpServers?: typeof listConfiguredMcpServers;
    nowMs?: number;
  } = {},
): Promise<PersistedClawMcpServerRef[]> {
  const setMcpServer = options.setMcpServer ?? setConfiguredMcpServer;
  const listMcpServers = options.listMcpServers ?? listConfiguredMcpServers;
  const refs: PersistedClawMcpServerRef[] = [];
  for (const action of plan.actions.filter((candidate) => candidate.kind === "mcpServer")) {
    await withClawMcpLifecycleLease(action.id, options, async () => {
      const server = action.details ? mcpServerFromActionDetails(action.details) : undefined;
      if (!server) {
        throw new ClawMcpInstallError(
          "mcp_plan_invalid",
          `MCP server action ${JSON.stringify(action.id)} is invalid.`,
          refs,
        );
      }
      const listed = await listMcpServers();
      if (!listed.ok) {
        throw new ClawMcpInstallError("mcp_preflight_failed", listed.error, refs);
      }
      const configured = listed.mcpServers[action.id];
      const configDigest = digestClawMcpServer(server);
      if (configured && digestClawMcpServer(configured) !== configDigest) {
        throw new ClawMcpInstallError(
          "mcp_config_conflict",
          `MCP server ${JSON.stringify(action.id)} already exists with different configuration.`,
          refs,
        );
      }
      const existingRefs = readClawMcpServerRefsByName(action.id, options);
      const inheritsClawOrigin =
        existingRefs.length > 0 &&
        existingRefs.every(
          (candidate) => candidate.origin === "claw-introduced" && !candidate.independentOwner,
        );
      const ownership = configured
        ? {
            relationship: "referenced" as const,
            origin: inheritsClawOrigin ? ("claw-introduced" as const) : ("pre-existing" as const),
            independentOwner: !inheritsClawOrigin,
          }
        : {
            relationship: "managed" as const,
            origin: "claw-introduced" as const,
            independentOwner: false,
          };
      const pendingResult = persistPendingRef(plan, action.id, server, ownership, options);
      let pending = pendingResult.ref;
      refs.push(pending);
      if (pending.status === "complete") {
        if (configured) {
          return;
        }
        const hasSiblingOwner = readClawMcpServerRefsByName(action.id, options).some(
          (candidate) => candidate.agentId !== plan.agent.finalId,
        );
        if (
          pending.relationship !== "managed" ||
          pending.origin !== "claw-introduced" ||
          pending.independentOwner ||
          hasSiblingOwner
        ) {
          throw new ClawMcpInstallError(
            "mcp_reconcile_conflict",
            `MCP server ${JSON.stringify(action.id)} was removed while shared or independently owned and will not be recreated.`,
            refs,
          );
        }
        pending = updateRef(pending, { status: "pending" }, options);
        refs[refs.length - 1] = pending;
      }
      if (pendingResult.existing && configured) {
        if (digestClawMcpServer(configured) !== pending.configDigest) {
          throw new ClawMcpInstallError(
            "mcp_reconcile_conflict",
            `MCP server ${JSON.stringify(action.id)} changed after an ambiguous write.`,
            refs,
          );
        }
        refs[refs.length - 1] = updateRef(pending, { status: "complete" }, options);
        return;
      }
      if (configured) {
        refs[refs.length - 1] = updateRef(pending, { status: "complete" }, options);
        return;
      }
      let result: Awaited<ReturnType<typeof setConfiguredMcpServer>>;
      try {
        result = await setMcpServer({
          name: action.id,
          server,
          createOnly: true,
          recordIndependentOwner: false,
        });
      } catch (error) {
        const message = coerceErrorMessage(error);
        throw new ClawMcpInstallError("mcp_install_uncertain", message, refs);
      }
      if (!result.ok) {
        refs[refs.length - 1] = updateRef(
          pending,
          { status: "failed", error: result.error },
          options,
        );
        throw new ClawMcpInstallError("mcp_install_failed", result.error, refs);
      }
      try {
        refs[refs.length - 1] = updateRef(pending, { status: "complete" }, options);
      } catch (error) {
        const message = coerceErrorMessage(error);
        throw new ClawMcpInstallError(
          "mcp_provenance_failed",
          `MCP server was configured, but ownership could not be persisted: ${message}`,
          refs,
        );
      }
    });
  }
  return refs;
}

export function readClawMcpServerRefs(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawMcpServerRef[] {
  const { db } = openOpenClawStateDatabase(options);
  if (options.readOnly && !tableExists(db, "claw_mcp_server_refs")) {
    return [];
  }
  const { compiled, bind } = compileSqliteQueryBindings<string>((parameter) =>
    selectMcpRefs(db)
      .where(
        "agent_id",
        "=",
        parameter((value) => value),
      )
      .orderBy("name"),
  );
  const rows =
    db /* sqlite-allow-raw: preserve native full-agent inventory errors without a write transaction. */
      .prepare(compiled.sql)
      // SAFETY: The canonical table and explicit projection provide this generated row shape.
      .all(...bind(agentId)) as McpRefRow[];
  return rows.map(rowToRef);
}

export function readClawMcpServerRefsByName(
  name: string,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawMcpServerRef[] {
  const { db } = openOpenClawStateDatabase(options);
  if (options.readOnly && !tableExists(db, "claw_mcp_server_refs")) {
    return [];
  }
  const { compiled, bind } = compileSqliteQueryBindings<string>((parameter) =>
    selectMcpRefs(db)
      .where(
        "name",
        "=",
        parameter((value) => value),
      )
      .orderBy("agent_id"),
  );
  const rows =
    db /* sqlite-allow-raw: preserve native sibling-inventory errors without a write transaction. */
      .prepare(compiled.sql)
      // SAFETY: The canonical table and explicit projection provide this generated row shape.
      .all(...bind(name)) as McpRefRow[];
  return rows.map(rowToRef);
}

export function clawMcpRemovalSelector(ref: PersistedClawMcpServerRef): string {
  return `mcp:${ref.name}`;
}

type ClawMcpServerRemovalDecision = {
  ref: PersistedClawMcpServerRef;
  action: "remove" | "release";
  blocked: boolean;
  affectedClawAgentIds: string[];
  reason?: string;
};

export function planClawMcpServerRemoval(
  ref: PersistedClawMcpServerRef,
  options: OpenClawStateDatabaseOptions & { referencedCleanup?: ClawReferencedCleanup } = {},
): ClawMcpServerRemovalDecision {
  const otherRefs = readClawMcpServerRefsByName(ref.name, options).filter(
    (candidate) => candidate.agentId !== ref.agentId,
  );
  const affectedClawAgentIds = otherRefs.map((candidate) => candidate.agentId).toSorted();
  const cleanup = options.referencedCleanup ?? { mode: "retain" };
  const explicitlySelected =
    cleanup.mode === "remove-selected" &&
    (cleanup.selected ?? []).includes(clawMcpRemovalSelector(ref));
  const conflicts =
    affectedClawAgentIds.length > 0 || ref.independentOwner || ref.origin === "pre-existing";
  const release = (reason: string, blocked = false): ClawMcpServerRemovalDecision => ({
    ref,
    action: "release",
    blocked,
    affectedClawAgentIds,
    reason,
  });

  if (ref.relationship === "managed") {
    if (explicitlySelected) {
      return release(
        "--remove-referenced only accepts resources with a referenced relationship.",
        true,
      );
    }
    if (affectedClawAgentIds.length > 0) {
      return release("Another Claw still references this MCP server.");
    }
    if (ref.independentOwner) {
      return release("MCP server has a current non-Claw owner.");
    }
    return { ref, action: "remove", blocked: false, affectedClawAgentIds };
  }
  if (!explicitlySelected && cleanup.mode !== "remove-if-unused") {
    return release("Referenced resources are retained unless a cleanup mode selects them.");
  }
  if (!explicitlySelected && conflicts) {
    return release(
      affectedClawAgentIds.length > 0
        ? "Another Claw still references this MCP server."
        : "MCP server has a current non-Claw owner or pre-existing origin.",
    );
  }
  if (explicitlySelected && conflicts && !cleanup.allowConflicts) {
    return release(
      "Selected MCP server has other Claw dependents, a non-Claw owner, or pre-existing origin; explicit conflict override is required.",
      true,
    );
  }
  return { ref, action: "remove", blocked: false, affectedClawAgentIds };
}

export function reconcileClawMcpServerRefs(
  agentId: string,
  configuredServers: Record<string, Record<string, unknown>>,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): PersistedClawMcpServerRef[] {
  return readClawMcpServerRefs(agentId, options).map((ref) => {
    if (ref.status !== "pending") {
      return ref;
    }
    const configured = configuredServers[ref.name];
    return configured && digestClawMcpServer(configured) === ref.configDigest
      ? updateRef(ref, { status: "complete" }, options)
      : ref;
  });
}

export function deleteClawMcpServerRef(
  agentId: string,
  name: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<McpDatabase>(db)
        .deleteFrom("claw_mcp_server_refs")
        .where("agent_id", "=", agentId)
        .where("name", "=", name),
    );
  }, options);
}

export function upsertClawMcpServerRef(
  ref: PersistedClawMcpServerRef,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<McpDatabase>(db)
        .insertInto("claw_mcp_server_refs")
        .values(refToRow(ref))
        .onConflict((conflict) =>
          conflict.columns(["agent_id", "name"]).doUpdateSet((eb) => ({
            schema_version: eb.ref("excluded.schema_version"),
            config_digest: eb.ref("excluded.config_digest"),
            relationship: eb.ref("excluded.relationship"),
            origin: eb.ref("excluded.origin"),
            independent_owner: eb.ref("excluded.independent_owner"),
            status: eb.ref("excluded.status"),
            error: eb.ref("excluded.error"),
            // Existing claims retain their original creation timestamp through updates and undo.
            updated_at_ms: eb.ref("excluded.updated_at_ms"),
          })),
        ),
    );
  }, options);
}
