/** Env/config-backed credential discovery shared by agent auth discovery modes. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AgentCredentialMap } from "./agent-auth-credentials.js";
import {
  listProviderEnvAuthLookupKeys,
  resolveProviderEnvAuthLookupMaps,
} from "./model-auth-env-vars.js";
import { resolveEnvApiKey } from "./model-auth-env.js";

/** Options for discovering env-backed credentials during agent auth discovery. */
export type AgentDiscoveryAuthLookupOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};

/** Adds provider credentials resolvable from env/config without mutating existing credentials. */
export function addEnvBackedAgentCredentials(
  credentials: AgentCredentialMap,
  options: AgentDiscoveryAuthLookupOptions = {},
): AgentCredentialMap {
  const env = options.env ?? process.env;
  const lookupParams = {
    config: options.config,
    workspaceDir: options.workspaceDir,
    env,
  };
  const lookupMaps = resolveProviderEnvAuthLookupMaps(lookupParams);
  const { aliasMap, envCandidateMap: candidateMap, authEvidenceMap } = lookupMaps;
  const next = { ...credentials };
  // session runtime hides providers from its registry when auth storage lacks
  // a matching credential entry. Mirror env-backed provider auth here so
  // live/model discovery sees the same providers runtime auth can use.
  for (const provider of listProviderEnvAuthLookupKeys({
    envCandidateMap: candidateMap,
    authEvidenceMap,
  })) {
    if (next[provider]) {
      continue;
    }
    const resolved = resolveEnvApiKey(provider, env, {
      config: options.config,
      workspaceDir: options.workspaceDir,
      aliasMap,
      candidateMap,
      authEvidenceMap,
    });
    if (!resolved?.apiKey) {
      continue;
    }
    next[provider] = {
      type: "api_key",
      key: resolved.apiKey,
    };
  }
  return next;
}
