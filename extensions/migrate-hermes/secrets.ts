// Migrate Hermes plugin module implements secrets behavior.
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  resolveAuthStorePathForDisplay,
} from "openclaw/plugin-sdk/agent-runtime";
import type { MigrationItem, MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { updateAuthProfileStoreWithLock } from "openclaw/plugin-sdk/provider-auth";
import {
  applyAuthProfileConfigWithConflictCheck,
  hasAuthProfileConfigConflict,
  hasCurrentAuthProfileConfigConflict,
  type HermesAuthProfileConfig,
} from "./auth-config.js";
import { isRecord, parseEnv, readString, readText } from "./helpers.js";
import {
  createHermesSecretItem,
  HERMES_REASON_AUTH_PROFILE_EXISTS,
  HERMES_REASON_AUTH_PROFILE_WRITE_FAILED,
  HERMES_REASON_MISSING_SECRET_METADATA,
  HERMES_REASON_SECRET_NO_LONGER_PRESENT,
  hermesItemConflict,
  hermesItemError,
  hermesItemSkipped,
  readHermesSecretDetails,
} from "./items.js";
import type { HermesSource } from "./source.js";
import type { PlannedTargets } from "./targets.js";

type SecretCredentialMode = "api_key" | "token";

type SecretMapping = {
  envVar: string;
  provider: string;
  profileId: string;
  mode?: SecretCredentialMode;
};

const SECRET_MAPPINGS: readonly SecretMapping[] = [
  { envVar: "OPENAI_API_KEY", provider: "openai", profileId: "openai:hermes-import" },
  { envVar: "ANTHROPIC_API_KEY", provider: "anthropic", profileId: "anthropic:hermes-import" },
  { envVar: "OPENROUTER_API_KEY", provider: "openrouter", profileId: "openrouter:hermes-import" },
  { envVar: "GOOGLE_API_KEY", provider: "google", profileId: "google:hermes-import" },
  { envVar: "GEMINI_API_KEY", provider: "google", profileId: "google:hermes-import" },
  { envVar: "GROQ_API_KEY", provider: "groq", profileId: "groq:hermes-import" },
  { envVar: "XAI_API_KEY", provider: "xai", profileId: "xai:hermes-import" },
  { envVar: "MISTRAL_API_KEY", provider: "mistral", profileId: "mistral:hermes-import" },
  { envVar: "DEEPSEEK_API_KEY", provider: "deepseek", profileId: "deepseek:hermes-import" },
  { envVar: "ZAI_API_KEY", provider: "zai", profileId: "zai:hermes-import" },
  { envVar: "Z_AI_API_KEY", provider: "zai", profileId: "zai:hermes-import" },
  { envVar: "GLM_API_KEY", provider: "zai", profileId: "zai:hermes-import" },
  { envVar: "KIMI_API_KEY", provider: "kimi-coding", profileId: "kimi-coding:hermes-import" },
  { envVar: "KIMICODE_API_KEY", provider: "kimi-coding", profileId: "kimi-coding:hermes-import" },
  { envVar: "MOONSHOT_API_KEY", provider: "moonshot", profileId: "moonshot:hermes-import" },
  { envVar: "MINIMAX_API_KEY", provider: "minimax", profileId: "minimax:hermes-import" },
  {
    envVar: "MINIMAX_CODING_API_KEY",
    provider: "minimax",
    profileId: "minimax:hermes-import",
  },
  { envVar: "DASHSCOPE_API_KEY", provider: "qwen", profileId: "qwen:hermes-import" },
  { envVar: "QWEN_API_KEY", provider: "qwen", profileId: "qwen:hermes-import" },
  { envVar: "MODELSTUDIO_API_KEY", provider: "qwen", profileId: "qwen:hermes-import" },
  { envVar: "KILOCODE_API_KEY", provider: "kilocode", profileId: "kilocode:hermes-import" },
  {
    envVar: "AI_GATEWAY_API_KEY",
    provider: "vercel-ai-gateway",
    profileId: "vercel-ai-gateway:hermes-import",
  },
  { envVar: "HF_TOKEN", provider: "huggingface", profileId: "huggingface:hermes-import" },
  {
    envVar: "HUGGINGFACE_HUB_TOKEN",
    provider: "huggingface",
    profileId: "huggingface:hermes-import",
  },
  { envVar: "TOGETHER_API_KEY", provider: "together", profileId: "together:hermes-import" },
  { envVar: "FIREWORKS_API_KEY", provider: "fireworks", profileId: "fireworks:hermes-import" },
  { envVar: "DEEPINFRA_API_KEY", provider: "deepinfra", profileId: "deepinfra:hermes-import" },
  { envVar: "CEREBRAS_API_KEY", provider: "cerebras", profileId: "cerebras:hermes-import" },
  { envVar: "NVIDIA_API_KEY", provider: "nvidia", profileId: "nvidia:hermes-import" },
  { envVar: "VENICE_API_KEY", provider: "venice", profileId: "venice:hermes-import" },
  { envVar: "XIAOMI_API_KEY", provider: "xiaomi", profileId: "xiaomi:hermes-import" },
  { envVar: "ALIBABA_API_KEY", provider: "alibaba", profileId: "alibaba:hermes-import" },
  { envVar: "ARCEEAI_API_KEY", provider: "arcee", profileId: "arcee:hermes-import" },
  { envVar: "CHUTES_API_KEY", provider: "chutes", profileId: "chutes:hermes-import" },
  {
    envVar: "CLOUDFLARE_AI_GATEWAY_API_KEY",
    provider: "cloudflare-ai-gateway",
    profileId: "cloudflare-ai-gateway:hermes-import",
  },
  { envVar: "QIANFAN_API_KEY", provider: "qianfan", profileId: "qianfan:hermes-import" },
  { envVar: "OPENCODE_API_KEY", provider: "opencode", profileId: "opencode:hermes-import" },
  { envVar: "OPENCODE_API_KEY", provider: "opencode-go", profileId: "opencode-go:hermes-import" },
  { envVar: "OPENCODE_ZEN_API_KEY", provider: "opencode", profileId: "opencode:hermes-import" },
  {
    envVar: "OPENCODE_ZEN_API_KEY",
    provider: "opencode-go",
    profileId: "opencode-go:hermes-import",
  },
  {
    envVar: "OPENCODE_GO_API_KEY",
    provider: "opencode-go",
    profileId: "opencode-go:hermes-import",
  },
  {
    envVar: "COPILOT_GITHUB_TOKEN",
    provider: "github-copilot",
    profileId: "github-copilot:github",
    mode: "token",
  },
  {
    envVar: "GH_TOKEN",
    provider: "github-copilot",
    profileId: "github-copilot:github",
    mode: "token",
  },
  {
    envVar: "GITHUB_TOKEN",
    provider: "github-copilot",
    profileId: "github-copilot:github",
    mode: "token",
  },
] as const;

type SecretCandidate = {
  id: string;
  source?: string;
  envVar?: string;
  provider: string;
  profileId: string;
  mode: SecretCredentialMode;
  sourceKind?: "hermes-env" | "opencode-auth-json";
  sourceProvider?: string;
  secretField?: string;
};

function authProfileTarget(agentDir: string, profileId: string): string {
  return `${resolveAuthStorePathForDisplay(agentDir)}#${profileId}`;
}

function secretAuthProfileConfig(details: {
  provider: string;
  profileId: string;
  mode?: SecretCredentialMode;
}): HermesAuthProfileConfig {
  return {
    profileId: details.profileId,
    provider: details.provider,
    mode: details.mode ?? "api_key",
    displayName: "Hermes import",
  };
}

function secretMode(mapping: SecretMapping): SecretCredentialMode {
  return mapping.mode ?? "api_key";
}

function buildEnvSecretCandidates(params: {
  env: Record<string, string>;
  envPath?: string;
}): SecretCandidate[] {
  return SECRET_MAPPINGS.flatMap((mapping) => {
    const value = params.env[mapping.envVar]?.trim();
    if (!value) {
      return [];
    }
    return [
      {
        id: `secret:${mapping.provider}`,
        source: params.envPath,
        envVar: mapping.envVar,
        provider: mapping.provider,
        profileId: mapping.profileId,
        mode: secretMode(mapping),
      },
    ];
  });
}

async function readOpenCodeAuthJson(
  authPath: string | undefined,
): Promise<Record<string, unknown>> {
  const raw = await readText(authPath);
  if (!raw) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function buildOpenCodeSecretCandidates(
  authPath: string | undefined,
): Promise<SecretCandidate[]> {
  if (!authPath) {
    return [];
  }
  const auth = await readOpenCodeAuthJson(authPath);
  const opencode = isRecord(auth.opencode) ? auth.opencode : {};
  const opencodeGo = isRecord(auth["opencode-go"]) ? auth["opencode-go"] : {};
  const githubCopilot = isRecord(auth["github-copilot"]) ? auth["github-copilot"] : {};
  const githubCopilotEnterpriseUrl = readString(githubCopilot.enterpriseUrl);
  const candidates: SecretCandidate[] = [];
  if (readString(opencode.key)) {
    candidates.push({
      id: "secret:opencode:opencode-auth-json",
      source: authPath,
      provider: "opencode",
      profileId: "opencode:hermes-import",
      mode: "api_key",
      sourceKind: "opencode-auth-json",
      sourceProvider: "opencode",
      secretField: "key",
    });
  }
  if (readString(opencodeGo.key)) {
    candidates.push({
      id: "secret:opencode-go:opencode-auth-json",
      source: authPath,
      provider: "opencode-go",
      profileId: "opencode-go:hermes-import",
      mode: "api_key",
      sourceKind: "opencode-auth-json",
      sourceProvider: "opencode-go",
      secretField: "key",
    });
  }
  // OpenClaw's Copilot token profile cannot preserve OpenCode enterprise routing yet.
  if (readString(githubCopilot.refresh) && !githubCopilotEnterpriseUrl) {
    candidates.push({
      id: "secret:github-copilot:opencode-auth-json",
      source: authPath,
      provider: "github-copilot",
      profileId: "github-copilot:github",
      mode: "token",
      sourceKind: "opencode-auth-json",
      sourceProvider: "github-copilot",
      secretField: "refresh",
    });
  }
  return candidates;
}

async function readSecretCandidateValue(
  details: {
    envVar?: string;
    sourceKind?: string;
    sourceProvider?: string;
    secretField?: string;
  },
  source: string,
): Promise<string | undefined> {
  if (details.sourceKind === "opencode-auth-json") {
    const auth = await readOpenCodeAuthJson(source);
    const sourceProvider = details.sourceProvider;
    const secretField = details.secretField;
    if (!sourceProvider || !secretField) {
      return undefined;
    }
    const provider = isRecord(auth[sourceProvider]) ? auth[sourceProvider] : {};
    return readString(provider[secretField]);
  }
  if (!details.envVar) {
    return undefined;
  }
  const env = parseEnv(await readText(source));
  return env[details.envVar]?.trim() || undefined;
}

export async function buildSecretItems(params: {
  ctx: MigrationProviderContext;
  source: HermesSource;
  targets: PlannedTargets;
}): Promise<MigrationItem[]> {
  const env = parseEnv(await readText(params.source.envPath));
  const store = loadAuthProfileStoreWithoutExternalProfiles(params.targets.agentDir);
  const seenProfiles = new Set<string>();
  const items: MigrationItem[] = [];
  const candidates = [
    ...buildEnvSecretCandidates({ env, envPath: params.source.envPath }),
    ...(await buildOpenCodeSecretCandidates(params.source.opencodeAuthPath)),
  ];
  for (const candidate of candidates) {
    if (seenProfiles.has(candidate.profileId)) {
      continue;
    }
    seenProfiles.add(candidate.profileId);
    const existsAlready = Boolean(store.profiles[candidate.profileId]);
    const configConflict = hasAuthProfileConfigConflict(
      params.ctx.config,
      secretAuthProfileConfig(candidate),
      Boolean(params.ctx.overwrite),
    );
    items.push(
      createHermesSecretItem({
        id: candidate.id,
        source: candidate.source,
        target: authProfileTarget(params.targets.agentDir, candidate.profileId),
        includeSecrets: params.ctx.includeSecrets,
        existsAlready: (existsAlready && !params.ctx.overwrite) || configConflict,
        details: {
          ...(candidate.envVar ? { envVar: candidate.envVar } : {}),
          provider: candidate.provider,
          profileId: candidate.profileId,
          ...(candidate.mode === "token" ? { mode: candidate.mode } : {}),
          ...(candidate.sourceKind ? { sourceKind: candidate.sourceKind } : {}),
          ...(candidate.sourceProvider ? { sourceProvider: candidate.sourceProvider } : {}),
          ...(candidate.secretField ? { secretField: candidate.secretField } : {}),
        },
      }),
    );
  }
  return items;
}

export async function applySecretItem(
  ctx: MigrationProviderContext,
  item: MigrationItem,
  targets: PlannedTargets,
): Promise<MigrationItem> {
  if (item.status !== "planned") {
    return item;
  }
  const details = readHermesSecretDetails(item);
  const source = item.source;
  if (!details || !source) {
    return hermesItemError(item, HERMES_REASON_MISSING_SECRET_METADATA);
  }
  const key = await readSecretCandidateValue(details, source);
  if (!key) {
    return hermesItemSkipped(item, HERMES_REASON_SECRET_NO_LONGER_PRESENT);
  }
  const configProfile = secretAuthProfileConfig(details);
  if (hasCurrentAuthProfileConfigConflict(ctx, configProfile)) {
    return hermesItemConflict(item, HERMES_REASON_AUTH_PROFILE_EXISTS);
  }
  let conflicted = false;
  let wrote = false;
  const store = await updateAuthProfileStoreWithLock({
    agentDir: targets.agentDir,
    updater: (freshStore) => {
      if (!ctx.overwrite && freshStore.profiles[details.profileId]) {
        conflicted = true;
        return false;
      }
      freshStore.profiles[details.profileId] =
        details.mode === "token"
          ? {
              type: "token",
              provider: details.provider,
              token: key,
              displayName: "Hermes import",
            }
          : {
              type: "api_key",
              provider: details.provider,
              key,
              displayName: "Hermes import",
            };
      wrote = true;
      return true;
    },
  });
  if (conflicted) {
    return hermesItemConflict(item, HERMES_REASON_AUTH_PROFILE_EXISTS);
  }
  if (!store?.profiles[details.profileId]) {
    return hermesItemError(item, HERMES_REASON_AUTH_PROFILE_WRITE_FAILED);
  }
  if (!wrote && !ctx.overwrite) {
    return hermesItemConflict(item, HERMES_REASON_AUTH_PROFILE_EXISTS);
  }
  const configResult = await applyAuthProfileConfigWithConflictCheck({
    ctx,
    profile: configProfile,
  });
  if (configResult === "conflict") {
    return hermesItemConflict(item, HERMES_REASON_AUTH_PROFILE_EXISTS);
  }
  return {
    ...item,
    status: "migrated",
    details: {
      ...item.details,
      configUpdated: configResult === "configured",
    },
  };
}
