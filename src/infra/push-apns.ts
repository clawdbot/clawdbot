// Manages APNs registration state and direct/relay push sending.
import { createHash, createPrivateKey, sign as signJwt } from "node:crypto";
import fs from "node:fs/promises";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { DeviceIdentity } from "./device-identity.js";
import { formatErrorMessage, toErrorObject } from "./errors.js";
import {
  APNS_HTTP2_CANCEL_CODE,
  appendApnsResponseBodyCapture,
  connectApnsHttp2Session,
  createApnsResponseBodyCapture,
} from "./push-apns-http2.js";
import {
  createApnsAlertPayload,
  createApnsApprovalAlertPayload,
  createApnsApprovalResolvedPayload,
  createApnsBackgroundPayload,
  resolveExecApprovalAlertBody,
  resolvePluginApprovalAlertBody,
} from "./push-apns-payloads.js";
import {
  isLikelyApnsToken,
  isValidApnsTopic,
  normalizeApnsToken,
  normalizeApnsTopic,
  type ApnsEnvironment,
  type ApnsRegistration,
  type DirectApnsRegistration,
  type RelayApnsRegistration,
} from "./push-apns-store.js";
import {
  type ApnsRelayConfig,
  type ApnsRelayPushResponse,
  type ApnsRelayRequestSender,
  resolveApnsRelayConfigFromEnv,
  sendApnsRelayPush,
} from "./push-apns.relay.js";

export {
  clearApnsRegistrationIfCurrent,
  loadApnsRegistration,
  loadApnsRegistrations,
  normalizeApnsEnvironment,
  registerApnsRegistration,
} from "./push-apns-store.js";
export type { ApnsRegistration } from "./push-apns-store.js";

type ApnsTransport = "direct" | "relay";

/** Direct APNs provider authentication used to mint ES256 bearer tokens. */
export type ApnsAuthConfig = {
  teamId: string;
  keyId: string;
  privateKey: string;
};

type ApnsAuthConfigResolution = { ok: true; value: ApnsAuthConfig } | { ok: false; error: string };

/** Normalized APNs push result returned to gateway push/nodes methods. */
type ApnsPushResult = {
  ok: boolean;
  status: number;
  apnsId?: string;
  reason?: string;
  tokenSuffix: string;
  topic: string;
  environment: ApnsEnvironment;
  transport: ApnsTransport;
};

type ApnsPushAlertResult = ApnsPushResult;
type ApnsPushWakeResult = ApnsPushResult;

const EXEC_APPROVAL_NOTIFICATION_CATEGORY = "openclaw.exec-approval";
const PLUGIN_APPROVAL_NOTIFICATION_CATEGORY = "openclaw.plugin-approval";

type ApnsPushType = "alert" | "background";

type ApnsRequestParams = {
  token: string;
  topic: string;
  environment: ApnsEnvironment;
  bearerToken: string;
  payload: object;
  timeoutMs: number;
  pushType: ApnsPushType;
  priority: "10" | "5";
};

type ApnsRequestResponse = { status: number; apnsId?: string; body: string };

type ApnsRequestSender = (params: ApnsRequestParams) => Promise<ApnsRequestResponse>;

const APNS_JWT_TTL_MS = 50 * 60 * 1000;
const DEFAULT_APNS_TIMEOUT_MS = 10_000;

let cachedJwt: { cacheKey: string; token: string; expiresAtMs: number } | null = null;

function parseReason(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as { reason?: unknown };
    return typeof parsed.reason === "string" && parsed.reason.trim().length > 0
      ? parsed.reason.trim()
      : truncateUtf16Safe(trimmed, 200);
  } catch {
    return truncateUtf16Safe(trimmed, 200);
  }
}

function toBase64UrlBytes(value: Uint8Array): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function toBase64UrlJson(value: object): string {
  return toBase64UrlBytes(Buffer.from(JSON.stringify(value)));
}

function getJwtCacheKey(auth: ApnsAuthConfig): string {
  const keyHash = createHash("sha256").update(auth.privateKey).digest("hex");
  return `${auth.teamId}:${auth.keyId}:${keyHash}`;
}

