import { createHash } from "node:crypto";
import { stableStringify } from "../agents/stable-stringify.js";
import { canonicalizeConfiguredMcpServer } from "../config/mcp-config-normalize.js";
import { listConfiguredMcpServers, setConfiguredMcpServer } from "../config/mcp-config.js";
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

type McpRefRow = {
  schema_version: string;
  agent_id: string;
  name: string;
  config_digest: string;
  relationship: PersistedClawMcpServerRef["relationship"];
  origin: PersistedClawMcpServerRef["origin"];
  independent_owner: number | bigint;
  status: PersistedClawMcpServerRef["status"];
  error: string | null;
  created_at_ms: number | bigint;
  updated_at_ms: number | bigint;
};

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
    relationship: row.relationship,
    origin: row.origin,
    independentOwner: Number(row.independent_owner) === 1,
    status: row.status,
    ...(row.error ? { error: row.error } : {}),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
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
  const existing = database.db /* sqlite-allow-raw: read one Claw MCP ownership row. */
    .prepare(
      `SELECT schema_version, agent_id, name, config_digest, relationship, origin,
              independent_owner, status, error,
              created_at_ms, updated_at_ms
         FROM claw_mcp_server_refs
        WHERE agent_id = ? AND name = ?`,
    )
    .get(plan.agent.finalId, name) as McpRefRow | undefined;
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
    db /* sqlite-allow-raw: persist one pending Claw MCP ownership row. */
      .prepare(
        `INSERT INTO claw_mcp_server_refs (
         agent_id, name, schema_version, config_digest, relationship, origin,
         independent_owner, status, error,
         created_at_ms, updated_at_ms
       ) VALUES (
         @agent_id, @name, @schema_version, @config_digest, @relationship, @origin,
         @independent_owner, @status, NULL,
         @created_at_ms, @updated_at_ms
       )`,
      )
      .run({
        agent_id: ref.agentId,
        name: ref.name,
        schema_version: ref.schemaVersion,
        config_digest: ref.configDigest,
        relationship: ref.relationship,
        origin: ref.origin,
        independent_owner: ref.independentOwner ? 1 : 0,
        status: ref.status,
        created_at_ms: nowMs,
        updated_at_ms: nowMs,
      });
  }, options);
  return { ref, existing: false };
}

function updateRef(
  ref: PersistedClawMcpServerRef,
  update: { status: "complete" | "failed"; error?: string },
  options: OpenClawStateDatabaseOptions & { nowMs?: number },
): PersistedClawMcpServerRef {
  const updated = { ...ref, ...update, updatedAtMs: options.nowMs ?? Date.now() };
  runOpenClawStateWriteTransaction(({ db }) => {
    db /* sqlite-allow-raw: update one Claw MCP ownership row after config write. */
      .prepare(
        `UPDATE claw_mcp_server_refs
          SET status = @status, error = @error, updated_at_ms = @updated_at_ms
        WHERE agent_id = @agent_id AND name = @name`,
      )
      .run({
        agent_id: ref.agentId,
        name: ref.name,
        status: update.status,
        error: update.error ?? null,
        updated_at_ms: updated.updatedAtMs,
      });
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
    const pending = pendingResult.ref;
    refs.push(pending);
    if (pending.status === "complete") {
      continue;
    }
    if (pendingResult.existing) {
      if (configured) {
        if (digestClawMcpServer(configured) !== pending.configDigest) {
          throw new ClawMcpInstallError(
            "mcp_reconcile_conflict",
            `MCP server ${JSON.stringify(action.id)} changed after an ambiguous write.`,
            refs,
          );
        }
        refs[refs.length - 1] = updateRef(pending, { status: "complete" }, options);
        continue;
      }
    }
    if (configured) {
      refs[refs.length - 1] = updateRef(pending, { status: "complete" }, options);
      continue;
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
      const message = error instanceof Error ? error.message : String(error);
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
      const message = error instanceof Error ? error.message : String(error);
      throw new ClawMcpInstallError(
        "mcp_provenance_failed",
        `MCP server was configured, but ownership could not be persisted: ${message}`,
        refs,
      );
    }
  }
  return refs;
}

export function readClawMcpServerRefs(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawMcpServerRef[] {
  const database = openOpenClawStateDatabase(options);
  if (
    options.readOnly &&
    !database.db /* sqlite-allow-raw: read-only Claw MCP table-existence probe. */
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claw_mcp_server_refs'")
      .get()
  ) {
    return [];
  }
  const rows = database.db /* sqlite-allow-raw: read Claw MCP refs for one agent. */
    .prepare(
      `SELECT schema_version, agent_id, name, config_digest, relationship, origin,
              independent_owner, status, error,
              created_at_ms, updated_at_ms
         FROM claw_mcp_server_refs
        WHERE agent_id = ?
        ORDER BY name`,
    )
    .all(agentId) as McpRefRow[];
  return rows.map(rowToRef);
}

export function readClawMcpServerRefsByName(
  name: string,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawMcpServerRef[] {
  const database = openOpenClawStateDatabase(options);
  if (
    options.readOnly &&
    !database.db /* sqlite-allow-raw: read-only Claw MCP table-existence probe. */
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claw_mcp_server_refs'")
      .get()
  ) {
    return [];
  }
  const rows = database.db /* sqlite-allow-raw: read sibling Claw MCP refs by server name. */
    .prepare(
      `SELECT schema_version, agent_id, name, config_digest, relationship, origin,
              independent_owner, status, error,
              created_at_ms, updated_at_ms
         FROM claw_mcp_server_refs
        WHERE name = ?
        ORDER BY agent_id`,
    )
    .all(name) as McpRefRow[];
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
    db /* sqlite-allow-raw: delete one released Claw MCP ownership row. */
      .prepare("DELETE FROM claw_mcp_server_refs WHERE agent_id = ? AND name = ?")
      .run(agentId, name);
  }, options);
}

export function upsertClawMcpServerRef(
  ref: PersistedClawMcpServerRef,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    db /* sqlite-allow-raw: Claw MCP lifecycle provenance write. */
      .prepare(
        `INSERT INTO claw_mcp_server_refs (
         agent_id, name, schema_version, config_digest, relationship, origin,
         independent_owner, status, error,
         created_at_ms, updated_at_ms
       ) VALUES (
         @agent_id, @name, @schema_version, @config_digest, @relationship, @origin,
         @independent_owner, @status, @error,
         @created_at_ms, @updated_at_ms
       )
       ON CONFLICT(agent_id, name) DO UPDATE SET
         schema_version = excluded.schema_version,
         config_digest = excluded.config_digest,
         relationship = excluded.relationship,
         origin = excluded.origin,
         independent_owner = excluded.independent_owner,
         status = excluded.status,
         error = excluded.error,
         updated_at_ms = excluded.updated_at_ms`,
      )
      .run({
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
      });
  }, options);
}
