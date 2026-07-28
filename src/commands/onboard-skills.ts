/**
 * Interactive skill dependency setup for onboarding.
 *
 * It reports workspace skill readiness, offers safe dependency installs, and
 * leaves per-skill credentials to the agent when a skill actually needs them.
 */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveBrewExecutable } from "../infra/brew.js";
import { isContainerEnvironment } from "../infra/container-environment.js";
import type { RuntimeEnv } from "../runtime.js";
import { buildWorkspaceSkillStatus } from "../skills/discovery/status.js";
import {
  installSkill,
  MIN_AUTO_GO_VERSION,
  resolveInstallerKindReadiness,
  type SkillInstallReadiness,
  type SkillInstallSkipReason,
} from "../skills/lifecycle/install.js";
import { t } from "../wizard/i18n/index.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { detectBinary } from "./onboard-helpers.js";
import { isNodeManagerChoice, type NodeManagerChoice } from "./onboard-types.js";

const HOMEBREW_PROMPT_PLATFORMS = new Set(["darwin", "linux"]);
const SKIPPED_INSTALL_NAME_LIMIT = 8;

type OnboardInstallSkill = {
  name: string;
  description?: string;
  install: Array<{ kind: string; label: string }>;
};

type SkippedInstall = {
  skill: OnboardInstallSkill;
  reason: SkillInstallSkipReason;
  detail?: string;
};

function supportsHomebrewPrompt(platform: NodeJS.Platform): boolean {
  return HOMEBREW_PROMPT_PLATFORMS.has(platform);
}

function summarizeInstallFailure(message: string): string | undefined {
  const cleaned = message.replace(/^Install failed(?:\s*\([^)]*\))?\s*:?\s*/i, "").trim();
  if (!cleaned) {
    return undefined;
  }
  const maxLen = 140;
  return cleaned.length > maxLen ? `${truncateUtf16Safe(cleaned, maxLen - 1)}…` : cleaned;
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
  return combined.length > maxLen ? `${truncateUtf16Safe(combined, maxLen - 1)}…` : combined;
}

const testing = { formatSkillHint, summarizeInstallFailure };

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.onboardSkillsTestApi")] =
    testing;
}

const SKIP_REASON_LABELS = {
  brew: "Homebrew",
  go: `Go toolchain (${MIN_AUTO_GO_VERSION}+)`,
  uv: "uv",
} satisfies Record<SkillInstallSkipReason, string>;

function formatSkillNames(names: string[]): string {
  const visible = names.slice(0, SKIPPED_INSTALL_NAME_LIMIT);
  const suffix = names.length > visible.length ? ` (+${names.length - visible.length} more)` : "";
  return `${visible.join(", ")}${suffix}`;
}

function formatSkippedInstallNote(skipped: SkippedInstall[]): string {
  const byReason = new Map<SkillInstallSkipReason, string[]>();
  for (const item of skipped) {
    const names = byReason.get(item.reason) ?? [];
    names.push(item.skill.name);
    byReason.set(item.reason, names);
  }
  const lines = [t("wizard.skills.manualPrereqsIntro")];
  for (const reason of ["brew", "go", "uv"] as const) {
    const names = byReason.get(reason);
    if (!names || names.length === 0) {
      continue;
    }
    lines.push(`${SKIP_REASON_LABELS[reason]}: ${formatSkillNames(names)}`);
  }
  for (const item of skipped.filter((entry) => entry.detail).slice(0, SKIPPED_INSTALL_NAME_LIMIT)) {
    lines.push(`${item.skill.name}: ${item.detail}`);
  }
  lines.push(t("wizard.skills.manualPrereqsDoctorHint"));
  return lines.join("\n");
}

function isBrewOnlyInstallableSkill(skill: {
  install: Array<{ kind: string }>;
  missing: { bins: string[] };
}): boolean {
  return (
    skill.install.length > 0 &&
    skill.missing.bins.length > 0 &&
    skill.install.every((option) => option.kind === "brew")
  );
}

function isTrustedAutoInstallableSkill(skill: { bundled: boolean; source: string }): boolean {
  // Onboarding can auto-run bundled recipes without another prompt. Workspace
  // skill metadata is mutable project input, so those installs stay explicit.
  return skill.bundled && skill.source === "openclaw-bundled";
}

function resolveDefaultNodeManager(
  config: OpenClawConfig,
  requested: NodeManagerChoice | undefined,
  runtime: RuntimeEnv,
): NodeManagerChoice {
  if (requested !== undefined) {
    if (!isNodeManagerChoice(requested)) {
      runtime.error('Invalid --node-manager. Use "npm", "pnpm", or "bun".');
      runtime.exit(1);
      return "npm";
    }
    return requested;
  }
  const existing = config.skills?.install?.nodeManager;
  return existing === "npm" || existing === "pnpm" || existing === "bun" ? existing : "npm";
}