function getApnsBearerToken(auth: ApnsAuthConfig, nowMs: number = Date.now()): string {
  const cacheKey = getJwtCacheKey(auth);
  if (cachedJwt && cachedJwt.cacheKey === cacheKey && nowMs < cachedJwt.expiresAtMs) {
    return cachedJwt.token;
  }

  // APNs provider tokens are valid for one hour. Cache for slightly less so
  // bursty wake/approval pushes avoid repeated ECDSA signing.
  const iat = Math.floor(nowMs / 1000);
  const header = toBase64UrlJson({ alg: "ES256", kid: auth.keyId, typ: "JWT" });
  const payload = toBase64UrlJson({ iss: auth.teamId, iat });
  const signingInput = `${header}.${payload}`;
  const signature = signJwt("sha256", Buffer.from(signingInput, "utf8"), {
    key: createPrivateKey(auth.privateKey),
    dsaEncoding: "ieee-p1363",
  });
  const token = `${signingInput}.${toBase64UrlBytes(signature)}`;
  cachedJwt = {
    cacheKey,
    token,
    expiresAtMs: nowMs + APNS_JWT_TTL_MS,
  };
  return token;
}

function normalizePrivateKey(value: string): string {
  return value.trim().replace(/\\n/g, "\n");
}

function normalizeNonEmptyString(value: string | undefined): string | null {
  const trimmed = normalizeOptionalString(value) ?? "";
  return trimmed.length > 0 ? trimmed : null;
}

/** Returns true for APNs responses that mean the direct device token is no longer usable. */
function shouldInvalidateApnsRegistration(result: { status: number; reason?: string }): boolean {
  if (result.status === 410) {
    return true;
  }
  return result.status === 400 && result.reason?.trim() === "BadDeviceToken";
}

/** Decides whether a failed direct push should clear the persisted registration. */
export function shouldClearStoredApnsRegistration(params: {
  registration: ApnsRegistration;
  result: { status: number; reason?: string };
  overrideEnvironment?: ApnsEnvironment | null;
}): boolean {
  if (params.registration.transport !== "direct") {
    return false;
  }
  if (
    params.overrideEnvironment &&
    params.overrideEnvironment !== params.registration.environment
  ) {
    return false;
  }
  return shouldInvalidateApnsRegistration(params.result);
}

/** Resolves direct APNs provider auth from env, accepting inline or file-backed keys. */
export async function resolveApnsAuthConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ApnsAuthConfigResolution> {
  const teamId = normalizeNonEmptyString(env.OPENCLAW_APNS_TEAM_ID);
  const keyId = normalizeNonEmptyString(env.OPENCLAW_APNS_KEY_ID);
  if (!teamId || !keyId) {
    return {
      ok: false,
      error: "APNs auth missing: set OPENCLAW_APNS_TEAM_ID and OPENCLAW_APNS_KEY_ID",
    };
  }

  const inlineKeyRaw =
    normalizeNonEmptyString(env.OPENCLAW_APNS_PRIVATE_KEY_P8) ??
    normalizeNonEmptyString(env.OPENCLAW_APNS_PRIVATE_KEY);
  if (inlineKeyRaw) {
    return {
      ok: true,
      value: {
        teamId,
        keyId,
        privateKey: normalizePrivateKey(inlineKeyRaw),
      },
    };
  }

  const keyPath = normalizeNonEmptyString(env.OPENCLAW_APNS_PRIVATE_KEY_PATH);
  if (!keyPath) {
    return {
      ok: false,
      error:
        "APNs private key missing: set OPENCLAW_APNS_PRIVATE_KEY_P8 or OPENCLAW_APNS_PRIVATE_KEY_PATH",
    };
  }
  try {
    const privateKey = normalizePrivateKey(await fs.readFile(keyPath, "utf8"));
    return {
      ok: true,
      value: {
        teamId,
        keyId,
        privateKey,
      },
    };
  } catch (err) {
    const message = formatErrorMessage(err);
    return {
      ok: false,
      error: `failed reading OPENCLAW_APNS_PRIVATE_KEY_PATH (${keyPath}): ${message}`,
    };
  }
}

