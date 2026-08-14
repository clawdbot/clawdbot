import { rawDataToString as gatewayRawDataToString } from "@openclaw/gateway-client/websocket-data";
import type WebSocket from "ws";

// Keep the declaration owner stable for the shipped webhook-ingress SDK export;
// WebSocket conversion itself is canonical in @openclaw/gateway-client.
export function rawDataToString(
  data: WebSocket.RawData,
  encoding: BufferEncoding = "utf8",
): string {
  return gatewayRawDataToString(data, encoding);
}

export function rawDataByteLength(data: WebSocket.RawData): number {
  return Array.isArray(data)
    ? data.reduce((total, chunk) => total + chunk.byteLength, 0)
    : data.byteLength;
}
