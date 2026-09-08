import { hash, randomBytes } from "node:crypto";
import type { OAuthCredential } from "./types.js";

const OAUTH_REFRESH_FENCE_PREFIX = "openclaw-oauth-refresh-fence:v1:";
const OAUTH_REFRESH_ACCESS_PATTERN =
  /^openclaw-oauth-refresh-fence:v1:([a-f0-9]{32}):(failed:)?access:([a-f0-9]{64})$/;
const OAUTH_REFRESH_TOKEN_PATTERN =
  /^openclaw-oauth-refresh-fence:v1:([a-f0-9]{32}):(failed:)?refresh:([a-f0-9]{64})$/;

type OAuthRefreshFenceCredential = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
};

function buildOAuthRefreshSecretDigest(params: {
  profileId: string;
  provider: string;
  kind: "access" | "refresh";
  secret: string;
}): string {
  const generationInput = JSON.stringify([
    "openclaw.oauth-refresh-generation",
    1,
    params.profileId,
    params.provider,
    params.kind,
    params.secret,
  ]);
  // Refresh markers correlate provider-issued high-entropy OAuth token generations;
  // they are not used for password storage or credential verification.
  return hash("sha256", generationInput, "hex");
}

function parseOAuthRefreshFence(credential: OAuthRefreshFenceCredential | undefined):
  | {
      accessDigest: string;
      claimId: string;
      refreshDigest: string;
      state: "pending" | "failed";
    }
  | undefined {
  if (!credential || credential.type !== "oauth" || credential.expires !== 1) {
    return undefined;
  }
  const access = OAUTH_REFRESH_ACCESS_PATTERN.exec(credential.access);
  const refresh = OAUTH_REFRESH_TOKEN_PATTERN.exec(credential.refresh);
  if (!access || !refresh || access[1] !== refresh[1] || access[2] !== refresh[2]) {
    return undefined;
  }
  return {
    accessDigest: access[3]!,
    claimId: access[1]!,
    refreshDigest: refresh[3]!,
    state: access[2] ? "failed" : "pending",
  };
}

/** Replace one claimed OAuth generation with an inert, schema-valid durable marker. */
export function createOAuthRefreshFence(params: {
  profileId: string;
  credential: OAuthCredential;
}): OAuthCredential {
  const {
    access,
    refresh,
    expires: _expires,
    idToken: _idToken,
    oauthRef: _oauthRef,
    copyToAgents: _copyToAgents,
    ...rest
  } = params.credential;
  const claimId = randomBytes(16).toString("hex");
  return {
    ...rest,
    type: "oauth",
    provider: params.credential.provider,
    access: `${OAUTH_REFRESH_FENCE_PREFIX}${claimId}:access:${buildOAuthRefreshSecretDigest({
      profileId: params.profileId,
      provider: params.credential.provider,
      kind: "access",
      secret: access,
    })}`,
    refresh: `${OAUTH_REFRESH_FENCE_PREFIX}${claimId}:refresh:${buildOAuthRefreshSecretDigest({
      profileId: params.profileId,
      provider: params.credential.provider,
      kind: "refresh",
      secret: refresh,
    })}`,
    expires: 1,
  };
}

/** True only for the exact v1 inert marker shape written by the refresh owner. */
export function isOAuthRefreshFence(credential: OAuthRefreshFenceCredential | undefined): boolean {
  return parseOAuthRefreshFence(credential) !== undefined;
}

/** True only while the durable refresh owner may still settle its claim. */
export function isPendingOAuthRefreshFence(
  credential: OAuthRefreshFenceCredential | undefined,
): boolean {
  return parseOAuthRefreshFence(credential)?.state === "pending";
}

/** Mark a failed owner terminal without restoring its single-use refresh generation. */
export function createFailedOAuthRefreshFence(credential: OAuthCredential): OAuthCredential {
  const fence = parseOAuthRefreshFence(credential);
  if (!fence || fence.state === "failed") {
    return credential;
  }
  return {
    ...credential,
    access: `${OAUTH_REFRESH_FENCE_PREFIX}${fence.claimId}:failed:access:${fence.accessDigest}`,
    refresh: `${OAUTH_REFRESH_FENCE_PREFIX}${fence.claimId}:failed:refresh:${fence.refreshDigest}`,
  };
}

/** True when two persisted values share the same single-use refresh generation. */
export function isSameOAuthRefreshGeneration(params: {
  profileId: string;
  left: OAuthCredential;
  right: OAuthCredential;
}): boolean {
  if (params.left.provider !== params.right.provider) {
    return false;
  }
  const leftFence = parseOAuthRefreshFence(params.left);
  const rightFence = parseOAuthRefreshFence(params.right);
  const refreshDigest = (credential: OAuthCredential) =>
    buildOAuthRefreshSecretDigest({
      profileId: params.profileId,
      provider: credential.provider,
      kind: "refresh",
      secret: credential.refresh,
    });
  return (
    (leftFence?.refreshDigest ?? refreshDigest(params.left)) ===
    (rightFence?.refreshDigest ?? refreshDigest(params.right))
  );
}
