import {
  ensureAuthProfileStore,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import { resolveEnvApiKey } from "../../agents/model-auth.js";
import { formatCliCommand } from "../../cli/command-format.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RuntimeEnv } from "../../runtime.js";
import { normalizeOptionalSecretInput } from "../../utils/normalize-secret-input.js";
import type { SecretInputMode } from "../onboard-types.js";

export type NonInteractiveApiKeySource = "flag" | "env" | "profile";

function parseEnvVarNameFromSourceLabel(source: string | undefined): string | undefined {
  if (!source) {
    return undefined;
  }
  const match = /^(?:shell env: |env: )([A-Z][A-Z0-9_]*)$/.exec(source.trim());
  return match?.[1];
}

async function resolveApiKeyFromProfiles(params: {
  provider: string;
  cfg: OpenClawConfig;
  agentDir?: string;
}): Promise<string | null> {
  const store = ensureAuthProfileStore(params.agentDir);
  const order = resolveAuthProfileOrder({
    cfg: params.cfg,
    store,
    provider: params.provider,
  });
  for (const profileId of order) {
    const cred = store.profiles[profileId];
    if (cred?.type !== "api_key") {
      continue;
    }
    const resolved = await resolveApiKeyForProfile({
      cfg: params.cfg,
      store,
      profileId,
      agentDir: params.agentDir,
    });
    if (resolved?.apiKey) {
      return resolved.apiKey;
    }
  }
  return null;
}

export async function resolveNonInteractiveApiKey(params: {
  provider: string;
  cfg: OpenClawConfig;
  flagValue?: string;
  flagName: string;
  envVar: string;
  envVarName?: string;
  runtime: RuntimeEnv;
  agentDir?: string;
  allowProfile?: boolean;
  required?: boolean;
  secretInputMode?: SecretInputMode;
}): Promise<{ key: string; source: NonInteractiveApiKeySource; envVarName?: string } | null> {
  const flagKey = normalizeOptionalSecretInput(params.flagValue);
  const explicitEnvVar = params.envVarName?.trim() || params.envVar.trim();
  const resolveExplicitEnvKey = () => normalizeOptionalSecretInput(process.env[explicitEnvVar]);
  const resolveEnvKey = () => {
    const envResolved = resolveEnvApiKey(params.provider);
    const explicitEnvKey = explicitEnvVar
      ? normalizeOptionalSecretInput(process.env[explicitEnvVar])
      : undefined;
    return {
      key: envResolved?.apiKey ?? explicitEnvKey,
      envVarName: parseEnvVarNameFromSourceLabel(envResolved?.source) ?? explicitEnvVar,
    };
  };

  const useSecretRefMode = params.secretInputMode === "ref"; // pragma: allowlist secret
  if (useSecretRefMode && flagKey) {
    const explicitEnvKey = resolveExplicitEnvKey();
    if (explicitEnvKey) {
      return { key: explicitEnvKey, source: "env", envVarName: explicitEnvVar };
    }
    params.runtime.error(
      [
        `${params.flagName} cannot be used with --secret-input-mode ref unless ${params.envVar} is set in env.`,
        `Set ${params.envVar} in env and omit ${params.flagName}, or use --secret-input-mode plaintext.`,
      ].join("\n"),
    );
    params.runtime.exit(1);
    return null;
  }

  if (useSecretRefMode) {
    const resolvedEnv = resolveEnvKey();
    if (resolvedEnv.key) {
      if (!resolvedEnv.envVarName) {
        params.runtime.error(
          [
            `--secret-input-mode ref requires an explicit environment variable for provider "${params.provider}".`,
            `Set ${params.envVar} in env and retry, or use --secret-input-mode plaintext.`,
          ].join("\n"),
        );
        params.runtime.exit(1);
        return null;
      }
      return { key: resolvedEnv.key, source: "env", envVarName: resolvedEnv.envVarName };
    }
  }

  if (flagKey) {
    return { key: flagKey, source: "flag" };
  }

  const resolvedEnv = resolveEnvKey();
  if (resolvedEnv.key) {
    return { key: resolvedEnv.key, source: "env", envVarName: resolvedEnv.envVarName };
  }

  if (params.allowProfile ?? true) {
    const profileKey = await resolveApiKeyFromProfiles({
      provider: params.provider,
      cfg: params.cfg,
      agentDir: params.agentDir,
    });
    if (profileKey) {
      return { key: profileKey, source: "profile" };
    }
  }

  if (params.required === false) {
    return null;
  }

  const profileHint =
    params.allowProfile === false ? "" : `, or existing ${params.provider} API-key profile`;
  params.runtime.error(
    `Missing ${params.flagName} (or ${params.envVar} in env${profileHint}). Export ${params.envVar}, pass ${params.flagName}, or run ${formatCliCommand("openclaw onboard")} for interactive setup.`,
  );
  params.runtime.exit(1);
  return null;
}
