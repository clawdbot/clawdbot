import type { DatabaseSync } from "node:sqlite";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.generated.js";

const MODEL_SPEND_SCHEMA_START = "CREATE TABLE IF NOT EXISTS model_spend_daily (";

function splitModelSpendSchema(sql: string): { modelSpend: string; withoutModelSpend: string } {
  const start = sql.indexOf(MODEL_SPEND_SCHEMA_START);
  if (start === -1) {
    throw new Error("OpenClaw agent model-spend schema marker is missing.");
  }
  return {
    modelSpend: sql.slice(start),
    withoutModelSpend: sql.slice(0, start),
  };
}

const modelSpendSchema = splitModelSpendSchema(OPENCLAW_AGENT_SCHEMA_SQL);

export const AGENT_MODEL_SPEND_SCHEMA_SQL = modelSpendSchema.modelSpend;
export const AGENT_SCHEMA_WITHOUT_MODEL_SPEND_SQL = modelSpendSchema.withoutModelSpend;

/** Ensures the additive model-spend tables inside the caller's schema transaction. */
export function ensureOpenClawAgentModelSpendSchemaInTransaction(db: DatabaseSync): void {
  if (!db.isTransaction) {
    throw new Error("model-spend schema ensure requires an active transaction");
  }
  db.exec(AGENT_MODEL_SPEND_SCHEMA_SQL); // sqlite-allow-raw -- Canonical DDL bootstrap for the lazy additive schema.
}
