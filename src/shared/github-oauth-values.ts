import { z } from "zod";
import { MANAGED_GITHUB_PROFILE_ID_PATTERN } from "../config/github-identity-profile-id.js";

export const githubOAuthTimestamp = z.number().int().nonnegative().safe();
export const githubOAuthSecret = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[^\r\n]+$/u);
export const githubOAuthProfileId = z.string().regex(MANAGED_GITHUB_PROFILE_ID_PATTERN);
export const githubOAuthScopes = z
  .array(
    z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9:_-]+$/u),
  )
  .max(32);
export const githubOAuthRefreshFields = {
  accountId: z.number().int().positive().safe(),
  login: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u),
  refreshToken: githubOAuthSecret,
  accessExpiresAtMs: githubOAuthTimestamp,
  refreshExpiresAtMs: githubOAuthTimestamp,
  scopes: githubOAuthScopes,
};
export const githubOAuthDeviceFields = {
  deviceCode: z.string().regex(/^[A-Za-z0-9_-]{40}$/u),
  userCode: z.string().regex(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/u),
  verificationUri: z.literal("https://github.com/login/device"),
  createdAtMs: githubOAuthTimestamp,
  expiresAtMs: githubOAuthTimestamp,
  pollIntervalMs: z.number().int().min(1000).max(60000),
  nextPollAtMs: githubOAuthTimestamp,
};

export function validGitHubDeviceTiming(record: {
  createdAtMs: number;
  expiresAtMs: number;
  nextPollAtMs?: number;
}): boolean {
  return (
    record.expiresAtMs > record.createdAtMs &&
    record.expiresAtMs - record.createdAtMs <= 900000 &&
    (record.nextPollAtMs === undefined ||
      (record.nextPollAtMs >= record.createdAtMs && record.nextPollAtMs <= record.expiresAtMs))
  );
}
