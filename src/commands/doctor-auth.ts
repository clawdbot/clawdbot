import { note } from "@clack/prompts";

import {
  ensureAuthProfileStore,
  repairOAuthProfileIdMismatch,
} from "../agents/auth-profiles.js";
import type { ClawdbotConfig } from "../config/config.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

export async function maybeRepairAnthropicOAuthProfileId(
  cfg: ClawdbotConfig,
  prompter: DoctorPrompter,
): Promise<ClawdbotConfig> {
  const store = ensureAuthProfileStore();
  const repair = repairOAuthProfileIdMismatch({
    cfg,
    store,
    provider: "anthropic",
    legacyProfileId: "anthropic:default",
  });
  if (!repair.migrated || repair.changes.length === 0) return cfg;

  note(repair.changes.map((c) => `- ${c}`).join("\n"), "Auth profiles");
  const apply = await prompter.confirm({
    message: "Update Anthropic OAuth profile id in config now?",
    initialValue: true,
  });
  if (!apply) return cfg;
  return repair.config;
}
