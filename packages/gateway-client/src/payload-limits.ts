export const DEFAULT_GATEWAY_MAX_PAYLOAD_BYTES = 25 * 1024 * 1024;
export const DEFAULT_GATEWAY_PREAUTH_MAX_PAYLOAD_BYTES = 64 * 1024;

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
  isPreAuth = method === "connect",
): void {
  // The Gateway caps every unauthenticated WebSocket frame, not only connect.
  const usesPreAuthLimit = isPreAuth || method === "connect";
  const limit = usesPreAuthLimit ? DEFAULT_GATEWAY_PREAUTH_MAX_PAYLOAD_BYTES : maxPayloadBytes;
  if (limit === undefined) {
    return;
  }
  const frameBytes = new TextEncoder().encode(frame).byteLength;
  if (frameBytes > limit) {
    throw new RangeError(
      `gateway request ${method} exceeds ${usesPreAuthLimit ? "pre-auth" : "negotiated"} max payload ` +
        `(${frameBytes} > ${limit} bytes). Shorten the message or remove one or more attachments and retry.`,
    );
  }
}
