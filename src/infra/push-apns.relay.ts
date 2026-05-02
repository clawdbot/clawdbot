import { URL } from "node:url";
import type { GatewayConfig } from "../config/types.gateway.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import {
  loadOrCreateDeviceIdentity,
  signDevicePayload,
  type DeviceIdentity,
} from "./device-identity.js";
import { formatErrorMessage } from "./errors.js";
import { normalizeHostname } from "./net/hostname.js";

type ApnsRelayPushType = "alert" | "background";

export type ApnsRelayConfig = {
  baseUrl: string;
  timeoutMs: number;
};

type ApnsRelayConfigResolution =
  | { ok: true; value: ApnsRelayConfig }
  | { ok: false; error: string };

export type ApnsRelayPushResponse = {
  ok: boolean;
  status: number;
  apnsId?: string;
  reason?: string;
  environment: "production";
  tokenSuffix?: string;
};

export type ApnsRelayRequestSender = (params: {
  relayConfig: ApnsRelayConfig;
  sendGrant: string;
  relayHandle: string;
  gatewayDeviceId: string;
  signature: string;
  signedAtMs: number;
  bodyJson: string;
  pushType: ApnsRelayPushType;
  priority: "10" | "5";
  payload: object;
}) => Promise<ApnsRelayPushResponse>;

const DEFAULT_APNS_RELAY_TIMEOUT_MS = 10_000;
const GATEWAY_DEVICE_ID_HEADER = "x-openclaw-gateway-device-id";
const GATEWAY_SIGNATURE_HEADER = "x-openclaw-gateway-signature";
const GATEWAY_SIGNED_AT_HEADER = "x-openclaw-gateway-signed-at-ms";

