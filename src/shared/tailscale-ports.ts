// Tailnet-facing port constants shared by config validation and the runtime
// route claim. Kept dependency-free so config schemas can import it without
// pulling in the process-spawning Tailscale runtime helpers.

/** Tailnet-facing HTTPS port used when the caller does not pick one. */
export const TAILSCALE_DEFAULT_ROUTE_PORT = 443;

/** Ports Tailscale Funnel accepts. Serve has no such restriction. */
export const TAILSCALE_FUNNEL_PORTS: readonly number[] = [443, 8443, 10_000];

/**
 * Builds the tailnet authority for a published URL. The default port is left
 * implicit so published URLs keep the documented Serve/Funnel form, while any
 * other port must stay visible: clients dial the tailnet route directly, so an
 * authority without it points at whatever else owns 443 on the host.
 */
export function formatTailscaleAuthority(host: string, port?: number): string {
  // The host resolver falls back to `TailscaleIPs`, which can yield an IPv6
  // literal. Those must be bracketed in a URL authority: `fd7a::1:8443` parses
  // as a longer address rather than host plus port, and a bare `fd7a::1` is not
  // a valid authority either, so bracket regardless of the port.
  const authorityHost = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return port === undefined || port === TAILSCALE_DEFAULT_ROUTE_PORT
    ? authorityHost
    : `${authorityHost}:${port}`;
}
