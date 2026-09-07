// Formatting layer for `openclaw skills` commands; keeps discovery data separate from terminal UI.
import { sanitizeForLog, stripAnsi } from "../../packages/terminal-core/src/ansi.js";
import {
  decorativeEmoji,
  decorativePrefix,
} from "../../packages/terminal-core/src/decorative-emoji.js";
import { getTerminalTableWidth, renderTable } from "../../packages/terminal-core/src/table.js";
import { theme } from "../../packages/terminal-core/src/theme.js";
import {
  hasMissingSkillRequirements,
  resolveSkillStatusEntry,
  type SkillStatusEntry,
  type SkillStatusReport,
} from "../skills/discovery/status.js";
import { shortenHomePath } from "../utils.js";
import { formatCliCommand } from "./command-format.js";
import { formatCliJsonFailure } from "./failure-output.js";

/** Options for rendering the skill list command. */
export type SkillsListOptions = {
  json?: boolean;
  eligible?: boolean;
  verbose?: boolean;
};

/** Options for rendering one skill detail view. */
export type SkillInfoOptions = {
  json?: boolean;
};

/** Options for rendering skill readiness checks. */
export type SkillsCheckOptions = {
  json?: boolean;
  agent?: string;
};

function appendClawHubHint(output: string, json?: boolean): string {
  if (json) {
    return output;
  }
  const command = formatCliCommand("openclaw skills");
  return `${output}\n\nTip: use \`${command} search\`, \`${command} install\`, and \`${command} update\` for ClawHub-backed skills.`;
}

function formatSkillStatus(skill: SkillStatusEntry): string {
  if (skill.disabled) {
    return theme.warn(decorativePrefix("⏸", "disabled"));
  }
  if (skill.blockedByAllowlist) {
    return theme.warn(decorativePrefix("🚫", "blocked"));
  }
  if (skill.blockedByAgentFilter) {
    return theme.warn(decorativePrefix("🚫", "excluded"));
  }
  if (skill.eligible) {
    return theme.success("✓ ready");
  }
  return theme.warn("△ needs setup");
}

function normalizeSkillEmoji(emoji?: string): string {
  if (emoji) {
    return emoji.replaceAll("\uFE0E", "\uFE0F");
  }
  return decorativeEmoji("📦");
}

const REMAINING_ESC_SEQUENCE_REGEX = new RegExp(
  String.raw`\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])`,
  "g",
);
// JSON escapes tabs and line endings; preserve their meaning in descriptions and paths.
const JSON_CONTROL_CHAR_REGEX = new RegExp(
  String.raw`[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]`,
  "g",
);

function sanitizeJsonString(value: string): string {
  return stripAnsi(value)
    .replace(REMAINING_ESC_SEQUENCE_REGEX, "")
    .replace(JSON_CONTROL_CHAR_REGEX, "");
}

function formatSkillsJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, entry: unknown) => (typeof entry === "string" ? sanitizeJsonString(entry) : entry),
    2,
  );
}
function formatSkillName(skill: SkillStatusEntry): string {
  const emoji = normalizeSkillEmoji(skill.emoji);
  const name = theme.command(sanitizeForLog(skill.name));
  return emoji ? `${emoji} ${name}` : name;
}

const SKILL_REQUIREMENT_GROUPS = [
  ["bins", "Binaries"],
  ["anyBins", "Any binaries"],
  ["env", "Environment"],
  ["config", "Config"],
  ["os", "OS"],
] as const;

function formatSkillMissingSummary(skill: SkillStatusEntry): string {
  return SKILL_REQUIREMENT_GROUPS.filter(([key]) => skill.missing[key].length > 0)
    .map(([key]) => `${key}: ${skill.missing[key].join(", ")}`)
    .join("; ");
}

