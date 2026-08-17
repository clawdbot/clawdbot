// Tailnet-facing port constants shared by config validation and the runtime
// route claim. Kept dependency-free so config schemas can import it without
// pulling in the process-spawning Tailscale runtime helpers.

/** Tailnet-facing HTTPS port used when the caller does not pick one. */
export const TAILSCALE_DEFAULT_ROUTE_PORT = 443;

/** Ports Tailscale Funnel accepts. Serve has no such restriction. */
export const TAILSCALE_FUNNEL_PORTS: readonly number[] = [443, 8443, 10_000];
