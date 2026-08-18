import { asNullableObjectRecord as readRecord } from "@openclaw/normalization-core/record-coerce";

const TAILSCALE_ROUTE_MIGRATION_REQUIRED_CODE = "TAILSCALE_ROUTE_MIGRATION_REQUIRED";

export class TailscaleRouteMigrationRequiredError extends Error {
  readonly code = TAILSCALE_ROUTE_MIGRATION_REQUIRED_CODE;

  constructor() {
    super(
      "Tailscale HTTPS port 443 is already owned by a route that OpenClaw cannot safely migrate. " +
        "Inspect `tailscale serve status`; remove or reconfigure that route manually, then restart the Gateway.",
    );
    this.name = "TailscaleRouteMigrationRequiredError";
  }
}

export function isTailscaleRouteMigrationRequiredError(error: unknown): boolean {
  return (
    error instanceof TailscaleRouteMigrationRequiredError ||
    readRecord(error)?.code === TAILSCALE_ROUTE_MIGRATION_REQUIRED_CODE
  );
}
