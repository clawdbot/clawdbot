/**
 * Gateway message decoding utilities.
 *
 * Extracted from `gateway.ts` — handles the various data formats that
 * the QQ Bot WebSocket can deliver (string, Buffer, Buffer[], ArrayBuffer).
 *
 * Zero external dependencies beyond Node.js built-ins.
 */

/**
 * Decode raw WebSocket `data` into a UTF-8 string.
 *
 * The QQ Bot gateway can send data as a plain string, a single Buffer,
 * an array of Buffer chunks, an ArrayBuffer, or a typed array view.
 */
export function decodeGatewayMessageData(data: unknown): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (Array.isArray(data) && data.every((chunk) => Buffer.isBuffer(chunk))) {
    return Buffer.concat(data).toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return "";
}

/**
 * Read the optional `message_scene.ext` array from an event payload.
 *
 * Guild, C2C, and Group events may carry a `message_scene` object
 * with an `ext` string array used for ref-index parsing.
 */
export function readOptionalMessageSceneExt(event: Record<string, unknown>): string[] | undefined {
  if (!("message_scene" in event)) {
    return undefined;
  }
  const scene = event.message_scene as { ext?: string[] } | undefined;
  return scene?.ext;
}