async function sendApnsRequest(params: {
  token: string;
  topic: string;
  environment: ApnsEnvironment;
  bearerToken: string;
  payload: object;
  timeoutMs: number;
  pushType: ApnsPushType;
  priority: "10" | "5";
}): Promise<ApnsRequestResponse> {
  const authority =
    params.environment === "production"
      ? "https://api.push.apple.com"
      : "https://api.sandbox.push.apple.com";

  const body = JSON.stringify(params.payload);
  const requestPath = `/3/device/${params.token}`;

  const client = await connectApnsHttp2Session({
    authority,
    timeoutMs: params.timeoutMs,
  });

  return await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      client.destroy();
      reject(toErrorObject(err, "Non-Error rejection"));
    };
    const finish = (result: { status: number; apnsId?: string; body: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      client.close();
      resolve(result);
    };

    client.once("error", (err) => fail(err));

    const req = client.request({
      ":method": "POST",
      ":path": requestPath,
      authorization: `bearer ${params.bearerToken}`,
      "apns-topic": params.topic,
      "apns-push-type": params.pushType,
      "apns-priority": params.priority,
      "apns-expiration": "0",
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body).toString(),
    });

    let statusCode = 0;
    let apnsId: string | undefined;
    const responseBody = createApnsResponseBodyCapture();

    req.setEncoding("utf8");
    req.setTimeout(params.timeoutMs, () => {
      req.close(APNS_HTTP2_CANCEL_CODE);
      fail(new Error(`APNs request timed out after ${params.timeoutMs}ms`));
    });
    req.on("response", (headers) => {
      const statusHeader = headers[":status"];
      statusCode = statusHeader ?? 0;
      const idHeader = headers["apns-id"];
      if (typeof idHeader === "string" && idHeader.trim().length > 0) {
        apnsId = idHeader.trim();
      }
    });
    req.on("data", (chunk) => {
      if (typeof chunk === "string") {
        appendApnsResponseBodyCapture(responseBody, chunk);
      }
    });
    req.on("end", () => {
      finish({ status: statusCode, apnsId, body: responseBody.text });
    });
    req.on("error", (err) => fail(err));

    req.end(body);
  });
}

function resolveApnsTimeoutMs(timeoutMs: number | undefined): number {
  return resolveTimerTimeoutMs(timeoutMs, DEFAULT_APNS_TIMEOUT_MS, 1000);
}

function resolveDirectSendContext(params: {
  auth: ApnsAuthConfig;
  registration: DirectApnsRegistration;
}): {
  token: string;
  topic: string;
  environment: ApnsEnvironment;
  bearerToken: string;
} {
  const token = normalizeApnsToken(params.registration.token);
  if (!isLikelyApnsToken(token)) {
    throw new Error("invalid APNs token");
  }
  const topic = normalizeApnsTopic(params.registration.topic);
  if (!isValidApnsTopic(topic)) {
    throw new Error("topic required");
  }
  return {
    token,
    topic,
    environment: params.registration.environment,
    bearerToken: getApnsBearerToken(params.auth),
  };
}

function resolveRegistrationDebugSuffix(
  registration: ApnsRegistration,
  relayResult?: Pick<ApnsRelayPushResponse, "tokenSuffix">,
): string {
  if (registration.transport === "direct") {
    return registration.token.slice(-8);
  }
  return (
    relayResult?.tokenSuffix ?? registration.tokenDebugSuffix ?? registration.relayHandle.slice(-8)
  );
}

function toPushResult(params: {
  registration: ApnsRegistration;
  response: ApnsRequestResponse | ApnsRelayPushResponse;
  tokenSuffix?: string;
}): ApnsPushResult {
  const response =
    "body" in params.response
      ? {
          ok: params.response.status === 200,
          status: params.response.status,
          apnsId: params.response.apnsId,
          reason: parseReason(params.response.body),
          environment: params.registration.environment,
          tokenSuffix: params.tokenSuffix,
        }
      : params.response;
  return {
    ok: response.ok,
    status: response.status,
    apnsId: response.apnsId,
    reason: response.reason,
    tokenSuffix:
      params.tokenSuffix ??
      resolveRegistrationDebugSuffix(
        params.registration,
        "tokenSuffix" in response ? response : undefined,
      ),
    topic: params.registration.topic,
    environment: response.environment ?? params.registration.environment,
    transport: params.registration.transport,
  };
}

async function sendDirectApnsPush(params: {
  auth: ApnsAuthConfig;
  registration: DirectApnsRegistration;
  payload: object;
  timeoutMs?: number;
  requestSender?: ApnsRequestSender;
  pushType: ApnsPushType;
  priority: "10" | "5";
}): Promise<ApnsPushResult> {
  const { token, topic, environment, bearerToken } = resolveDirectSendContext({
    auth: params.auth,
    registration: params.registration,
  });
  const sender = params.requestSender ?? sendApnsRequest;
  const response = await sender({
    token,
    topic,
    environment,
    bearerToken,
    payload: params.payload,
    timeoutMs: resolveApnsTimeoutMs(params.timeoutMs),
    pushType: params.pushType,
    priority: params.priority,
  });
  return toPushResult({
    registration: params.registration,
    response,
    tokenSuffix: token.slice(-8),
  });
}

