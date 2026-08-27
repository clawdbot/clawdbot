import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CloudflareAccessCredentials } from "../../packages/gateway-client/src/cloudflare-access.js";
import { NODE_PORTAL_ATTACH_PATH } from "../shared/node-desktop-stream.js";
import { runNodeStreamTransport } from "./node-stream-transport.js";

const REQUEST_MAX_BYTES = 16 * 1024;
const TICKET_PATTERN = /^[a-f0-9]{48}$/u;

function parseNodeWorkerPortalStreamInput(raw?: string | null): {
  ticket: string;
  attachPath: string;
  port: number;
} {
  if (!raw || Buffer.byteLength(raw, "utf8") > REQUEST_MAX_BYTES) {
    throw new Error("INVALID_REQUEST: invalid node worker portal stream request");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("INVALID_REQUEST: malformed node worker portal stream request");
  }
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    typeof value.ticket !== "string" ||
    !TICKET_PATTERN.test(value.ticket) ||
    value.attachPath !== `${NODE_PORTAL_ATTACH_PATH}?ticket=${value.ticket}` ||
    typeof value.port !== "number" ||
    !Number.isSafeInteger(value.port) ||
    value.port < 1 ||
    value.port > 65_535
  ) {
    throw new Error("INVALID_REQUEST: invalid node worker portal stream request");
  }
  return { ticket: value.ticket, attachPath: value.attachPath, port: value.port };
}

/** Runs a private worker portal stream against its exact enrolled Gateway owner. */
export async function invokeNodeWorkerPortalStream(params: {
  paramsJSON?: string | null;
  gatewayUrl?: string;
  gatewayTlsFingerprint?: string;
  gatewayCloudflareAccess?: CloudflareAccessCredentials;
  signal?: AbortSignal;
}): Promise<void> {
  if (!params.gatewayUrl || !params.signal) {
    throw new Error("node worker portal gateway connection is unavailable");
  }
  const command = parseNodeWorkerPortalStreamInput(params.paramsJSON);
  await runNodeStreamTransport({
    gatewayUrl: params.gatewayUrl,
    gatewayTlsFingerprint: params.gatewayTlsFingerprint,
    gatewayCloudflareAccess: params.gatewayCloudflareAccess,
    attachPath: command.attachPath,
    expectedAttachPath: NODE_PORTAL_ATTACH_PATH,
    port: command.port,
    metadata: { ok: true },
    streamName: "portal",
    signal: params.signal,
    connectAfterGatewayAttach: true,
  });
}
