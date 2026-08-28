import type { IncomingHttpHeaders } from "node:http";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { GatewayAuthConfig } from "../config/types.gateway.js";
import { resolveCachedGitHubIdentity } from "../state/user-profile-github-identity.js";
import { classifyTailscaleLogin } from "../state/user-profiles-tailscale-login.js";
import { syncGitHubIdentity } from "../state/user-profiles.js";
import { normalizeGitHubLogin } from "../utils/github-login.js";
import type { GatewayAuthResult } from "./auth.js";
import {
  ControlUiGitHubError,
  fetchGitHubApi,
  GITHUB_API_ORIGIN,
  GITHUB_REQUEST_TIMEOUT_MS,
  readBoundedResponse,
  readGitHubJsonResponse,
  resolveGitHubApiCredentialScope,
} from "./control-ui-github-api.js";
import {
  githubUserIdentityCoordinator,
  type ResolvedGitHubUserIdentity,
} from "./github-user-identity-coordinator.js";

const CLOUDFLARE_ACCESS_USER_HEADER = "cf-access-authenticated-user-email";
const CLOUDFLARE_ACCESS_ASSERTION_HEADER = "cf-access-jwt-assertion";
const CLOUDFLARE_ACCESS_HOST_SUFFIX = ".cloudflareaccess.com";
const CLOUDFLARE_ACCESS_IDENTITY_PATH = "/cdn-cgi/access/get-identity";
const ACCESS_ASSERTION_MAX_BYTES = 16 * 1024;
const ACCESS_IDENTITY_MAX_BYTES = 64 * 1024;
const JWT_SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/u;

type AuthenticatedGitHubIdentitySyncResult = { profileId: string; updatedAt: number };
export type AuthenticatedGitHubIdentitySync = () => Promise<AuthenticatedGitHubIdentitySyncResult>;
type GitHubApiCredentialScope = ReturnType<typeof resolveGitHubApiCredentialScope>;

