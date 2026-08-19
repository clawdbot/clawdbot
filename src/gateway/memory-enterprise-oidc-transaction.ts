import { createHash, randomBytes } from "node:crypto";
import {
  getProcessEnterpriseIdentityProviderAuthorityRegistry,
  type EnterpriseIdentityProviderAuthorityRegistry,
  type EnterpriseIdentityProviderRegistration,
} from "../plugins/enterprise-identity-provider-authority-registry.js";
import { admitVerifiedEnterpriseIdentityForMemory } from "../state/memory-enterprise-admission.js";
import { linkMemoryEnterpriseProfile } from "../state/memory-enterprise-identity.js";
import {
  persistVerifiedEnterpriseOidcIdentity,
  verifyEnterpriseOidcIdentity,
} from "../state/memory-enterprise-verifier.js";
import { resolveMemoryPrincipalForUserProfile } from "../state/memory-identity.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import type { GatewayClient } from "./server-methods/types.js";

const TRANSACTION_TTL_MS = 5 * 60_000;
const MAX_TRANSACTIONS = 256;
const MAX_TRANSACTIONS_PER_PROFILE = 16;

type EnterpriseOidcTransaction = Readonly<{
  providerPrefix: string;
  userProfileId: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: number;
}>;

const transactions = new Map<string, EnterpriseOidcTransaction>();

export type GatewayEnterpriseIdentityAuthorizationStart = Readonly<{
  state: string;
  authorizationUrl: string;
  expiresAt: string;
}>;

export type GatewayEnterpriseIdentityAuthorizationResult =
  | Readonly<{ kind: "linked"; providerId: string; expiresAt: string }>
  | Readonly<{
      kind: "denied";
      reason: "transaction-invalid" | "provider-unavailable" | "identity-verification-failed";
    }>;

type EnterpriseAuthorizationCompletion = Readonly<{
  state: string;
  code: string;
  /** The authenticated RPC caller is an additional binding; browser callbacks have no caller. */
  expectedUserProfileId?: string;
  /** RPC callers name the selected provider; browser callbacks recover it from the receipt. */
  expectedProviderPrefix?: string;
  authorityRegistry?: EnterpriseIdentityProviderAuthorityRegistry;
  options?: OpenClawStateDatabaseOptions;
  now?: number;
}>;

