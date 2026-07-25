// Gateway Client WebSocket helpers normalize transport payloads without a core dependency.
import { Buffer } from "node:buffer";
import type { RawData } from "ws";

export function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return data instanceof ArrayBuffer ? Buffer.from(data).toString("utf8") : data.toString("utf8");
}
