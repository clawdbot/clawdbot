// Gateway daemon runtime option definitions used by install/configure flows.
import { isBunRuntime } from "../daemon/runtime-binary.js";

export type GatewayDaemonRuntime = "bun" | "node";

export const DEFAULT_GATEWAY_DAEMON_RUNTIME: GatewayDaemonRuntime = "node";

export const GATEWAY_DAEMON_RUNTIME_OPTIONS: Array<{
  value: GatewayDaemonRuntime;
  label: string;
  hint?: string;
}> = [
  {
    value: "node",
    label: "Node",
    hint: "Primary and recommended runtime for managed services.",
  },
  {
    value: "bun",
    label: "Bun 1.4+",
    hint: "Requires Bun 1.4 or newer with WAL-reset-safe node:sqlite.",
  },
];

/** Narrow arbitrary input to a supported Gateway daemon runtime id. */
export function isGatewayDaemonRuntime(value: string | undefined): value is GatewayDaemonRuntime {
  return value === "bun" || value === "node";
}

/** Detects the runtime selected by an installed daemon command. */
export function resolveGatewayDaemonRuntime(
  programArguments: string[] | undefined,
): GatewayDaemonRuntime {
  return isBunRuntime(programArguments?.[0] ?? "") ? "bun" : DEFAULT_GATEWAY_DAEMON_RUNTIME;
}
