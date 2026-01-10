import chalk from "chalk";
import type { Command } from "commander";
import {
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  buildWorkspaceSkillStatus,
  type SkillStatusEntry,
  type SkillStatusReport,
} from "../agents/skills-status.js";
import { loadConfig } from "../config/config.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";

export type SkillsListOptions = {
  json?: boolean;
  eligible?: boolean;
  verbose?: boolean;
};

export type SkillInfoOptions = {
  json?: boolean;
};

export type SkillsCheckOptions = {
  json?: boolean;
};

function appendClawdHubHint(output: string, json?: boolean): string {
  if (json) return output;
  return `${output}\n\nTip: use \`npx clawdhub\` to search, install, and sync skills.`;
}

/**
 * Format a single skill for display in the list
 */
function formatSkillLine(skill: SkillStatusEntry, verbose = false): string {
  const emoji = skill.emoji ?? "📦";
  const status = skill.eligible
    ? chalk.green("✓")
    : skill.disabled
      ? chalk.yellow("disabled")
      : skill.blockedByAllowlist
        ? chalk.yellow("blocked")
        : chalk.red("missing reqs");

  const name = skill.eligible
    ? chalk.white(skill.name)
    : chalk.gray(skill.name);

  const desc = chalk.gray(
    skill.description.length > 50
      ? `${skill.description.slice(0, 47)}...`
      : skill.description,
  );

  if (verbose) {
    const missing: string[] = [];
    if (skill.missing.bins.length > 0) {
      missing.push(`bins: ${skill.missing.bins.join(", ")}`);
    }
    if (skill.missing.anyBins.length > 0) {
      missing.push(`anyBins: ${skill.missing.anyBins.join(", ")}`);
    }
    if (skill.missing.env.length > 0) {
      missing.push(`env: ${skill.missing.env.join(", ")}`);
    }
    if (skill.missing.config.length > 0) {
      missing.push(`config: ${skill.missing.config.join(", ")}`);
    }
    if (skill.missing.os.length > 0) {
      missing.push(`os: ${skill.missing.os.join(", ")}`);
    }
    const missingStr =
      missing.length > 0 ? chalk.red(` [${missing.join("; ")}]`) : "";
    return `${emoji} ${name} ${status}${missingStr}\n   ${desc}`;
  }

  return `${emoji} ${name} ${status} - ${desc}`;
}

/**
 * Format the skills list output
 */
export function formatSkillsList(
  report: SkillStatusReport,
  opts: SkillsListOptions,
): string {
  const skills = opts.eligible
    ? report.skills.filter((s) => s.eligible)
    : report.skills;

  if (opts.json) {
    const jsonReport = {
      workspaceDir: report.workspaceDir,
      managedSkillsDir: report.managedSkillsDir,
      skills: skills.map((s) => ({
        name: s.name,
        description: s.description,
        emoji: s.emoji,
        eligible: s.eligible,
        disabled: s.disabled,
        blockedByAllowlist: s.blockedByAllowlist,
        source: s.source,
        primaryEnv: s.primaryEnv,
        homepage: s.homepage,
        missing: s.missing,
      })),
    };
    return JSON.stringify(jsonReport, null, 2);
  }

  if (skills.length === 0) {
    const message = opts.eligible
      ? "No eligible skills found. Run `clawdbot skills list` to see all skills."
      : "No skills found.";
    return appendClawdHubHint(message, opts.json);
  }

  const eligible = skills.filter((s) => s.eligible);
  const notEligible = skills.filter((s) => !s.eligible);

  const lines: string[] = [];
  lines.push(
    chalk.bold.cyan("Skills") +
      chalk.gray(` (${eligible.length}/${skills.length} ready)`),
  );
  lines.push("");

  if (eligible.length > 0) {
    lines.push(chalk.bold.green("Ready:"));
    for (const skill of eligible) {
      lines.push(`  ${formatSkillLine(skill, opts.verbose)}`);
    }
  }

  if (notEligible.length > 0 && !opts.eligible) {
    if (eligible.length > 0) lines.push("");
    lines.push(chalk.bold.yellow("Not ready:"));
    for (const skill of notEligible) {
      lines.push(`  ${formatSkillLine(skill, opts.verbose)}`);
    }
  }

  return appendClawdHubHint(lines.join("\n"), opts.json);
}

/**
 * Format detailed info for a single skill
 */
