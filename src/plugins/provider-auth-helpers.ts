// Builds provider auth credentials from config and plugin metadata.
import fs from "node:fs";
import path from "node:path";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveDefaultAgentDir } from "../agents/agent-scope-config.js";
import { buildAuthProfileId } from "../agents/auth-profiles/identity.js";
import {
  upsertAuthProfile,
  upsertAuthProfileWithLock,
  upsertAuthProfileWithLockOrThrow,
} from "../agents/auth-profiles/profiles.js";
import { resolveProviderIdForAuth } from "../agents/provider-auth-aliases.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  coerceSecretRef,
  DEFAULT_SECRET_PROVIDER_ALIAS,
  parseEnvTemplateSecretRef,
  type SecretInput,
  type SecretRef,
} from "../config/types.secrets.js";
import { safeRealpathSync } from "../infra/boundary-path.js";
import type { OAuthCredentials } from "../llm/oauth.js";
import { getProviderEnvVars } from "../secrets/provider-env-vars.js";
import { isValidSecretRef } from "../secrets/ref-contract.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import type { SecretInputMode } from "./provider-auth-types.js";

const resolveAuthAgentDir = (agentDir?: string, config?: OpenClawConfig) =>
  agentDir ?? resolveDefaultAgentDir(config ?? {});

export type ApiKeyStorageOptions = {
  secretInputMode?: SecretInputMode;
  config?: OpenClawConfig;
};

export type WriteOAuthCredentialsOptions = {
  syncSiblingAgents?: boolean;
  profileName?: string;
  displayName?: string;
};

function buildEnvSecretRef(id: string): SecretRef {
  return { source: "env", provider: DEFAULT_SECRET_PROVIDER_ALIAS, id };
}

function resolveProviderDefaultEnvSecretRef(provider: string, config?: OpenClawConfig): SecretRef {
  const envVars = getProviderEnvVars(provider, {
    ...(config ? { config } : {}),
    includeUntrustedWorkspacePlugins: false,
  });
  const envVar = envVars?.find((candidate) => candidate.trim().length > 0);
  if (!envVar) {
    throw new Error(
      `Provider "${provider}" does not have a default env var mapping for secret-input-mode=ref.`,
    );
  }
  return buildEnvSecretRef(envVar);
}

function resolveApiKeySecretInput(
  provider: string,
  input: SecretInput,
  options?: ApiKeyStorageOptions,
): SecretInput {
  if (input !== null && typeof input === "object") {
    const coercedRef = coerceSecretRef(input);
    if (!coercedRef || !isValidSecretRef(coercedRef)) {
      throw new Error("API key SecretRef is invalid.");
    }
    return coercedRef;
  }
  if (options?.secretInputMode === "plaintext") {
    return normalizeSecretInput(input);
  }
  const coercedRef = coerceSecretRef(input);
  if (coercedRef) {
    if (!isValidSecretRef(coercedRef)) {
      throw new Error("API key SecretRef is invalid.");
    }
    return coercedRef;
  }
  const normalized = normalizeSecretInput(input);
  const inlineEnvRef = parseEnvTemplateSecretRef(normalized, DEFAULT_SECRET_PROVIDER_ALIAS);
  if (inlineEnvRef) {
    return inlineEnvRef;
  }
  if (options?.secretInputMode === "ref") {
    return resolveProviderDefaultEnvSecretRef(provider, options.config);
  }
  return normalized;
}

export function buildApiKeyCredential(
  provider: string,
  input: SecretInput,
  metadata?: Record<string, string>,
  options?: ApiKeyStorageOptions,
): {
  type: "api_key";
  provider: string;
  key?: string;
  keyRef?: SecretRef;
  metadata?: Record<string, string>;
} {
  const secretInput = resolveApiKeySecretInput(provider, input, options);
  if (typeof secretInput === "string") {
    return {
      type: "api_key",
      provider,
      key: secretInput,
      ...(metadata ? { metadata } : {}),
    };
  }
  return {
    type: "api_key",
    provider,
    keyRef: secretInput,
    ...(metadata ? { metadata } : {}),
  };
}

