import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
/** Removes retired provider profiles and repairs legacy OAuth profile ids. */
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { repairOAuthProfileIdMismatch } from "../agents/auth-profiles/repair.js";
import { ensureAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles/store.js";
import { applyProviderConfigDefaultsForConfig } from "../config/provider-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  configReferencesAuthProfile,
  removeAuthProfileConfig,
} from "../plugins/provider-auth-helpers.js";
import { listAuthProfileRepairCandidates } from "./doctor-auth-legacy-paths.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

function sanitizePromptLabel(label: string | undefined): string | undefined {
  const sanitized = label ? sanitizeForLog(label).trim() : undefined;
  return sanitized || undefined;
}

/**
 * Applies provider-declared OAuth profile id repairs to config after prompting.
 *
 * Providers own the legacy id mapping; doctor only loads setup-time provider metadata and asks
 * before writing config so stale provider-specific ids do not silently shadow current profiles.
 */
export async function maybeRepairLegacyOAuthProfileIds(
  cfg: OpenClawConfig,
  prompter: DoctorPrompter,
): Promise<LegacyOAuthProfileRepairResult> {
  let nextCfg = cfg;
  const retiredProfileCleanupPlans: RetiredAuthProfileCleanupPlan[] = [];
  const repairCandidates = listAuthProfileRepairCandidates(cfg, process.env).map(
    ({ agentDir }) => ({
      agentDir,
      profiles: loadPersistedAuthProfileStore(agentDir)?.profiles ?? {},
    }),
  );
  // runAuthProfileHealth migrates stores before this step. Without profiles or
  // config references, loading provider runtimes cannot produce a repair.
  if (
    Object.keys(cfg.auth?.profiles ?? {}).length === 0 &&
    !Object.values(cfg.auth?.order ?? {}).some((order) => order.length > 0) &&
    !Object.values(cfg.models?.providers ?? {}).some(
      (provider) => typeof provider.apiKey === "string",
    ) &&
    repairCandidates.every(({ profiles }) => Object.keys(profiles).length === 0)
  ) {
    return { config: nextCfg, retiredProfileCleanupPlans };
  }
  const { resolvePluginProvidersCore } = await import("../plugins/providers.runtime.js");
  const providers = resolvePluginProvidersCore({
    config: cfg,
    env: process.env,
    mode: "setup",
  });
  for (const provider of providers) {
    for (const profileId of provider.deprecatedProfileIds ?? []) {
      const profileStores = repairCandidates.flatMap(({ agentDir, profiles }) => {
        const profile = profiles[profileId];
        return profile ? [{ agentDir, provider: profile.provider }] : [];
      });
      if (profileStores.length === 0 && !configReferencesAuthProfile(nextCfg, profileId)) {
        continue;
      }
      const { note } = await import("../../packages/terminal-core/src/note.js");
      note(
        `- Remove retired auth profile ${profileId}. The provider's native login remains unchanged.`,
        "Auth profiles",
      );
      const label = sanitizePromptLabel(provider.label) ?? provider.id;
      const apply = await prompter.confirm({
        message: `Remove retired ${label} auth profile now?`,
        initialValue: true,
      });
      if (!apply) {
        continue;
      }
      const configuredProfileProvider = nextCfg.auth?.profiles?.[profileId]?.provider;
      const selectedProviderIds = new Set([
        provider.id,
        ...profileStores.map((store) => store.provider),
      ]);
      if (configuredProfileProvider) {
        selectedProviderIds.add(configuredProfileProvider);
      }
      if (
        collectConfiguredModelRefs(nextCfg).some(({ value }) => {
          const separator = value.indexOf("/");
          return separator > 0 && selectedProviderIds.has(value.slice(0, separator));
        })
      ) {
        // Preserve a selected provider's runtime routing before removing the
        // retired profile that still identifies its native CLI migration.
        nextCfg = applyProviderConfigDefaultsForConfig({
          provider: provider.id,
          config: nextCfg,
          env: process.env,
        });
      }
      nextCfg = removeAuthProfileConfig(nextCfg, profileId);
      for (const candidate of profileStores) {
        retiredProfileCleanupPlans.push({
          agentDir: candidate.agentDir,
          profileIds: [profileId],
        });
      }
    }
  }
  if (!Object.values(nextCfg.auth?.profiles ?? {}).some((profile) => profile?.mode === "oauth")) {
    return { config: nextCfg, retiredProfileCleanupPlans };
  }
  const store = ensureAuthProfileStoreWithoutExternalProfiles();
  if (Object.keys(store.profiles).length === 0) {
    return { config: nextCfg, retiredProfileCleanupPlans };
  }
  for (const provider of providers) {
    for (const repairSpec of provider.oauthProfileIdRepairs ?? []) {
      const repair = repairOAuthProfileIdMismatch({
        cfg: nextCfg,
        store,
        provider: provider.id,
        legacyProfileId: repairSpec.legacyProfileId,
      });
      if (!repair.migrated || repair.changes.length === 0) {
        continue;
      }

      const { note } = await import("../../packages/terminal-core/src/note.js");
      note(repair.changes.map((c) => `- ${c}`).join("\n"), "Auth profiles");
      const label =
        sanitizePromptLabel(repairSpec.promptLabel) ??
        sanitizePromptLabel(provider.label) ??
        provider.id;
      const apply = await prompter.confirm({
        message: `Update ${label} OAuth profile id in config now?`,
        initialValue: true,
      });
      if (!apply) {
        continue;
      }
      nextCfg = repair.config;
    }
  }
  return { config: nextCfg, retiredProfileCleanupPlans };
}

export type RetiredAuthProfileCleanupPlan = {
  agentDir?: string;
  profileIds: readonly string[];
};

export type LegacyOAuthProfileRepairResult = {
  config: OpenClawConfig;
  retiredProfileCleanupPlans: readonly RetiredAuthProfileCleanupPlan[];
};
