import { asNullableObjectRecord as readRecord } from "@openclaw/normalization-core/record-coerce";

const TAILSCALE_ROUTE_OWNERSHIP_CONFLICT_CODE = "TAILSCALE_ROUTE_OWNERSHIP_CONFLICT";

export class TailscaleRouteOwnershipConflictError extends Error {
  readonly code = TAILSCALE_ROUTE_OWNERSHIP_CONFLICT_CODE;

  constructor() {
    super(
      "Tailscale HTTPS port 443 is already owned by a route whose ownership OpenClaw cannot prove; it was not modified. " +
        "Inspect `tailscale serve status`. If it is a stale route from an older OpenClaw release, remove its root handler with " +
        "`tailscale serve --yes --https=443 --set-path=/ off` or `tailscale funnel --yes --https=443 --set-path=/ off`, then restart the Gateway. " +
        "Otherwise disable managed Tailscale ingress or reconfigure the route before restarting.",
    );
    this.name = "TailscaleRouteOwnershipConflictError";
  }
}

export function isTailscaleRouteOwnershipConflictError(error: unknown): boolean {
  return (
    error instanceof TailscaleRouteOwnershipConflictError ||
    readRecord(error)?.code === TAILSCALE_ROUTE_OWNERSHIP_CONFLICT_CODE
  );
}