function normalizeNonEmptyString(value: string | undefined): string | null {
  const trimmed = normalizeOptionalString(value) ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeTimeoutMs(value: string | number | undefined): number {
  const raw =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? normalizeOptionalString(value)
        : undefined;
  if (raw === undefined || raw === "") {
    return DEFAULT_APNS_RELAY_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_APNS_RELAY_TIMEOUT_MS;
  }
  return Math.max(1000, Math.trunc(parsed));
}

function readAllowHttp(value: string | undefined): boolean {
  const normalized = normalizeOptionalString(value)
    ? normalizeLowercaseStringOrEmpty(value)
    : undefined;
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isLoopbackRelayHostname(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function parseReason(value: unknown): string | undefined {
  return typeof value === "string" ? normalizeOptionalString(value) : undefined;
}

function buildRelayGatewaySignaturePayload(params: {
  gatewayDeviceId: string;
  signedAtMs: number;
  bodyJson: string;
}): string {
  return [
    "openclaw-relay-send-v1",
    params.gatewayDeviceId.trim(),
    String(Math.trunc(params.signedAtMs)),
    params.bodyJson,
  ].join("\n");
}

export function resolveApnsRelayConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  gatewayConfig?: GatewayConfig,
): ApnsRelayConfigResolution {
  const configuredRelay = gatewayConfig?.push?.apns?.relay;
  const envBaseUrl = normalizeNonEmptyString(env.OPENCLAW_APNS_RELAY_BASE_URL);
  const configBaseUrl = normalizeNonEmptyString(configuredRelay?.baseUrl);
  const baseUrl = envBaseUrl ?? configBaseUrl;
  const baseUrlSource = envBaseUrl
    ? "OPENCLAW_APNS_RELAY_BASE_URL"
    : "gateway.push.apns.relay.baseUrl";
  if (!baseUrl) {
    return {
      ok: false,
      error:
        "APNs relay config missing: set gateway.push.apns.relay.baseUrl or OPENCLAW_APNS_RELAY_BASE_URL",
    };
  }

  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
    if (!parsed.hostname) {
      throw new Error("host required");
    }
    if (parsed.protocol === "http:" && !readAllowHttp(env.OPENCLAW_APNS_RELAY_ALLOW_HTTP)) {
      throw new Error(
        "http relay URLs require OPENCLAW_APNS_RELAY_ALLOW_HTTP=true (development only)",
      );
    }
    if (parsed.protocol === "http:" && !isLoopbackRelayHostname(parsed.hostname)) {
      throw new Error("http relay URLs are limited to loopback hosts");
    }
    if (parsed.username || parsed.password) {
      throw new Error("userinfo is not allowed");
    }
    if (parsed.search || parsed.hash) {
      throw new Error("query and fragment are not allowed");
    }
    return {
      ok: true,
      value: {
        baseUrl: parsed.toString().replace(/\/+$/, ""),
        timeoutMs: normalizeTimeoutMs(
          env.OPENCLAW_APNS_RELAY_TIMEOUT_MS ?? configuredRelay?.timeoutMs,
        ),
      },
    };
  } catch (err) {
    const message = formatErrorMessage(err);
    return {
      ok: false,
      error: `invalid ${baseUrlSource} (${baseUrl}): ${message}`,
    };
  }
}

async function sendApnsRelayRequest(params: {
  relayConfig: ApnsRelayConfig;
  sendGrant: string;
  relayHandle: string;
  gatewayDeviceId: string;
  signature: string;
  signedAtMs: number;
  bodyJson: string;
  pushType: ApnsRelayPushType;
  priority: "10" | "5";
  payload: object;
}): Promise<ApnsRelayPushResponse> {
  const response = await fetch(`${params.relayConfig.baseUrl}/v1/push/send`, {
    method: "POST",
    redirect: "manual",
    headers: {
      authorization: `Bearer ${params.sendGrant}`,
      "content-type": "application/json",
      [GATEWAY_DEVICE_ID_HEADER]: params.gatewayDeviceId,
      [GATEWAY_SIGNATURE_HEADER]: params.signature,
      [GATEWAY_SIGNED_AT_HEADER]: String(params.signedAtMs),
    },
    body: params.bodyJson,
    signal: AbortSignal.timeout(params.relayConfig.timeoutMs),
  });
  if (response.status >= 300 && response.status < 400) {
    return {
      ok: false,
      status: response.status,
      reason: "RelayRedirectNotAllowed",
      environment: "production",
    };
  }

  let json: unknown = null;
  try {
    json = (await response.json()) as unknown;
  } catch {
    json = null;
  }
  const body =
    json && typeof json === "object" && !Array.isArray(json)
      ? (json as Record<string, unknown>)
      : {};

  const status =
    typeof body.status === "number" && Number.isFinite(body.status)
      ? Math.trunc(body.status)
      : response.status;
  return {
    ok: typeof body.ok === "boolean" ? body.ok : response.ok && status >= 200 && status < 300,
    status,
    apnsId: parseReason(body.apnsId),
    reason: parseReason(body.reason),
    environment: "production",
    tokenSuffix: parseReason(body.tokenSuffix),
  };
}

export async function sendApnsRelayPush(params: {
  relayConfig: ApnsRelayConfig;
  sendGrant: string;
  relayHandle: string;
  pushType: ApnsRelayPushType;
  priority: "10" | "5";
  payload: object;
  gatewayIdentity?: Pick<DeviceIdentity, "deviceId" | "privateKeyPem">;
  requestSender?: ApnsRelayRequestSender;
}): Promise<ApnsRelayPushResponse> {
  const sender = params.requestSender ?? sendApnsRelayRequest;
  const gatewayIdentity = params.gatewayIdentity ?? loadOrCreateDeviceIdentity();
  const signedAtMs = Date.now();
  const bodyJson = JSON.stringify({
    relayHandle: params.relayHandle,
    pushType: params.pushType,
    priority: Number(params.priority),
    payload: params.payload,
  });
  const signature = signDevicePayload(
    gatewayIdentity.privateKeyPem,
    buildRelayGatewaySignaturePayload({
      gatewayDeviceId: gatewayIdentity.deviceId,
      signedAtMs,
      bodyJson,
    }),
  );
  return await sender({
    relayConfig: params.relayConfig,
    sendGrant: params.sendGrant,
    relayHandle: params.relayHandle,
    gatewayDeviceId: gatewayIdentity.deviceId,
    signature,
    signedAtMs,
    bodyJson,
    pushType: params.pushType,
    priority: params.priority,
    payload: params.payload,
  });
}
