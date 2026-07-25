// Openai plugin module implements openai chatgpt device code behavior.
import {
  shouldUseEnvHttpProxyForUrl,
  withTrustedEnvProxyGuardedFetchMode,
} from "openclaw/plugin-sdk/fetch-runtime";
import {
  positiveSecondsToSafeMilliseconds,
  resolveExpiresAtMsFromDurationSeconds,
} from "openclaw/plugin-sdk/number-runtime";
import { readResponseTextLimited } from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveCodexAccessTokenExpiry } from "./openai-chatgpt-auth-identity.js";
import { trimNonEmptyString } from "./openai-chatgpt-shared.js";

const OPENAI_AUTH_BASE_URL = "https://auth.openai.com";
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS = 15 * 60_000;
const OPENAI_CODEX_DEVICE_REQUEST_TIMEOUT_MS = 30_000;
const OPENAI_CODEX_DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const OPENAI_CODEX_DEVICE_CODE_MIN_INTERVAL_MS = 1_000;
const OPENAI_CODEX_DEVICE_CALLBACK_URL = `${OPENAI_AUTH_BASE_URL}/deviceauth/callback`;
const OPENAI_CODEX_DEVICE_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const OPENAI_CODEX_DEVICE_JSON_BODY_LIMIT_BYTES = 256 * 1024;

function resolveOpenAICodexDeviceCodeHeaders(contentType: string): Record<string, string> {
  const version = process.env.OPENCLAW_VERSION?.trim();
  return {
    "Content-Type": contentType,
    originator: "openclaw",
    ...(version ? { version } : {}),
    "User-Agent": version ? `openclaw/${version}` : "openclaw",
  };
}

type OpenAICodexDeviceCodePrompt = {
  verificationUrl: string;
  userCode: string;
  expiresInMs: number;
};

type OpenAICodexDeviceCodeCredentials = {
  access: string;
  refresh: string;
  expires: number;
};

type DeviceCodeUserCodePayload = {
  device_auth_id?: unknown;
  user_code?: unknown;
  usercode?: unknown;
  interval?: unknown;
};

type DeviceCodeTokenPayload = {
  authorization_code?: unknown;
  code_challenge?: unknown;
  code_verifier?: unknown;
};

type OAuthTokenPayload = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
};

type RequestedDeviceCode = {
  deviceAuthId: string;
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
};

type DeviceCodeAuthorizationCode = {
  authorizationCode: string;
  codeVerifier: string;
};

type DeviceCodeHttpResult = {
  ok: boolean;
  status: number;
  bodyText: string;
};

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function sanitizeDeviceCodeErrorText(value: string): string {
  const esc = String.fromCharCode(0x1b);
  const ansiCsiRegex = new RegExp(`${esc}\\[[\\u0020-\\u003f]*[\\u0040-\\u007e]`, "g");
  const osc8Regex = new RegExp(`${esc}\\]8;;.*?${esc}\\\\|${esc}\\]8;;${esc}\\\\`, "g");
  const c0Start = String.fromCharCode(0x00);
  const c0End = String.fromCharCode(0x1f);
  const del = String.fromCharCode(0x7f);
  const c1Start = String.fromCharCode(0x80);
  const c1End = String.fromCharCode(0x9f);
  const controlCharsRegex = new RegExp(`[${c0Start}-${c0End}${del}${c1Start}-${c1End}]`, "g");
  return value
    .replace(osc8Regex, "")
    .replace(ansiCsiRegex, "")
    .replace(controlCharsRegex, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveNextDeviceCodePollDelayMs(intervalMs: number, deadlineMs: number): number {
  const remainingMs = Math.max(0, deadlineMs - Date.now());
  return Math.min(Math.max(intervalMs, OPENAI_CODEX_DEVICE_CODE_MIN_INTERVAL_MS), remainingMs);
}

function resolveDeviceCodePollRequestTimeoutMs(deadlineMs: number): number {
  return Math.min(OPENAI_CODEX_DEVICE_REQUEST_TIMEOUT_MS, Math.max(0, deadlineMs - Date.now()));
}

function isDeviceCodeOperationTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function rethrowIfDeviceCodeCallerAborted(signal: AbortSignal | undefined, error: unknown): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : error;
  }
}

function formatDeviceCodeError(params: {
  prefix: string;
  status: number;
  bodyText: string;
}): string {
  const body = parseJsonObject(params.bodyText);
  const error = trimNonEmptyString(body?.error);
  const description = trimNonEmptyString(body?.error_description);
  const safeError = error ? sanitizeDeviceCodeErrorText(error) : undefined;
  const safeDescription = description ? sanitizeDeviceCodeErrorText(description) : undefined;
  if (safeError && safeDescription) {
    return `${params.prefix}: ${safeError} (${safeDescription})`;
  }
  if (safeError) {
    return `${params.prefix}: ${safeError}`;
  }
  const bodyText = sanitizeDeviceCodeErrorText(params.bodyText);
  return bodyText
    ? `${params.prefix}: HTTP ${params.status} ${bodyText}`
    : `${params.prefix}: HTTP ${params.status}`;
}

