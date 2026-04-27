import { loadAuthProfileStoreWithoutExternalProfiles } from "openclaw/plugin-sdk/agent-runtime";
import type { MigrationItem, MigrationProviderContext } from "openclaw/plugin-sdk/plugin-entry";
import { updateAuthProfileStoreWithLock } from "openclaw/plugin-sdk/provider-auth";
import { parseEnv, readText } from "./helpers.js";
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

type SecretMapping = {
  envVar: string;
  provider: string;
  profileId: string;
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
] as const;

export async function buildSecretItems(params: {
  ctx: MigrationProviderContext;
  source: HermesSource;
  targets: PlannedTargets;
}): Promise<MigrationItem[]> {
  const env = parseEnv(await readText(params.source.envPath));
  const store = loadAuthProfileStoreWithoutExternalProfiles(params.targets.agentDir);
  const seenProfiles = new Set<string>();
  const items: MigrationItem[] = [];
  for (const mapping of SECRET_MAPPINGS) {
    const value = env[mapping.envVar]?.trim();
    if (!value || seenProfiles.has(mapping.profileId)) {
      continue;
    }
    seenProfiles.add(mapping.profileId);
    const existsAlready = Boolean(store.profiles[mapping.profileId]);
    items.push(
      createHermesSecretItem({
        id: `secret:${mapping.provider}`,
        source: params.source.envPath,
        target: `${params.targets.agentDir}/auth-profiles.json#${mapping.profileId}`,
        includeSecrets: params.ctx.includeSecrets,
        existsAlready: existsAlready && !params.ctx.overwrite,
        details: {
          envVar: mapping.envVar,
          provider: mapping.provider,
          profileId: mapping.profileId,
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
  const env = parseEnv(await readText(source));
  const key = env[details.envVar]?.trim();
  if (!key) {
    return hermesItemSkipped(item, HERMES_REASON_SECRET_NO_LONGER_PRESENT);
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
      freshStore.profiles[details.profileId] = {
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
  return { ...item, status: "migrated" };
}
