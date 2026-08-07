import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import {
  CLAW_SETUP_SECRET_REJECTION_MESSAGE,
  containsSensitiveClawSetupValue,
  isSensitiveClawSetupField,
} from "./setup-secret-validation.js";
import type { ClawSetupMaterialization } from "./setup.js";
import type { ClawAddPlan } from "./types.js";

export const CLAW_SETUP_STATE_SCHEMA_VERSION = "openclaw.clawSetupState.v1" as const;

export type PersistedClawSetupAnswer = ClawSetupMaterialization["answers"][number];

export type PersistedClawSetupSeed = {
  source: string;
  destination: string;
  inputIds: string[];
  renderedDigest: string;
  status: "pending" | "complete";
  createdAtMs?: number;
};

export type PersistedClawSetupState = {
  schemaVersion: typeof CLAW_SETUP_STATE_SCHEMA_VERSION;
  agentId: string;
  clawName: string;
  clawVersion: string;
  setupSchemaDigest: string;
  answerDigest: string;
  answers: PersistedClawSetupAnswer[];
  seeds: PersistedClawSetupSeed[];
  status: "pending" | "complete" | "partial";
  appliedAtMs?: number;
  updatedAtMs: number;
};

export type ClawSetupTargetState = Pick<
  PersistedClawSetupState,
  "clawName" | "clawVersion" | "setupSchemaDigest" | "answerDigest" | "answers" | "seeds"
>;

export type PersistedClawSetupPending = ClawSetupTargetState & {
  schemaVersion: typeof CLAW_SETUP_STATE_SCHEMA_VERSION;
  agentId: string;
  status: "pending" | "partial";
  updatedAtMs: number;
};

type SetupStateRow = {
  agent_id: string;
  record_version: string;
  claw_name: string;
  claw_version: string;
  setup_schema_digest: string;
  answer_digest: string;
  answers_json: string;
  seeds_json: string;
  status: PersistedClawSetupState["status"];
  applied_at_ms: number | bigint | null;
  updated_at_ms: number | bigint;
};

type SetupPendingRow = Omit<SetupStateRow, "status" | "applied_at_ms"> & {
  status: PersistedClawSetupPending["status"];
};

const CLAW_SETUP_STATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS claw_setup_state (
  agent_id TEXT NOT NULL PRIMARY KEY,
  record_version TEXT NOT NULL,
  claw_name TEXT NOT NULL,
  claw_version TEXT NOT NULL,
  setup_schema_digest TEXT NOT NULL,
  answer_digest TEXT NOT NULL,
  answers_json TEXT NOT NULL,
  seeds_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'partial')),
  applied_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL
) STRICT;`;

const CLAW_SETUP_PENDING_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS claw_setup_pending (
  agent_id TEXT NOT NULL PRIMARY KEY,
  record_version TEXT NOT NULL,
  claw_name TEXT NOT NULL,
  claw_version TEXT NOT NULL,
  setup_schema_digest TEXT NOT NULL,
  answer_digest TEXT NOT NULL,
  answers_json TEXT NOT NULL,
  seeds_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'partial')),
  updated_at_ms INTEGER NOT NULL
) STRICT;`;

function tableExists(options: OpenClawStateDatabaseOptions): boolean {
  const database = openOpenClawStateDatabase(options);
  return Boolean(
    database.db /* sqlite-allow-raw: probe one feature-local setup state table. */
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claw_setup_state'")
      .get(),
  );
}

function ensureTable(options: OpenClawStateDatabaseOptions): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    db.exec(CLAW_SETUP_STATE_TABLE_SQL);
    db.exec(CLAW_SETUP_PENDING_TABLE_SQL);
  }, options);
}

function parseJsonArray(value: string, label: string): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Claw setup ${label} state is not valid JSON.`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Claw setup ${label} state is invalid.`);
  }
  return parsed;
}

function parseAnswers(value: string, label = "answer"): PersistedClawSetupAnswer[] {
  return parseJsonArray(value, label).map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("id" in entry) ||
      typeof entry.id !== "string" ||
      !("source" in entry) ||
      (entry.source !== "explicit" && entry.source !== "default") ||
      !("value" in entry) ||
      !(
        typeof entry.value === "string" ||
        typeof entry.value === "number" ||
        typeof entry.value === "boolean" ||
        (Array.isArray(entry.value) && entry.value.every((item) => typeof item === "string"))
      )
    ) {
      throw new Error(`Claw setup ${label} state is invalid.`);
    }
    return entry as PersistedClawSetupAnswer;
  });
}

