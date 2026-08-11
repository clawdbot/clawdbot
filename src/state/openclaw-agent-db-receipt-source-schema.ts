import type { DatabaseSync } from "node:sqlite";
import { hasPendingConversationDeliveryReceiptSourceProjection } from "./openclaw-agent-db-session-migrations.js";
import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

const RECEIPT_SOURCE_COLUMN = "  platform_message_id_source TEXT,\n";
if (!OPENCLAW_AGENT_SCHEMA_SQL.includes(RECEIPT_SOURCE_COLUMN)) {
  throw new Error("OpenClaw agent receipt-source schema marker is missing.");
}
const AGENT_SCHEMA_BEFORE_RECEIPT_SOURCE_SQL = OPENCLAW_AGENT_SCHEMA_SQL.replace(
  RECEIPT_SOURCE_COLUMN,
  "",
);

/** Accepts only the intentionally lazy current-version receipt projection. */
export function resolveOpenClawAgentSchemaForCurrentDatabase(db: DatabaseSync): string {
  return hasPendingConversationDeliveryReceiptSourceProjection(db)
    ? AGENT_SCHEMA_BEFORE_RECEIPT_SOURCE_SQL
    : OPENCLAW_AGENT_SCHEMA_SQL;
}