/** Runs the interactive skills setup step and returns the updated config. */
export async function setupSkills(
  cfg: OpenClawConfig,
  workspaceDir: string,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
  options: { nodeManager?: NodeManagerChoice } = {},
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

  const baseInstallable = missing.filter(
    (skill) =>
      skill.install.length > 0 &&
      skill.missing.bins.length > 0 &&
      isTrustedAutoInstallableSkill(skill),
  );
  let brewAvailable: boolean | undefined;
  const detectBrewOnce = async () => {
    // Brew detection can shell out; cache it for the whole skills step because
    // install filtering and prompts both need the same answer.
    brewAvailable ??= (await detectBinary("brew")) || resolveBrewExecutable() !== undefined;
    return brewAvailable;
  };
  const readinessByKind = new Map<string, SkillInstallReadiness>();
  const resolveKindReadinessOnce = async (kind: string) => {
    // The lifecycle preflight can shell out (go version, sudo probe); resolve
    // each recipe kind once per onboarding run.
    const cached = readinessByKind.get(kind);
    if (cached) {
      return cached;
    }
    const readiness = await resolveInstallerKindReadiness(kind);
    readinessByKind.set(kind, readiness);
    return readiness;
  };
  const inLinuxContainer = process.platform === "linux" && isContainerEnvironment();
  let installable = baseInstallable;
  if (inLinuxContainer && baseInstallable.length > 0 && !(await detectBrewOnce())) {
    // Linux containers without brew cannot use brew-only recipes reliably; hide
    // them from install selection and leave manual instructions in the note.
    const hiddenBrewOnly = baseInstallable.filter(isBrewOnlyInstallableSkill);
    installable = baseInstallable.filter((skill) => !isBrewOnlyInstallableSkill(skill));
    if (hiddenBrewOnly.length > 0) {
      await prompter.note(
        [t("wizard.skills.containerBrewHidden"), t("wizard.skills.containerBrewManual")].join("\n"),
        t("wizard.skills.containerInstallsTitle"),
      );
    }
  }
  const candidateInstallable = installable;
  const needsBrewPrompt =
    supportsHomebrewPrompt(process.platform) &&
    candidateInstallable.some((skill) => skill.install.some((option) => option.kind === "brew")) &&
    !(await detectBrewOnce());
  const readyInstallable: typeof installable = [];
  const skippedInstallable: SkippedInstall[] = [];
  for (const skill of candidateInstallable) {
    // Onboarding intentionally executes only the primary recipe below. Keep
    // readiness aligned with that recipe instead of silently changing methods.
    const primaryInstall = skill.install[0];
    if (!primaryInstall) {
      continue;
    }
    const readiness = await resolveKindReadinessOnce(primaryInstall.kind);
    if (readiness.ready) {
      readyInstallable.push(skill);
    } else {
      skippedInstallable.push({ skill, reason: readiness.reason });
    }
  }
  installable = readyInstallable;
  if (needsBrewPrompt) {
    await prompter.note(
      [
        "Many skill dependencies are shipped via Homebrew.",
        "Without brew, you'll need to build from source or download releases manually.",
        "",
        "Install Homebrew:",
        '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"',
      ].join("\n"),
      t("wizard.skills.homebrewRecommendedTitle"),
    );
  }
  if (skippedInstallable.length > 0) {
    await prompter.note(
      formatSkippedInstallNote(skippedInstallable),
      t("wizard.skills.manualPrereqsTitle"),
    );
  }
  let next: OpenClawConfig = cfg;
  if (installable.length === 0 && missing.length === 0) {
    await prompter.note(
      [
        "No missing skill dependencies to install.",
        `To inspect available skills, run: ${formatCliCommand("openclaw skills list --verbose")}`,
        `To check skill status, run: ${formatCliCommand("openclaw skills check")}`,
      ].join("\n"),
      t("wizard.skills.allReadyTitle") ?? "All skills ready",
    );
    return next;
  }
  if (installable.length > 0) {
    await prompter.note(
      installable.map((skill) => `${skill.name}: ${formatSkillHint(skill)}`).join("\n"),
      t("wizard.skills.installDeps"),
    );
    const selectedSkills = installable;

    const needsNodeManagerPrompt = selectedSkills.some((skill) =>
      skill.install.some((option) => option.kind === "node"),
    );
    if (needsNodeManagerPrompt) {
      // Persist the package manager before invoking installers so node recipes
      // and later skill lifecycle commands agree on the selected tool.
      const nodeManager = resolveDefaultNodeManager(next, options.nodeManager, runtime);
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

    const deferredSkippedInstallable: SkippedInstall[] = [];
    for (const target of selectedSkills) {
      if (target.install.length === 0) {
        continue;
      }
      const installId = target.install[0]?.id;
      if (!installId) {
        continue;
      }
      // Onboarding installs the primary recipe only; alternative recipes remain
      // visible through `openclaw skills list --verbose`.
      const spin = prompter.progress(t("wizard.skills.installing", { name: target.name }));
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
            ? t("wizard.skills.installedWithWarnings", { name: target.name })
            : t("wizard.skills.installed", { name: target.name }),
        );
        for (const warning of warnings) {
          runtime.log(warning);
        }
        continue;
      }
      if (result.skipReason) {
        spin.stop(t("wizard.skills.installSkipped", { name: target.name }));
        const detail = summarizeInstallFailure(result.message);
        deferredSkippedInstallable.push({
          skill: target,
          reason: result.skipReason,
          ...(detail ? { detail } : {}),
        });
        for (const warning of warnings) {
          runtime.log(warning);
        }
        continue;
      }
      const code = result.code == null ? "" : ` (exit ${result.code})`;
      const detail = summarizeInstallFailure(result.message);
      spin.stop(
        t("wizard.skills.installFailed", {
          name: target.name,
          code,
          detail: detail ? ` - ${detail}` : "",
        }),
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
    if (deferredSkippedInstallable.length > 0) {
      await prompter.note(
        formatSkippedInstallNote(deferredSkippedInstallable),
        t("wizard.skills.manualPrereqsTitle"),
      );
    }
  }

  return next;
}
