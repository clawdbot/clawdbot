import type { GatewayReceivePayload } from "discord-api-types/v10";

export function ensureGatewayParams(url: string): string {
  const parsed = new URL(url);
  parsed.searchParams.set("v", parsed.searchParams.get("v") ?? "10");
  parsed.searchParams.set("encoding", parsed.searchParams.get("encoding") ?? "json");
  return parsed.toString();
}

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