export function upsertApiKeyProfile(params: {
  provider: string;
  input: SecretInput;
  agentDir?: string;
  options?: ApiKeyStorageOptions;
  profileId?: string;
  metadata?: Record<string, string>;
}): string {
  const profileId = params.profileId ?? buildAuthProfileId({ providerId: params.provider });
  upsertAuthProfile({
    profileId,
    credential: buildApiKeyCredential(
      params.provider,
      params.input,
      params.metadata,
      params.options,
    ),
    agentDir: resolveAuthAgentDir(params.agentDir, params.options?.config),
  });
  return profileId;
}

export function applyAuthProfileConfig(
  cfg: OpenClawConfig,
  params: {
    profileId: string;
    provider: string;
    mode: "api_key" | "aws-sdk" | "oauth" | "token";
    email?: string;
    displayName?: string;
    preferProfileFirst?: boolean;
  },
): OpenClawConfig {
  const profiles = {
    ...cfg.auth?.profiles,
    [params.profileId]: {
      provider: params.provider,
      mode: params.mode,
      ...(params.email ? { email: params.email } : {}),
      ...(params.displayName ? { displayName: params.displayName } : {}),
    },
  };

  const next = { ...cfg, auth: { ...cfg.auth, profiles } };
  const configuredProfiles = Object.entries(cfg.auth?.profiles ?? {});
  const orderEntries = Object.entries(cfg.auth?.order ?? {});
  const preferProfileFirst = params.preferProfileFirst ?? true;
  // Aliases only affect ordering. A config-only profile insertion must not
  // discover plugins (and open their state database) when order cannot change.
  if (
    orderEntries.length === 0 &&
    (!preferProfileFirst ||
      !configuredProfiles.some(
        ([profileId, profile]) => profileId !== params.profileId && profile.mode !== params.mode,
      ))
  ) {
    return next;
  }

  const normalizedProvider = resolveProviderIdForAuth(params.provider, {
    config: cfg,
    storedCredential: true,
  });
  const matchesProvider = (provider: string, storedCredential = false) =>
    resolveProviderIdForAuth(provider, { config: cfg, storedCredential }) === normalizedProvider;
  const matchingOrderEntries = orderEntries.filter(([provider]) => matchesProvider(provider));
  let providerOrder: string[] | undefined;
  if (matchingOrderEntries.length > 0) {
    const existingOrder = uniqueStrings(matchingOrderEntries.flatMap(([, order]) => order));
    providerOrder = preferProfileFirst
      ? [params.profileId, ...existingOrder.filter((profileId) => profileId !== params.profileId)]
      : existingOrder.includes(params.profileId)
        ? existingOrder
        : [...existingOrder, params.profileId];
  } else if (preferProfileFirst) {
    const peers = configuredProfiles.filter(([, profile]) =>
      matchesProvider(profile.provider, true),
    );
    if (
      peers.some(
        ([profileId, profile]) => profileId !== params.profileId && profile.mode !== params.mode,
      )
    ) {
      providerOrder = [
        params.profileId,
        ...peers
          .map(([profileId]) => profileId)
          .filter((profileId) => profileId !== params.profileId),
      ];
    }
  }
  if (providerOrder) {
    next.auth.order = {
      ...Object.fromEntries(orderEntries.filter(([provider]) => !matchesProvider(provider))),
      [normalizedProvider]: providerOrder,
    };
  }
  return next;
}

/** Returns true when config still names a removed auth profile. */
export function configReferencesAuthProfile(cfg: OpenClawConfig, profileId: string): boolean {
  return (
    Boolean(cfg.auth?.profiles?.[profileId]) ||
    Object.values(cfg.auth?.order ?? {}).some((order) => order.includes(profileId)) ||
    Object.values(cfg.models?.providers ?? {}).some((provider) => provider.apiKey === profileId)
  );
}

/**
 * Drops a profile from `auth.profiles`, every `auth.order` list, and provider-entry
 * `apiKey` references. An emptied provider order is deleted rather than left as
 * `[]`, because an authored empty order is a hard "select no profiles" instruction.
 */
