import { resolveCodexAccessTokenExpiry } from "./openai-codex-auth-identity.js";
import { trimNonEmptyString } from "./openai-codex-shared.js";

const OPENAI_AUTH_BASE_URL = "https://auth.openai.com";
const OPENAI_CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS = 15 * 60_000;
const OPENAI_CODEX_DEVICE_CODE_DEFAULT_INTERVAL_MS = 5_000;
const OPENAI_CODEX_DEVICE_CODE_MIN_INTERVAL_MS = 1_000;
const OPENAI_CODEX_DEVICE_CALLBACK_URL = `${OPENAI_AUTH_BASE_URL}/deviceauth/callback`;

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

function normalizePositiveMilliseconds(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value * 1000);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    const seconds = Number.parseInt(value.trim(), 10);
    return seconds > 0 ? seconds * 1000 : undefined;
  }
  return undefined;
}

function normalizeTokenLifetimeMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value * 1000);
  }
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10) * 1000;
  }
  return undefined;
}

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

async function requestOpenAICodexDeviceCode(fetchFn: typeof fetch): Promise<RequestedDeviceCode> {
  const response = await fetchFn(`${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: OPENAI_CODEX_CLIENT_ID,
    }),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        "OpenAI Codex device code login is not enabled for this server. Use ChatGPT OAuth instead.",
      );
    }
    throw new Error(
      formatDeviceCodeError({
        prefix: "OpenAI device code request failed",
        status: response.status,
        bodyText,
      }),
    );
  }

  const body = parseJsonObject(bodyText) as DeviceCodeUserCodePayload | null;
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
      normalizePositiveMilliseconds(body?.interval) ?? OPENAI_CODEX_DEVICE_CODE_DEFAULT_INTERVAL_MS,
  };
}

async function pollOpenAICodexDeviceCode(params: {
  fetchFn: typeof fetch;
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
}): Promise<DeviceCodeAuthorizationCode> {
  const deadline = Date.now() + OPENAI_CODEX_DEVICE_CODE_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const response = await params.fetchFn(`${OPENAI_AUTH_BASE_URL}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        device_auth_id: params.deviceAuthId,
        user_code: params.userCode,
      }),
    });

    const bodyText = await response.text();
    if (response.ok) {
      const body = parseJsonObject(bodyText) as DeviceCodeTokenPayload | null;
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

    if (response.status === 403 || response.status === 404) {
      await new Promise((resolve) =>
        setTimeout(resolve, resolveNextDeviceCodePollDelayMs(params.intervalMs, deadline)),
      );
      continue;
    }

    throw new Error(
      formatDeviceCodeError({
        prefix: "OpenAI device authorization failed",
        status: response.status,
        bodyText,
      }),
    );
  }

  throw new Error("OpenAI device authorization timed out after 15 minutes.");
}

async function exchangeOpenAICodexDeviceCode(params: {
  fetchFn: typeof fetch;
  authorizationCode: string;
  codeVerifier: string;
}): Promise<OpenAICodexDeviceCodeCredentials> {
  const response = await params.fetchFn(`${OPENAI_AUTH_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: params.authorizationCode,
      redirect_uri: OPENAI_CODEX_DEVICE_CALLBACK_URL,
      client_id: OPENAI_CODEX_CLIENT_ID,
      code_verifier: params.codeVerifier,
    }),
  });

  const bodyText = await response.text();
  if (!response.ok) {
    throw new Error(
      formatDeviceCodeError({
        prefix: "OpenAI device token exchange failed",
        status: response.status,
        bodyText,
      }),
    );
  }

  const body = parseJsonObject(bodyText) as OAuthTokenPayload | null;
  const access = trimNonEmptyString(body?.access_token);
  const refresh = trimNonEmptyString(body?.refresh_token);
  if (!access || !refresh) {
    throw new Error("OpenAI token exchange succeeded but did not return OAuth tokens.");
  }

  const expiresInMs = normalizeTokenLifetimeMs(body?.expires_in);
  const expires =
    expiresInMs !== undefined
      ? Date.now() + expiresInMs
      : (resolveCodexAccessTokenExpiry(access) ?? Date.now());

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
}): Promise<OpenAICodexDeviceCodeCredentials> {
  const fetchFn = params.fetchFn ?? fetch;

  params.onProgress?.("Requesting device code…");
  const deviceCode = await requestOpenAICodexDeviceCode(fetchFn);

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
  });

  params.onProgress?.("Exchanging device code…");
  return await exchangeOpenAICodexDeviceCode({
    fetchFn,
    authorizationCode: authorization.authorizationCode,
    codeVerifier: authorization.codeVerifier,
  });
}
