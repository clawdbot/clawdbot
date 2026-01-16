import type { ClawdbotConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { buildWorkspaceHookStatus } from "../hooks/hooks-status.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";

export async function setupInternalHooks(
  cfg: ClawdbotConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<ClawdbotConfig> {
  await prompter.note(
    [
      "Internal hooks let you automate actions when agent commands are issued.",
      "Example: Save session context to memory when you issue /new.",
      "",
      "Learn more: https://docs.clawd.bot/internal-hooks",
    ].join("\n"),
    "Internal Hooks",
  );

  // Discover available hooks using the hook discovery system
  const workspaceDir = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  const report = buildWorkspaceHookStatus(workspaceDir, { config: cfg });

  // Filter for eligible and recommended hooks (session-memory is recommended)
  const recommendedHooks = report.hooks.filter(
    (h) => h.eligible && h.name === "session-memory",
  );

  if (recommendedHooks.length === 0) {
    await prompter.note(
      "No eligible hooks found. You can configure hooks later in your config.",
      "No Hooks Available",
    );
    return cfg;
  }

  const toEnable = await prompter.multiselect({
    message: "Enable internal hooks?",
    options: [
      { value: "__skip__", label: "Skip for now" },
      ...recommendedHooks.map((hook) => ({
        value: hook.name,
        label: `${hook.emoji ?? "🔗"} ${hook.name}`,
        hint: hook.description,
      })),
    ],
  });

  const selected = toEnable.filter((name) => name !== "__skip__");
  if (selected.length === 0) {
    return cfg;
  }

  // Enable selected hooks using the new entries config format
  const entries = { ...(cfg.hooks?.internal?.entries ?? {}) };
  for (const name of selected) {
    entries[name] = { enabled: true };
  }

  const next: ClawdbotConfig = {
    ...cfg,
    hooks: {
      ...cfg.hooks,
      internal: {
        enabled: true,
        entries,
      },
    },
  };

  await prompter.note(
    [
      `Enabled ${selected.length} hook${selected.length > 1 ? "s" : ""}: ${selected.join(", ")}`,
      "",
      "You can manage hooks later with:",
      "  clawdbot hooks internal list",
      "  clawdbot hooks internal enable <name>",
      "  clawdbot hooks internal disable <name>",
    ].join("\n"),
    "Hooks Configured",
  );

  return next;
}
