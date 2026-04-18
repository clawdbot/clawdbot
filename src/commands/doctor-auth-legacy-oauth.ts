import { repairOAuthProfileIdMismatch } from "../agents/auth-profiles/repair.js";
import { ensureAuthProfileStore } from "../agents/auth-profiles/store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

async function loadProviderRuntime() {
  return import("../plugins/providers.runtime.js");
}

async function loadNoteRuntime() {
  return import("../terminal/note.js");
}

export async function maybeRepairLegacyOAuthProfileIds(
  cfg: OpenClawConfig,
  prompter: DoctorPrompter,
): Promise<OpenClawConfig> {
  const store = ensureAuthProfileStore();
  let nextCfg = cfg;
  const { resolvePluginProviders } = await loadProviderRuntime();
  const providers = resolvePluginProviders({
    config: cfg,
    env: process.env,
    mode: "setup",
  });
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

      const { note } = await loadNoteRuntime();
      note(repair.changes.map((c) => `- ${c}`).join("\n"), "Auth profiles");
      const apply = await prompter.confirm({
        message: `Update ${repairSpec.promptLabel ?? provider.label} OAuth profile id in config now?`,
        initialValue: true,
      });
      if (!apply) {
        continue;
      }
      nextCfg = repair.config;
    }
  }
  return nextCfg;
}
