// Manages APNs registration state and direct/relay push sending.
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { DeviceIdentity } from "./device-identity.js";
import { toErrorObject } from "./errors.js";
import { getApnsBearerToken, type ApnsAuthConfig } from "./push-apns-auth.js";
import {
  APNS_HTTP2_CANCEL_CODE,
  appendApnsResponseBodyCapture,
  connectApnsHttp2Session,
  createApnsResponseBodyCapture,
  getApnsResponseBodyCaptureText,
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
  ApnsRegistrationPairingChangedError,
  clearApnsRegistrationIfCurrent,
  loadApnsRegistration,
  loadApnsRegistrations,
  normalizeApnsEnvironment,
  registerApnsRegistration,
} from "./push-apns-store.js";
export type { ApnsRegistration } from "./push-apns-store.js";
export { resolveApnsAuthConfigFromEnv } from "./push-apns-auth.js";
export type { ApnsAuthConfig } from "./push-apns-auth.js";

type ApnsTransport = "direct" | "relay";

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
  signal?: AbortSignal;
  isCurrent?: () => Promise<boolean>;
};

type ApnsRequestResponse = { status: number; apnsId?: string; body: string };

type ApnsRequestSender = (params: ApnsRequestParams) => Promise<ApnsRequestResponse>;

const DEFAULT_APNS_TIMEOUT_MS = 10_000;

function throwIfApnsSendAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error ? signal.reason : new Error("APNs send invalidated");
}

async function requireCurrentApnsSend(params: {
  signal?: AbortSignal;
  isCurrent?: () => Promise<boolean>;
}): Promise<void> {
  throwIfApnsSendAborted(params.signal);
  if (params.isCurrent && !(await params.isCurrent())) {
    throw new Error("APNs send invalidated");
  }
  throwIfApnsSendAborted(params.signal);
}

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

async function sendApnsRequest(params: {
  token: string;
  topic: string;
  environment: ApnsEnvironment;
  bearerToken: string;
  payload: object;
  timeoutMs: number;
  pushType: ApnsPushType;
  priority: "10" | "5";
  signal?: AbortSignal;
  isCurrent?: () => Promise<boolean>;
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
    ...(params.signal ? { signal: params.signal } : {}),
  });

  // Connection failures can arrive while the persistent ownership check is
  // yielding. Keep a consuming owner until the session closes, while the
  // request-specific listener below still rejects the active send.
  const consumeSessionError = () => undefined;
  client.on("error", consumeSessionError);
  client.once("close", () => client.off("error", consumeSessionError));

  return await new Promise((resolve, reject) => {
    let settled = false;
    let activeRequest: ReturnType<typeof client.request> | undefined;
    const cleanup = () => {
      client.off("error", fail);
      params.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (err: unknown, options?: { cancelRequest?: boolean }) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (options?.cancelRequest && activeRequest && !activeRequest.destroyed) {
        activeRequest.close(APNS_HTTP2_CANCEL_CODE);
        client.close();
      } else {
        client.destroy();
      }
      reject(toErrorObject(err, "Non-Error rejection"));
    };
    const onAbort = () =>
      fail(
        params.signal?.reason instanceof Error
          ? params.signal.reason
          : new Error("APNs send invalidated"),
        { cancelRequest: true },
      );
    const finish = (result: { status: number; apnsId?: string; body: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      client.close();
      resolve(result);
    };

    const startRequest = async () => {
      try {
        await requireCurrentApnsSend(params);
        if (settled) {
          return;
        }
        if (params.signal?.aborted) {
          onAbort();
          return;
        }

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
        activeRequest = req;

        let statusCode = 0;
        let apnsId: string | undefined;
        const responseBody = createApnsResponseBodyCapture();

        req.setTimeout(params.timeoutMs, () => {
          fail(new Error(`APNs request timed out after ${params.timeoutMs}ms`), {
            cancelRequest: true,
          });
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
          appendApnsResponseBodyCapture(responseBody, chunk);
        });
        req.on("end", () => {
          finish({
            status: statusCode,
            apnsId,
            body: getApnsResponseBodyCaptureText(responseBody),
          });
        });
        req.on("error", (err) => fail(err));

        if (params.signal?.aborted) {
          onAbort();
          return;
        }
        req.end(body);
      } catch (error) {
        fail(error);
      }
    };

    client.once("error", fail);
    params.signal?.addEventListener("abort", onAbort, { once: true });
    if (params.signal?.aborted) {
      onAbort();
      return;
    }
    void startRequest();
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
  signal?: AbortSignal;
  isCurrent?: () => Promise<boolean>;
}): Promise<ApnsPushResult> {
  const { token, topic, environment, bearerToken } = resolveDirectSendContext({
    auth: params.auth,
    registration: params.registration,
  });
  await requireCurrentApnsSend(params);
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
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.isCurrent ? { isCurrent: params.isCurrent } : {}),
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
  signal?: AbortSignal;
  isCurrent?: () => Promise<boolean>;
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
    ...(params.signal ? { signal: params.signal } : {}),
    ...(params.isCurrent ? { isCurrent: params.isCurrent } : {}),
  });
  return toPushResult({ registration: params.registration, response });
}

type ApnsAlertCommonParams = {
  nodeId: string;
  title: string;
  body: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  isCurrent?: () => Promise<boolean>;
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
  signal?: AbortSignal;
  isCurrent?: () => Promise<boolean>;
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
      ...(relayParams.signal ? { signal: relayParams.signal } : {}),
      ...(relayParams.isCurrent ? { isCurrent: relayParams.isCurrent } : {}),
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
    ...(directParams.signal ? { signal: directParams.signal } : {}),
    ...(directParams.isCurrent ? { isCurrent: directParams.isCurrent } : {}),
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
      ...(relayParams.signal ? { signal: relayParams.signal } : {}),
      ...(relayParams.isCurrent ? { isCurrent: relayParams.isCurrent } : {}),
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
    ...(directParams.signal ? { signal: directParams.signal } : {}),
    ...(directParams.isCurrent ? { isCurrent: directParams.isCurrent } : {}),
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
