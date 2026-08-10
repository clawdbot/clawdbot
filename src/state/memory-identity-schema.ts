import { OPENCLAW_STATE_SCHEMA_SQL } from "./openclaw-state-schema.js";

const START = "CREATE TABLE IF NOT EXISTS memory_principals (";
const END = "CREATE TABLE IF NOT EXISTS session_state_events (";

function extractSchema(): string {
  const start = OPENCLAW_STATE_SCHEMA_SQL.indexOf(START);
  const end = OPENCLAW_STATE_SCHEMA_SQL.indexOf(END, start);
  if (start < 0 || end <= start) {
    throw new Error("memory identity schema markers are missing");
  }
  return OPENCLAW_STATE_SCHEMA_SQL.slice(start, end).trim();
}

export const MEMORY_IDENTITY_SCHEMA_SQL = extractSchema();