async function readOpenAICodexDeviceBody(response: Response): Promise<string> {
  return await readResponseTextLimited(
    response,
    response.ok
      ? OPENAI_CODEX_DEVICE_JSON_BODY_LIMIT_BYTES
      : OPENAI_CODEX_DEVICE_ERROR_BODY_LIMIT_BYTES,
  );
}

async function runOpenAICodexDeviceRequest(params: {
  fetchFn: typeof fetch;
  url: string;
  init: Omit<RequestInit, "signal">;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<DeviceCodeHttpResult> {
  const guardedOptions = {
    url: params.url,
    fetchImpl: params.fetchFn,
    init: params.init,
    timeoutMs: params.timeoutMs,
    ...(params.signal ? { signal: params.signal } : {}),
    requireHttps: true,
    auditContext: "openai-chatgpt-device-code",
  };
  const { response, release } = await fetchWithSsrFGuard(
    shouldUseEnvHttpProxyForUrl(params.url)
      ? withTrustedEnvProxyGuardedFetchMode(guardedOptions)
      : guardedOptions,
  );
  try {
    return {
      ok: response.ok,
      status: response.status,
      bodyText: await readOpenAICodexDeviceBody(response),
    };
  } finally {
    await release();
  }
}

async function fetchOpenAICodexDeviceCode(params: {
  fetchFn: typeof fetch;
  url: string;
  init: Omit<RequestInit, "signal">;
  timeoutOperation: string;
  signal?: AbortSignal;
}): Promise<DeviceCodeHttpResult> {
  try {
    return await runOpenAICodexDeviceRequest({
      ...params,
      timeoutMs: OPENAI_CODEX_DEVICE_REQUEST_TIMEOUT_MS,
    });
  } catch (error) {
    rethrowIfDeviceCodeCallerAborted(params.signal, error);
    if (isDeviceCodeOperationTimeoutError(error)) {
      throw new Error(
        `OpenAI device code ${params.timeoutOperation} timed out after ${OPENAI_CODEX_DEVICE_REQUEST_TIMEOUT_MS}ms`,
        { cause: error },
      );
    }
    throw error;
  }
}

async function requestOpenAICodexDeviceCode(
  fetchFn: typeof fetch,
  signal?: AbortSignal,
): Promise<RequestedDeviceCode> {
  signal?.throwIfAborted();
  const result = await fetchOpenAICodexDeviceCode({
    fetchFn,
    url: `${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`,
    init: {
      method: "POST",
      headers: resolveOpenAICodexDeviceCodeHeaders("application/json"),
      body: JSON.stringify({
        client_id: OPENAI_CODEX_CLIENT_ID,
      }),
    },
    timeoutOperation: "user code request",
    ...(signal ? { signal } : {}),
  });

  if (!result.ok) {
    if (result.status === 404) {
      throw new Error(
        "OpenAI Codex device code login is not enabled for this server. Use ChatGPT OAuth instead.",
      );
    }
    throw new Error(
      formatDeviceCodeError({
        prefix: "OpenAI device code request failed",
        status: result.status,
        bodyText: result.bodyText,
      }),
    );
  }

  const body = parseJsonObject(result.bodyText) as DeviceCodeUserCodePayload | null;
  const deviceAuthId = trimNonEmptyString(body?.device_auth_id);
  const userCode = trimNonEmptyString(body?.user_code) ?? trimNonEmptyString(body?.usercode);
  if (!deviceAuthId || !userCode) {
    throw new Error("OpenAI device code response was missing the device code or user code.");
  }

  return {
    deviceAuthId,
    userCode,
    verificationUrl: `${OPENAI_AUTH_BASE_URL}/codex/device`,
    intervalMs:
      positiveSecondsToSafeMilliseconds(body?.interval) ??
      OPENAI_CODEX_DEVICE_CODE_DEFAULT_INTERVAL_MS,
  };
}

async function pollOpenAICodexDeviceCode(params: {
  fetchFn: typeof fetch;
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  signal?: AbortSignal;
}): Promise<DeviceCodeAuthorizationCode> {
  const deadline = Date.now() + OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    params.signal?.throwIfAborted();
    const requestTimeoutMs = resolveDeviceCodePollRequestTimeoutMs(deadline);
    if (requestTimeoutMs <= 0) {
      break;
    }

    let result: DeviceCodeHttpResult;
    try {
      result = await runOpenAICodexDeviceRequest({
        fetchFn: params.fetchFn,
        url: `${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/token`,
        init: {
          method: "POST",
          headers: resolveOpenAICodexDeviceCodeHeaders("application/json"),
          body: JSON.stringify({
            device_auth_id: params.deviceAuthId,
            user_code: params.userCode,
          }),
        },
        timeoutMs: requestTimeoutMs,
        ...(params.signal ? { signal: params.signal } : {}),
      });
    } catch (error) {
      rethrowIfDeviceCodeCallerAborted(params.signal, error);
      // A stalled poll is transient; keep the overall 15-minute authorization deadline.
      if (isDeviceCodeOperationTimeoutError(error)) {
        continue;
      }
      throw error;
    }

    if (result.ok) {
      const body = parseJsonObject(result.bodyText) as DeviceCodeTokenPayload | null;
      const authorizationCode = trimNonEmptyString(body?.authorization_code);
      const codeVerifier = trimNonEmptyString(body?.code_verifier);
      if (!authorizationCode || !codeVerifier) {
        throw new Error("OpenAI device authorization response was missing the exchange code.");
      }
      return {
        authorizationCode,
        codeVerifier,
      };
    }

    if (result.status === 403 || result.status === 404) {
      await waitForDeviceCodePoll(
        resolveNextDeviceCodePollDelayMs(params.intervalMs, deadline),
        params.signal,
      );
      continue;
    }

    throw new Error(
      formatDeviceCodeError({
        prefix: "OpenAI device authorization failed",
        status: result.status,
        bodyText: result.bodyText,
      }),
    );
  }

  throw new Error("OpenAI device authorization timed out after 15 minutes.");
}

async function exchangeOpenAICodexDeviceCode(params: {
  fetchFn: typeof fetch;
  authorizationCode: string;
  codeVerifier: string;
  signal?: AbortSignal;
}): Promise<OpenAICodexDeviceCodeCredentials> {
  params.signal?.throwIfAborted();
  const result = await fetchOpenAICodexDeviceCode({
    fetchFn: params.fetchFn,
    url: `${OPENAI_AUTH_BASE_URL}/oauth/token`,
    init: {
      method: "POST",
      headers: resolveOpenAICodexDeviceCodeHeaders("application/x-www-form-urlencoded"),
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: params.authorizationCode,
        redirect_uri: OPENAI_CODEX_DEVICE_CALLBACK_URL,
        client_id: OPENAI_CODEX_CLIENT_ID,
        code_verifier: params.codeVerifier,
      }),
    },
    timeoutOperation: "token exchange",
    ...(params.signal ? { signal: params.signal } : {}),
  });

  if (!result.ok) {
    throw new Error(
      formatDeviceCodeError({
        prefix: "OpenAI device token exchange failed",
        status: result.status,
        bodyText: result.bodyText,
      }),
    );
  }

  const body = parseJsonObject(result.bodyText) as OAuthTokenPayload | null;
  const access = trimNonEmptyString(body?.access_token);
  const refresh = trimNonEmptyString(body?.refresh_token);
  if (!access || !refresh) {
    throw new Error("OpenAI token exchange succeeded but did not return OAuth tokens.");
  }

  const expires =
    resolveExpiresAtMsFromDurationSeconds(body?.expires_in) ??
    resolveCodexAccessTokenExpiry(access) ??
    Date.now();

  return {
    access,
    refresh,
    expires,
  };
}

