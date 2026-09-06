import type { ToolsGitHubAuthorizePollResult } from "../../packages/gateway-protocol/src/index.js";
import {
  pollGitHubOAuthDeviceToken,
  requestGitHubOAuthDeviceCode,
  type GitHubOAuthTokenPair,
} from "../agents/github-oauth-client.js";

export type GitHubDeviceFlow = {
  deviceCode: string;
  userCode: string;
  verificationUri: "https://github.com/login/device";
  createdAtMs: number;
  expiresAtMs: number;
  pollIntervalMs: number;
  nextPollAtMs: number;
};
type PollResult = Exclude<ToolsGitHubAuthorizePollResult, { status: "success" }>;

/** Transport and scheduling are shared; the caller owns identity, TTL/CAS, and installation. */
export async function startGitHubDeviceFlow(signal: AbortSignal): Promise<GitHubDeviceFlow> {
  const startedAt = Date.now();
  const authorization = await requestGitHubOAuthDeviceCode({ signal });
  if (authorization.expiresInSeconds > 900 || authorization.intervalSeconds > 60) {
    throw new Error("GitHub device authorization timing is outside the supported bounds.");
  }
  const pollIntervalMs = authorization.intervalSeconds * 1000;
  return {
    deviceCode: authorization.deviceCode,
    userCode: authorization.userCode,
    verificationUri: authorization.verificationUri,
    createdAtMs: startedAt,
    expiresAtMs: startedAt + authorization.expiresInSeconds * 1000,
    pollIntervalMs,
    nextPollAtMs: startedAt + pollIntervalMs,
  };
}

export async function pollGitHubDeviceFlow(
  record: GitHubDeviceFlow,
  signal: AbortSignal,
): Promise<
  | { kind: "authorized"; tokens: GitHubOAuthTokenPair }
  | { kind: "waiting"; result: PollResult; pollIntervalMs: number; nextPollAtMs: number }
  | { kind: "terminal"; result: PollResult }
> {
  const now = Date.now();
  if (record.expiresAtMs <= now) {
    return { kind: "terminal", result: { status: "expired" } };
  }
  if (now < record.nextPollAtMs) {
    return {
      kind: "waiting",
      result: { status: "pending", retryAfterMs: record.nextPollAtMs - now },
      pollIntervalMs: record.pollIntervalMs,
      nextPollAtMs: record.nextPollAtMs,
    };
  }
  let result;
  try {
    result = await pollGitHubOAuthDeviceToken({ deviceCode: record.deviceCode, signal });
  } catch {
    const nextPollAtMs = Math.min(record.expiresAtMs, Date.now() + record.pollIntervalMs);
    return {
      kind: "waiting",
      result: { status: "network_error", retryAfterMs: Math.max(1, nextPollAtMs - Date.now()) },
      pollIntervalMs: record.pollIntervalMs,
      nextPollAtMs,
    };
  }
  if (result.status === "authorized") {
    return { kind: "authorized", tokens: result.tokens };
  }
  if (result.status === "authorization_pending" || result.status === "slow_down") {
    const pollIntervalMs =
      result.status === "slow_down"
        ? Math.min(
            60000,
            Math.max(record.pollIntervalMs + 5000, (result.intervalSeconds ?? 0) * 1000),
          )
        : record.pollIntervalMs;
    const nextPollAtMs = Math.min(record.expiresAtMs, Date.now() + pollIntervalMs);
    return {
      kind: "waiting",
      pollIntervalMs,
      nextPollAtMs,
      result: {
        status: result.status === "slow_down" ? "slow_down" : "pending",
        retryAfterMs: Math.max(1, nextPollAtMs - Date.now()),
      },
    };
  }
  if (result.status === "access_denied") {
    return { kind: "terminal", result: { status: "access_denied" } };
  }
  if (result.status === "expired_token") {
    return { kind: "terminal", result: { status: "expired" } };
  }
  return {
    kind: "terminal",
    result:
      result.code === "incorrect_device_code" || result.code === "bad_verification_code"
        ? { status: "incorrect_device_code" }
        : { status: "failed", reason: "setup_failed" },
  };
}
