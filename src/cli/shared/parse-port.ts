// CLI-facing TCP port parser wrapper.
import { parseTcpPort } from "../../infra/tcp-port.js";

/** Re-export the canonical TCP port parser and limit for CLI callers. */
export { MAX_TCP_PORT, parseTcpPort } from "../../infra/tcp-port.js";

/** Parse a TCP port from unknown CLI/config input, returning null for invalid values. */
export function parsePort(raw: unknown): number | null {
  return parseTcpPort(raw);
}
