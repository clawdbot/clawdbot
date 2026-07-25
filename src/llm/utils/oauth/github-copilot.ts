/**
 * GitHub Copilot OAuth flow
 */

import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import {
  assertOkOrThrowProviderError,
  readProviderJsonResponse,
} from "../../../agents/provider-http-errors.js";
import {
  nonNegativeSecondsToSafeMilliseconds,
  positiveSecondsToSafeMilliseconds,
  resolveExpiresAtMsFromDurationSeconds,
  resolveExpiresAtMsFromEpochSeconds,
} from "../../../infra/parse-finite-number.js";
import {
  isSupportedGithubCopilotDomain,
  normalizeGithubCopilotDomain,
} from "../../../plugin-sdk/github-copilot-domain.js";
import { resolveGithubCopilotTokenEndpoint } from "../../../plugin-sdk/github-copilot-token-endpoint.js";
import type {
  CopilotModelListEntry,
  CopilotRequestOptions,
  DeviceCodeResponse,
  DeviceTokenErrorResponse,
  DeviceTokenSuccessResponse,
} from "../../github-copilot-oauth-types.js";
import type { Model } from "../../types.js";
import type { OAuthCredentials, OAuthLoginCallbacks, OAuthProviderInterface } from "./types.js";

type CopilotCredentials = OAuthCredentials & {
  enterpriseUrl?: string;
};

const CLIENT_ID = "Iv1.b507a08c87ecfe98";

const COPILOT_HEADERS = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
} as const;

const INITIAL_POLL_INTERVAL_MULTIPLIER = 1.2;
const SLOW_DOWN_POLL_INTERVAL_MULTIPLIER = 1.4;
const COPILOT_ROUTER_ID_PREFIX = "accounts/";
const COPILOT_REQUEST_TIMEOUT_MS = 30_000;

function resolveExpiresAtFromDurationSeconds(value: unknown): number | undefined {
  return resolveExpiresAtMsFromDurationSeconds(value);
}

function resolveExpiresAtFromEpochSeconds(value: unknown): number | undefined {
  return resolveExpiresAtMsFromEpochSeconds(value, { bufferMs: 5 * 60 * 1000 });
}

function normalizeDomain(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }
  try {
    const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return url.hostname;
  } catch {
    return null;
  }
}

function getUrls(domain: string): {
  deviceCodeUrl: string;
  accessTokenUrl: string;
  copilotTokenUrl: string;
} {
  const safeDomain = normalizeGithubCopilotDomain(domain);
  return {
    deviceCodeUrl: `https://${safeDomain}/login/device/code`,
    accessTokenUrl: `https://${safeDomain}/login/oauth/access_token`,
    copilotTokenUrl: `https://api.${safeDomain}/copilot_internal/v2/token`,
  };
}

function getGitHubCopilotBaseUrl(token?: string, enterpriseDomain?: string): string {
  if (enterpriseDomain && !isSupportedGithubCopilotDomain(enterpriseDomain)) {
    throw new Error(
      `Refusing to route GitHub Copilot requests for unsupported enterprise domain "${enterpriseDomain}". Re-authenticate with a supported host (github.com or a *.ghe.com tenant).`,
    );
  }
  // If we have a token, extract the base URL from proxy-ep
  if (token) {
    const tokenEndpoint = resolveGithubCopilotTokenEndpoint(token, enterpriseDomain);
    if (tokenEndpoint.hasProxyEndpoint && !tokenEndpoint.baseUrl) {
      throw new Error(
        "Refusing to route GitHub Copilot requests to an unsupported proxy endpoint.",
      );
    }
    if (tokenEndpoint.baseUrl) {
      return tokenEndpoint.baseUrl;
    }
  }
  // Fallback for enterprise or if token parsing fails
  if (enterpriseDomain) {
    return `https://copilot-api.${normalizeGithubCopilotDomain(enterpriseDomain)}`;
  }
  return "https://api.individual.githubcopilot.com";
}

function formatCopilotRequestError(
  operation: string,
  error: unknown,
  options: Required<Pick<CopilotRequestOptions, "timeoutMs">> & {
    signal?: AbortSignal;
  },
): Error {
  if (options.signal?.aborted) {
    return new Error("Login cancelled");
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return new Error(`GitHub Copilot ${operation} timed out after ${options.timeoutMs}ms`);
  }
  return error instanceof Error
    ? error
    : new Error(`GitHub Copilot ${operation} failed: ${String(error)}`);
}

