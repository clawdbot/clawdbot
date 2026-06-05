/** Migrates legacy provider-declared OAuth profile ids to current auth profile ids. */
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { repairOAuthProfileIdMismatch } from "../agents/auth-profiles/repair.js";
import { ensureAuthProfileStore } from "../agents/auth-profiles/store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

async function loadProviderRuntime() {
  return import("../plugins/providers.runtime.js");
}

async function loadNoteRuntime() {
  return import("../../packages/terminal-core/src/note.js");
}

function hasConfigOAuthProfiles(cfg: OpenClawConfig): boolean {
  return Object.values(cfg.auth?.profiles ?? {}).some((profile) => profile?.mode === "oauth");
}

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
): Promise<OpenClawConfig> {
  if (!hasConfigOAuthProfiles(cfg)) {
    return cfg;
  }
  const store = ensureAuthProfileStore();
  if (Object.keys(store.profiles).length === 0) {
    return cfg;
  }
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
  return nextCfg;
}