async function sendRelayApnsPush(params: {
  relayConfig: ApnsRelayConfig;
  registration: RelayApnsRegistration;
  payload: object;
  pushType: ApnsPushType;
  priority: "10" | "5";
  gatewayIdentity?: Pick<DeviceIdentity, "deviceId" | "privateKeyPem">;
  requestSender?: ApnsRelayRequestSender;
}): Promise<ApnsPushResult> {
  const response = await sendApnsRelayPush({
    relayConfig: params.relayConfig,
    sendGrant: params.registration.sendGrant,
    relayHandle: params.registration.relayHandle,
    payload: params.payload,
    pushType: params.pushType,
    priority: params.priority,
    gatewayIdentity: params.gatewayIdentity,
    requestSender: params.requestSender,
  });
  return toPushResult({ registration: params.registration, response });
}

type ApnsAlertCommonParams = {
  nodeId: string;
  title: string;
  body: string;
  timeoutMs?: number;
};

type DirectApnsAlertParams = ApnsAlertCommonParams & {
  registration: DirectApnsRegistration;
  auth: ApnsAuthConfig;
  requestSender?: ApnsRequestSender;
  relayConfig?: never;
  relayRequestSender?: never;
};

type RelayApnsAlertParams = ApnsAlertCommonParams & {
  registration: RelayApnsRegistration;
  relayConfig: ApnsRelayConfig;
  relayRequestSender?: ApnsRelayRequestSender;
  relayGatewayIdentity?: Pick<DeviceIdentity, "deviceId" | "privateKeyPem">;
  auth?: never;
  requestSender?: never;
};

type ApnsBackgroundWakeCommonParams = {
  nodeId: string;
  wakeReason?: string;
  timeoutMs?: number;
};

type DirectApnsBackgroundWakeParams = ApnsBackgroundWakeCommonParams & {
  registration: DirectApnsRegistration;
  auth: ApnsAuthConfig;
  requestSender?: ApnsRequestSender;
  relayConfig?: never;
  relayRequestSender?: never;
};

type RelayApnsBackgroundWakeParams = ApnsBackgroundWakeCommonParams & {
  registration: RelayApnsRegistration;
  relayConfig: ApnsRelayConfig;
  relayRequestSender?: ApnsRelayRequestSender;
  relayGatewayIdentity?: Pick<DeviceIdentity, "deviceId" | "privateKeyPem">;
  auth?: never;
  requestSender?: never;
};

type ApnsApprovalCommonParams = {
  nodeId: string;
  approvalId: string;
  gatewayDeviceId: string;
  timeoutMs?: number;
};

type DirectApnsApprovalParams = ApnsApprovalCommonParams & {
  registration: DirectApnsRegistration;
  auth: ApnsAuthConfig;
  requestSender?: ApnsRequestSender;
  relayConfig?: never;
  relayRequestSender?: never;
};

type RelayApnsApprovalParams = ApnsApprovalCommonParams & {
  registration: RelayApnsRegistration;
  relayConfig: ApnsRelayConfig;
  relayRequestSender?: ApnsRelayRequestSender;
  relayGatewayIdentity?: Pick<DeviceIdentity, "deviceId" | "privateKeyPem">;
  auth?: never;
  requestSender?: never;
};

type ApnsApprovalParams = DirectApnsApprovalParams | RelayApnsApprovalParams;

type ApnsPluginApprovalAlertParams = ApnsApprovalParams & {
  title?: string | null;
  description: string;
};

/** Sends a visible APNs alert via direct APNs token or relay registration. */
export async function sendApnsAlert(
  params: DirectApnsAlertParams | RelayApnsAlertParams,
): Promise<ApnsPushAlertResult> {
  const payload = createApnsAlertPayload({
    nodeId: params.nodeId,
    title: params.title,
    body: params.body,
  });

  if (params.registration.transport === "relay") {
    const relayParams = params as RelayApnsAlertParams;
    return await sendRelayApnsPush({
      relayConfig: relayParams.relayConfig,
      registration: relayParams.registration,
      payload,
      pushType: "alert",
      priority: "10",
      gatewayIdentity: relayParams.relayGatewayIdentity,
      requestSender: relayParams.relayRequestSender,
    });
  }
  const directParams = params as DirectApnsAlertParams;
  return await sendDirectApnsPush({
    auth: directParams.auth,
    registration: directParams.registration,
    payload,
    timeoutMs: directParams.timeoutMs,
    requestSender: directParams.requestSender,
    pushType: "alert",
    priority: "10",
  });
}