function randomBase64Url(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function requireAuthenticatedGatewayProfile(client: GatewayClient): string {
  const profileId = client.authenticatedUserProfile?.profileId;
  if (!profileId) {
    throw new Error("enterprise identity authorization requires an authenticated Gateway profile");
  }
  return profileId;
}

function resolveRegistration(params: {
  providerPrefix: string;
  authorityRegistry?: EnterpriseIdentityProviderAuthorityRegistry;
}): EnterpriseIdentityProviderRegistration | undefined {
  const registry =
    params.authorityRegistry ?? getProcessEnterpriseIdentityProviderAuthorityRegistry();
  if (!registry?.isSealed()) {
    throw new Error(
      "enterprise identity authorization requires the sealed Gateway provider registry",
    );
  }
  return registry.providers.find(
    (candidate) => candidate.provider.providerPrefix === params.providerPrefix,
  );
}

async function resolveAuthorizationCodeClientSecret(
  registration: EnterpriseIdentityProviderRegistration,
): Promise<string | undefined> {
  try {
    return await registration.provider.resolveAuthorizationCodeClientSecret?.();
  } catch {
    return undefined;
  }
}

function cleanupExpiredTransactions(now: number): void {
  for (const [state, transaction] of transactions) {
    if (transaction.expiresAt <= now) {
      transactions.delete(state);
    }
  }
}

/** Test lifecycle hook; authorization code verifiers and nonces never survive a process restart. */
export function clearGatewayEnterpriseOidcTransactionsForTest(): void {
  transactions.clear();
}

/**
 * Starts a self-service public-client authorization-code flow. The browser only
 * receives opaque state and a PKCE challenge; the verifier and nonce remain in
 * the Gateway process and are consumed exactly once by completion.
 */
export async function startGatewayEnterpriseIdentityAuthorization(params: {
  client: GatewayClient;
  providerPrefix: string;
  authorityRegistry?: EnterpriseIdentityProviderAuthorityRegistry;
  now?: number;
}): Promise<GatewayEnterpriseIdentityAuthorizationStart> {
  const userProfileId = requireAuthenticatedGatewayProfile(params.client);
  const registration = resolveRegistration(params);
  if (!registration || registration.provider.authorities.length !== 1) {
    throw new Error(
      "enterprise identity provider is not enabled for a single configured authority",
    );
  }
  const availability = await registration.provider.checkServiceAvailability?.();
  if (availability && !availability.available) {
    throw new Error("enterprise identity provider is unavailable");
  }
  if (!(await resolveAuthorizationCodeClientSecret(registration))) {
    throw new Error("enterprise identity provider client authentication is unavailable");
  }
  const now = params.now ?? Date.now();
  cleanupExpiredTransactions(now);
  if (transactions.size >= MAX_TRANSACTIONS) {
    throw new Error(
      "enterprise identity authorization is temporarily busy; complete or retry shortly",
    );
  }
  const profileTransactionCount = [...transactions.values()].filter(
    (transaction) => transaction.userProfileId === userProfileId,
  ).length;
  if (profileTransactionCount >= MAX_TRANSACTIONS_PER_PROFILE) {
    throw new Error(
      "enterprise identity authorization already has too many pending requests for this profile",
    );
  }
  const state = randomBase64Url(32);
  const nonce = randomBase64Url(32);
  const verifier = randomBase64Url(48);
  const authority = registration.provider.authorities[0]!;
  const url = new URL(authority.authorizationCodeFlow.authorizationEndpoint);
  url.searchParams.set("client_id", authority.authorizationCodeFlow.clientId);
  url.searchParams.set("redirect_uri", authority.authorizationCodeFlow.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", authority.authorizationCodeFlow.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", codeChallenge(verifier));
  url.searchParams.set("code_challenge_method", "S256");
  // OIDC providers emit auth_time for a max_age-bound transaction. Core then
  // verifies it against the same sealed assurance policy before linking memory.
  url.searchParams.set(
    "max_age",
    String(Math.max(1, Math.floor(authority.assurance.maxAuthenticationAgeMs / 1_000))),
  );
  const expiresAt = now + TRANSACTION_TTL_MS;
  transactions.set(
    state,
    Object.freeze({
      providerPrefix: registration.provider.providerPrefix,
      userProfileId,
      nonce,
      codeVerifier: verifier,
      expiresAt,
    }),
  );
  return Object.freeze({
    state,
    authorizationUrl: url.toString(),
    expiresAt: new Date(expiresAt).toISOString(),
  });
}

async function exchangeAuthorizationCode(params: {
  registration: EnterpriseIdentityProviderRegistration;
  code: string;
  transaction: EnterpriseOidcTransaction;
}): Promise<string | undefined> {
  const authority = params.registration.provider.authorities[0];
  if (!authority) {
    return undefined;
  }
  const clientSecret = await resolveAuthorizationCodeClientSecret(params.registration);
  if (!clientSecret) {
    return undefined;
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: authority.authorizationCodeFlow.redirectUri,
    code_verifier: params.transaction.codeVerifier,
  });
  try {
    const response = await fetch(authority.authorizationCodeFlow.tokenEndpoint, {
      method: "POST",
      // HTTPS Gateway callbacks are confidential web clients. Never silently
      // retry this exchange as a public client if the configured secret is absent.
      headers: {
        accept: "application/json",
        authorization: `Basic ${Buffer.from(
          `${authority.authorizationCodeFlow.clientId}:${clientSecret}`,
          "utf8",
        ).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      return undefined;
    }
    const payload: unknown = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return undefined;
    }
    const idToken = (payload as Record<string, unknown>).id_token;
    return typeof idToken === "string" && idToken ? idToken : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Consumes a Gateway-created state receipt. There is no bearer-token linking
 * or caller-selected target profile: the verified result can link only the
 * authenticated profile that started this exact PKCE+nonce transaction.
 */
async function completeEnterpriseIdentityAuthorization(
  params: EnterpriseAuthorizationCompletion,
): Promise<GatewayEnterpriseIdentityAuthorizationResult> {
  const now = params.now ?? Date.now();
  cleanupExpiredTransactions(now);
  const transaction = transactions.get(params.state);
  // Consume before exchange: any replay, changed user, provider mismatch, or
  // failed exchange requires a new authorization transaction.
  transactions.delete(params.state);
  if (
    !transaction ||
    transaction.expiresAt <= now ||
    (params.expectedUserProfileId !== undefined &&
      transaction.userProfileId !== params.expectedUserProfileId) ||
    (params.expectedProviderPrefix !== undefined &&
      transaction.providerPrefix !== params.expectedProviderPrefix) ||
    !params.code.trim()
  ) {
    return { kind: "denied", reason: "transaction-invalid" };
  }
  const registration = resolveRegistration({
    providerPrefix: transaction.providerPrefix,
    authorityRegistry: params.authorityRegistry,
  });
  if (!registration) {
    return { kind: "denied", reason: "transaction-invalid" };
  }
  const availability = await registration.provider.checkServiceAvailability?.();
  if (availability && !availability.available) {
    return { kind: "denied", reason: "provider-unavailable" };
  }
  const idToken = await exchangeAuthorizationCode({
    registration,
    code: params.code.trim(),
    transaction,
  });
  if (!idToken) {
    return { kind: "denied", reason: "provider-unavailable" };
  }
  const verification = await verifyEnterpriseOidcIdentity({
    adapter: registration.provider,
    token: idToken,
    expectedNonce: transaction.nonce,
    now,
  });
  if (verification.kind !== "verified") {
    return {
      kind: "denied",
      reason:
        verification.reason === "provider-unavailable"
          ? "provider-unavailable"
          : "identity-verification-failed",
    };
  }
  const userPrincipal = resolveMemoryPrincipalForUserProfile({
    userProfileId: transaction.userProfileId,
    options: params.options,
  });
  if (!userPrincipal) {
    throw new Error("enterprise identity authorization requires an active Gateway user principal");
  }
  const persisted = persistVerifiedEnterpriseOidcIdentity({
    identity: verification.identity,
    options: params.options,
  });
  const profileLink = linkMemoryEnterpriseProfile({
    enterprisePrincipalId: persisted.principal.principalId,
    providerId: verification.identity.providerId,
    userPrincipalId: userPrincipal.principalId,
    createdByPrincipalId: userPrincipal.principalId,
    options: params.options,
    now,
  });
  admitVerifiedEnterpriseIdentityForMemory({
    userPrincipalId: userPrincipal.principalId,
    principal: persisted.principal,
    profileLink,
    identity: verification.identity,
  });
  return {
    kind: "linked",
    providerId: verification.identity.providerId,
    expiresAt: new Date(verification.identity.expiresAt).toISOString(),
  };
}

export async function completeGatewayEnterpriseIdentityAuthorization(params: {
  client: GatewayClient;
  providerPrefix: string;
  state: string;
  code: string;
  authorityRegistry?: EnterpriseIdentityProviderAuthorityRegistry;
  options?: OpenClawStateDatabaseOptions;
  now?: number;
}): Promise<GatewayEnterpriseIdentityAuthorizationResult> {
  const userProfileId = requireAuthenticatedGatewayProfile(params.client);
  return await completeEnterpriseIdentityAuthorization({
    ...params,
    expectedUserProfileId: userProfileId,
    expectedProviderPrefix: params.providerPrefix,
  });
}

/**
 * Completes a public OIDC redirect. The consumed receipt supplies both target
 * profile and provider; request parameters never select either authority.
 */
export async function completeGatewayEnterpriseIdentityAuthorizationCallback(params: {
  state: string;
  code: string;
  authorityRegistry?: EnterpriseIdentityProviderAuthorityRegistry;
  options?: OpenClawStateDatabaseOptions;
  now?: number;
}): Promise<GatewayEnterpriseIdentityAuthorizationResult> {
  return await completeEnterpriseIdentityAuthorization(params);
}
