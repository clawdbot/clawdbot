// Shared parser for CLI flags that select a local Gateway TCP port.
import { parseStrictPositiveInteger } from "@openclaw/normalization-core/number-coercion";
import type { GatewayRpcOpts } from "./gateway-rpc.types.js";

const MAX_TCP_PORT = 65_535;

export function parseGatewayPortOption(raw: unknown, flagName = "--port"): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }

  const parsed = parseStrictPositiveInteger(typeof raw === "bigint" ? String(raw) : raw);
  if (parsed === undefined || parsed > MAX_TCP_PORT) {
    throw new Error(`${flagName} must be an integer between 1 and ${MAX_TCP_PORT}.`);
  }
  return parsed;
}

export function resolveGatewayLocalPortOverride(
  opts: Pick<GatewayRpcOpts, "port" | "url"> & { localPortOverride?: number },
): number | undefined {
  const port = opts.localPortOverride ?? parseGatewayPortOption(opts.port);
  if (port !== undefined && typeof opts.url === "string" && opts.url.trim()) {
    throw new Error("Use either --url or --port, not both.");
  }
  return port;
}
