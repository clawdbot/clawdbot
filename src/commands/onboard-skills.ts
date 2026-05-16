import { installSkill } from "../agents/skills-install.js";
import { buildWorkspaceSkillStatus } from "../agents/skills-status.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { normalizeSecretInput } from "../utils/normalize-secret-input.js";
import { t } from "../wizard/i18n/index.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { detectBinary, resolveNodeManagerOptions } from "./onboard-helpers.js";

function summarizeInstallFailure(message: string): string | undefined {
  const cleaned = message.replace(/^Install failed(?:\s*\([^)]*\))?\s*:?\s*/i, "").trim();
  if (!cleaned) {
    return undefined;
  }
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
  if (!combined) {
    return "install";
  }
  const maxLen = 90;
  return combined.length > maxLen ? `${combined.slice(0, maxLen - 1)}…` : combined;
}

function upsertSkillEntry(
  cfg: OpenClawConfig,
  skillKey: string,
  patch: { apiKey?: string },
): OpenClawConfig {
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
  cfg: OpenClawConfig,
  workspaceDir: string,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<OpenClawConfig> {
  const report = buildWorkspaceSkillStatus(workspaceDir, { config: cfg });
  const eligible = report.skills.filter((s) => s.eligible);
  const unsupportedOs = report.skills.filter(
    (s) => !s.disabled && !s.blockedByAllowlist && s.missing.os.length > 0,
  );
  const missing = report.skills.filter(
    (s) => !s.eligible && !s.disabled && !s.blockedByAllowlist && s.missing.os.length === 0,
  );
  const blocked = report.skills.filter((s) => s.blockedByAllowlist);

  await prompter.note(
    [
      `Eligible: ${eligible.length}`,
      `Missing requirements: ${missing.length}`,
      `Unsupported on this OS: ${unsupportedOs.length}`,
      `Blocked by allowlist: ${blocked.length}`,
    ].join("\n"),
    t("wizard.skills.statusTitle"),
  );

  const shouldConfigure = await prompter.confirm({
    message: t("wizard.skills.configure"),
    initialValue: true,
  });
  if (!shouldConfigure) {
    return cfg;
  }

  const installable = missing.filter(
    (skill) => skill.install.length > 0 && skill.missing.bins.length > 0,
  );
  let next: OpenClawConfig = cfg;
  if (installable.length > 0) {
    const toInstall = await prompter.multiselect({
      message: t("wizard.skills.installDeps"),
      options: [
        {
          value: "__skip__",
          label: t("common.skipForNow"),
          hint: t("wizard.skills.skipDepsHint"),
        },
        ...installable.map((skill) => ({
          value: skill.name,
          label: `${skill.emoji ?? "🧩"} ${skill.name}`,
          hint: formatSkillHint(skill),
        })),
      ],
    });

    const selected = toInstall.filter((name) => name !== "__skip__");

    const selectedSkills = selected
      .map((name) => installable.find((s) => s.name === name))
      .filter((item): item is (typeof installable)[number] => Boolean(item));

    const needsBrewPrompt =
      process.platform !== "win32" &&
      selectedSkills.some((skill) => skill.install.some((option) => option.kind === "brew")) &&
      !(await detectBinary("brew"));

    if (needsBrewPrompt) {
      await prompter.note(
        [
          "Many skill dependencies are shipped via Homebrew.",
          "Without brew, you'll need to build from source or download releases manually.",
        ].join("\n"),
        t("wizard.skills.homebrewRecommendedTitle"),
      );
      const showBrewInstall = await prompter.confirm({
        message: t("wizard.skills.homebrewCommand"),
        initialValue: true,
      });
      if (showBrewInstall) {
        await prompter.note(
          [
            "Run:",
            '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
          ].join("\n"),
          t("wizard.skills.homebrewInstallTitle"),
        );
      }
    }

    const needsNodeManagerPrompt = selectedSkills.some((skill) =>
      skill.install.some((option) => option.kind === "node"),
    );
    if (needsNodeManagerPrompt) {
      const nodeManager = (await prompter.select({
        message: t("wizard.skills.nodeManager"),
        options: resolveNodeManagerOptions(),
      })) as "npm" | "pnpm" | "bun";
      next = {
        ...next,
        skills: {
          ...next.skills,
          install: {
            ...next.skills?.install,
            nodeManager,
          },
        },
      };
    }

    for (const name of selected) {
      const target = installable.find((s) => s.name === name);
      if (!target || target.install.length === 0) {
        continue;
      }
      const installId = target.install[0]?.id;
      if (!installId) {
        continue;
      }
      const spin = prompter.progress(t("wizard.skills.installing", { name }));
      const result = await installSkill({
        workspaceDir,
        skillName: target.name,
        installId,
        config: next,
      });
      const warnings = result.warnings ?? [];
      if (result.ok) {
        spin.stop(
          warnings.length > 0
            ? t("wizard.skills.installedWithWarnings", { name })
            : t("wizard.skills.installed", { name }),
        );
        for (const warning of warnings) {
          runtime.log(warning);
        }
        continue;
      }
      const code = result.code == null ? "" : ` (exit ${result.code})`;
      const detail = summarizeInstallFailure(result.message);
      spin.stop(
        t("wizard.skills.installFailed", { name, code, detail: detail ? ` - ${detail}` : "" }),
      );
      for (const warning of warnings) {
        runtime.log(warning);
      }
      if (result.stderr) {
        runtime.log(result.stderr.trim());
      } else if (result.stdout) {
        runtime.log(result.stdout.trim());
      }
      runtime.log(
        `Tip: run \`${formatCliCommand("openclaw doctor")}\` to review skills + requirements.`,
      );
      runtime.log(t("wizard.skills.docsLine"));
    }
  }

  for (const skill of missing) {
    if (!skill.primaryEnv || skill.missing.env.length === 0) {
      continue;
    }
    const wantsKey = await prompter.confirm({
      message: t("wizard.skills.setEnv", { env: skill.primaryEnv, name: skill.name }),
      initialValue: false,
    });
    if (!wantsKey) {
      continue;
    }
    const apiKey = await prompter.text({
      message: t("wizard.skills.enterEnv", { env: skill.primaryEnv }),
      validate: (value) => (value?.trim() ? undefined : t("common.required")),
      sensitive: true,
    });
    next = upsertSkillEntry(next, skill.skillKey, { apiKey: normalizeSecretInput(apiKey) });
  }

  return next;
}