export async function loginOpenAICodexDeviceCode(params: {
  fetchFn?: typeof fetch;
  onVerification: (prompt: OpenAICodexDeviceCodePrompt) => Promise<void> | void;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}): Promise<OpenAICodexDeviceCodeCredentials> {
  const fetchFn = params.fetchFn ?? fetch;

  params.onProgress?.("Requesting device code…");
  const deviceCode = await requestOpenAICodexDeviceCode(fetchFn, params.signal);

  await params.onVerification({
    verificationUrl: deviceCode.verificationUrl,
    userCode: deviceCode.userCode,
    expiresInMs: OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS,
  });

  params.onProgress?.("Waiting for device authorization…");
  const authorization = await pollOpenAICodexDeviceCode({
    fetchFn,
    deviceAuthId: deviceCode.deviceAuthId,
    userCode: deviceCode.userCode,
    intervalMs: deviceCode.intervalMs,
    ...(params.signal ? { signal: params.signal } : {}),
  });

  params.onProgress?.("Exchanging device code…");
  return await exchangeOpenAICodexDeviceCode({
    fetchFn,
    authorizationCode: authorization.authorizationCode,
    codeVerifier: authorization.codeVerifier,
    ...(params.signal ? { signal: params.signal } : {}),
  });
}

function waitForDeviceCodePoll(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error("Device login cancelled"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
