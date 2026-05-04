import { Buffer } from "node:buffer";
import type { ChatType } from "../channels/chat-type.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { NormalizedPluginsConfig } from "./config-state.js";
import type {
  DelegatedAccessTokenRequest,
  DelegatedAccessTokenResult,
  OpenClawPluginAuthContext,
} from "./tool-types.js";

type DelegatedAccessConfig = NonNullable<
  NormalizedPluginsConfig["entries"][string]["auth"]
>["delegatedAccess"];

const log = createSubsystemLogger("plugins/tools");

function normalizeStringSet(list?: string[]): Set<string> {
  return new Set((list ?? []).map((entry) => entry.trim()).filter(Boolean));
}

function expandAcceptedAudienceValues(expected: string): Set<string> {
  const trimmed = expected.trim();
  const values = new Set([trimmed]);
  const appId = parseApiSchemeAppId(expected);
  if (appId) {
    values.add(appId);
    values.add(normalizeAppIdAudience(appId));
  } else if (isPlainAppId(expected)) {
    values.add(`api://${trimmed}`);
    values.add(normalizeAppIdAudience(trimmed));
  }
  return values;
}

function expandAcceptedAudienceSet(values: Set<string>): Set<string> {
  const expanded = new Set<string>();
  for (const value of values) {
    for (const accepted of expandAcceptedAudienceValues(value)) {
      expanded.add(accepted);
    }
  }
  return expanded;
}

function parseApiSchemeAppId(value: string): string | undefined {
  const match = /^api:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
    value.trim(),
  );
  return match?.[1];
}

function isPlainAppId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim());
}

function audienceValueMatches(value: string, accepted: Set<string>): boolean {
  return accepted.has(value) || accepted.has(normalizeAudienceValueForComparison(value));
}

function normalizeAudienceValueForComparison(value: string): string {
  const appId = parseApiSchemeAppId(value);
  if (appId) {
    return normalizeAppIdAudience(appId);
  }
  if (isPlainAppId(value)) {
    return normalizeAppIdAudience(value);
  }
  return value;
}

function normalizeAppIdAudience(value: string): string {
  return value.trim().toLowerCase();
}

function isDelegatedAccessRequestAllowed(
  request: DelegatedAccessTokenRequest,
  config: DelegatedAccessConfig,
): boolean {
  if (!config || config.enabled !== true) {
    return false;
  }
  const providers = normalizeStringSet(config.providers);
  if (providers.size > 0 && !providers.has(request.provider)) {
    return false;
  }
  const audiences = normalizeStringSet(config.audiences);
  const requestedAudience = request.audience?.trim();
  if (
    audiences.size > 0 &&
    (!requestedAudience ||
      !audienceValueMatches(requestedAudience, expandAcceptedAudienceSet(audiences)))
  ) {
    return false;
  }
  const scopes = normalizeStringSet(config.scopes);
  const requestedScopes = (request.scopes ?? []).map((scope) => scope.trim()).filter(Boolean);
  if (scopes.size > 0) {
    if (requestedScopes.length === 0) {
      return false;
    }
    for (const scope of requestedScopes) {
      if (!scopes.has(scope)) {
        return false;
      }
    }
  }
  return true;
}

function isDelegatedAccessChatTypeAllowed(
  chatType: ChatType | undefined,
  config: DelegatedAccessConfig,
): boolean {
  const chatTypes = normalizeStringSet(config?.chatTypes);
  return chatTypes.size === 0 || (chatType !== undefined && chatTypes.has(chatType));
}

function readJwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) {
    return null;
  }
  try {
    const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const parsed = JSON.parse(Buffer.from(padded, "base64").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readJwtScopes(value: unknown): string[] {
  if (typeof value === "string") {
    return value.split(/\s+/).filter(Boolean);
  }
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  }
  return [];
}

function jwtAudienceAllowed(value: unknown, allowed: Set<string>): boolean {
  const accepted = expandAcceptedAudienceSet(allowed);
  if (typeof value === "string") {
    return audienceValueMatches(value, accepted);
  }
  if (Array.isArray(value)) {
    const audiences = value.filter((entry): entry is string => typeof entry === "string");
    return (
      audiences.length === value.length &&
      audiences.some((entry) => audienceValueMatches(entry, accepted))
    );
  }
  return false;
}

function areDelegatedAccessTokenClaimsAllowed(params: {
  token: string;
  request: DelegatedAccessTokenRequest;
  config: DelegatedAccessConfig;
}): boolean {
  const allowedAudiences = normalizeStringSet(params.config?.audiences);
  const requestedAudience = params.request.audience?.trim();
  const requestedScopes = (params.request.scopes ?? [])
    .map((scope) => scope.trim())
    .filter(Boolean);
  if (!requestedAudience && allowedAudiences.size === 0 && requestedScopes.length === 0) {
    return true;
  }
  const payload = readJwtPayload(params.token);
  if (!payload) {
    return false;
  }
  if (requestedAudience && !jwtAudienceAllowed(payload.aud, new Set([requestedAudience]))) {
    return false;
  }
  if (
    !requestedAudience &&
    allowedAudiences.size > 0 &&
    !jwtAudienceAllowed(payload.aud, allowedAudiences)
  ) {
    return false;
  }
  if (requestedScopes.length > 0) {
    const actualScopes = readJwtScopes(payload.scp);
    if (actualScopes.length === 0) {
      return false;
    }
    const actualScopeSet = new Set(actualScopes);
    for (const scope of requestedScopes) {
      if (!actualScopeSet.has(scope)) {
        return false;
      }
    }
  }
  return true;
}

async function resolveAllowedDelegatedAccessToken(params: {
  auth: OpenClawPluginAuthContext;
  request: DelegatedAccessTokenRequest;
  config: DelegatedAccessConfig;
}): Promise<DelegatedAccessTokenResult> {
  const result = await params.auth.getDelegatedAccessToken(params.request);
  if (!result.ok) {
    return result;
  }
  if (
    !areDelegatedAccessTokenClaimsAllowed({
      token: result.token,
      request: params.request,
      config: params.config,
    })
  ) {
    log.debug?.("plugin delegated auth token rejected by plugin policy claims", {
      provider: params.request.provider,
      hasAudience: Boolean(params.request.audience?.trim()),
      scopeCount: params.request.scopes?.filter((scope) => scope.trim()).length ?? 0,
    });
    return { ok: false, reason: "unavailable" };
  }
  return result;
}

export function resolveDelegatedAuthForPlugin(params: {
  auth: OpenClawPluginAuthContext | undefined;
  chatType: ChatType | undefined;
  pluginId: string;
  plugins: NormalizedPluginsConfig;
}): OpenClawPluginAuthContext | undefined {
  const delegatedAccess = params.plugins.entries[params.pluginId]?.auth?.delegatedAccess;
  if (delegatedAccess?.enabled !== true) {
    return undefined;
  }
  if (!params.auth) {
    return undefined;
  }
  const auth = params.auth;
  return {
    getDelegatedAccessToken: async (request) => {
      if (!isDelegatedAccessRequestAllowed(request, delegatedAccess)) {
        return { ok: false, reason: "not_configured" };
      }
      if (!isDelegatedAccessChatTypeAllowed(params.chatType, delegatedAccess)) {
        return { ok: false, reason: "not_configured" };
      }
      return resolveAllowedDelegatedAccessToken({
        auth,
        request,
        config: delegatedAccess,
      });
    },
  };
}
