import { parseTcpPort } from "../../infra/tcp-port.js";

export { MAX_TCP_PORT, parseTcpPort } from "../../infra/tcp-port.js";

export function parsePort(raw: unknown): number | null {
  return parseTcpPort(raw);
}
