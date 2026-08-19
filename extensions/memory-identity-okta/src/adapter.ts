import type { EnterpriseIdentityProviderAdapter } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";

type OktaConfig = Readonly<{
  issuer?: unknown;
  clientId?: unknown;
  clientSecret?: unknown;
  redirectUri?: unknown;
  groupIdsClaim?: unknown;
  roleGroupIds?: unknown;
  maxAuthenticationAgeMs?: unknown;
  maxSnapshotAgeMs?: unknown;
  acceptedAcrValues?: unknown;
  requiredAmrValues?: unknown;
}>;

type ClientSecretResolver = (value: unknown) => Promise<string | undefined>;

const OKTA_GROUP_ID_PATTERN = /^00g[0-9a-z]{17}$/iu;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().replace(/\/$/u, "") : "";
}

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim())
    ? [...new Set(value.map((entry) => entry.trim()))].toSorted()
    : [];
}

function requireCustomAuthorizationServerIssuer(value: unknown): string {
  const issuer = text(value);
  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    throw new Error("memory-identity-okta requires an HTTPS custom authorization-server issuer");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    !/^\/oauth2\/[^/]+$/u.test(parsed.pathname)
  ) {
    throw new Error("memory-identity-okta requires an HTTPS custom authorization-server issuer");
  }
  return parsed.toString().replace(/\/$/u, "");
}

function requiredGroupIds(value: unknown): readonly string[] {
  const ids = strings(value);
  if (ids.length === 0 || ids.some((id) => !OKTA_GROUP_ID_PATTERN.test(id))) {
    throw new Error("memory-identity-okta requires immutable Okta group IDs");
  }
  return ids;
}

function requiredClaim(value: unknown): string {
  const claim = text(value);
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(claim)) {
    throw new Error(
      "memory-identity-okta requires groupIdsClaim to name an ID-valued custom claim",
    );
  }
  return claim;
}

function duration(value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("memory-identity-okta requires a positive integer duration");
  }
  return value;
}

/** Okta's exact verified custom authorization-server issuer is its tenant boundary. */
export function createOktaEnterpriseIdentityProvider(
  rawConfig: OktaConfig | undefined,
  options: Readonly<{ resolveClientSecret?: ClientSecretResolver }> = {},
): EnterpriseIdentityProviderAdapter {
  const config = rawConfig ?? {};
  const issuer = requireCustomAuthorizationServerIssuer(config.issuer);
  const groupIdsClaim = requiredClaim(config.groupIdsClaim);
  const roleGroupIds = requiredGroupIds(config.roleGroupIds);
  return {
    providerPrefix: "okta",
    authorities: [
      {
        issuer,
        tenantId: issuer,
        audiences: [text(config.clientId)],
        jwksUri: `${issuer}/v1/keys`,
        algorithm: "RS256",
        tenantBinding: { kind: "issuer", tenantId: issuer },
        assurance: {
          maxAuthenticationAgeMs: duration(config.maxAuthenticationAgeMs, 60 * 60_000),
          ...(strings(config.acceptedAcrValues).length > 0
            ? { acceptedAcrValues: strings(config.acceptedAcrValues) }
            : {}),
          ...(strings(config.requiredAmrValues).length > 0
            ? { requiredAmrValues: strings(config.requiredAmrValues) }
            : {}),
        },
        authorizationCodeFlow: {
          clientId: text(config.clientId),
          authorizationEndpoint: `${issuer}/v1/authorize`,
          tokenEndpoint: `${issuer}/v1/token`,
          redirectUri: text(config.redirectUri),
          scopes: ["openid", "profile", "email", "groups"],
        },
        membership: {
          kind: "oidc-claim",
          claim: groupIdsClaim,
          required: true,
          roleGroupIds,
          maxGroups: 100,
        },
        maxSnapshotAgeMs: duration(config.maxSnapshotAgeMs, 60 * 60_000),
      },
    ],
    resolveAuthorizationCodeClientSecret: async () =>
      options.resolveClientSecret
        ? await options.resolveClientSecret(config.clientSecret)
        : normalizeResolvedSecretInputString({
            value: config.clientSecret,
            path: "plugins.entries.memory-identity-okta.config.clientSecret",
          }),
  };
}
