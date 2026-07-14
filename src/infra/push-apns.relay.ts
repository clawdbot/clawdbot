// Sends APNs notifications through the configured relay endpoint.
import { URL } from "node:url";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { GatewayConfig } from "../config/types.gateway.js";
import {
  loadOrCreateProcessDeviceIdentity,
  signDevicePayload,
  type DeviceIdentity,
} from "./device-identity.js";
import { formatErrorMessage } from "./errors.js";
import { readResponseWithLimit } from "./http-body.js";
import { normalizeHostname } from "./net/hostname.js";

type ApnsRelayPushType = "alert" | "background";
type ApnsRelayEnvironment = "production" | "sandbox";

/** Resolved APNs relay endpoint and client timeout for gateway-originated sends. */
export type ApnsRelayConfig = {
  baseUrl: string;
  timeoutMs: number;
};

type ApnsRelayConfigResolution =
  | { ok: true; value: ApnsRelayConfig }
  | { ok: false; error: string };

type ApnsRelayConfigResolutionOptions = {
  registrationRelayOrigin?: string;
};

/** Normalized relay response after the hosted relay has attempted an APNs send. */
export type ApnsRelayPushResponse = {
  ok: boolean;
  status: number;
  apnsId?: string;
  reason?: string;
  environment?: ApnsRelayEnvironment;
  tokenSuffix?: string;
};

/** Test/integration seam for sending a signed APNs relay request. */
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

/** Hosted APNs relay origin used only when registrations prove they were minted there. */
const DEFAULT_APNS_RELAY_BASE_URL = "https://ios-push-relay.openclaw.ai";
const DEFAULT_APNS_SANDBOX_RELAY_BASE_URL = "https://ios-push-relay-sandbox.openclaw.ai";
const DEFAULT_APNS_RELAY_TIMEOUT_MS = 10_000;
// Hard cap on the relay response body. The hosted relay reply is a tiny JSON status object;
// without a cap a buggy/hostile/compromised relay could stream an unbounded body and exhaust
// gateway memory (the existing AbortSignal.timeout only bounds connection latency, not body size).
const APNS_RELAY_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
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
  return resolveTimerTimeoutMs(parsed, DEFAULT_APNS_RELAY_TIMEOUT_MS, 1000);
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

function parseRelayEnvironment(value: unknown): ApnsRelayEnvironment | undefined {
  const normalized = typeof value === "string" ? normalizeLowercaseStringOrEmpty(value) : "";
  if (normalized === "sandbox" || normalized === "production") {
    return normalized;
  }
  return undefined;
}

/** Validate and canonicalize an APNs relay base URL for config and registration origins. */
export function normalizeApnsRelayBaseUrl(
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): { ok: true; value: string } | { ok: false; error: string } {
  try {
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new Error("unsupported protocol");
    }
    if (!parsed.hostname) {
      throw new Error("host required");
    }
    // Plain HTTP is only for local relay development; production relay URLs must use TLS.
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
    return { ok: true, value: parsed.toString().replace(/\/+$/, "") };
  } catch (err) {
    return { ok: false, error: formatErrorMessage(err) };
  }
}

function buildRelayGatewaySignaturePayload(params: {
  gatewayDeviceId: string;
  signedAtMs: number;
  bodyJson: string;
}): string {
  // Domain-separate relay send signatures from other gateway/device signatures.
  return [
    "openclaw-relay-send-v1",
    params.gatewayDeviceId.trim(),
    String(Math.trunc(params.signedAtMs)),
    params.bodyJson,
  ].join("\n");
}

