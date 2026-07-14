// Normalizes WebSocket raw payload data to strings.
import { Buffer } from "node:buffer";
import type WebSocket from "ws";

// ws emits raw payloads as buffers, ArrayBuffers, or buffer fragments.
export function rawDataToString(
  data: WebSocket.RawData,
  encoding: BufferEncoding = "utf8",
): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString(encoding);
  }
  return data instanceof ArrayBuffer
    ? Buffer.from(data).toString(encoding)
    : data.toString(encoding);
}

export function rawDataByteLength(data: WebSocket.RawData): number {
  return Array.isArray(data)
    ? data.reduce((total, chunk) => total + chunk.byteLength, 0)
    : data.byteLength;
}