/** Sends a silent background wake via direct APNs token or relay registration. */
export async function sendApnsBackgroundWake(
  params: DirectApnsBackgroundWakeParams | RelayApnsBackgroundWakeParams,
): Promise<ApnsPushWakeResult> {
  const payload = createApnsBackgroundPayload({
    nodeId: params.nodeId,
    wakeReason: params.wakeReason,
  });

  if (params.registration.transport === "relay") {
    const relayParams = params as RelayApnsBackgroundWakeParams;
    return await sendRelayApnsPush({
      relayConfig: relayParams.relayConfig,
      registration: relayParams.registration,
      payload,
      pushType: "background",
      priority: "5",
      gatewayIdentity: relayParams.relayGatewayIdentity,
      requestSender: relayParams.relayRequestSender,
    });
  }
  const directParams = params as DirectApnsBackgroundWakeParams;
  return await sendDirectApnsPush({
    auth: directParams.auth,
    registration: directParams.registration,
    payload,
    timeoutMs: directParams.timeoutMs,
    requestSender: directParams.requestSender,
    pushType: "background",
    priority: "5",
  });
}

async function sendApnsApprovalPush(params: {
  transport: ApnsApprovalParams;
  payload: object;
  pushType: ApnsPushType;
  priority: "10" | "5";
}): Promise<ApnsPushResult> {
  const transport = params.transport;
  if (transport.registration.transport === "relay") {
    const relayParams = transport as RelayApnsApprovalParams;
    return await sendRelayApnsPush({
      relayConfig: relayParams.relayConfig,
      registration: relayParams.registration,
      payload: params.payload,
      pushType: params.pushType,
      priority: params.priority,
      gatewayIdentity: relayParams.relayGatewayIdentity,
      requestSender: relayParams.relayRequestSender,
    });
  }
  const directParams = transport as DirectApnsApprovalParams;
  return await sendDirectApnsPush({
    auth: directParams.auth,
    registration: directParams.registration,
    payload: params.payload,
    timeoutMs: directParams.timeoutMs,
    requestSender: directParams.requestSender,
    pushType: params.pushType,
    priority: params.priority,
  });
}

/** Sends an exec-approval alert notification via direct APNs or relay. */
export async function sendApnsExecApprovalAlert(
  params: ApnsApprovalParams,
): Promise<ApnsPushAlertResult> {
  return await sendApnsApprovalPush({
    transport: params,
    payload: createApnsApprovalAlertPayload({
      kind: "exec",
      approvalId: params.approvalId,
      gatewayDeviceId: params.gatewayDeviceId,
      title: "Exec approval required",
      body: resolveExecApprovalAlertBody(),
      category: EXEC_APPROVAL_NOTIFICATION_CATEGORY,
    }),
    pushType: "alert",
    priority: "10",
  });
}

/** Sends a plugin-approval alert notification via direct APNs or relay. */
export async function sendApnsPluginApprovalAlert(
  params: ApnsPluginApprovalAlertParams,
): Promise<ApnsPushAlertResult> {
  return await sendApnsApprovalPush({
    transport: params,
    payload: createApnsApprovalAlertPayload({
      kind: "plugin",
      approvalId: params.approvalId,
      gatewayDeviceId: params.gatewayDeviceId,
      title: normalizeOptionalString(params.title) ?? "Approval required",
      body: resolvePluginApprovalAlertBody(params.description),
      category: PLUGIN_APPROVAL_NOTIFICATION_CATEGORY,
    }),
    pushType: "alert",
    priority: "10",
  });
}

async function sendApnsApprovalResolvedWake(params: {
  transport: ApnsApprovalParams;
  kind: "exec" | "plugin";
}): Promise<ApnsPushWakeResult> {
  return await sendApnsApprovalPush({
    transport: params.transport,
    payload: createApnsApprovalResolvedPayload({
      kind: params.kind,
      approvalId: params.transport.approvalId,
      gatewayDeviceId: params.transport.gatewayDeviceId,
    }),
    pushType: "background",
    priority: "5",
  });
}

/** Sends a silent wake telling the app an exec approval changed state. */
export async function sendApnsExecApprovalResolvedWake(
  params: ApnsApprovalParams,
): Promise<ApnsPushWakeResult> {
  return await sendApnsApprovalResolvedWake({ transport: params, kind: "exec" });
}

/** Sends a silent wake telling the app a plugin approval changed state. */
export async function sendApnsPluginApprovalResolvedWake(
  params: ApnsApprovalParams,
): Promise<ApnsPushWakeResult> {
  return await sendApnsApprovalResolvedWake({ transport: params, kind: "plugin" });
}

export { type ApnsRelayConfig, resolveApnsRelayConfigFromEnv };
