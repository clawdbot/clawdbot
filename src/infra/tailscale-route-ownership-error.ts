import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { asNullableObjectRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

const TAILSCALE_ROUTE_OWNERSHIP_CONFLICT_CODE = "TAILSCALE_ROUTE_OWNERSHIP_CONFLICT";

export class TailscaleRouteOwnershipConflictError extends Error {
  readonly code = TAILSCALE_ROUTE_OWNERSHIP_CONFLICT_CODE;

  constructor(port = 443, serveStatus = "{}") {
    const status = safeParseJsonRecord(
      serveStatus.slice(serveStatus.indexOf("{"), serveStatus.lastIndexOf("}") + 1),
    );
    const [session, config] =
      Object.entries(readRecord(status?.Foreground) ?? {}).find(
        ([, entry]) => readRecord(readRecord(entry)?.TCP)?.[String(port)],
      ) ?? [];
    const [host, server] =
      Object.entries(readRecord(readRecord(config)?.Web) ?? {}).find(([hostPort]) =>
        hostPort.endsWith(`:${port}`),
      ) ?? [];
    const [mount, handler] =
      Object.entries(readRecord(readRecord(server)?.Handlers) ?? {})[0] ?? [];
    const route = host
      ? `https://${host}${mount ?? ""} -> ${normalizeOptionalString(readRecord(handler)?.Proxy) ?? "non-proxy handler"}`
      : `HTTPS port ${port}`;
    super(
      `Tailscale HTTPS port ${port} is already owned by a route whose ownership OpenClaw cannot prove; it was not modified. ` +
        (session
          ? `Foreground session ${session} (${route.slice(0, 512)}). Inspect \`tailscale serve status --json\` and stop the confirmed owning process, then restart the Gateway. Tailscale status does not report the claimant PID; \`serve off\` does not release foreground claims. `
          : "Inspect `tailscale serve status`. If the route belongs to the current Tailscale hostname and is stale from an older OpenClaw release, remove its background root handler with " +
            `\`tailscale serve --yes --https=${port} --set-path=/ off\`, then restart the Gateway. ` +
            "Otherwise disable managed Tailscale ingress or reconfigure the route before restarting."),
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
