import { OPENCLAW_AGENT_SCHEMA_WITHOUT_BOARD_SQL } from "./openclaw-agent-board-schema.js";

const SHARING_SCHEMA_START = "CREATE TABLE IF NOT EXISTS session_members (";
const SHARING_SCHEMA_END = "CREATE TABLE IF NOT EXISTS heartbeat_outcomes (";
const SUGGESTIONS_SCHEMA_START = "CREATE TABLE IF NOT EXISTS session_suggestions (";

function splitSessionSharingSchema(sql: string): { sharing: string; withoutSharing: string } {
  const start = sql.indexOf(SHARING_SCHEMA_START);
  const end = sql.indexOf(SHARING_SCHEMA_END, start);
  if (start === -1 || end === -1) {
    throw new Error("OpenClaw agent session-sharing schema markers are missing.");
  }
  return {
    sharing: sql.slice(start, end),
    withoutSharing: `${sql.slice(0, start)}${sql.slice(end)}`,
  };
}

const sessionSharingSchema = splitSessionSharingSchema(OPENCLAW_AGENT_SCHEMA_WITHOUT_BOARD_SQL);
const sessionSuggestionsStart = sessionSharingSchema.sharing.indexOf(SUGGESTIONS_SCHEMA_START);
if (sessionSuggestionsStart === -1) {
  throw new Error("OpenClaw agent session-suggestions schema marker is missing.");
}
export const AGENT_V14_SESSION_SHARING_SCHEMA_SQL = sessionSharingSchema.sharing.slice(
  0,
  sessionSuggestionsStart,
);
export const AGENT_V14_ADDITIVE_SCHEMA_SQL =
  sessionSharingSchema.sharing.slice(sessionSuggestionsStart);
export const AGENT_V14_CORE_SCHEMA_SQL = sessionSharingSchema.withoutSharing;
