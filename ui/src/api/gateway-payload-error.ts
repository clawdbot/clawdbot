const DEFAULT_GATEWAY_PAYLOAD_ERROR_MESSAGE =
  "Request exceeds the Gateway payload limit. Shorten the message or remove one or more attachments and retry.";

export class GatewayPayloadLimitError extends Error {
  constructor(message = DEFAULT_GATEWAY_PAYLOAD_ERROR_MESSAGE) {
    super(message);
    this.name = "GatewayPayloadLimitError";
  }
}

export function normalizeGatewayPayloadError(error: unknown): unknown {
  return error instanceof RangeError ? new GatewayPayloadLimitError(error.message) : error;
}
