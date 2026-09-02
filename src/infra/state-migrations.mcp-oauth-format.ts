import {
  OAuthClientInformationSchema,
  OAuthMetadataSchema,
  OAuthProtectedResourceMetadataSchema,
  OAuthTokensSchema,
  OpenIdProviderDiscoveryMetadataSchema,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

const MAX_TIMESTAMP_MS = 8_640_000_000_000_000;
const STORE_KEYS = new Set([
  "clientInformation",
  "tokens",
  "tokenExpiresAt",
  "codeVerifier",
  "discoveryState",
  "lastAuthorizationUrl",
  "redirectUrl",
  "state",
]);
const DISCOVERY_KEYS = new Set([
  "authorizationServerUrl",
  "authorizationServerMetadata",
  "resourceMetadata",
  "resourceMetadataUrl",
]);

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
): void {
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${label} has an unexpected field`);
  }
}

function parseSafeUrl(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} is not a string`);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (["javascript:", "data:", "vbscript:"].includes(parsed.protocol)) {
    throw new Error(`${label} uses an unsafe URL scheme`);
  }
  return value;
}

function parseDiscoveryState(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("legacy MCP OAuth discovery state is not an object");
  }
  assertOnlyKeys(value, DISCOVERY_KEYS, "legacy MCP OAuth discovery state");
  const result: Record<string, unknown> = {
    authorizationServerUrl: parseSafeUrl(
      value.authorizationServerUrl,
      "legacy MCP OAuth authorization server URL",
    ),
  };
  if (value.authorizationServerMetadata !== undefined) {
    const oauth = OAuthMetadataSchema.safeParse(value.authorizationServerMetadata);
    const oidc = oauth.success
      ? null
      : OpenIdProviderDiscoveryMetadataSchema.safeParse(value.authorizationServerMetadata);
    if (!oauth.success && !oidc?.success) {
      throw new Error("legacy MCP OAuth authorization server metadata is invalid");
    }
    result.authorizationServerMetadata = value.authorizationServerMetadata;
  }
  if (value.resourceMetadata !== undefined) {
    const parsed = OAuthProtectedResourceMetadataSchema.safeParse(value.resourceMetadata);
    if (!parsed.success) {
      throw new Error("legacy MCP OAuth resource metadata is invalid");
    }
    result.resourceMetadata = value.resourceMetadata;
  }
  if (value.resourceMetadataUrl !== undefined) {
    result.resourceMetadataUrl = parseSafeUrl(
      value.resourceMetadataUrl,
      "legacy MCP OAuth resource metadata URL",
    );
  }
  return result;
}

export function parseLegacyMcpOAuthStore(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("legacy MCP OAuth store is not an object");
  }
  assertOnlyKeys(value, STORE_KEYS, "legacy MCP OAuth store");
  const result: Record<string, unknown> = {};
  if (value.clientInformation !== undefined) {
    const parsed = OAuthClientInformationSchema.safeParse(value.clientInformation);
    if (!parsed.success) {
      throw new Error("legacy MCP OAuth client information is invalid");
    }
    result.clientInformation = value.clientInformation;
  }
  if (value.tokens !== undefined) {
    const parsed = OAuthTokensSchema.safeParse(value.tokens);
    if (!parsed.success) {
      throw new Error("legacy MCP OAuth tokens are invalid");
    }
    result.tokens = value.tokens;
  }
  if (value.tokenExpiresAt !== undefined) {
    if (
      typeof value.tokenExpiresAt !== "number" ||
      !Number.isFinite(value.tokenExpiresAt) ||
      value.tokenExpiresAt < 0 ||
      value.tokenExpiresAt > MAX_TIMESTAMP_MS
    ) {
      throw new Error("legacy MCP OAuth token expiry is invalid");
    }
    if (result.tokens !== undefined) {
      result.tokenExpiresAt = value.tokenExpiresAt;
    }
  }
  if (value.codeVerifier !== undefined) {
    if (typeof value.codeVerifier !== "string" || value.codeVerifier.length === 0) {
      throw new Error("legacy MCP OAuth code verifier is invalid");
    }
    result.codeVerifier = value.codeVerifier;
  }
  if (value.discoveryState !== undefined) {
    result.discoveryState = parseDiscoveryState(value.discoveryState);
  }
  if (value.lastAuthorizationUrl !== undefined) {
    result.lastAuthorizationUrl = parseSafeUrl(
      value.lastAuthorizationUrl,
      "legacy MCP OAuth authorization URL",
    );
  }
  if (value.redirectUrl !== undefined) {
    result.redirectUrl = parseSafeUrl(value.redirectUrl, "legacy MCP OAuth redirect URL");
  }
  // `state` was persisted but never read. Doctor deliberately leaves it retired.
  return result;
}