function buildCopilotRequestSignal(options: CopilotRequestOptions): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(
    resolveTimerTimeoutMs(options.timeoutMs, COPILOT_REQUEST_TIMEOUT_MS),
  );
  if (!options.signal) {
    return timeoutSignal;
  }
  return AbortSignal.any([options.signal, timeoutSignal]);
}

async function fetchResponse(
  url: string,
  init: RequestInit,
  operation: string,
  options: CopilotRequestOptions = {},
): Promise<Response> {
  const timeoutMs = resolveTimerTimeoutMs(options.timeoutMs, COPILOT_REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, {
      ...init,
      signal: buildCopilotRequestSignal({ ...options, timeoutMs }),
    });
  } catch (error) {
    throw formatCopilotRequestError(operation, error, {
      signal: options.signal,
      timeoutMs,
    });
  }
}

// Shared 16 MiB bounded reader — a hostile OAuth endpoint cannot force the
// runtime to buffer an unbounded body through `.text()` / `.json()`.
async function fetchJson(
  url: string,
  init: RequestInit,
  operation: string,
  options: CopilotRequestOptions = {},
): Promise<unknown> {
  const response = await fetchResponse(url, init, operation, options);
  const label = `GitHub Copilot ${operation}`;
  await assertOkOrThrowProviderError(response, label);
  return readProviderJsonResponse(response, label);
}

async function startDeviceFlow(
  domain: string,
  options: CopilotRequestOptions = {},
): Promise<DeviceCodeResponse> {
  const urls = getUrls(domain);
  const data = await fetchJson(
    urls.deviceCodeUrl,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "GitHubCopilotChat/0.35.0",
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        scope: "read:user",
      }),
    },
    "device code request",
    options,
  );

  if (!data || typeof data !== "object") {
    throw new Error("Invalid device code response");
  }

  const deviceCode = (data as Record<string, unknown>).device_code;
  const userCode = (data as Record<string, unknown>).user_code;
  const verificationUri = (data as Record<string, unknown>).verification_uri;
  const interval = (data as Record<string, unknown>).interval;
  const intervalMs = nonNegativeSecondsToSafeMilliseconds(interval);
  const expiresAt = resolveExpiresAtFromDurationSeconds(
    (data as Record<string, unknown>).expires_in,
  );

  if (
    typeof deviceCode !== "string" ||
    typeof userCode !== "string" ||
    typeof verificationUri !== "string" ||
    intervalMs === undefined ||
    expiresAt === undefined
  ) {
    throw new Error("Invalid device code response fields");
  }

  return {
    device_code: deviceCode,
    user_code: userCode,
    verification_uri: verificationUri,
    intervalMs,
    expiresAt,
  };
}

/**
 * Sleep that can be interrupted by an AbortSignal.
 * Resolve and abort both settle once and remove the abort listener so
 * multi-round device polling cannot accumulate listeners on a shared signal.
 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Login cancelled"));
      return;
    }

    let settled = false;
    const timeout = setTimeout(() => {
      settle(resolve);
    }, ms);

    const onAbort = () => {
      settle(() => {
        reject(new Error("Login cancelled"));
      });
    };

    function settle(action: () => void) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      action();
    }

    signal?.addEventListener("abort", onAbort);
  });
}

async function pollForGitHubAccessToken(
  domain: string,
  deviceCode: string,
  intervalMs: number,
  deadline: number,
  signal?: AbortSignal,
) {
  const urls = getUrls(domain);
  let pollingIntervalMs = Math.max(1000, intervalMs);
  let intervalMultiplier = INITIAL_POLL_INTERVAL_MULTIPLIER;
  let slowDownResponses = 0;

  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error("Login cancelled");
    }

    const remainingMs = deadline - Date.now();
    const waitMs = Math.min(Math.ceil(pollingIntervalMs * intervalMultiplier), remainingMs);
    await abortableSleep(waitMs, signal);

    const raw = await fetchJson(
      urls.accessTokenUrl,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "GitHubCopilotChat/0.35.0",
        },
        body: new URLSearchParams({
          client_id: CLIENT_ID,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }),
      },
      "device token request",
      { signal },
    );

    if (
      raw &&
      typeof raw === "object" &&
      typeof (raw as DeviceTokenSuccessResponse).access_token === "string"
    ) {
      return (raw as DeviceTokenSuccessResponse).access_token;
    }

    if (
      raw &&
      typeof raw === "object" &&
      typeof (raw as DeviceTokenErrorResponse).error === "string"
    ) {
      const { error, error_description: description, interval } = raw as DeviceTokenErrorResponse;
      if (error === "authorization_pending") {
        continue;
      }

      if (error === "slow_down") {
        slowDownResponses += 1;
        const slowDownIntervalMs = positiveSecondsToSafeMilliseconds(interval);
        pollingIntervalMs =
          slowDownIntervalMs === undefined
            ? Math.max(1000, pollingIntervalMs + 5000)
            : Math.max(1000, slowDownIntervalMs);
        intervalMultiplier = SLOW_DOWN_POLL_INTERVAL_MULTIPLIER;
        continue;
      }

      const descriptionSuffix = description ? `: ${description}` : "";
      throw new Error(`Device flow failed: ${error}${descriptionSuffix}`);
    }
  }

  if (slowDownResponses > 0) {
    throw new Error(
      "Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again.",
    );
  }

  throw new Error("Device flow timed out");
}

/**
 * Refresh GitHub Copilot token
 */
