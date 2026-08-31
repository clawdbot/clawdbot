import { createSqliteAuditRecordStore } from "../infra/sqlite-audit-record-store.js";
import {
  SYSTEM_AGENT_AUDIT_MAX_ENTRIES,
  SYSTEM_AGENT_AUDIT_SCOPE,
  type SystemAgentAuditEntry,
} from "./audit.js";

export function listSystemAgentAuditEntriesForTests(params?: { env?: NodeJS.ProcessEnv }) {
  return createSqliteAuditRecordStore<SystemAgentAuditEntry>({
    scope: SYSTEM_AGENT_AUDIT_SCOPE,
    maxEntries: SYSTEM_AGENT_AUDIT_MAX_ENTRIES,
    ...(params?.env ? { env: params.env } : {}),
  }).entries();
}
