/** ACP handshake normalization shared by stdio server entrypoints. */
import { AGENT_METHODS, PROTOCOL_VERSION, type AnyMessage } from "@agentclientprotocol/sdk";

type JsonObject = Record<string, unknown>;

/**
 * Normalizes date-style client versions before the ACP SDK validates them.
 *
 * The ACP SDK validates this uint16 before the agent handler runs; some editors
 * send MCP date strings here, so normalize only this handshake field.
 */
export function normalizeAcpInitializeProtocolVersion(message: AnyMessage): AnyMessage {
  if (!isJsonObject(message)) {
    return message;
  }
  const object = message as JsonObject;
  if (object.method !== AGENT_METHODS.initialize) {
    return message;
  }
  const params = object.params;
  if (
    !isJsonObject(params) ||
    typeof params.protocolVersion !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion)
  ) {
    return message;
  }
  return {
    ...message,
    params: {
      ...params,
      protocolVersion: PROTOCOL_VERSION,
    },
  } as AnyMessage;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
