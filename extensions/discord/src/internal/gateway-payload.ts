import type { GatewayReceivePayload } from "discord-api-types/v10";

export function decodeGatewayMessage(incoming: unknown): GatewayReceivePayload | null {
  const text = Buffer.isBuffer(incoming)
    ? incoming.toString("utf8")
    : incoming instanceof ArrayBuffer
      ? Buffer.from(incoming).toString("utf8")
      : Array.isArray(incoming)
        ? Buffer.concat(incoming.map((entry) => Buffer.from(entry))).toString("utf8")
        : String(incoming);
  try {
    return JSON.parse(text) as GatewayReceivePayload;
  } catch {
    return null;
  }
}
