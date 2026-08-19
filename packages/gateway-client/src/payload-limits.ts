export const DEFAULT_GATEWAY_MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;
export const DEFAULT_GATEWAY_PREAUTH_MAX_PAYLOAD_BYTES = 64 * 1024;
const GATEWAY_PAYLOAD_LIMIT_RECOVERY_MESSAGE =
  "Shorten the message or remove one or more attachments and retry.";

export function resolveGatewayMaxPayloadBytes(
  policy?: { maxPayload?: unknown } | null,
): number | undefined {
  const maxPayload = policy?.maxPayload;
  if (maxPayload === undefined) {
    return undefined;
  }
  return typeof maxPayload === "number" && Number.isSafeInteger(maxPayload) && maxPayload > 0
    ? maxPayload
    : DEFAULT_GATEWAY_MAX_PAYLOAD_BYTES;
}

export function validateGatewayRequestFrame(
  frame: string,
  method: string,
  maxPayloadBytes: number | undefined,
): void {
  const isConnect = method === "connect";
  const limit = isConnect ? DEFAULT_GATEWAY_PREAUTH_MAX_PAYLOAD_BYTES : maxPayloadBytes;
  if (limit === undefined) {
    return;
  }
  const frameBytes = new TextEncoder().encode(frame).byteLength;
  if (frameBytes > limit) {
    throw new RangeError(
      `gateway request ${method} exceeds ${isConnect ? "pre-auth" : "negotiated"} max payload ` +
        `(${frameBytes} > ${limit} bytes). ${GATEWAY_PAYLOAD_LIMIT_RECOVERY_MESSAGE}`,
    );
  }
}