function parseSeeds(value: string, label = "seed"): PersistedClawSetupSeed[] {
  return parseJsonArray(value, label).map((entry) => {
    if (
      !entry ||
      typeof entry !== "object" ||
      !("source" in entry) ||
      typeof entry.source !== "string" ||
      !("destination" in entry) ||
      typeof entry.destination !== "string" ||
      !("inputIds" in entry) ||
      !Array.isArray(entry.inputIds) ||
      !entry.inputIds.every((item) => typeof item === "string") ||
      !("renderedDigest" in entry) ||
      typeof entry.renderedDigest !== "string" ||
      !("status" in entry) ||
      (entry.status !== "pending" && entry.status !== "complete") ||
      ("createdAtMs" in entry &&
        entry.createdAtMs !== undefined &&
        (typeof entry.createdAtMs !== "number" || !Number.isSafeInteger(entry.createdAtMs)))
    ) {
      throw new Error(`Claw setup ${label} state is invalid.`);
    }
    return entry as PersistedClawSetupSeed;
  });
}

function rowToState(row: SetupStateRow): PersistedClawSetupState {
  if (
    row.record_version !== CLAW_SETUP_STATE_SCHEMA_VERSION ||
    (row.status !== "pending" && row.status !== "complete" && row.status !== "partial")
  ) {
    throw new Error(`Claw setup state for agent ${JSON.stringify(row.agent_id)} is unsupported.`);
  }
  return {
    schemaVersion: CLAW_SETUP_STATE_SCHEMA_VERSION,
    agentId: row.agent_id,
    clawName: row.claw_name,
    clawVersion: row.claw_version,
    setupSchemaDigest: row.setup_schema_digest,
    answerDigest: row.answer_digest,
    answers: parseAnswers(row.answers_json),
    seeds: parseSeeds(row.seeds_json),
    status: row.status,
    ...(row.applied_at_ms === null ? {} : { appliedAtMs: Number(row.applied_at_ms) }),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function readStateInDatabase(
  agentId: string,
  db: ReturnType<typeof openOpenClawStateDatabase>["db"],
): PersistedClawSetupState | undefined {
  const row = db /* sqlite-allow-raw: read one setup state row by closed agent id. */
    .prepare(
      `SELECT agent_id, record_version, claw_name, claw_version, setup_schema_digest,
              answer_digest, answers_json, seeds_json, status, applied_at_ms, updated_at_ms
         FROM claw_setup_state
        WHERE agent_id = ?`,
    )
    .get(agentId) as SetupStateRow | undefined;
  return row ? rowToState(row) : undefined;
}

function rowToPending(row: SetupPendingRow): PersistedClawSetupPending {
  if (
    row.record_version !== CLAW_SETUP_STATE_SCHEMA_VERSION ||
    (row.status !== "pending" && row.status !== "partial")
  ) {
    throw new Error(
      `Pending Claw setup state for agent ${JSON.stringify(row.agent_id)} is unsupported.`,
    );
  }
  return {
    schemaVersion: CLAW_SETUP_STATE_SCHEMA_VERSION,
    agentId: row.agent_id,
    clawName: row.claw_name,
    clawVersion: row.claw_version,
    setupSchemaDigest: row.setup_schema_digest,
    answerDigest: row.answer_digest,
    answers: parseAnswers(row.answers_json, "pending answer"),
    seeds: parseSeeds(row.seeds_json, "pending seed"),
    status: row.status,
    updatedAtMs: Number(row.updated_at_ms),
  };
}

function readPendingInDatabase(
  agentId: string,
  db: ReturnType<typeof openOpenClawStateDatabase>["db"],
): PersistedClawSetupPending | undefined {
  const row = db /* sqlite-allow-raw: read one pending setup reconciliation by agent id. */
    .prepare(
      `SELECT agent_id, record_version, claw_name, claw_version, setup_schema_digest,
              answer_digest, answers_json, seeds_json, status, updated_at_ms
         FROM claw_setup_pending
        WHERE agent_id = ?`,
    )
    .get(agentId) as SetupPendingRow | undefined;
  return row ? rowToPending(row) : undefined;
}

export function readClawSetupState(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawSetupState | undefined {
  if (!tableExists(options)) {
    return undefined;
  }
  return readStateInDatabase(agentId, openOpenClawStateDatabase(options).db);
}

export function readClawSetupStates(
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawSetupState[] {
  if (!tableExists(options)) {
    return [];
  }
  const rows = openOpenClawStateDatabase(options)
    .db /* sqlite-allow-raw: read bounded setup state inventory. */
    .prepare(
      `SELECT agent_id, record_version, claw_name, claw_version, setup_schema_digest,
              answer_digest, answers_json, seeds_json, status, applied_at_ms, updated_at_ms
         FROM claw_setup_state
        ORDER BY agent_id`,
    )
    .all() as SetupStateRow[];
  return rows.map(rowToState);
}

export function readClawSetupPending(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): PersistedClawSetupPending | undefined {
  if (!tableExists(options)) {
    return undefined;
  }
  const database = openOpenClawStateDatabase(options);
  const pendingExists = Boolean(
    database.db /* sqlite-allow-raw: probe the feature-local pending setup table. */
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'claw_setup_pending'")
      .get(),
  );
  return pendingExists ? readPendingInDatabase(agentId, database.db) : undefined;
}

function assertSafeClawSetupAnswers(answers: readonly PersistedClawSetupAnswer[]): void {
  if (
    answers.some(
      (answer) =>
        isSensitiveClawSetupField({ id: answer.id }) ||
        containsSensitiveClawSetupValue(answer.value),
    )
  ) {
    throw new Error(CLAW_SETUP_SECRET_REJECTION_MESSAGE);
  }
}

function samePendingTarget(
  pending: PersistedClawSetupPending,
  target: ClawSetupTargetState,
): boolean {
  return (
    pending.clawName === target.clawName &&
    pending.clawVersion === target.clawVersion &&
    pending.setupSchemaDigest === target.setupSchemaDigest &&
    pending.answerDigest === target.answerDigest
  );
}

export function beginClawSetupUpdate(
  agentId: string,
  target: ClawSetupTargetState,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): PersistedClawSetupPending {
  assertSafeClawSetupAnswers(target.answers);
  ensureTable(options);
  const nowMs = options.nowMs ?? Date.now();
  return runOpenClawStateWriteTransaction(({ db }) => {
    const existing = readPendingInDatabase(agentId, db);
    if (existing) {
      if (!samePendingTarget(existing, target)) {
        throw new Error("A different Claw setup update is already pending.");
      }
      return existing;
    }
    const pending: PersistedClawSetupPending = {
      schemaVersion: CLAW_SETUP_STATE_SCHEMA_VERSION,
      agentId,
      ...target,
      status: "pending",
      updatedAtMs: nowMs,
    };
    db /* sqlite-allow-raw: persist one recoverable setup update intent. */
      .prepare(
        `INSERT INTO claw_setup_pending (
           agent_id, record_version, claw_name, claw_version, setup_schema_digest,
           answer_digest, answers_json, seeds_json, status, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        pending.agentId,
        pending.schemaVersion,
        pending.clawName,
        pending.clawVersion,
        pending.setupSchemaDigest,
        pending.answerDigest,
        JSON.stringify(pending.answers),
        JSON.stringify(pending.seeds),
        pending.status,
        pending.updatedAtMs,
      );
    return pending;
  }, options);
}

export function markClawSetupUpdateSeedComplete(
  agentId: string,
  destination: string,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): PersistedClawSetupPending {
  const nowMs = options.nowMs ?? Date.now();
  return runOpenClawStateWriteTransaction(({ db }) => {
    const pending = readPendingInDatabase(agentId, db);
    if (!pending) {
      throw new Error("Pending Claw setup update disappeared during seed creation.");
    }
    const seed = pending.seeds.find((candidate) => candidate.destination === destination);
    if (!seed) {
      throw new Error(`Pending Claw setup seed ${JSON.stringify(destination)} is not recorded.`);
    }
    seed.status = "complete";
    seed.createdAtMs ??= nowMs;
    pending.updatedAtMs = nowMs;
    const result = db /* sqlite-allow-raw: compare-and-swap a pending update seed handoff. */
      .prepare(
        `UPDATE claw_setup_pending SET seeds_json = ?, updated_at_ms = ?
          WHERE agent_id = ? AND setup_schema_digest = ? AND answer_digest = ?`,
      )
      .run(
        JSON.stringify(pending.seeds),
        nowMs,
        pending.agentId,
        pending.setupSchemaDigest,
        pending.answerDigest,
      );
    if (Number(result.changes) !== 1) {
      throw new Error("Pending Claw setup state changed while recording seed handoff.");
    }
    return pending;
  }, options);
}

export function markClawSetupUpdatePartial(
  agentId: string,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): void {
  const nowMs = options.nowMs ?? Date.now();
  runOpenClawStateWriteTransaction(({ db }) => {
    db /* sqlite-allow-raw: retain an interrupted setup update for explicit recovery. */
      .prepare(
        "UPDATE claw_setup_pending SET status = 'partial', updated_at_ms = ? WHERE agent_id = ?",
      )
      .run(nowMs, agentId);
  }, options);
}

export function finalizeClawSetupUpdate(
  agentId: string,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): PersistedClawSetupState {
  const nowMs = options.nowMs ?? Date.now();
  return runOpenClawStateWriteTransaction(({ db }) => {
    const pending = readPendingInDatabase(agentId, db);
    if (!pending || pending.seeds.some((seed) => seed.status !== "complete")) {
      throw new Error(
        "Claw setup update cannot complete before every new seed handoff is recorded.",
      );
    }
    const install =
      db /* sqlite-allow-raw: verify root update identity before setup-state commit. */
        .prepare("SELECT claw_name, claw_version, status FROM claw_installs WHERE agent_id = ?")
        .get(agentId) as { claw_name: string; claw_version: string; status: string } | undefined;
    if (
      !install ||
      install.claw_name !== pending.clawName ||
      install.claw_version !== pending.clawVersion ||
      install.status !== "complete"
    ) {
      throw new Error("Root Claw update did not reach the pending setup target.");
    }
    db /* sqlite-allow-raw: atomically publish current setup state from the pending intent. */
      .prepare(
        `INSERT INTO claw_setup_state (
           agent_id, record_version, claw_name, claw_version, setup_schema_digest,
           answer_digest, answers_json, seeds_json, status, applied_at_ms, updated_at_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET
           record_version = excluded.record_version,
           claw_name = excluded.claw_name,
           claw_version = excluded.claw_version,
           setup_schema_digest = excluded.setup_schema_digest,
           answer_digest = excluded.answer_digest,
           answers_json = excluded.answers_json,
           seeds_json = excluded.seeds_json,
           status = excluded.status,
           applied_at_ms = excluded.applied_at_ms,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run(
        agentId,
        pending.schemaVersion,
        pending.clawName,
        pending.clawVersion,
        pending.setupSchemaDigest,
        pending.answerDigest,
        JSON.stringify(pending.answers),
        JSON.stringify(pending.seeds),
        nowMs,
        nowMs,
      );
    db /* sqlite-allow-raw: clear the published setup update intent. */
      .prepare("DELETE FROM claw_setup_pending WHERE agent_id = ?")
      .run(agentId);
    return {
      schemaVersion: CLAW_SETUP_STATE_SCHEMA_VERSION,
      agentId,
      clawName: pending.clawName,
      clawVersion: pending.clawVersion,
      setupSchemaDigest: pending.setupSchemaDigest,
      answerDigest: pending.answerDigest,
      answers: pending.answers,
      seeds: pending.seeds,
      status: "complete",
      appliedAtMs: nowMs,
      updatedAtMs: nowMs,
    };
  }, options);
}

function samePendingSetup(
  existing: PersistedClawSetupState,
  plan: ClawAddPlan,
  materialization: ClawSetupMaterialization,
): boolean {
  return (
    existing.agentId === plan.agent.finalId &&
    existing.clawName === plan.claw.name &&
    existing.clawVersion === plan.claw.version &&
    existing.setupSchemaDigest === materialization.schemaDigest &&
    existing.answerDigest === materialization.answerDigest
  );
}

export function isResumableClawSetupAdd(
  plan: ClawAddPlan,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  const state = readClawSetupState(plan.agent.finalId, options);
  return Boolean(
    state &&
    state.status !== "complete" &&
    state.clawName === plan.claw.name &&
    state.clawVersion === plan.claw.version &&
    state.setupSchemaDigest === plan.setup?.schemaDigest &&
    state.answerDigest === plan.setup.answerDigest,
  );
}

export function beginClawSetupState(
  plan: ClawAddPlan,
  materialization: ClawSetupMaterialization,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): PersistedClawSetupState {
  assertSafeClawSetupAnswers(materialization.answers);
  ensureTable(options);
  const nowMs = options.nowMs ?? Date.now();
  return runOpenClawStateWriteTransaction(({ db }) => {
    const existing = readStateInDatabase(plan.agent.finalId, db);
    if (existing) {
      if (!samePendingSetup(existing, plan, materialization)) {
        throw new Error("Claw setup state changed after planning.");
      }
      return existing;
    }
    const state: PersistedClawSetupState = {
      schemaVersion: CLAW_SETUP_STATE_SCHEMA_VERSION,
      agentId: plan.agent.finalId,
      clawName: plan.claw.name,
      clawVersion: plan.claw.version,
      setupSchemaDigest: materialization.schemaDigest,
      answerDigest: materialization.answerDigest,
      answers: materialization.answers,
      seeds: materialization.seeds.map((seed) => ({
        source: seed.source,
        destination: seed.destination,
        inputIds: seed.inputIds,
        renderedDigest: seed.digest,
        status: "pending",
      })),
      status: "pending",
      updatedAtMs: nowMs,
    };
    db /* sqlite-allow-raw: insert one pending setup state row. */
      .prepare(
        `INSERT INTO claw_setup_state (
         agent_id, record_version, claw_name, claw_version, setup_schema_digest,
         answer_digest, answers_json, seeds_json, status, applied_at_ms, updated_at_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      )
      .run(
        state.agentId,
        state.schemaVersion,
        state.clawName,
        state.clawVersion,
        state.setupSchemaDigest,
        state.answerDigest,
        JSON.stringify(state.answers),
        JSON.stringify(state.seeds),
        state.status,
        state.updatedAtMs,
      );
    return state;
  }, options);
}

export function markClawSetupSeedComplete(
  agentId: string,
  destination: string,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): PersistedClawSetupState {
  const nowMs = options.nowMs ?? Date.now();
  return runOpenClawStateWriteTransaction(({ db }) => {
    const state = readStateInDatabase(agentId, db);
    if (!state) {
      throw new Error("Claw setup state disappeared during seed creation.");
    }
    const seed = state.seeds.find((candidate) => candidate.destination === destination);
    if (!seed) {
      throw new Error(`Claw setup seed ${JSON.stringify(destination)} is not recorded.`);
    }
    seed.status = "complete";
    seed.createdAtMs ??= nowMs;
    state.updatedAtMs = nowMs;
    const result = db /* sqlite-allow-raw: compare-and-swap one seed handoff marker. */
      .prepare(
        `UPDATE claw_setup_state
          SET seeds_json = ?, updated_at_ms = ?
        WHERE agent_id = ? AND setup_schema_digest = ? AND answer_digest = ?`,
      )
      .run(
        JSON.stringify(state.seeds),
        nowMs,
        state.agentId,
        state.setupSchemaDigest,
        state.answerDigest,
      );
    if (Number(result.changes) !== 1) {
      throw new Error("Claw setup state changed while recording seed handoff.");
    }
    return state;
  }, options);
}

export function markClawSetupStatePartial(
  agentId: string,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): void {
  if (!tableExists(options)) {
    return;
  }
  const nowMs = options.nowMs ?? Date.now();
  runOpenClawStateWriteTransaction(({ db }) => {
    db /* sqlite-allow-raw: retain explicit partial setup state for recovery. */
      .prepare(
        `UPDATE claw_setup_state SET status = 'partial', updated_at_ms = ? WHERE agent_id = ?`,
      )
      .run(nowMs, agentId);
  }, options);
}

export function completeClawInstallSetup(
  agentId: string,
  options: OpenClawStateDatabaseOptions & { nowMs?: number } = {},
): PersistedClawSetupState {
  const nowMs = options.nowMs ?? Date.now();
  return runOpenClawStateWriteTransaction(({ db }) => {
    const state = readStateInDatabase(agentId, db);
    if (!state || state.seeds.some((seed) => seed.status !== "complete")) {
      throw new Error("Claw setup cannot complete before every seed handoff is recorded.");
    }
    const setupResult = db /* sqlite-allow-raw: complete setup and root provenance atomically. */
      .prepare(
        `UPDATE claw_setup_state
            SET status = 'complete', applied_at_ms = ?, updated_at_ms = ?
          WHERE agent_id = ? AND status IN ('pending', 'partial', 'complete')`,
      )
      .run(nowMs, nowMs, agentId);
    const installResult = db /* sqlite-allow-raw: complete setup and root provenance atomically. */
      .prepare(
        `UPDATE claw_installs SET status = 'complete', updated_at_ms = ?
          WHERE agent_id = ? AND status IN ('config_committed', 'partial', 'complete')`,
      )
      .run(nowMs, agentId);
    if (Number(setupResult.changes) !== 1 || Number(installResult.changes) !== 1) {
      throw new Error("Claw setup or root install state changed before completion.");
    }
    return { ...state, status: "complete", appliedAtMs: nowMs, updatedAtMs: nowMs };
  }, options);
}

export function deleteClawSetupState(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): void {
  if (!tableExists(options)) {
    return;
  }
  runOpenClawStateWriteTransaction(({ db }) => {
    db /* sqlite-allow-raw: clear setup state after successful root removal. */
      .prepare("DELETE FROM claw_setup_state WHERE agent_id = ?")
      .run(agentId);
  }, options);
}
