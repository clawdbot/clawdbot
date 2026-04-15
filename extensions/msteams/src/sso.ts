/**
 * Bot Framework OAuth SSO invoke handlers for Microsoft Teams.
 *
 * Handles two invoke activities Teams sends when the bot has presented
 * an `oauthCard` or when the user completes an interactive sign-in:
 *
 * 1. `signin/tokenExchange`
 *    The Teams client obtained an exchangeable token from the bot's
 *    AAD app and forwards it to the bot. The bot exchanges that token
 *    with the Bot Framework User Token service, which returns the real
 *    delegated user token (for example, a Microsoft Graph access token
 *    if the OAuth connection is set up for Graph).
 *
 * 2. `signin/verifyState`
 *    Fallback for the magic-code flow: the user finishes sign-in in a
 *    browser tab, receives a 6-digit code, and pastes it back into the
 *    chat. The bot then asks the User Token service for the token
 *    corresponding to that code.
 *
 * In both cases the bot must reply with an `invokeResponse` (HTTP 200)
 * immediately or the Teams UI shows "Something went wrong". Callers of
 * {@link handleSigninTokenExchangeInvoke} and
 * {@link handleSigninVerifyStateInvoke} are responsible for sending
 * that ack; these helpers encapsulate token exchange and persistence.
 */

import type { MSTeamsAccessTokenProvider } from "./attachments/types.js";
import type { MSTeamsSsoTokenStore } from "./sso-token-store.js";
import { buildUserAgent } from "./user-agent.js";

/** Scope used to obtain a Bot Framework service token. */
export const BOT_FRAMEWORK_TOKEN_SCOPE = "https://api.botframework.com/.default";

/** Bot Framework User Token service base URL. */
export const BOT_FRAMEWORK_USER_TOKEN_BASE_URL = "https://token.botframework.com";

/**
 * Response shape returned by the Bot Framework User Token service for
 * `GetUserToken` and `ExchangeToken`.
 *
 * @see https://learn.microsoft.com/azure/bot-service/rest-api/bot-framework-rest-connector-user-token-service
 */
export type BotFrameworkUserTokenResponse = {
  channelId?: string;
  connectionName: string;
  token: string;
  expiration?: string;
};

export type MSTeamsSsoFetch = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export type MSTeamsSsoDeps = {
  tokenProvider: MSTeamsAccessTokenProvider;
  tokenStore: MSTeamsSsoTokenStore;
  connectionName: string;
  /** Override `fetch` for testing. */
  fetchImpl?: MSTeamsSsoFetch;
  /** Override the User Token service base URL (testing / sovereign clouds). */
  userTokenBaseUrl?: string;
};

export type MSTeamsSsoUser = {
  /** Stable user identifier — AAD object ID when available. */
  userId: string;
  /** Bot Framework channel ID (default: "msteams"). */
  channelId?: string;
};

export type MSTeamsSsoResult =
  | {
      ok: true;
      token: string;
      expiresAt?: string;
    }
  | {
      ok: false;
      code:
        | "missing_user"
        | "missing_connection"
        | "missing_token"
        | "missing_state"
        | "service_error"
        | "unexpected_response";
      message: string;
      status?: number;
    };

export type SigninTokenExchangeValue = {
  id?: string;
  connectionName?: string;
  token?: string;
};

export type SigninVerifyStateValue = {
  state?: string;
};

/**
 * Extract and validate the `signin/tokenExchange` activity value. Teams
 * delivers `{ id, connectionName, token }`; any field may be missing on
 * malformed invocations, so callers should check the parsed result.
 */
export function parseSigninTokenExchangeValue(value: unknown): SigninTokenExchangeValue | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const id = typeof obj.id === "string" ? obj.id : undefined;
  const connectionName = typeof obj.connectionName === "string" ? obj.connectionName : undefined;
  const token = typeof obj.token === "string" ? obj.token : undefined;
  return { id, connectionName, token };
}

/** Extract the `signin/verifyState` activity value `{ state }`. */
export function parseSigninVerifyStateValue(value: unknown): SigninVerifyStateValue | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const obj = value as Record<string, unknown>;
  const state = typeof obj.state === "string" ? obj.state : undefined;
  return { state };
}

type UserTokenServiceCallParams = {
  baseUrl: string;
  path: string;
  query: Record<string, string>;
  method: "GET" | "POST";
  body?: unknown;
  bearerToken: string;
  fetchImpl: MSTeamsSsoFetch;
};

