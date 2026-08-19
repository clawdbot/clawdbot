import { JWT } from "google-auth-library";
import type { EnterpriseIdentityProviderAdapter } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";

const CLOUD_IDENTITY_GROUPS_READ_SCOPE =
  "https://www.googleapis.com/auth/cloud-identity.groups.readonly";

type GoogleWorkspaceConfig = Readonly<{
  hostedDomain?: unknown;
  clientId?: unknown;
  clientSecret?: unknown;
  redirectUri?: unknown;
  delegatedAdminEmail?: unknown;
  directoryServiceAccount?: unknown;
  roleGroupResourceNames?: unknown;
  customerId?: unknown;
  maxAuthenticationAgeMs?: unknown;
  maxSnapshotAgeMs?: unknown;
}>;

type DirectoryServiceAccountResolver = (value: unknown) => Promise<string | undefined>;
type ClientSecretResolver = (value: unknown) => Promise<string | undefined>;

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function requiredHostedDomain(value: unknown): string {
  const domain = text(value).toLowerCase();
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u.test(domain)) {
    throw new Error("memory-identity-google-workspace requires a registered hostedDomain");
  }
  return domain;
}

function requiredDelegatedAdmin(value: unknown, hostedDomain: string): string {
  const email = text(value).toLowerCase();
  if (!/^[^@\s]+@[^@\s]+$/u.test(email) || !email.endsWith(`@${hostedDomain}`)) {
    throw new Error(
      "memory-identity-google-workspace requires delegatedAdminEmail in hostedDomain",
    );
  }
  return email;
}

function groups(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("memory-identity-google-workspace requires roleGroupResourceNames");
  }
  const resourceNames = value.map((entry) => text(entry));
  if (
    resourceNames.some((resourceName) => !/^groups\/[^/\s]+$/u.test(resourceName)) ||
    new Set(resourceNames).size !== resourceNames.length
  ) {
    throw new Error("memory-identity-google-workspace requires unique groups/<id> resource names");
  }
  return resourceNames.toSorted();
}

function duration(value: unknown, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error("memory-identity-google-workspace requires a positive integer duration");
  }
  return value;
}

async function acquireDirectoryAccessToken(
  config: GoogleWorkspaceConfig,
  resolveDirectoryServiceAccount?: DirectoryServiceAccountResolver,
) {
  try {
    const serializedCredentials = resolveDirectoryServiceAccount
      ? await resolveDirectoryServiceAccount(config.directoryServiceAccount)
      : normalizeResolvedSecretInputString({
          value: config.directoryServiceAccount,
          path: "plugins.entries.memory-identity-google-workspace.config.directoryServiceAccount",
        });
    const delegatedAdminEmail = text(config.delegatedAdminEmail);
    if (!serializedCredentials || !delegatedAdminEmail) {
      return { kind: "unavailable" as const, reason: "directory credentials are unavailable" };
    }
    const credentials: unknown = JSON.parse(serializedCredentials);
    if (!credentials || typeof credentials !== "object" || Array.isArray(credentials)) {
      return { kind: "unavailable" as const, reason: "directory credentials are malformed" };
    }
    const clientEmail = text((credentials as Record<string, unknown>).client_email);
    const privateKey = text((credentials as Record<string, unknown>).private_key);
    if (!clientEmail || !privateKey) {
      return { kind: "unavailable" as const, reason: "directory credentials are malformed" };
    }
    const auth = new JWT({
      email: clientEmail,
      key: privateKey,
      subject: delegatedAdminEmail,
      scopes: [CLOUD_IDENTITY_GROUPS_READ_SCOPE],
    });
    const token = await auth.getAccessToken();
    const accessToken = token.token;
    return accessToken
      ? { kind: "available" as const, accessToken }
      : { kind: "unavailable" as const, reason: "directory token is unavailable" };
  } catch {
    return { kind: "unavailable" as const, reason: "directory token request failed" };
  }
}

/** The adapter obtains only an ephemeral DWD token; core performs membership lookup and persistence. */
export function createGoogleWorkspaceEnterpriseIdentityProvider(
  rawConfig: GoogleWorkspaceConfig | undefined,
  options: Readonly<{
    resolveDirectoryServiceAccount?: DirectoryServiceAccountResolver;
    resolveClientSecret?: ClientSecretResolver;
  }> = {},
): EnterpriseIdentityProviderAdapter {
  const config = rawConfig ?? {};
  const hostedDomain = requiredHostedDomain(config.hostedDomain);
  const delegatedAdminEmail = requiredDelegatedAdmin(config.delegatedAdminEmail, hostedDomain);
  const roleGroupResourceNames = groups(config.roleGroupResourceNames);
  const customerId = text(config.customerId);
  if (customerId && !/^C[\w-]+$/u.test(customerId)) {
    throw new Error(
      "memory-identity-google-workspace requires customerId in the canonical C<id> form",
    );
  }
  return {
    providerPrefix: "google-workspace",
    authorities: [
      {
        issuer: "https://accounts.google.com",
        acceptedIssuerAliases: ["accounts.google.com"],
        tenantId: hostedDomain,
        audiences: [text(config.clientId)],
        jwksUri: "https://www.googleapis.com/oauth2/v3/certs",
        algorithm: "RS256",
        tenantBinding: { kind: "issuer", tenantId: hostedDomain },
        assurance: { maxAuthenticationAgeMs: duration(config.maxAuthenticationAgeMs, 60 * 60_000) },
        authorizationCodeFlow: {
          clientId: text(config.clientId),
          authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenEndpoint: "https://oauth2.googleapis.com/token",
          redirectUri: text(config.redirectUri),
          scopes: ["openid", "email", "profile"],
        },
        requiredClaims: [
          { claim: "email_verified", value: true },
          { claim: "hd", value: hostedDomain },
        ],
        membership: {
          kind: "google-workspace-directory",
          verifiedEmailClaim: "email",
          roleGroupResourceNames,
          ...(customerId ? { customerId } : {}),
          maxGroups: roleGroupResourceNames.length,
        },
        maxSnapshotAgeMs: duration(config.maxSnapshotAgeMs, 60 * 60_000),
      },
    ],
    resolveAuthorizationCodeClientSecret: async () =>
      options.resolveClientSecret
        ? await options.resolveClientSecret(config.clientSecret)
        : normalizeResolvedSecretInputString({
            value: config.clientSecret,
            path: "plugins.entries.memory-identity-google-workspace.config.clientSecret",
          }),
    acquireDirectoryAccessToken: () =>
      acquireDirectoryAccessToken(
        { ...config, delegatedAdminEmail },
        options.resolveDirectoryServiceAccount,
      ),
  };
}
