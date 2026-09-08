import "./sealed-runtime-bootstrap.js";

export { assertOpenClawStateWriteAllowed } from "../state/openclaw-state-ownership.js";
export { resolveImmutableSqliteFileUri } from "./node-sqlite.js";
export { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

export { hasManagedUpdateRecoveryRecord } from "./update-managed-service-recovery-presence.js";
