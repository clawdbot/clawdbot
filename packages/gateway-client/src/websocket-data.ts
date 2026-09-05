// Gateway Client WebSocket helpers normalize transport payloads without a core dependency.
import { Buffer } from "node:buffer";
import type { RawData } from "ws";

export function rawDataToString(data: RawData, encoding: BufferEncoding = "utf8"): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString(encoding);
  }
  return data instanceof ArrayBuffer
    ? Buffer.from(data).toString(encoding)
    : data.toString(encoding);
}