export function formatSkillInfo(
  report: SkillStatusReport,
  skillName: string,
  opts: SkillInfoOptions,
): string {
  const skill = report.skills.find(
    (s) => s.name === skillName || s.skillKey === skillName,
  );

  if (!skill) {
    if (opts.json) {
      return JSON.stringify({ error: "not found", skill: skillName }, null, 2);
    }
    return appendClawdHubHint(
      `Skill "${skillName}" not found. Run \`clawdbot skills list\` to see available skills.`,
      opts.json,
    );
  }

  if (opts.json) {
    return JSON.stringify(skill, null, 2);
  }

  const lines: string[] = [];
  const emoji = skill.emoji ?? "📦";
  const status = skill.eligible
    ? chalk.green("✓ Ready")
    : skill.disabled
      ? chalk.yellow("⏸ Disabled")
      : skill.blockedByAllowlist
        ? chalk.yellow("🚫 Blocked by allowlist")
        : chalk.red("✗ Missing requirements");

  lines.push(`${emoji} ${chalk.bold.cyan(skill.name)} ${status}`);
  lines.push("");
  lines.push(chalk.white(skill.description));
  lines.push("");

  // Details
  lines.push(chalk.bold("Details:"));
  lines.push(`  Source: ${skill.source}`);
  lines.push(`  Path: ${chalk.gray(skill.filePath)}`);
  if (skill.homepage) {
    lines.push(`  Homepage: ${chalk.blue(skill.homepage)}`);
  }
  if (skill.primaryEnv) {
    lines.push(`  Primary env: ${skill.primaryEnv}`);
  }

  // Requirements
  const hasRequirements =
    skill.requirements.bins.length > 0 ||
    skill.requirements.anyBins.length > 0 ||
    skill.requirements.env.length > 0 ||
    skill.requirements.config.length > 0 ||
    skill.requirements.os.length > 0;

  if (hasRequirements) {
    lines.push("");
    lines.push(chalk.bold("Requirements:"));
    if (skill.requirements.bins.length > 0) {
      const binsStatus = skill.requirements.bins.map((bin) => {
        const missing = skill.missing.bins.includes(bin);
        return missing ? chalk.red(`✗ ${bin}`) : chalk.green(`✓ ${bin}`);
      });
      lines.push(`  Binaries: ${binsStatus.join(", ")}`);
    }
    if (skill.requirements.anyBins.length > 0) {
      const anyBinsMissing = skill.missing.anyBins.length > 0;
      const anyBinsStatus = skill.requirements.anyBins.map((bin) => {
        const missing = anyBinsMissing;
        return missing ? chalk.red(`✗ ${bin}`) : chalk.green(`✓ ${bin}`);
      });
      lines.push(`  Any binaries: ${anyBinsStatus.join(", ")}`);
    }
    if (skill.requirements.env.length > 0) {
      const envStatus = skill.requirements.env.map((env) => {
        const missing = skill.missing.env.includes(env);
        return missing ? chalk.red(`✗ ${env}`) : chalk.green(`✓ ${env}`);
      });
      lines.push(`  Environment: ${envStatus.join(", ")}`);
    }
    if (skill.requirements.config.length > 0) {
      const configStatus = skill.requirements.config.map((cfg) => {
        const missing = skill.missing.config.includes(cfg);
        return missing ? chalk.red(`✗ ${cfg}`) : chalk.green(`✓ ${cfg}`);
      });
      lines.push(`  Config: ${configStatus.join(", ")}`);
    }
    if (skill.requirements.os.length > 0) {
      const osStatus = skill.requirements.os.map((osName) => {
        const missing = skill.missing.os.includes(osName);
        return missing ? chalk.red(`✗ ${osName}`) : chalk.green(`✓ ${osName}`);
      });
      lines.push(`  OS: ${osStatus.join(", ")}`);
    }
  }

  // Install options
  if (skill.install.length > 0 && !skill.eligible) {
    lines.push("");
    lines.push(chalk.bold("Install options:"));
    for (const inst of skill.install) {
      lines.push(`  ${chalk.yellow("→")} ${inst.label}`);
    }
  }

  return appendClawdHubHint(lines.join("\n"), opts.json);
}

/**
 * Format a check/summary of all skills status
 */
