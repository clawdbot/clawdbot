import type { SkillSelectionAuditEventRecord } from "./audit-event-types.js";
import { AUDIT_EVENT_SCHEMA_VERSION } from "./audit-event-types.js";

type SkillRow = {
  event_id: string;
  source_id: string;
  tool_call_id: string | null;
  error_code: string | null;
  tool_name: string | null;
  action: string | null;
  status: string | null;
  agent_id: string | null;
  session_key: string | null;
  session_id: string | null;
  run_id: string | null;
  occurred_at: number | bigint;
  [key: string]: unknown;
};

function corrupt(problem: string, row: SkillRow): never {
  throw new Error(`corrupt audit row ${row.event_id} (${row.source_id}): ${problem}`);
}

export function parseSkillSelectionAuditRow(row: SkillRow): SkillSelectionAuditEventRecord {
  if (row.tool_call_id !== null) {
    corrupt("tool_call_id must be null", row);
  }
  if (row.error_code !== null) {
    corrupt("error_code must be null", row);
  }
  if (!row.tool_name) {
    corrupt("missing selected skill name", row);
  }
  return {
    schemaVersion: AUDIT_EVENT_SCHEMA_VERSION,
    eventId: row.event_id,
    kind: "skill_selection",
    agentId: row.agent_id,
    sessionKey: row.session_key,
    sessionId: row.session_id,
    runId: row.run_id,
    toolName: row.tool_name,
    action: "skill.selection.observed",
    status: "observed",
    occurredAt: Number(row.occurred_at),
  };
}
