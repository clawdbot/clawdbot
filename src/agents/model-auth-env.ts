/**
 * Resolves model provider API keys from explicit environment variables.
 */
import { normalizeProviderIdForAuth } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getShellEnvAppliedKeys } from "../infra/shell-env.js";
import { resolvePluginSetupProviderCore } from "../plugins/setup-registry.js";
import { resolveLocalProviderAuthEvidence } from "../secrets/provider-auth-evidence.js";
import type {
  ProviderAuthEvidence,
  ProviderEnvVarLookupParams,
} from "../secrets/provider-env-vars.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import { resolveProviderEnvAuthLookupMaps } from "./model-auth-env-vars.js";
import { GCP_VERTEX_CREDENTIALS_MARKER } from "./model-auth-markers.js";

// Resolves API keys and local auth evidence from environment state. This keeps
// env-var lookup, shell-env provenance, and plugin setup fallbacks in one path.
export type EnvApiKeyResult = {
  apiKey: string;
  source: string;
};

type ProviderEnvAuthEvidence = {
  mode: "api-key" | "aws-sdk" | "oauth";
  source: string;
};

/** Secret-free direct-auth fact retained for runtime credential resolution. */
type ProviderDirectAuthPlanningEvidence =
  | ({ kind: "environment" } & ProviderEnvAuthEvidence)
  | {
      kind: "setup-provider";
      mode: "api-key";
      source: "setup provider";
    };

export type EnvApiKeyLookupOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  aliasMap?: Readonly<Record<string, string>>;
  candidateMap?: Readonly<Record<string, readonly string[]>>;
  authEvidenceMap?: Readonly<Record<string, readonly ProviderAuthEvidence[]>>;
  setupProviderFallbackRefs?: readonly string[];
  skipSetupProviderFallback?: boolean;
};

function resolveAuthEvidence(
  evidence: readonly ProviderAuthEvidence[] | undefined,
  env: NodeJS.ProcessEnv,
): EnvApiKeyResult | null {
  const resolved = resolveLocalProviderAuthEvidence(evidence, env);
  return resolved ? { apiKey: resolved.credentialMarker, source: resolved.source } : null;
}

/** Reports env/local auth presence without returning or resolving credential material. */
export function resolveProviderEnvAuthEvidence(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
  options: EnvApiKeyLookupOptions = {},
): ProviderEnvAuthEvidence | null {
  const providerId = normalizeProviderIdForAuth(provider);
  const lookupMaps =
    !options.aliasMap || !options.candidateMap || !options.authEvidenceMap
      ? resolveProviderEnvAuthLookupMaps({
          config: options.config,
          workspaceDir: options.workspaceDir,
          env,
        })
      : undefined;
  const aliasMap = options.aliasMap ?? lookupMaps?.aliasMap ?? {};
  const normalized = aliasMap[providerId] ?? providerId;
  const candidateMap = options.candidateMap ?? lookupMaps?.envCandidateMap ?? {};
  const authEvidenceMap = options.authEvidenceMap ?? lookupMaps?.authEvidenceMap ?? {};
  const applied = new Set(getShellEnvAppliedKeys());

  for (const envVar of candidateMap[normalized] ?? []) {
    if (!normalizeOptionalSecretInput(env[envVar])) {
      continue;
    }
    const mode =
      normalized === "amazon-bedrock" && envVar.startsWith("AWS_")
        ? "aws-sdk"
        : envVar.includes("OAUTH_TOKEN")
          ? "oauth"
          : "api-key";
    return {
      mode,
      source: applied.has(envVar) ? `shell env: ${envVar}` : `env: ${envVar}`,
    };
  }

  const localEvidence = resolveLocalProviderAuthEvidence(authEvidenceMap[normalized], env);
  if (localEvidence) {
    return {
      mode: normalized === "amazon-bedrock" ? "aws-sdk" : "api-key",
      source: localEvidence.source,
    };
  }
  return null;
}

/**
 * Plans direct auth without loading a provider runtime or resolving credential material.
 * Setup-provider refs are deferred evidence only; runtime lookup still decides availability.
 */
