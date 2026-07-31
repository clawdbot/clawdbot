import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";

const LEGACY_AUDIT_COORDINATION_SCOPE = "migration.legacy-audit";
const LEGACY_AUDIT_COORDINATION_KEY = "filesystem-sqlite-boundary";

export function withLegacyAuditMigrationLease<T>(
  stateDir: string,
  run: () => Promise<T>,
): Promise<T> {
  return withOpenClawStateLease(
    {
      scope: LEGACY_AUDIT_COORDINATION_SCOPE,
      key: LEGACY_AUDIT_COORDINATION_KEY,
      database: {
        scope: "shared",
        options: { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
      },
      leaseMs: 60_000,
      waitMs: 5_000,
      leaseLabel: "legacy audit migration lease",
      operationLabel: "migration.legacy-audit.lease",
    },
    async () => await run(),
  );
}