export function formatSkillsCheck(
  report: SkillStatusReport,
  opts: SkillsCheckOptions,
): string {
  const eligible = report.skills.filter((s) => s.eligible);
  const disabled = report.skills.filter((s) => s.disabled);
  const blocked = report.skills.filter(
    (s) => s.blockedByAllowlist && !s.disabled,
  );
  const missingReqs = report.skills.filter(
    (s) => !s.eligible && !s.disabled && !s.blockedByAllowlist,
  );

  if (opts.json) {
    return JSON.stringify(
      {
        summary: {
          total: report.skills.length,
          eligible: eligible.length,
          disabled: disabled.length,
          blocked: blocked.length,
          missingRequirements: missingReqs.length,
        },
        eligible: eligible.map((s) => s.name),
        disabled: disabled.map((s) => s.name),
        blocked: blocked.map((s) => s.name),
        missingRequirements: missingReqs.map((s) => ({
          name: s.name,
          missing: s.missing,
          install: s.install,
        })),
      },
      null,
      2,
    );
  }

  const lines: string[] = [];
  lines.push(chalk.bold.cyan("Skills Status Check"));
  lines.push("");
  lines.push(`Total: ${report.skills.length}`);
  lines.push(`${chalk.green("✓")} Eligible: ${eligible.length}`);
  lines.push(`${chalk.yellow("⏸")} Disabled: ${disabled.length}`);
  lines.push(`${chalk.yellow("🚫")} Blocked by allowlist: ${blocked.length}`);
  lines.push(`${chalk.red("✗")} Missing requirements: ${missingReqs.length}`);

  if (eligible.length > 0) {
    lines.push("");
    lines.push(chalk.bold.green("Ready to use:"));
    for (const skill of eligible) {
      const emoji = skill.emoji ?? "📦";
      lines.push(`  ${emoji} ${skill.name}`);
    }
  }

  if (missingReqs.length > 0) {
    lines.push("");
    lines.push(chalk.bold.red("Missing requirements:"));
    for (const skill of missingReqs) {
      const emoji = skill.emoji ?? "📦";
      const missing: string[] = [];
      if (skill.missing.bins.length > 0) {
        missing.push(`bins: ${skill.missing.bins.join(", ")}`);
      }
      if (skill.missing.anyBins.length > 0) {
        missing.push(`anyBins: ${skill.missing.anyBins.join(", ")}`);
      }
      if (skill.missing.env.length > 0) {
        missing.push(`env: ${skill.missing.env.join(", ")}`);
      }
      if (skill.missing.config.length > 0) {
        missing.push(`config: ${skill.missing.config.join(", ")}`);
      }
      if (skill.missing.os.length > 0) {
        missing.push(`os: ${skill.missing.os.join(", ")}`);
      }
      lines.push(
        `  ${emoji} ${skill.name} ${chalk.gray(`(${missing.join("; ")})`)}`,
      );
    }
  }

  return appendClawdHubHint(lines.join("\n"), opts.json);
}

/**
 * Register the skills CLI commands
 */
export function registerSkillsCli(program: Command) {
  const skills = program
    .command("skills")
    .description("List and inspect available skills")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink(
          "/skills",
          "docs.clawd.bot/skills",
        )}\n`,
    );

  skills
    .command("list")
    .description("List all available skills")
    .option("--json", "Output as JSON", false)
    .option("--eligible", "Show only eligible (ready to use) skills", false)
    .option(
      "-v, --verbose",
      "Show more details including missing requirements",
      false,
    )
    .action(async (opts) => {
      try {
        const config = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(
          config,
          resolveDefaultAgentId(config),
        );
        const report = buildWorkspaceSkillStatus(workspaceDir, { config });
        console.log(formatSkillsList(report, opts));
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  skills
    .command("info")
    .description("Show detailed information about a skill")
    .argument("<name>", "Skill name")
    .option("--json", "Output as JSON", false)
    .action(async (name, opts) => {
      try {
        const config = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(
          config,
          resolveDefaultAgentId(config),
        );
        const report = buildWorkspaceSkillStatus(workspaceDir, { config });
        console.log(formatSkillInfo(report, name, opts));
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  skills
    .command("check")
    .description("Check which skills are ready vs missing requirements")
    .option("--json", "Output as JSON", false)
    .action(async (opts) => {
      try {
        const config = loadConfig();
        const workspaceDir = resolveAgentWorkspaceDir(
          config,
          resolveDefaultAgentId(config),
        );
        const report = buildWorkspaceSkillStatus(workspaceDir, { config });
        console.log(formatSkillsCheck(report, opts));
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });

  // Default action (no subcommand) - show list
  skills.action(async () => {
    try {
      const config = loadConfig();
      const workspaceDir = resolveAgentWorkspaceDir(
        config,
        resolveDefaultAgentId(config),
      );
      const report = buildWorkspaceSkillStatus(workspaceDir, { config });
      console.log(formatSkillsList(report, {}));
    } catch (err) {
      defaultRuntime.error(String(err));
      defaultRuntime.exit(1);
    }
  });
}
