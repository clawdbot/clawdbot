import { installSkill } from "../agents/skills-install.js";
import { buildWorkspaceSkillStatus } from "../agents/skills-status.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { MoltbotConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { detectBinary, resolveNodeManagerOptions } from "./onboard-helpers.js";

function summarizeInstallFailure(message: string): string | undefined {
  const cleaned = message.replace(/^Install failed(?:\s*\([^)]*\))?\s*:?\s*/i, "").trim();
  if (!cleaned) return undefined;
  const maxLen = 140;
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}

function formatSkillHint(skill: {
  description?: string;
  install: Array<{ label: string }>;
}): string {
  const desc = skill.description?.trim();
  const installLabel = skill.install[0]?.label?.trim();
  const combined = desc && installLabel ? `${desc} — ${installLabel}` : desc || installLabel;
  if (!combined) return "install";
  const maxLen = 90;
  return combined.length > maxLen ? `${combined.slice(0, maxLen - 1)}…` : combined;
}

function upsertSkillEntry(
  cfg: MoltbotConfig,
  skillKey: string,
  patch: { apiKey?: string },
): MoltbotConfig {
  const entries = { ...cfg.skills?.entries };
  const existing = (entries[skillKey] as { apiKey?: string } | undefined) ?? {};
  entries[skillKey] = { ...existing, ...patch };
  return {
    ...cfg,
    skills: {
      ...cfg.skills,
      entries,
    },
  };
}

export async function setupSkills(
  cfg: MoltbotConfig,
  workspaceDir: string,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<MoltbotConfig> {
  const report = buildWorkspaceSkillStatus(workspaceDir, { config: cfg });
  const eligible = report.skills.filter((s) => s.eligible);
  const missing = report.skills.filter((s) => !s.eligible && !s.disabled && !s.blockedByAllowlist);
  const blocked = report.skills.filter((s) => s.blockedByAllowlist);

  const needsBrewPrompt =
    process.platform !== "win32" &&
    report.skills.some((skill) => skill.install.some((option) => option.kind === "brew")) &&
    !(await detectBinary("brew"));

  await prompter.note(
    [
      `Eligible: ${eligible.length}`,
      `Missing requirements: ${missing.length}`,
      `Blocked by allowlist: ${blocked.length}`,
    ].join("\n"),
    "Skills status",
  );

  const shouldConfigure = await prompter.confirm({
    message: "Configure skills now? (recommended)",
    initialValue: true,
  });
  if (!shouldConfigure) return cfg;

  if (needsBrewPrompt) {
    await prompter.note(
      [
        "Many skill dependencies are shipped via Homebrew.",
        "Without brew, you'll need to build from source or download releases manually.",
      ].join("\n"),
      "Homebrew recommended",
    );
    const showBrewInstall = await prompter.confirm({
      message: "Show Homebrew install command?",
      initialValue: true,
    });
    if (showBrewInstall) {
      await prompter.note(
        [
          "Run:",
          '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
        ].join("\n"),
        "Homebrew install",
      );
    }
  }

  const nodeManager = (await prompter.select({
    message: "Preferred node manager for skill installs",
    options: resolveNodeManagerOptions(),
  })) as "npm" | "pnpm" | "bun";

  let next: MoltbotConfig = {
    ...cfg,
    skills: {
      ...cfg.skills,
      install: {
        ...cfg.skills?.install,
        nodeManager,
      },
    },
  };

  const installable = missing.filter(
    (skill) => skill.install.length > 0 && skill.missing.bins.length > 0,
  );
  if (installable.length > 0) {
    const toInstall = await prompter.multiselect({
      message: "Install missing skill dependencies",
      options: [
        {
          value: "__skip__",
          label: "Skip for now",
          hint: "Continue without installing dependencies",
        },
        ...installable.map((skill) => ({
          value: skill.name,
          label: `${skill.emoji ?? "🧩"} ${skill.name}`,
          hint: formatSkillHint(skill),
        })),
      ],
    });

    const selected = (toInstall as string[]).filter((name) => name !== "__skip__");
    for (const name of selected) {
      const target = installable.find((s) => s.name === name);
      if (!target || target.install.length === 0) continue;
      const installId = target.install[0]?.id;
      if (!installId) continue;
      const spin = prompter.progress(`Installing ${name}…`);
      const result = await installSkill({
        workspaceDir,
        skillName: target.name,
        installId,
        config: next,
      });
      if (result.ok) {
        spin.stop(`Installed ${name}`);
      } else {
        const code = result.code == null ? "" : ` (exit ${result.code})`;
        const detail = summarizeInstallFailure(result.message);
        spin.stop(`Install failed: ${name}${code}${detail ? ` — ${detail}` : ""}`);
        if (result.stderr) runtime.log(result.stderr.trim());
        else if (result.stdout) runtime.log(result.stdout.trim());
        runtime.log(
          `Tip: run \`${formatCliCommand("moltbot doctor")}\` to review skills + requirements.`,
        );
        runtime.log("Docs: https://docs.molt.bot/skills");
      }
    }
  }

  for (const skill of missing) {
    if (!skill.primaryEnv || skill.missing.env.length === 0) continue;
    const wantsKey = await prompter.confirm({
      message: `Set ${skill.primaryEnv} for ${skill.name}?`,
      initialValue: false,
    });
    if (!wantsKey) continue;
    const apiKey = String(
      await prompter.text({
        message: `Enter ${skill.primaryEnv}`,
        validate: (value) => (value?.trim() ? undefined : "Required"),
      }),
    );
    next = upsertSkillEntry(next, skill.skillKey, { apiKey: apiKey.trim() });
  }

  return next;
}