class GitHubIdentityLookupError extends ControlUiGitHubError {
  constructor(
    error: ControlUiGitHubError,
    readonly retryableForCachedIdentity: boolean,
  ) {
    super(
      error.statusCode,
      error.message,
      error.retryAfterMs === undefined ? undefined : { retryAfterMs: error.retryAfterMs },
    );
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function cloudflareAccessIssuer(assertion: string): URL {
  if (Buffer.byteLength(assertion, "utf8") > ACCESS_ASSERTION_MAX_BYTES) {
    throw new Error("Cloudflare Access assertion is invalid");
  }
  const segments = assertion.split(".");
  if (segments.length !== 3 || segments.some((segment) => !JWT_SEGMENT_PATTERN.test(segment))) {
    throw new Error("Cloudflare Access assertion is invalid");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf8"));
  } catch {
    throw new Error("Cloudflare Access assertion is invalid");
  }
  if (!isRecord(payload) || typeof payload.iss !== "string") {
    throw new Error("Cloudflare Access assertion issuer is invalid");
  }
  let issuer: URL;
  try {
    issuer = new URL(payload.iss);
  } catch {
    throw new Error("Cloudflare Access assertion issuer is invalid");
  }
  if (
    issuer.protocol !== "https:" ||
    issuer.username ||
    issuer.password ||
    issuer.port ||
    issuer.pathname !== "/" ||
    issuer.search ||
    issuer.hash ||
    !issuer.hostname.endsWith(CLOUDFLARE_ACCESS_HOST_SUFFIX)
  ) {
    throw new Error("Cloudflare Access assertion issuer is invalid");
  }
  return issuer;
}

async function resolveCloudflareAccessIdentity(
  assertion: string,
  authenticatedPrincipal: string,
): Promise<{ accountId: number; initialDisplayName?: string }> {
  const issuer = cloudflareAccessIssuer(assertion);
  let payload: unknown;
  try {
    const response = await fetch(`${issuer.origin}${CLOUDFLARE_ACCESS_IDENTITY_PATH}`, {
      headers: { Cookie: `CF_Authorization=${assertion}` },
      redirect: "manual",
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error("identity response was not successful");
    }
    const body = await readBoundedResponse(response, ACCESS_IDENTITY_MAX_BYTES);
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    // Never attach the underlying fetch error: request errors may retain the bearer cookie.
    throw new Error("Cloudflare Access identity lookup failed");
  }
  if (!isRecord(payload)) {
    throw new Error("Cloudflare Access identity response is invalid");
  }
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  if (!email || email.toLowerCase() !== authenticatedPrincipal.trim().toLowerCase()) {
    throw new Error("Cloudflare Access identity principal did not match");
  }
  if (!isRecord(payload.idp) || payload.idp.type !== "github") {
    throw new Error("Cloudflare Access identity is not GitHub-backed");
  }
  if (typeof payload.id !== "number" || !Number.isSafeInteger(payload.id) || payload.id <= 0) {
    throw new Error("Cloudflare Access GitHub account id is invalid");
  }
  const initialDisplayName =
    typeof payload.name === "string" && payload.name.trim() ? payload.name : undefined;
  return { accountId: payload.id, ...(initialDisplayName ? { initialDisplayName } : {}) };
}

async function fetchGitHubIdentityPayload(rawUrl: string, token: string | undefined) {
  let response: Response | undefined;
  try {
    response = await fetchGitHubApi(rawUrl, fetch, token);
    return await readGitHubJsonResponse(response);
  } catch (error) {
    if (error instanceof ControlUiGitHubError) {
      throw new GitHubIdentityLookupError(
        error,
        response === undefined || error.statusCode === 429 || response.status >= 500,
      );
    }
    throw new GitHubIdentityLookupError(
      new ControlUiGitHubError(502, "GitHub request failed"),
      response === undefined,
    );
  }
}

async function resolveGitHubUserIdentityByLogin(
  username: string,
  credential: GitHubApiCredentialScope,
): Promise<ResolvedGitHubUserIdentity> {
  const requestedLogin = normalizeGitHubLogin(username);
  if (!requestedLogin) {
    throw new TypeError("GitHub username is invalid");
  }
  return githubUserIdentityCoordinator.lookup({
    credentialScope: credential.cacheScope,
    request: async () => {
      const payload = await fetchGitHubIdentityPayload(
        `${GITHUB_API_ORIGIN}/users/${encodeURIComponent(requestedLogin)}`,
        credential.token,
      );
      if (!isRecord(payload)) {
        throw new ControlUiGitHubError(502, "GitHub response was not an object");
      }
      const accountId = payload.id;
      const login =
        typeof payload.login === "string" ? normalizeGitHubLogin(payload.login) : undefined;
      if (!Number.isSafeInteger(accountId) || typeof accountId !== "number" || accountId <= 0) {
        throw new ControlUiGitHubError(502, "GitHub response omitted a valid account id");
      }
      if (!login) {
        throw new ControlUiGitHubError(502, "GitHub response omitted a valid login");
      }
      return { accountId, login };
    },
  });
}

function resolveGitHubUserIdentityById(
  accountId: number,
  credential: GitHubApiCredentialScope,
): Promise<ResolvedGitHubUserIdentity> {
  return githubUserIdentityCoordinator.lookup({
    credentialScope: credential.cacheScope,
    request: async () => {
      const payload = await fetchGitHubIdentityPayload(
        `${GITHUB_API_ORIGIN}/user/${accountId}`,
        credential.token,
      );
      if (!isRecord(payload) || payload.id !== accountId) {
        throw new ControlUiGitHubError(502, "GitHub account id did not match");
      }
      const login =
        typeof payload.login === "string" ? normalizeGitHubLogin(payload.login) : undefined;
      if (!login) {
        throw new ControlUiGitHubError(502, "GitHub response omitted a valid login");
      }
      return { accountId, login };
    },
  });
}

function retryableConnectionSync(
  sync: () => Promise<AuthenticatedGitHubIdentitySyncResult>,
): AuthenticatedGitHubIdentitySync {
  let inFlight: Promise<AuthenticatedGitHubIdentitySyncResult> | undefined;
  let completed: AuthenticatedGitHubIdentitySyncResult | undefined;
  return () => {
    if (completed) {
      return Promise.resolve(completed);
    }
    if (inFlight) {
      return inFlight;
    }
    const current = sync().then((result) => {
      completed = result;
      return result;
    });
    inFlight = current;
    void current.then(
      () => {
        inFlight = undefined;
      },
      () => {
        inFlight = undefined;
      },
    );
    return current;
  };
}

function cloudflareAccessAssertion(params: {
  authResult: GatewayAuthResult;
  authConfig?: GatewayAuthConfig;
  requestHeaders?: IncomingHttpHeaders;
}): { assertion: string; principal: string } | undefined {
  const trustedProxy = params.authConfig?.trustedProxy;
  if (
    !params.authResult.ok ||
    params.authResult.method !== "trusted-proxy" ||
    params.authConfig?.mode !== "trusted-proxy" ||
    normalizeLowercaseStringOrEmpty(trustedProxy?.userHeader) !== CLOUDFLARE_ACCESS_USER_HEADER ||
    !trustedProxy?.requiredHeaders?.some(
      (header) => normalizeLowercaseStringOrEmpty(header) === CLOUDFLARE_ACCESS_ASSERTION_HEADER,
    )
  ) {
    return undefined;
  }
  const principal = params.authResult.user?.trim();
  const assertion = headerValue(
    params.requestHeaders?.[CLOUDFLARE_ACCESS_ASSERTION_HEADER],
  )?.trim();
  return principal && assertion ? { assertion, principal } : undefined;
}

export function createAuthenticatedGitHubIdentitySync(params: {
  authResult: GatewayAuthResult;
  authConfig?: GatewayAuthConfig;
  requestHeaders?: IncomingHttpHeaders;
}): AuthenticatedGitHubIdentitySync | undefined {
  const tailscaleLogin = params.authResult.tailscaleIdentity
    ? classifyTailscaleLogin(params.authResult.tailscaleIdentity.login)
    : undefined;
  if (tailscaleLogin?.kind === "provider" && tailscaleLogin.provider === "github") {
    return retryableConnectionSync(async () => {
      const credential = resolveGitHubApiCredentialScope();
      const identity = await resolveGitHubUserIdentityByLogin(tailscaleLogin.subject, credential);
      const profile = syncGitHubIdentity({
        identity,
        authenticationAlias: { kind: "github-login", login: tailscaleLogin.subject },
        initialDisplayName: params.authResult.tailscaleIdentity?.name,
      });
      return { profileId: profile.id, updatedAt: profile.updatedAt };
    });
  }

  const access = cloudflareAccessAssertion(params);
  if (!access) {
    return undefined;
  }
  return retryableConnectionSync(async () => {
    const credential = resolveGitHubApiCredentialScope();
    const accessIdentity = await resolveCloudflareAccessIdentity(
      access.assertion,
      access.principal,
    );
    let identity: ResolvedGitHubUserIdentity;
    try {
      identity = await resolveGitHubUserIdentityById(accessIdentity.accountId, credential);
    } catch (error) {
      const retryable =
        (error instanceof GitHubIdentityLookupError && error.retryableForCachedIdentity) ||
        (error instanceof ControlUiGitHubError && error.statusCode === 429);
      if (retryable) {
        // Retry failures may reuse only the exact verified email + immutable-account binding.
        const cached = resolveCachedGitHubIdentity({
          accountId: accessIdentity.accountId,
          email: access.principal,
        });
        if (cached) {
          return cached;
        }
      }
      throw error instanceof ControlUiGitHubError
        ? error
        : new ControlUiGitHubError(502, "GitHub request failed");
    }
    const profile = syncGitHubIdentity({
      identity,
      authenticationAlias: { kind: "email", email: access.principal },
      initialDisplayName: accessIdentity.initialDisplayName,
    });
    return { profileId: profile.id, updatedAt: profile.updatedAt };
  });
}