/** Render skill discovery status as sanitized JSON or a terminal table. */
export function formatSkillsList(report: SkillStatusReport, opts: SkillsListOptions): string {
  const isReadyForAgent = (skill: SkillStatusEntry) =>
    skill.eligible && !skill.blockedByAgentFilter;
  const skills = opts.eligible ? report.skills.filter(isReadyForAgent) : report.skills;

  if (opts.json) {
    return formatSkillsJson({
      workspaceDir: report.workspaceDir,
      managedSkillsDir: report.managedSkillsDir,
      skills: skills.map((s) => ({
        name: s.name,
        description: s.description,
        emoji: s.emoji,
        eligible: s.eligible,
        disabled: s.disabled,
        blockedByAllowlist: s.blockedByAllowlist,
        blockedByAgentFilter: s.blockedByAgentFilter,
        modelVisible: s.modelVisible,
        userInvocable: s.userInvocable,
        commandVisible: s.commandVisible,
        source: s.source,
        bundled: s.bundled,
        primaryEnv: s.primaryEnv,
        homepage: s.homepage,
        missing: s.missing,
      })),
    });
  }

  if (skills.length === 0) {
    const message = opts.eligible
      ? `No eligible skills found. Run \`${formatCliCommand("openclaw skills list")}\` to see all skills.`
      : "No skills found.";
    return appendClawHubHint(message, opts.json);
  }

  const ready = skills.filter(isReadyForAgent);
  const tableWidth = getTerminalTableWidth();
  const rows = skills.map((skill) => ({
    Status: formatSkillStatus(skill),
    Skill: formatSkillName(skill),
    Description: theme.muted(skill.description),
    Source: skill.source,
    Missing: opts.verbose ? theme.warn(formatSkillMissingSummary(skill)) : "",
  }));

  const columns = [
    { key: "Status", header: "Status", minWidth: 10 },
    { key: "Skill", header: "Skill", minWidth: 22 },
    { key: "Description", header: "Description", minWidth: 24, flex: true },
    { key: "Source", header: "Source", minWidth: 10 },
  ];
  if (opts.verbose) {
    columns.push({ key: "Missing", header: "Missing", minWidth: 18, flex: true });
  }

  const lines: string[] = [];
  lines.push(
    `${theme.heading("Skills")} ${theme.muted(`(${ready.length}/${skills.length} ready)`)}`,
  );
  lines.push(
    renderTable({
      width: tableWidth,
      columns,
      rows,
    }).trimEnd(),
  );

  return appendClawHubHint(lines.join("\n"), opts.json);
}

/** Render one skill's status, requirements, install hints, and API-key setup details. */
export function formatSkillInfo(
  report: SkillStatusReport,
  skillName: string,
  opts: SkillInfoOptions,
): string {
  const requestedName = skillName.trim();
  const skill = resolveSkillStatusEntry(report.skills, requestedName);

  if (!skill) {
    if (opts.json) {
      return formatSkillsJson({
        ...formatCliJsonFailure(`Skill "${requestedName}" not found.`),
        skill: requestedName,
      });
    }
    const safeRequestedName = sanitizeJsonString(sanitizeForLog(requestedName));
    return appendClawHubHint(
      `Skill "${safeRequestedName}" not found. Run \`${formatCliCommand("openclaw skills list")}\` to see available skills.`,
      opts.json,
    );
  }

  if (opts.json) {
    return formatSkillsJson(skill);
  }

  const lines: string[] = [];
  const emoji = normalizeSkillEmoji(skill.emoji);
  const status = skill.disabled
    ? theme.warn(decorativePrefix("⏸", "Disabled"))
    : skill.blockedByAllowlist
      ? theme.warn(decorativePrefix("🚫", "Blocked by allowlist"))
      : skill.blockedByAgentFilter
        ? theme.warn(decorativePrefix("🚫", "Excluded by agent allowlist"))
        : skill.eligible
          ? theme.success("✓ Ready")
          : theme.warn("△ Needs setup");

  const safeName = sanitizeForLog(skill.name);
  const safeHomepage = skill.homepage ? sanitizeForLog(skill.homepage) : undefined;
  const safeSkillKey = sanitizeForLog(skill.skillKey);

  lines.push(`${emoji ? `${emoji} ` : ""}${theme.heading(safeName)} ${status}`);
  lines.push("");
  lines.push(sanitizeForLog(skill.description));
  lines.push("");

  lines.push(theme.heading("Details:"));
  lines.push(`${theme.muted("  Source:")} ${sanitizeForLog(skill.source)}`);
  lines.push(`${theme.muted("  Path:")} ${shortenHomePath(skill.filePath)}`);
  if (safeHomepage) {
    lines.push(`${theme.muted("  Homepage:")} ${safeHomepage}`);
  }
  lines.push(
    `${theme.muted("  Visible to model:")} ${skill.modelVisible ? theme.success("yes") : theme.warn("no")}`,
  );
  lines.push(
    `${theme.muted("  Available as command:")} ${skill.commandVisible ? theme.success("yes") : theme.warn("no")}`,
  );
  if (skill.blockedByAgentFilter) {
    lines.push(`${theme.muted("  Agent allowlist:")} excludes this skill`);
  }
  if (skill.primaryEnv) {
    lines.push(`${theme.muted("  Primary env:")} ${skill.primaryEnv}`);
  }

  const requirementGroups = SKILL_REQUIREMENT_GROUPS.filter(
    ([key]) => skill.requirements[key].length > 0,
  );

  if (requirementGroups.length > 0) {
    lines.push("");
    lines.push(theme.heading("Requirements:"));
    for (const [key, label] of requirementGroups) {
      const missingRequirements = skill.missing[key];
      const requirementStatus = skill.requirements[key].map((requirement) => {
        const missing =
          key === "anyBins"
            ? missingRequirements.length > 0
            : missingRequirements.includes(requirement);
        return missing ? theme.error(`✗ ${requirement}`) : theme.success(`✓ ${requirement}`);
      });
      lines.push(`${theme.muted(`  ${label}:`)} ${requirementStatus.join(", ")}`);
    }
  }

  if (skill.install.length > 0 && !skill.eligible) {
    lines.push("");
    lines.push(theme.heading("Install options:"));
    for (const inst of skill.install) {
      lines.push(`  ${theme.warn("→")} ${inst.label}`);
    }
  }

  if (skill.primaryEnv && skill.missing.env.includes(skill.primaryEnv)) {
    lines.push("");
    lines.push(theme.heading("API key setup:"));
    if (safeHomepage) {
      lines.push(`  Get your key: ${safeHomepage}`);
    }
    lines.push(
      `  Save via UI: ${theme.muted("Control UI → Skills → ")}${safeName}${theme.muted(" → Save key")}`,
    );
    lines.push(
      `  Save via CLI: ${formatCliCommand(`openclaw config set skills.entries.${safeSkillKey}.apiKey YOUR_KEY`)}`,
    );
    lines.push(
      `  Stored in: ${theme.muted("$OPENCLAW_CONFIG_PATH")} ${theme.muted("(default: ~/.openclaw/openclaw.json)")}`,
    );
  }

  return appendClawHubHint(lines.join("\n"), opts.json);
}

