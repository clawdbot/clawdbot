// Normalizes WebSocket raw payload data to strings.
import { Buffer } from "node:buffer";
import type WebSocket from "ws";

// WebSocket.RawData can arrive as strings, buffers, ArrayBuffers, or buffer
// fragments depending on ws internals and caller options.
export function rawDataToString(
  data: WebSocket.RawData,
  encoding: BufferEncoding = "utf8",
): string {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString(encoding);
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString(encoding);
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString(encoding);
  }
  return Buffer.from(String(data)).toString(encoding);
}
