/**
 * Resolves model provider API keys from explicit environment variables.
 */
import fs from "node:fs";
import os from "node:os";
import { normalizeProviderIdForAuth } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString as normalizeOptionalPathInput } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getShellEnvAppliedKeys } from "../infra/shell-env.js";
import { resolvePluginSetupProvider } from "../plugins/setup-registry.js";
import type { ProviderAuthEvidence } from "../secrets/provider-env-vars.js";
import { normalizeOptionalSecretInput } from "../utils/normalize-secret-input.js";
import { resolveProviderEnvAuthLookupMaps } from "./model-auth-env-vars.js";
import { GCP_VERTEX_CREDENTIALS_MARKER } from "./model-auth-markers.js";

// Resolves API keys and local auth evidence from environment state. This keeps
// env-var lookup, shell-env provenance, and plugin setup fallbacks in one path.
export type EnvApiKeyResult = {
  apiKey: string;
  source: string;
};

export type EnvApiKeyLookupOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  aliasMap?: Readonly<Record<string, string>>;
  candidateMap?: Readonly<Record<string, readonly string[]>>;
  authEvidenceMap?: Readonly<Record<string, readonly ProviderAuthEvidence[]>>;
  skipSetupProviderFallback?: boolean;
};

function expandAuthEvidencePath(rawPath: string, env: NodeJS.ProcessEnv): string | undefined {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return undefined;
  }
  const homeDir = normalizeOptionalPathInput(env.HOME) ?? os.homedir();
  const appDataDir = normalizeOptionalPathInput(env.APPDATA);
  if (trimmed.includes("${APPDATA}") && !appDataDir) {
    return undefined;
  }
  return trimmed.replaceAll("${HOME}", homeDir).replaceAll("${APPDATA}", appDataDir ?? "");
}

function hasRequiredAuthEvidenceEnv(
  evidence: ProviderAuthEvidence,
  env: NodeJS.ProcessEnv,
): boolean {
  const hasEnv = (key: string) => Boolean(normalizeOptionalSecretInput(env[key]));
  if (evidence.requiresAnyEnv?.length && !evidence.requiresAnyEnv.some(hasEnv)) {
    return false;
  }
  if (evidence.requiresAllEnv?.length && !evidence.requiresAllEnv.every(hasEnv)) {
    return false;
  }
  return true;
}

function hasLocalFileAuthEvidence(evidence: ProviderAuthEvidence, env: NodeJS.ProcessEnv): boolean {
  if (evidence.fileEnvVar) {
    const explicitPath = normalizeOptionalPathInput(env[evidence.fileEnvVar]);
    if (explicitPath) {
      return fs.existsSync(explicitPath);
    }
  }
  for (const rawPath of evidence.fallbackPaths ?? []) {
    const expandedPath = expandAuthEvidencePath(rawPath, env);
    if (expandedPath && fs.existsSync(expandedPath)) {
      return true;
    }
  }
  return false;
}

function resolveAuthEvidence(
  evidence: readonly ProviderAuthEvidence[] | undefined,
  env: NodeJS.ProcessEnv,
): EnvApiKeyResult | null {
  for (const entry of evidence ?? []) {
    if (entry.type !== "local-file-with-env") {
      continue;
    }
    if (!hasRequiredAuthEvidenceEnv(entry, env) || !hasLocalFileAuthEvidence(entry, env)) {
      continue;
    }
    return {
      apiKey: entry.credentialMarker,
      source: entry.source ?? "local auth evidence",
    };
  }
  return null;
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

  const setupProvider = resolvePluginSetupProvider({
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
