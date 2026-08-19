import type { EnterpriseIdentityProviderAdapter } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";

type EntraConfig = Readonly<{
  tenantId?: unknown;
  clientId?: unknown;
  clientSecret?: unknown;
  redirectUri?: unknown;
  roleGroupIds?: unknown;
  maxAuthenticationAgeMs?: unknown;
  maxSnapshotAgeMs?: unknown;
  acceptedAcrValues?: unknown;
  requiredAmrValues?: unknown;
}>;

type ClientSecretResolver = (value: unknown) => Promise<string | undefined>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function strings(value: unknown): readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim())
    ? [...new Set(value.map((entry) => entry.trim()))].toSorted()
    : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requiredUuid(value: unknown, field: string): string {
  const normalized = text(value);
  if (!UUID_PATTERN.test(normalized)) {
    throw new Error(`memory-identity-entra requires ${field} to be an immutable Entra object ID`);
  }
  return normalized;
}

function requiredUuidList(value: unknown, field: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`memory-identity-entra requires at least one ${field}`);
  }
  const ids = value.map((entry) => requiredUuid(entry, field));
  if (new Set(ids).size !== ids.length) {
    throw new Error(`memory-identity-entra requires unique ${field}`);
  }
  return ids.toSorted();
}

function duration(value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("memory-identity-entra requires a positive integer duration");
  }
  return value;
}

/** Builds static Entra authority metadata; core validates every returned ID token. */
export function createEntraEnterpriseIdentityProvider(
  rawConfig: EntraConfig | undefined,
  options: Readonly<{ resolveClientSecret?: ClientSecretResolver }> = {},
): EnterpriseIdentityProviderAdapter {
  const config = rawConfig ?? {};
  const tenantId = requiredUuid(config.tenantId, "tenantId");
  const clientId = requiredUuid(config.clientId, "clientId");
  const issuer = `https://login.microsoftonline.com/${tenantId}/v2.0`;
  const roleGroupIds = requiredUuidList(config.roleGroupIds, "roleGroupIds");
  return {
    providerPrefix: "entra",
    authorities: [
      {
        issuer,
        tenantId,
        audiences: [clientId],
        jwksUri: `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
        algorithm: "RS256",
        tenantBinding: { kind: "claim", claim: "tid", value: tenantId },
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
          clientId,
          authorizationEndpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize`,
          tokenEndpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
          redirectUri: text(config.redirectUri),
          scopes: ["openid", "profile", "email"],
        },
        membership: {
          kind: "oidc-claim",
          claim: "groups",
          required: true,
          roleGroupIds,
          maxGroups: 200,
          incompleteIndicators: [
            { kind: "truthy-claim", claim: "hasgroups" },
            { kind: "nested-key", claim: "_claim_names", key: "groups" },
          ],
        },
        maxSnapshotAgeMs: duration(config.maxSnapshotAgeMs, 60 * 60_000),
      },
    ],
    resolveAuthorizationCodeClientSecret: async () =>
      options.resolveClientSecret
        ? await options.resolveClientSecret(config.clientSecret)
        : normalizeResolvedSecretInputString({
            value: config.clientSecret,
            path: "plugins.entries.memory-identity-entra.config.clientSecret",
          }),
  };
}