async function callUserTokenService(
  params: UserTokenServiceCallParams,
): Promise<BotFrameworkUserTokenResponse | { error: string; status: number }> {
  const qs = new URLSearchParams(params.query).toString();
  const url = `${params.baseUrl.replace(/\/+$/, "")}${params.path}?${qs}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${params.bearerToken}`,
    "User-Agent": buildUserAgent(),
  };
  if (params.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  const response = await params.fetchImpl(url, {
    method: params.method,
    headers,
    body: params.body === undefined ? undefined : JSON.stringify(params.body),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return { error: text || `HTTP ${response.status}`, status: response.status };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { error: "invalid JSON from User Token service", status: response.status };
  }
  if (!parsed || typeof parsed !== "object") {
    return { error: "empty response from User Token service", status: response.status };
  }
  const obj = parsed as Record<string, unknown>;
  const token = typeof obj.token === "string" ? obj.token : undefined;
  const connectionName = typeof obj.connectionName === "string" ? obj.connectionName : undefined;
  const channelId = typeof obj.channelId === "string" ? obj.channelId : undefined;
  const expiration = typeof obj.expiration === "string" ? obj.expiration : undefined;
  if (!token || !connectionName) {
    return { error: "User Token service response missing token/connectionName", status: 502 };
  }
  return { channelId, connectionName, token, expiration };
}

/**
 * Exchange a Teams SSO token for a delegated user token via Bot
 * Framework's User Token service, then persist the result.
 */
export async function handleSigninTokenExchangeInvoke(params: {
  value: SigninTokenExchangeValue;
  user: MSTeamsSsoUser;
  deps: MSTeamsSsoDeps;
}): Promise<MSTeamsSsoResult> {
  const { value, user, deps } = params;
  if (!user.userId) {
    return { ok: false, code: "missing_user", message: "no user id on invoke activity" };
  }
  const connectionName = value.connectionName?.trim() || deps.connectionName;
  if (!connectionName) {
    return { ok: false, code: "missing_connection", message: "no OAuth connection name" };
  }
  if (!value.token) {
    return { ok: false, code: "missing_token", message: "no exchangeable token on invoke" };
  }

  const bearer = await deps.tokenProvider.getAccessToken(BOT_FRAMEWORK_TOKEN_SCOPE);
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as MSTeamsSsoFetch);
  const result = await callUserTokenService({
    baseUrl: deps.userTokenBaseUrl ?? BOT_FRAMEWORK_USER_TOKEN_BASE_URL,
    path: "/api/usertoken/exchange",
    query: {
      userId: user.userId,
      connectionName,
      channelId: user.channelId ?? "msteams",
    },
    method: "POST",
    body: { token: value.token },
    bearerToken: bearer,
    fetchImpl,
  });

  if ("error" in result) {
    return {
      ok: false,
      code: result.status >= 500 ? "service_error" : "unexpected_response",
      message: result.error,
      status: result.status,
    };
  }

  await deps.tokenStore.save({
    connectionName,
    userId: user.userId,
    token: result.token,
    expiresAt: result.expiration,
    updatedAt: new Date().toISOString(),
  });

  return { ok: true, token: result.token, expiresAt: result.expiration };
}

/**
 * Finish a magic-code sign-in: look up the user token for the state
 * code via Bot Framework's User Token service, then persist it.
 */
export async function handleSigninVerifyStateInvoke(params: {
  value: SigninVerifyStateValue;
  user: MSTeamsSsoUser;
  deps: MSTeamsSsoDeps;
}): Promise<MSTeamsSsoResult> {
  const { value, user, deps } = params;
  if (!user.userId) {
    return { ok: false, code: "missing_user", message: "no user id on invoke activity" };
  }
  if (!deps.connectionName) {
    return { ok: false, code: "missing_connection", message: "no OAuth connection name" };
  }
  const state = value.state?.trim();
  if (!state) {
    return { ok: false, code: "missing_state", message: "no state code on invoke" };
  }

  const bearer = await deps.tokenProvider.getAccessToken(BOT_FRAMEWORK_TOKEN_SCOPE);
  const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as unknown as MSTeamsSsoFetch);
  const result = await callUserTokenService({
    baseUrl: deps.userTokenBaseUrl ?? BOT_FRAMEWORK_USER_TOKEN_BASE_URL,
    path: "/api/usertoken/GetToken",
    query: {
      userId: user.userId,
      connectionName: deps.connectionName,
      channelId: user.channelId ?? "msteams",
      code: state,
    },
    method: "GET",
    bearerToken: bearer,
    fetchImpl,
  });

  if ("error" in result) {
    return {
      ok: false,
      code: result.status >= 500 ? "service_error" : "unexpected_response",
      message: result.error,
      status: result.status,
    };
  }

  await deps.tokenStore.save({
    connectionName: deps.connectionName,
    userId: user.userId,
    token: result.token,
    expiresAt: result.expiration,
    updatedAt: new Date().toISOString(),
  });

  return { ok: true, token: result.token, expiresAt: result.expiration };
}