/** Render aggregate setup health for all discovered skills. */
export function formatSkillsCheck(report: SkillStatusReport, opts: SkillsCheckOptions): string {
  const eligible = report.skills.filter((s) => s.eligible);
  const modelVisible = report.skills.filter((s) => s.modelVisible);
  const commandVisible = report.skills.filter((s) => s.commandVisible);
  const disabled = report.skills.filter((s) => s.disabled);
  const blocked = report.skills.filter((s) => s.blockedByAllowlist && !s.disabled);
  // Agent exclusion is independent of readiness; report both when a skill needs setup.
  const agentFiltered = report.skills.filter((s) => s.blockedByAgentFilter);
  const promptHidden = report.skills.filter(
    (s) => s.eligible && !s.blockedByAgentFilter && !s.modelVisible,
  );
  const missingReqs = report.skills.filter(hasMissingSkillRequirements);
  const agentId = report.agentId ?? opts.agent;

  if (opts.json) {
    return formatSkillsJson({
      agentId,
      agentSkillFilter: report.agentSkillFilter,
      workspaceDir: report.workspaceDir,
      managedSkillsDir: report.managedSkillsDir,
      summary: {
        total: report.skills.length,
        eligible: eligible.length,
        modelVisible: modelVisible.length,
        commandVisible: commandVisible.length,
        disabled: disabled.length,
        blocked: blocked.length,
        agentFiltered: agentFiltered.length,
        notInjected: promptHidden.length,
        missingRequirements: missingReqs.length,
      },
      eligible: eligible.map((s) => s.name),
      modelVisible: modelVisible.map((s) => s.name),
      commandVisible: commandVisible.map((s) => s.name),
      disabled: disabled.map((s) => s.name),
      blocked: blocked.map((s) => s.name),
      agentFiltered: agentFiltered.map((s) => s.name),
      notInjected: promptHidden.map((s) => ({
        name: s.name,
        reason: "disable-model-invocation",
      })),
      missingRequirements: missingReqs.map((s) => ({
        name: s.name,
        missing: s.missing,
        install: s.install,
      })),
    });
  }

  const lines: string[] = [];
  lines.push(theme.heading("Skills Status Check"));
  if (agentId) {
    lines.push(`${theme.muted("Agent:")} ${sanitizeForLog(agentId)}`);
  }
  lines.push("");
  lines.push(`${theme.muted("Total:")} ${report.skills.length}`);
  lines.push(`${theme.success("✓")} ${theme.muted("Eligible:")} ${eligible.length}`);
  lines.push(`${theme.success("✓")} ${theme.muted("Visible to model:")} ${modelVisible.length}`);
  lines.push(
    `${theme.success("✓")} ${theme.muted("Available as command:")} ${commandVisible.length}`,
  );
  lines.push(
    `${theme.warn(decorativePrefix("⏸", "Disabled:"))} ${theme.muted(String(disabled.length))}`,
  );
  lines.push(
    `${theme.warn(decorativePrefix("🚫", "Blocked by allowlist:"))} ${theme.muted(String(blocked.length))}`,
  );
  if (agentId || agentFiltered.length > 0) {
    lines.push(
      `${theme.warn(decorativePrefix("🚫", "Excluded by agent allowlist:"))} ${theme.muted(String(agentFiltered.length))}`,
    );
  }
  if (promptHidden.length > 0) {
    lines.push(
      `${theme.warn("△")} ${theme.muted("Ready but hidden from model prompt:")} ${promptHidden.length}`,
    );
  }
  lines.push(`${theme.error("✗")} ${theme.muted("Missing requirements:")} ${missingReqs.length}`);

  if (modelVisible.length > 0 || commandVisible.length > 0 || promptHidden.length > 0) {
    lines.push("");
    lines.push(theme.heading("What this means:"));
    lines.push(
      `  ${theme.muted("Eligible:")} installed and requirements pass; the agent may still exclude it.`,
    );
    if (modelVisible.length > 0) {
      lines.push(
        `  ${theme.muted("Visible to model:")} the agent can see the skill instructions during normal chat.`,
      );
    }
    if (commandVisible.length > 0) {
      lines.push(
        `  ${theme.muted("Available as command:")} people, scripts, or automations can call the skill explicitly.`,
      );
    }
    if (promptHidden.length > 0) {
      lines.push(
        `  ${theme.muted("Hidden from model prompt:")} installed and ready, but kept out of normal chat.`,
      );
    }
  }

  if (modelVisible.length > 0) {
    lines.push("");
    lines.push(theme.heading("Ready and visible to model:"));
    for (const skill of modelVisible) {
      const emoji = normalizeSkillEmoji(skill.emoji);
      lines.push(`  ${emoji ? `${emoji} ` : ""}${sanitizeForLog(skill.name)}`);
    }
  }

  if (promptHidden.length > 0) {
    lines.push("");
    lines.push(theme.heading("Ready but hidden from model prompt:"));
    for (const skill of promptHidden) {
      const emoji = normalizeSkillEmoji(skill.emoji);
      const reason = skill.commandVisible
        ? "skill hides its instructions from the model; commands/cron may still use it"
        : "skill hides its instructions from the model and is not exposed as a command";
      lines.push(
        `  ${emoji ? `${emoji} ` : ""}${sanitizeForLog(skill.name)} ${theme.muted(`(${reason})`)}`,
      );
    }
  }

  if (agentFiltered.length > 0) {
    lines.push("");
    lines.push(theme.heading("Excluded by agent allowlist:"));
    for (const skill of agentFiltered) {
      const emoji = normalizeSkillEmoji(skill.emoji);
      lines.push(
        `  ${emoji ? `${emoji} ` : ""}${sanitizeForLog(skill.name)} ${theme.muted("(loaded, but this agent is not allowed to see/use it)")}`,
      );
    }
  }

  if (missingReqs.length > 0) {
    lines.push("");
    lines.push(theme.heading("Missing requirements:"));
    for (const skill of missingReqs) {
      const emoji = normalizeSkillEmoji(skill.emoji);
      const missing = formatSkillMissingSummary(skill);
      lines.push(
        `  ${emoji ? `${emoji} ` : ""}${sanitizeForLog(skill.name)} ${theme.muted(`(${missing})`)}`,
      );
    }
  }

  return appendClawHubHint(lines.join("\n"), opts.json);
}
