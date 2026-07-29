/** Server identity advertised by the local MCP loopback initialize response. */
export const MCP_LOOPBACK_SERVER_NAME = "openclaw";
/** Protocol-facing loopback server version, independent from the OpenClaw app version. */
export const MCP_LOOPBACK_SERVER_VERSION = "0.1.0";
/** MCP protocol versions accepted by the loopback HTTP bridge, newest first for negotiation. */
export const MCP_LOOPBACK_SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"] as const;

type JsonRpcId = string | number | null | undefined;

/** Minimal JSON-RPC request shape accepted by the MCP loopback HTTP handler. */
export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

/**
 * Builds a JSON-RPC success response, using null for notifications or malformed missing ids.
 */
export function jsonRpcResult(id: JsonRpcId, result: unknown) {
  return { jsonrpc: "2.0" as const, id: id ?? null, result };
}

/**
 * Builds a JSON-RPC error response with the same id normalization as success responses.
 */
export function jsonRpcError(id: JsonRpcId, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } };
}
