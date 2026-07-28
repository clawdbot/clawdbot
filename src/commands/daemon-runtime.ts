// Gateway daemon runtime option definitions used by install/configure flows.
export type GatewayDaemonRuntime = "node";

export const DEFAULT_GATEWAY_DAEMON_RUNTIME: GatewayDaemonRuntime = "node";

export const GATEWAY_DAEMON_RUNTIME_OPTIONS: Array<{
  value: GatewayDaemonRuntime;
  label: string;
  hint?: string;
}> = [
  {
    value: "node",
    label: "Node",
    hint: "Required for OpenClaw's SQLite-backed runtime state.",
  },
];

/** Narrow arbitrary input to a supported Gateway daemon runtime id. */
export function isGatewayDaemonRuntime(value: string | undefined): value is GatewayDaemonRuntime {
  return value === "node";
}
