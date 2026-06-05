// Gateway daemon runtime option definitions used by install/configure flows.
export type GatewayDaemonRuntime = "node" | "bun";

export const DEFAULT_GATEWAY_DAEMON_RUNTIME: GatewayDaemonRuntime = "node";

export const GATEWAY_DAEMON_RUNTIME_OPTIONS: Array<{
  value: GatewayDaemonRuntime;
  label: string;
  hint?: string;
}> = [
  {
    value: "node",
    label: "Node (recommended)",
    hint: "Required for WhatsApp + Telegram. Bun can corrupt memory on reconnect.",
  },
];

/** Narrow arbitrary input to a supported Gateway daemon runtime id. */
export function isGatewayDaemonRuntime(value: string | undefined): value is GatewayDaemonRuntime {
  return value === "node" || value === "bun";
}