async function refreshGitHubCopilotToken(
  refreshToken: string,
  enterpriseDomain?: string,
  options: CopilotRequestOptions = {},
): Promise<OAuthCredentials> {
  if (enterpriseDomain && !isSupportedGithubCopilotDomain(enterpriseDomain)) {
    throw new Error(
      `Refusing to refresh GitHub Copilot token for unsupported enterprise domain "${enterpriseDomain}". Re-authenticate with a supported host (github.com or a *.ghe.com tenant).`,
    );
  }
  const domain = enterpriseDomain || "github.com";
  const urls = getUrls(domain);

  const raw = await fetchJson(
    urls.copilotTokenUrl,
    {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${refreshToken}`,
        ...COPILOT_HEADERS,
      },
    },
    "token refresh request",
    options,
  );

  if (!raw || typeof raw !== "object") {
    throw new Error("Invalid Copilot token response");
  }

  const token = (raw as Record<string, unknown>).token;
  const expires = resolveExpiresAtFromEpochSeconds((raw as Record<string, unknown>).expires_at);

  if (typeof token !== "string" || expires === undefined) {
    throw new Error("Invalid Copilot token response fields");
  }

  return {
    refresh: refreshToken,
    access: token,
    expires,
    enterpriseUrl: enterpriseDomain,
  };
}

/**
 * Enable a model for the user's GitHub Copilot account.
 * This is required for some models (like Claude, Grok) before they can be used.
 */
async function enableGitHubCopilotModel(
  token: string,
  modelId: string,
  enterpriseDomain?: string,
  options: CopilotRequestOptions = {},
): Promise<boolean> {
  const baseUrl = getGitHubCopilotBaseUrl(token, enterpriseDomain);
  const url = `${baseUrl}/models/${modelId}/policy`;
  let response: Response | undefined;

  try {
    response = await fetchResponse(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
          ...COPILOT_HEADERS,
          "openai-intent": "chat-policy",
          "x-interaction-type": "chat-policy",
        },
        body: JSON.stringify({ state: "enabled" }),
      },
      "model policy request",
      options,
    );
    return response.ok;
  } catch {
    return false;
  } finally {
    await response?.body?.cancel().catch(() => undefined);
  }
}

async function listGitHubCopilotModelIds(
  token: string,
  enterpriseDomain?: string,
  options: CopilotRequestOptions = {},
): Promise<string[]> {
  const baseUrl = getGitHubCopilotBaseUrl(token, enterpriseDomain);
  const url = `${baseUrl}/models`;
  try {
    const raw = await fetchJson(
      url,
      {
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${token}`,
          ...COPILOT_HEADERS,
        },
      },
      "model list request",
      options,
    );
    const data = raw && typeof raw === "object" ? (raw as { data?: unknown }).data : undefined;
    if (!Array.isArray(data)) {
      return [];
    }
    return data.flatMap((entry) => {
      if (!entry || typeof entry !== "object") {
        return [];
      }
      const model = entry as CopilotModelListEntry;
      const id = typeof model.id === "string" ? model.id.trim() : "";
      if (!id || id.startsWith(COPILOT_ROUTER_ID_PREFIX)) {
        return [];
      }
      if (model.object && model.object !== "model") {
        return [];
      }
      if (model.capabilities?.type && model.capabilities.type !== "chat") {
        return [];
      }
      return [id];
    });
  } catch {
    return [];
  }
}

