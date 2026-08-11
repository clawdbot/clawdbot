// Canonical SQLite row helpers for exec approval policy state.
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { normalizeAgentId } from "../routing/session-key.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { sha256Hex } from "./crypto-digest.js";
import {
  normalizeExecApprovalsInternal,
  tryParsePersistedExecApprovals,
} from "./exec-approvals-config.js";
import type { ExecApprovalsFile, ExecApprovalsSnapshot } from "./exec-approvals-core.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";

const EXEC_APPROVALS_CONFIG_KEY = "current";

type ExecApprovalsDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "agent_deletion_journal" | "exec_approvals_config"
>;

export type ExecApprovalsMutationAuthority = {
  action: "remove" | "restore";
  agentId: string;
  operationId: string;
};

export class ExecApprovalsMutationFencedError extends Error {
  constructor() {
    super("Exec approvals cannot be changed while agent deletion is in progress; retry.");
    this.name = "ExecApprovalsMutationFencedError";
  }
}

export function assertExecApprovalsMutationAuthority(
  db: DatabaseSync,
  authority: ExecApprovalsMutationAuthority,
): void {
  const journal = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<ExecApprovalsDatabase>(db)
      .selectFrom("agent_deletion_journal")
      .select("operation_id")
      .where("agent_id", "=", normalizeAgentId(authority.agentId)),
  );
  if (journal?.operation_id !== authority.operationId) {
    throw new ExecApprovalsMutationFencedError();
  }
}

export function assertExecApprovalsMutationAllowed(params: {
  db: DatabaseSync;
  current: ExecApprovalsFile;
  next: ExecApprovalsFile;
  authority?: ExecApprovalsMutationAuthority;
}): void {
  const current = normalizeExecApprovalsInternal(params.current);
  const next = normalizeExecApprovalsInternal(params.next);
  const agentIds = new Set([
    ...Object.keys(current.agents ?? {}),
    ...Object.keys(next.agents ?? {}),
  ]);
  const state = getNodeSqliteKysely<ExecApprovalsDatabase>(params.db);
  for (const agentId of agentIds) {
    const currentPolicy = current.agents?.[agentId];
    const nextPolicy = next.agents?.[agentId];
    if (isDeepStrictEqual(currentPolicy, nextPolicy)) {
      continue;
    }
    const normalizedAgentId = normalizeAgentId(agentId);
    const journal = executeSqliteQueryTakeFirstSync(
      params.db,
      state
        .selectFrom("agent_deletion_journal")
        .select("operation_id")
        .where("agent_id", "=", normalizedAgentId),
    );
    if (!journal) {
      continue;
    }
    const authority = params.authority;
    const authorizedRemoval = currentPolicy !== undefined && nextPolicy === undefined;
    const authorizedRestore = currentPolicy === undefined && nextPolicy !== undefined;
    if (
      authority?.agentId === normalizedAgentId &&
      authority.operationId === journal.operation_id &&
      ((authority.action === "remove" && authorizedRemoval) ||
        (authority.action === "restore" && authorizedRestore))
    ) {
      continue;
    }
    throw new ExecApprovalsMutationFencedError();
  }
}

type ExecApprovalsConfigRow = {
  raw_json: string;
};

function hashExecApprovalsRaw(raw: string | null): string {
  return raw === null ? `missing:${sha256Hex("")}` : sha256Hex(raw);
}

export function serializeExecApprovals(file: ExecApprovalsFile): string {
  return `${JSON.stringify(file, null, 2)}\n`;
}

export function readExecApprovalsConfigRow(db: DatabaseSync): ExecApprovalsConfigRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<ExecApprovalsDatabase>(db)
      .selectFrom("exec_approvals_config")
      .select("raw_json")
      .where("config_key", "=", EXEC_APPROVALS_CONFIG_KEY),
  );
}

export function snapshotFromExecApprovalsRow(params: {
  path: string;
  row?: ExecApprovalsConfigRow;
  onMalformed?: () => void;
}): ExecApprovalsSnapshot {
  const raw = params.row?.raw_json ?? null;
  if (raw === null) {
    return {
      path: params.path,
      exists: false,
      raw: null,
      file: normalizeExecApprovalsInternal({ version: 1, agents: {} }),
      hash: hashExecApprovalsRaw(null),
    };
  }
  const parsed = tryParsePersistedExecApprovals(raw);
  if (!parsed) {
    params.onMalformed?.();
  }
  return {
    path: params.path,
    exists: true,
    raw,
    file:
      parsed ??
      normalizeExecApprovalsInternal({
        version: 1,
        defaults: {
          security: "deny",
          ask: "off",
          askFallback: "deny",
          autoAllowSkills: false,
        },
        agents: {},
      }),
    hash: hashExecApprovalsRaw(raw),
  };
}

export function projectionValues(file: ExecApprovalsFile) {
  const normalized = normalizeExecApprovalsInternal(file);
  const agents = Object.values(normalized.agents ?? {});
  return {
    socket_path: normalized.socket?.path ?? null,
    has_socket_token: normalized.socket?.token ? 1 : 0,
    default_security: normalized.defaults?.security ?? null,
    default_ask: normalized.defaults?.ask ?? null,
    default_ask_fallback: normalized.defaults?.askFallback ?? null,
    auto_allow_skills:
      normalized.defaults?.autoAllowSkills === undefined
        ? null
        : normalized.defaults.autoAllowSkills
          ? 1
          : 0,
    agent_count: agents.length,
    allowlist_count: agents.reduce((total, agent) => total + (agent.allowlist?.length ?? 0), 0),
  };
}

export function writeExecApprovalsConfigRow(params: {
  db: DatabaseSync;
  file: ExecApprovalsFile;
  raw?: string;
  now?: number;
}): void {
  const raw = params.raw ?? serializeExecApprovals(params.file);
  const values = {
    config_key: EXEC_APPROVALS_CONFIG_KEY,
    raw_json: raw,
    ...projectionValues(params.file),
    updated_at_ms: params.now ?? Date.now(),
  };
  executeSqliteQuerySync(
    params.db,
    getNodeSqliteKysely<ExecApprovalsDatabase>(params.db)
      .insertInto("exec_approvals_config")
      .values(values)
      .onConflict((conflict) =>
        conflict.column("config_key").doUpdateSet({
          raw_json: values.raw_json,
          socket_path: values.socket_path,
          has_socket_token: values.has_socket_token,
          default_security: values.default_security,
          default_ask: values.default_ask,
          default_ask_fallback: values.default_ask_fallback,
          auto_allow_skills: values.auto_allow_skills,
          agent_count: values.agent_count,
          allowlist_count: values.allowlist_count,
          updated_at_ms: values.updated_at_ms,
        }),
      ),
  );
}

export function deleteExecApprovalsConfigRow(db: DatabaseSync): void {
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<ExecApprovalsDatabase>(db)
      .deleteFrom("exec_approvals_config")
      .where("config_key", "=", EXEC_APPROVALS_CONFIG_KEY),
  );
}