export function removeAuthProfileConfig(cfg: OpenClawConfig, profileId: string): OpenClawConfig {
  if (!configReferencesAuthProfile(cfg, profileId)) {
    return cfg;
  }
  const authReferencesProfile =
    Boolean(cfg.auth?.profiles?.[profileId]) ||
    Object.values(cfg.auth?.order ?? {}).some((providerOrder) => providerOrder.includes(profileId));
  const profiles = Object.fromEntries(
    Object.entries(cfg.auth?.profiles ?? {}).filter(([id]) => id !== profileId),
  );
  const order = Object.entries(cfg.auth?.order ?? {}).reduce<Record<string, string[]>>(
    (acc, [providerId, providerOrder]) => {
      const next = providerOrder.filter((id) => id !== profileId);
      // Drop only an order this removal emptied. An order that was already
      // empty is an authored "select no profiles" instruction for an unrelated
      // provider and must survive untouched.
      if (next.length > 0 || next.length === providerOrder.length) {
        acc[providerId] = next;
      }
      return acc;
    },
    {},
  );
  const { order: _droppedOrder, ...auth } = cfg.auth ?? {};
  const providers = Object.fromEntries(
    Object.entries(cfg.models?.providers ?? {}).map(([providerId, provider]) => {
      if (provider.apiKey !== profileId) {
        return [providerId, provider];
      }
      const { apiKey: _droppedApiKey, ...nextProvider } = provider;
      return [providerId, nextProvider];
    }),
  );
  return {
    ...cfg,
    ...(authReferencesProfile
      ? {
          auth: {
            ...auth,
            profiles,
            ...(Object.keys(order).length > 0 ? { order } : {}),
          },
        }
      : {}),
    ...(cfg.models?.providers ? { models: { ...cfg.models, providers } } : {}),
  };
}

function resolveSiblingAgentDirs(primaryAgentDir: string): string[] {
  const normalized = path.resolve(primaryAgentDir);
  const parentOfAgent = path.dirname(normalized);
  const candidateAgentsRoot = path.dirname(parentOfAgent);
  const looksLikeStandardLayout =
    path.basename(normalized) === "agent" && path.basename(candidateAgentsRoot) === "agents";

  const agentsRoot = looksLikeStandardLayout
    ? candidateAgentsRoot
    : path.join(resolveStateDir(), "agents");

  const entries = (() => {
    try {
      return fs.readdirSync(agentsRoot, { withFileTypes: true });
    } catch {
      return [];
    }
  })();
  const discovered = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => path.join(agentsRoot, entry.name, "agent"));

  const seen = new Set<string>();
  const result: string[] = [];
  for (const dir of [normalized, ...discovered]) {
    const real = safeRealpathSync(path.resolve(dir));
    if (real && !seen.has(real)) {
      seen.add(real);
      result.push(real);
    }
  }
  return result;
}

export async function writeOAuthCredentials(
  provider: string,
  creds: OAuthCredentials,
  agentDir?: string,
  options?: WriteOAuthCredentialsOptions,
): Promise<string> {
  const email =
    typeof creds.email === "string" && creds.email.trim() ? creds.email.trim() : "default";
  const profileId = buildAuthProfileId({
    providerId: provider,
    profileName: options?.profileName ?? email,
  });
  const resolvedAgentDir = path.resolve(resolveAuthAgentDir(agentDir));
  const targetAgentDirs = options?.syncSiblingAgents
    ? resolveSiblingAgentDirs(resolvedAgentDir)
    : [resolvedAgentDir];

  const credential = {
    type: "oauth" as const,
    provider,
    ...creds,
    ...(options?.displayName ? { displayName: options.displayName } : {}),
  };

  await upsertAuthProfileWithLockOrThrow({
    profileId,
    credential,
    agentDir: resolvedAgentDir,
  });

  if (options?.syncSiblingAgents) {
    const primaryReal = safeRealpathSync(path.resolve(resolvedAgentDir));
    for (const targetAgentDir of targetAgentDirs) {
      const targetReal = safeRealpathSync(path.resolve(targetAgentDir));
      if (targetReal && primaryReal && targetReal === primaryReal) {
        continue;
      }
      try {
        await upsertAuthProfileWithLock({
          profileId,
          credential,
          agentDir: targetAgentDir,
        });
      } catch {
        // Best-effort: sibling sync failure must not block primary setup.
      }
    }
  }
  return profileId;
}