/**
 * Enable GitHub Copilot models visible to this account.
 * Called after successful login to ensure available models are policy-enabled.
 */
async function enableAllGitHubCopilotModels(
  token: string,
  enterpriseDomain?: string,
  onProgress?: (model: string, success: boolean) => void,
): Promise<void> {
  const modelIds = await listGitHubCopilotModelIds(token, enterpriseDomain);
  await Promise.all(
    modelIds.map(async (modelId) => {
      const success = await enableGitHubCopilotModel(token, modelId, enterpriseDomain);
      onProgress?.(modelId, success);
    }),
  );
}

/**
 * Login with GitHub Copilot OAuth (device code flow)
 *
 * @param options.onAuth - Callback with URL and optional instructions (user code)
 * @param options.onPrompt - Callback to prompt user for input
 * @param options.onProgress - Optional progress callback
 * @param options.signal - Optional AbortSignal for cancellation
 */
async function loginGitHubCopilot(options: {
  onAuth: (url: string, instructions?: string) => void;
  onPrompt: (prompt: {
    message: string;
    placeholder?: string;
    allowEmpty?: boolean;
  }) => Promise<string>;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}): Promise<OAuthCredentials> {
  const input = await options.onPrompt({
    message: "GitHub Enterprise URL/domain (blank for github.com)",
    placeholder: "company.ghe.com",
    allowEmpty: true,
  });

  if (options.signal?.aborted) {
    throw new Error("Login cancelled");
  }

  const trimmed = input.trim();
  const enterpriseDomain = normalizeDomain(input);
  if (trimmed && !enterpriseDomain) {
    throw new Error("Invalid GitHub Enterprise URL/domain");
  }
  if (!isSupportedGithubCopilotDomain(enterpriseDomain)) {
    throw new Error(
      `Unsupported GitHub Enterprise domain "${trimmed}". Use github.com or a *.ghe.com data-residency tenant.`,
    );
  }
  const domain = enterpriseDomain || "github.com";

  const device = await startDeviceFlow(domain, { signal: options.signal });
  options.onAuth(device.verification_uri, `Enter code: ${device.user_code}`);

  const githubAccessToken = await pollForGitHubAccessToken(
    domain,
    device.device_code,
    device.intervalMs,
    device.expiresAt,
    options.signal,
  );
  const credentials = await refreshGitHubCopilotToken(
    githubAccessToken,
    enterpriseDomain ?? undefined,
  );

  // Enable all models after successful login
  options.onProgress?.("Enabling models...");
  await enableAllGitHubCopilotModels(credentials.access, enterpriseDomain ?? undefined);
  return credentials;
}

export const githubCopilotOAuthProvider: OAuthProviderInterface = {
  id: "github-copilot",
  name: "GitHub Copilot",

  async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    return loginGitHubCopilot({
      onAuth: (url, instructions) => callbacks.onAuth({ url, instructions }),
      onPrompt: callbacks.onPrompt,
      onProgress: callbacks.onProgress,
      signal: callbacks.signal,
    });
  },

  async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    const creds = credentials as CopilotCredentials;
    return refreshGitHubCopilotToken(creds.refresh, creds.enterpriseUrl);
  },

  getApiKey(credentials: OAuthCredentials): string {
    return credentials.access;
  },

  modifyModels(models: Model[], credentials: OAuthCredentials): Model[] {
    const creds = credentials as CopilotCredentials;
    const domain = creds.enterpriseUrl
      ? (normalizeDomain(creds.enterpriseUrl) ?? undefined)
      : undefined;
    const tokenEndpoint = resolveGithubCopilotTokenEndpoint(creds.access, domain);
    if (
      !isSupportedGithubCopilotDomain(creds.enterpriseUrl) ||
      (tokenEndpoint.hasProxyEndpoint && !tokenEndpoint.baseUrl)
    ) {
      return models.filter((m) => m.provider !== "github-copilot");
    }
    const baseUrl = tokenEndpoint.baseUrl ?? getGitHubCopilotBaseUrl(undefined, domain);
    return models.map((m) => (m.provider === "github-copilot" ? { ...m, baseUrl } : m));
  },
};
