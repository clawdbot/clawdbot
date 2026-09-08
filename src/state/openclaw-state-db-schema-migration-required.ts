import { StartupMaintenanceRequiredError } from "../infra/startup-maintenance-required.js";

type OpenClawStateDatabaseSchemaMigrationRequiredKind =
  | "agent-databases-composite-primary-key"
  | "audit-events-v2";

export class OpenClawStateDatabaseSchemaMigrationRequiredError extends StartupMaintenanceRequiredError {
  constructor(
    override readonly kind: OpenClawStateDatabaseSchemaMigrationRequiredKind,
    readonly pathname: string,
  ) {
    super(
      kind,
      `OpenClaw state database schema migration required (${kind}) at ${pathname}; run openclaw doctor --fix to migrate it.`,
    );
    this.name = "OpenClawStateDatabaseSchemaMigrationRequiredError";
  }
}
