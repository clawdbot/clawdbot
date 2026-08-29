import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ClientOptions } from "ws";
import { normalizeTlsFingerprint } from "../../packages/gateway-client/src/client-address-utils.js";
import {
  buildCloudflareAccessHeaders,
  type CloudflareAccessCredentials,
} from "../../packages/gateway-client/src/cloudflare-access.js";
import {
  GatewayWebSocketTransportConfigurationError,
  resolveGatewayWebSocketTransport,
} from "../../packages/gateway-client/src/websocket-transport.js";
import { WORKER_PUBLIC_INGRESS_PATH } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH } from "../../packages/gateway-protocol/src/schema/worker-protocol-primitives.js";

const ENDPOINT_FIELD_MAX_LENGTH = 4_096;
// JSON needs at most six bytes per UTF-16 code unit (control/lone-surrogate escapes).
// These closed shapes cover both endpoints; parsed TLS pins are 64 ASCII hex digits.
export const WORKER_CONNECTION_ENDPOINT_MAX_JSON_BYTES = Math.max(
  Buffer.byteLength(
    JSON.stringify({
      kind: "unix",
      socketPath: "\0".repeat(WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH),
    }),
  ),
  Buffer.byteLength(
    JSON.stringify({
      kind: "websocket",
      url: "\0".repeat(ENDPOINT_FIELD_MAX_LENGTH),
      tlsFingerprint: "0".repeat(64),
      cloudflareAccess: {
        clientId: "\0".repeat(ENDPOINT_FIELD_MAX_LENGTH),
        clientSecret: "\0".repeat(ENDPOINT_FIELD_MAX_LENGTH),
      },
    }),
  ),
);

export class WorkerConnectionEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkerConnectionEndpointError";
  }
}

export type WorkerConnectionEndpoint =
  | { kind: "unix"; socketPath: string }
  | {
      kind: "websocket";
      url: string;
      tlsFingerprint?: string;
      cloudflareAccess?: CloudflareAccessCredentials;
    };

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  const allowed = new Set([...required, ...optional]);
  return (
    required.every((key) => key in value) && Object.keys(value).every((key) => allowed.has(key))
  );
}

function parseUnixEndpoint(value: Record<string, unknown>): WorkerConnectionEndpoint | undefined {
  if (
    !hasExactKeys(value, ["kind", "socketPath"]) ||
    value.kind !== "unix" ||
    typeof value.socketPath !== "string" ||
    value.socketPath.length > WORKER_PROTOCOL_MAX_IDENTIFIER_LENGTH ||
    !path.isAbsolute(value.socketPath) ||
    value.socketPath.includes(":")
  ) {
    return undefined;
  }
  return { kind: "unix", socketPath: value.socketPath };
}

function parseWebSocketEndpoint(
  value: Record<string, unknown>,
): WorkerConnectionEndpoint | undefined {
  const tlsFingerprint =
    typeof value.tlsFingerprint === "string"
      ? normalizeTlsFingerprint(value.tlsFingerprint)
      : undefined;
  if (
    !hasExactKeys(value, ["kind", "url"], ["tlsFingerprint", "cloudflareAccess"]) ||
    value.kind !== "websocket" ||
    typeof value.url !== "string" ||
    value.url.length > ENDPOINT_FIELD_MAX_LENGTH ||
    (value.tlsFingerprint !== undefined && !tlsFingerprint)
  ) {
    return undefined;
  }
  const cloudflareAccess = parseCloudflareAccessCredentials(value.cloudflareAccess);
  if (value.cloudflareAccess !== undefined && !cloudflareAccess) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value.url);
  } catch {
    return undefined;
  }
  if (
    (url.protocol !== "ws:" && url.protocol !== "wss:") ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.endsWith(WORKER_PUBLIC_INGRESS_PATH) ||
    (value.tlsFingerprint !== undefined && url.protocol !== "wss:") ||
    (cloudflareAccess !== undefined && url.protocol !== "wss:")
  ) {
    return undefined;
  }
  return {
    kind: "websocket",
    url: value.url,
    ...(tlsFingerprint ? { tlsFingerprint } : {}),
    ...(cloudflareAccess ? { cloudflareAccess } : {}),
  };
}

function parseCloudflareAccessCredentials(value: unknown): CloudflareAccessCredentials | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["clientId", "clientSecret"]) ||
    typeof value.clientId !== "string" ||
    value.clientId.trim().length === 0 ||
    value.clientId.length > ENDPOINT_FIELD_MAX_LENGTH ||
    typeof value.clientSecret !== "string" ||
    value.clientSecret.trim().length === 0 ||
    value.clientSecret.length > ENDPOINT_FIELD_MAX_LENGTH
  ) {
    return undefined;
  }
  return { clientId: value.clientId, clientSecret: value.clientSecret };
}

export function parseWorkerConnectionEndpoint(
  value: unknown,
): WorkerConnectionEndpoint | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return parseUnixEndpoint(value) ?? parseWebSocketEndpoint(value);
}

type WorkerConnectionTarget = {
  url: string;
  options: ClientOptions;
};

export function resolveWorkerConnectionTarget(
  endpoint: WorkerConnectionEndpoint,
  env: NodeJS.ProcessEnv = process.env,
): WorkerConnectionTarget {
  if (endpoint.kind === "unix") {
    return {
      url: `ws+unix://${endpoint.socketPath}:/`,
      options: {},
    };
  }
  if (endpoint.cloudflareAccess && new URL(endpoint.url).protocol !== "wss:") {
    throw new WorkerConnectionEndpointError(
      "Cloudflare Access credentials require a wss:// worker endpoint",
    );
  }
  try {
    const transport = resolveGatewayWebSocketTransport({
      url: endpoint.url,
      tlsFingerprint: endpoint.tlsFingerprint,
      env,
      options: endpoint.cloudflareAccess
        ? {
            followRedirects: false,
            headers: buildCloudflareAccessHeaders(endpoint.cloudflareAccess),
          }
        : {},
    });
    return { url: endpoint.url, ...transport };
  } catch (error) {
    if (error instanceof GatewayWebSocketTransportConfigurationError) {
      throw new WorkerConnectionEndpointError(error.message);
    }
    throw error;
  }
}