export function resolveProviderDirectAuthPlanningEvidence(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
  options: EnvApiKeyLookupOptions & Pick<ProviderEnvVarLookupParams, "metadataSnapshot"> = {},
): ProviderDirectAuthPlanningEvidence | null {
  const lookupMaps =
    !options.aliasMap ||
    !options.candidateMap ||
    !options.authEvidenceMap ||
    !options.setupProviderFallbackRefs
      ? resolveProviderEnvAuthLookupMaps({
          config: options.config,
          workspaceDir: options.workspaceDir,
          env,
          metadataSnapshot: options.metadataSnapshot,
        })
      : undefined;
  const aliasMap = options.aliasMap ?? lookupMaps?.aliasMap ?? {};
  const candidateMap = options.candidateMap ?? lookupMaps?.envCandidateMap ?? {};
  const authEvidenceMap = options.authEvidenceMap ?? lookupMaps?.authEvidenceMap ?? {};
  const concrete = resolveProviderEnvAuthEvidence(provider, env, {
    aliasMap,
    candidateMap,
    authEvidenceMap,
  });
  if (concrete) {
    return { kind: "environment", ...concrete };
  }

  const providerId = normalizeProviderIdForAuth(provider);
  const normalized = aliasMap[providerId] ?? providerId;
  const setupProviderFallbackRefs =
    options.setupProviderFallbackRefs ?? lookupMaps?.setupProviderFallbackRefs ?? [];
  return setupProviderFallbackRefs.some((ref) => normalizeProviderIdForAuth(ref) === normalized)
    ? { kind: "setup-provider", mode: "api-key", source: "setup provider" }
    : null;
}

/** Resolve an API key or auth-evidence marker for a provider from environment state. */
export function resolveEnvApiKey(
  provider: string,
  env: NodeJS.ProcessEnv = process.env,
  options: EnvApiKeyLookupOptions = {},
): EnvApiKeyResult | null {
  const normalizedProvider = normalizeProviderIdForAuth(provider);
  const lookupParams = {
    config: options.config,
    workspaceDir: options.workspaceDir,
    env,
  };
  const lookupMaps =
    !options.aliasMap || !options.candidateMap || !options.authEvidenceMap
      ? resolveProviderEnvAuthLookupMaps(lookupParams)
      : undefined;
  const aliasMap = options.aliasMap ?? lookupMaps?.aliasMap ?? {};
  const normalized = aliasMap[normalizedProvider] ?? normalizedProvider;
  const candidateMap = options.candidateMap ?? lookupMaps?.envCandidateMap ?? {};
  const authEvidenceMap = options.authEvidenceMap ?? lookupMaps?.authEvidenceMap ?? {};
  const applied = new Set(getShellEnvAppliedKeys());
  const pick = (envVar: string): EnvApiKeyResult | null => {
    const value = normalizeOptionalSecretInput(env[envVar]);
    if (!value) {
      return null;
    }
    const source = applied.has(envVar) ? `shell env: ${envVar}` : `env: ${envVar}`;
    return { apiKey: value, source };
  };

  const candidates = Object.hasOwn(candidateMap, normalized) ? candidateMap[normalized] : undefined;
  if (Array.isArray(candidates)) {
    for (const envVar of candidates) {
      const resolved = pick(envVar);
      if (resolved) {
        return resolved;
      }
    }
  }

  const evidence = Object.hasOwn(authEvidenceMap, normalized)
    ? authEvidenceMap[normalized]
    : undefined;
  const authEvidence = resolveAuthEvidence(evidence, env);
  if (authEvidence) {
    return authEvidence;
  }

  if (Array.isArray(candidates)) {
    return null;
  }
  if (options.skipSetupProviderFallback === true) {
    return null;
  }

  const setupProvider = resolvePluginSetupProviderCore({
    provider: normalized,
    config: options.config,
    workspaceDir: options.workspaceDir,
    env,
  });
  if (setupProvider?.resolveConfigApiKey) {
    const resolved = setupProvider.resolveConfigApiKey({
      provider: normalized,
      env,
    });
    if (resolved?.trim()) {
      return {
        apiKey: resolved,
        source: resolved === GCP_VERTEX_CREDENTIALS_MARKER ? "gcloud adc" : "env",
      };
    }
  }

  return null;
}