/** Resolve the relay endpoint from env/config and require it to match relay-minted registrations. */
export function resolveApnsRelayConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  gatewayConfig?: GatewayConfig,
  options: ApnsRelayConfigResolutionOptions = {},
): ApnsRelayConfigResolution {
  const configuredRelay = gatewayConfig?.push?.apns?.relay;
  const envBaseUrl = normalizeNonEmptyString(env.OPENCLAW_APNS_RELAY_BASE_URL);
  const configBaseUrl = normalizeNonEmptyString(configuredRelay?.baseUrl);
  const explicitBaseUrl = envBaseUrl ?? configBaseUrl;
  const normalizedRegistrationOrigin = options.registrationRelayOrigin
    ? normalizeApnsRelayBaseUrl(options.registrationRelayOrigin, env)
    : undefined;
  if (normalizedRegistrationOrigin && !normalizedRegistrationOrigin.ok) {
    return {
      ok: false,
      error: `invalid relay registration origin (${options.registrationRelayOrigin}): ${normalizedRegistrationOrigin.error}`,
    };
  }

  const hostedRelayBaseUrl =
    normalizedRegistrationOrigin?.value === DEFAULT_APNS_RELAY_BASE_URL
      ? DEFAULT_APNS_RELAY_BASE_URL
      : normalizedRegistrationOrigin?.value === DEFAULT_APNS_SANDBOX_RELAY_BASE_URL
        ? DEFAULT_APNS_SANDBOX_RELAY_BASE_URL
        : undefined;
  const baseUrl = explicitBaseUrl ?? hostedRelayBaseUrl;
  const baseUrlSource = envBaseUrl
    ? "OPENCLAW_APNS_RELAY_BASE_URL"
    : configBaseUrl
      ? "gateway.push.apns.relay.baseUrl"
      : "default APNs relay base URL";
  if (!baseUrl) {
    return {
      ok: false,
      error:
        "APNs relay config missing: set gateway.push.apns.relay.baseUrl or OPENCLAW_APNS_RELAY_BASE_URL for relay registrations without the hosted relay origin",
    };
  }

  const normalizedBaseUrl = normalizeApnsRelayBaseUrl(baseUrl, env);
  if (!normalizedBaseUrl.ok) {
    return {
      ok: false,
      error: `invalid ${baseUrlSource} (${baseUrl}): ${normalizedBaseUrl.error}`,
    };
  }
  if (
    normalizedRegistrationOrigin &&
    normalizedRegistrationOrigin.value !== normalizedBaseUrl.value
  ) {
    return {
      ok: false,
      error: `APNs relay config origin mismatch: registration uses ${normalizedRegistrationOrigin.value} but ${baseUrlSource} is ${normalizedBaseUrl.value}`,
    };
  }
  return {
    ok: true,
    value: {
      baseUrl: normalizedBaseUrl.value,
      timeoutMs: normalizeTimeoutMs(
        env.OPENCLAW_APNS_RELAY_TIMEOUT_MS ?? configuredRelay?.timeoutMs,
      ),
    },
  };
}

// Sentinel marking an over-cap relay body. Carried as a distinct type so the response-read
// catch path can fail closed on overflow instead of swallowing it into the malformed-JSON
// (treat-as-empty-body) fallback that would otherwise report a successful send.
class ApnsRelayResponseTooLargeError extends Error {
  constructor(
    readonly size: number,
    readonly maxBytes: number,
  ) {
    super(`APNs relay response exceeded ${maxBytes} bytes (${size} bytes received)`);
    this.name = "ApnsRelayResponseTooLargeError";
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
  // Do not follow relay redirects; grants and signatures are scoped to the configured relay origin.
  if (response.status >= 300 && response.status < 400) {
    return {
      ok: false,
      status: response.status,
      reason: "RelayRedirectNotAllowed",
    };
  }

  let json: unknown;
  try {
    // Bound the relay body before buffering it; cancel the stream past the cap.
    const buffer = await readResponseWithLimit(response, APNS_RELAY_MAX_RESPONSE_BYTES, {
      onOverflow: ({ size, maxBytes }) => new ApnsRelayResponseTooLargeError(size, maxBytes),
    });
    json = JSON.parse(new TextDecoder("utf-8").decode(buffer)) as unknown;
  } catch (err) {
    if (err instanceof ApnsRelayResponseTooLargeError) {
      // Fail closed: an oversized relay body must never be reported as a delivered push.
      return {
        ok: false,
        status: response.status,
        reason: "RelayResponseTooLarge",
      };
    }
    // Malformed/empty JSON (or a non-overflow body read error) keeps the prior behaviour:
    // treat the body as absent and derive status/ok from the HTTP response.
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
  const environment = parseRelayEnvironment(body.environment);
  return {
    ok: typeof body.ok === "boolean" ? body.ok : response.ok && status >= 200 && status < 300,
    status,
    apnsId: parseReason(body.apnsId),
    reason: parseReason(body.reason),
    ...(environment ? { environment } : {}),
    tokenSuffix: parseReason(body.tokenSuffix),
  };
}

/** Sign and send an APNs relay push using the gateway device identity. */
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
  const gatewayIdentity = params.gatewayIdentity ?? loadOrCreateProcessDeviceIdentity();
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
