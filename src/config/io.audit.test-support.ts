import { createSqliteAuditRecordStore } from "../infra/sqlite-audit-record-store.js";
import {
  CONFIG_AUDIT_MAX_ENTRIES,
  CONFIG_AUDIT_SCOPE,
  type ConfigAuditRecord,
} from "./io.audit.js";
import { resolveStateDir } from "./paths.js";

export function listConfigAuditRecordsForTests(params: {
  env: NodeJS.ProcessEnv;
  homedir: () => string;
}): ConfigAuditRecord[] {
  return createSqliteAuditRecordStore<ConfigAuditRecord>({
    scope: CONFIG_AUDIT_SCOPE,
    maxEntries: CONFIG_AUDIT_MAX_ENTRIES,
    env: {
      ...params.env,
      OPENCLAW_STATE_DIR: resolveStateDir(params.env, params.homedir),
    },
  })
    .entries()
    .map((entry) => entry.value);
}
