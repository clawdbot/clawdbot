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
  const normalizedProvider = resolveProviderIdForAuth(params.provider, { config: cfg });
  const profiles = {
    ...cfg.auth?.profiles,
    [params.profileId]: {
      provider: params.provider,
      mode: params.mode,
      ...(params.email ? { email: params.email } : {}),
      ...(params.displayName ? { displayName: params.displayName } : {}),
    },
  };

  const configuredProviderProfiles = Object.entries(cfg.auth?.profiles ?? {})
    .filter(
      ([, profile]) =>
        resolveProviderIdForAuth(profile.provider, { config: cfg }) === normalizedProvider,
    )
    .map(([profileId, profile]) => ({ profileId, mode: profile.mode }));

  // Maintain `auth.order` when it already exists. Additionally, if we detect
  // mixed auth modes for the same provider, keep the newly selected profile first.
  const matchingProviderOrderEntries = Object.entries(cfg.auth?.order ?? {}).filter(
    ([providerId]) => resolveProviderIdForAuth(providerId, { config: cfg }) === normalizedProvider,
  );
  const existingProviderOrder =
    matchingProviderOrderEntries.length > 0
      ? uniqueStrings(matchingProviderOrderEntries.flatMap(([, order]) => order))
      : undefined;
  const preferProfileFirst = params.preferProfileFirst ?? true;
  const reorderedProviderOrder =
    existingProviderOrder && preferProfileFirst
      ? [
          params.profileId,
          ...existingProviderOrder.filter((profileId) => profileId !== params.profileId),
        ]
      : existingProviderOrder;
  const hasMixedConfiguredModes = configuredProviderProfiles.some(
    ({ profileId, mode }) => profileId !== params.profileId && mode !== params.mode,
  );
  const derivedProviderOrder =
    existingProviderOrder === undefined && preferProfileFirst && hasMixedConfiguredModes
      ? [
          params.profileId,
          ...configuredProviderProfiles
            .map(({ profileId }) => profileId)
            .filter((profileId) => profileId !== params.profileId),
        ]
      : undefined;
  const baseOrder =
    matchingProviderOrderEntries.length > 0
      ? Object.fromEntries(
          Object.entries(cfg.auth?.order ?? {}).filter(
            ([providerId]) =>
              resolveProviderIdForAuth(providerId, { config: cfg }) !== normalizedProvider,
          ),
        )
      : cfg.auth?.order;
  const order =
    existingProviderOrder !== undefined
      ? {
          ...baseOrder,
          [normalizedProvider]: reorderedProviderOrder?.includes(params.profileId)
            ? reorderedProviderOrder
            : [...(reorderedProviderOrder ?? []), params.profileId],
        }
      : derivedProviderOrder
        ? {
            ...baseOrder,
            [normalizedProvider]: derivedProviderOrder,
          }
        : baseOrder;
  return {
    ...cfg,
    auth: {
      ...cfg.auth,
      profiles,
      ...(order ? { order } : {}),
    },
  };
}

/** Returns true when config still names a removed auth profile. */
export function configReferencesAuthProfile(cfg: OpenClawConfig, profileId: string): boolean {
  return (
    Boolean(cfg.auth?.profiles?.[profileId]) ||
    Object.values(cfg.auth?.order ?? {}).some((order) => order.includes(profileId))
  );
}

/**
 * Counterpart to {@link applyAuthProfileConfig}: drops a profile from
 * `auth.profiles` and every `auth.order` list. An emptied provider order is
 * deleted rather than left as `[]`, because an authored empty order is a hard
 * "select no profiles" instruction and would disable the provider entirely.
 */
export function removeAuthProfileConfig(cfg: OpenClawConfig, profileId: string): OpenClawConfig {
  if (!configReferencesAuthProfile(cfg, profileId)) {
    return cfg;
  }
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
  return {
    ...cfg,
    auth: {
      ...auth,
      profiles,
      ...(Object.keys(order).length > 0 ? { order } : {}),
    },
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
