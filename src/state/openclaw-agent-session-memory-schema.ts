import { OPENCLAW_AGENT_SCHEMA_SQL } from "./openclaw-agent-schema.js";

const START = "CREATE TABLE IF NOT EXISTS session_memory_subjects (";
const END = "CREATE TABLE IF NOT EXISTS session_key_contract (";

function extractSchema(): string {
  const start = OPENCLAW_AGENT_SCHEMA_SQL.indexOf(START);
  const end = OPENCLAW_AGENT_SCHEMA_SQL.indexOf(END, start);
  if (start < 0 || end <= start) {
    throw new Error("session memory subject schema markers are missing");
  }
  return OPENCLAW_AGENT_SCHEMA_SQL.slice(start, end).trim();
}

export const AGENT_SESSION_MEMORY_SCHEMA_SQL = extractSchema();
