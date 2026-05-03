import type { SkillStatusEntry, SkillStatusReport } from "../agents/skills-status.js";
import { sanitizeForLog, stripAnsi } from "../terminal/ansi.js";
import { getTerminalTableWidth, renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { shortenHomePath } from "../utils.js";
import { formatCliCommand } from "./command-format.js";

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
  agent?: string;
};

function appendClawHubHint(output: string, json?: boolean): string {
  if (json) {
    return output;
  }
  return `${output}\n\nTip: use \`openclaw skills search\`, \`openclaw skills install\`, and \`openclaw skills update\` for ClawHub-backed skills.`;
}

function formatSkillStatus(skill: SkillStatusEntry): string {
  if (skill.disabled) {
    return theme.warn("⏸ disabled");
  }
  if (skill.blockedByAllowlist) {
    return theme.warn("🚫 blocked");
  }
  if (skill.blockedByAgentFilter) {
    return theme.warn("🚫 excluded");
  }
  if (skill.eligible) {
    return theme.success("✓ ready");
  }
  return theme.warn("△ needs setup");
}

function normalizeSkillEmoji(emoji?: string): string {
  return (emoji ?? "📦").replaceAll("\uFE0E", "\uFE0F");
}

const REMAINING_ESC_SEQUENCE_REGEX = new RegExp(
  String.raw`\u001b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])`,
  "g",
);
const JSON_CONTROL_CHAR_REGEX = new RegExp(String.raw`[\u0000-\u001f\u007f-\u009f]`, "g");

function sanitizeJsonString(value: string): string {
  return stripAnsi(value)
    .replace(REMAINING_ESC_SEQUENCE_REGEX, "")
    .replace(JSON_CONTROL_CHAR_REGEX, "");
}

function sanitizeJsonValue(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeJsonString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeJsonValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entryValue]) => [key, sanitizeJsonValue(entryValue)]),
    );
  }
  return value;
}
function formatSkillName(skill: SkillStatusEntry): string {
  const emoji = normalizeSkillEmoji(skill.emoji);
  return `${emoji} ${theme.command(sanitizeForLog(skill.name))}`;
}

function formatSkillMissingSummary(skill: SkillStatusEntry): string {
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
  return missing.join("; ");
}

export function formatSkillsList(report: SkillStatusReport, opts: SkillsListOptions): string {
  const isReadyForAgent = (skill: SkillStatusEntry) =>
    skill.eligible && !skill.blockedByAgentFilter;
  const skills = opts.eligible ? report.skills.filter(isReadyForAgent) : report.skills;

  if (opts.json) {
    const jsonReport = sanitizeJsonValue({
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
    return JSON.stringify(jsonReport, null, 2);
  }

  if (skills.length === 0) {
    const message = opts.eligible
      ? `No eligible skills found. Run \`${formatCliCommand("openclaw skills list")}\` to see all skills.`
      : "No skills found.";
    return appendClawHubHint(message, opts.json);
  }

  const ready = skills.filter(isReadyForAgent);
  const tableWidth = getTerminalTableWidth();
  const rows = skills.map((skill) => {
    const missing = formatSkillMissingSummary(skill);
    return {
      Status: formatSkillStatus(skill),
      Skill: formatSkillName(skill),
      Description: theme.muted(skill.description),
      Source: skill.source,
      Missing: missing ? theme.warn(missing) : "",
    };
  });

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

export function formatSkillInfo(
  report: SkillStatusReport,
  skillName: string,
  opts: SkillInfoOptions,
): string {
  const skill = report.skills.find((s) => s.name === skillName || s.skillKey === skillName);

  if (!skill) {
    if (opts.json) {
      return JSON.stringify({ error: "not found", skill: skillName }, null, 2);
    }
    return appendClawHubHint(
      `Skill "${skillName}" not found. Run \`${formatCliCommand("openclaw skills list")}\` to see available skills.`,
      opts.json,
    );
  }

  if (opts.json) {
    return JSON.stringify(sanitizeJsonValue(skill), null, 2);
  }

  const lines: string[] = [];
  const emoji = normalizeSkillEmoji(skill.emoji);
  const status = skill.disabled
    ? theme.warn("⏸ Disabled")
    : skill.blockedByAllowlist
      ? theme.warn("🚫 Blocked by allowlist")
      : skill.blockedByAgentFilter
        ? theme.warn("🚫 Excluded by agent allowlist")
        : skill.eligible
          ? theme.success("✓ Ready")
          : theme.warn("△ Needs setup");

  const safeName = sanitizeForLog(skill.name);
  const safeHomepage = skill.homepage ? sanitizeForLog(skill.homepage) : undefined;
  const safeSkillKey = sanitizeForLog(skill.skillKey);

  lines.push(`${emoji} ${theme.heading(safeName)} ${status}`);
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

  const hasRequirements =
    skill.requirements.bins.length > 0 ||
    skill.requirements.anyBins.length > 0 ||
    skill.requirements.env.length > 0 ||
    skill.requirements.config.length > 0 ||
    skill.requirements.os.length > 0;

  if (hasRequirements) {
    lines.push("");
    lines.push(theme.heading("Requirements:"));
    if (skill.requirements.bins.length > 0) {
      const binsStatus = skill.requirements.bins.map((bin) => {
        const missing = skill.missing.bins.includes(bin);
        return missing ? theme.error(`✗ ${bin}`) : theme.success(`✓ ${bin}`);
      });
      lines.push(`${theme.muted("  Binaries:")} ${binsStatus.join(", ")}`);
    }
    if (skill.requirements.anyBins.length > 0) {
      const anyBinsMissing = skill.missing.anyBins.length > 0;
      const anyBinsStatus = skill.requirements.anyBins.map((bin) => {
        const missing = anyBinsMissing;
        return missing ? theme.error(`✗ ${bin}`) : theme.success(`✓ ${bin}`);
      });
      lines.push(`${theme.muted("  Any binaries:")} ${anyBinsStatus.join(", ")}`);
    }
    if (skill.requirements.env.length > 0) {
      const envStatus = skill.requirements.env.map((env) => {
        const missing = skill.missing.env.includes(env);
        return missing ? theme.error(`✗ ${env}`) : theme.success(`✓ ${env}`);
      });
      lines.push(`${theme.muted("  Environment:")} ${envStatus.join(", ")}`);
    }
    if (skill.requirements.config.length > 0) {
      const configStatus = skill.requirements.config.map((cfg) => {
        const missing = skill.missing.config.includes(cfg);
        return missing ? theme.error(`✗ ${cfg}`) : theme.success(`✓ ${cfg}`);
      });
      lines.push(`${theme.muted("  Config:")} ${configStatus.join(", ")}`);
    }
    if (skill.requirements.os.length > 0) {
      const osStatus = skill.requirements.os.map((osName) => {
        const missing = skill.missing.os.includes(osName);
        return missing ? theme.error(`✗ ${osName}`) : theme.success(`✓ ${osName}`);
      });
      lines.push(`${theme.muted("  OS:")} ${osStatus.join(", ")}`);
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

export function formatSkillsCheck(report: SkillStatusReport, opts: SkillsCheckOptions): string {
  const eligible = report.skills.filter((s) => s.eligible);
  const modelVisible = report.skills.filter((s) => s.modelVisible);
  const commandVisible = report.skills.filter((s) => s.commandVisible);
  const disabled = report.skills.filter((s) => s.disabled);
  const blocked = report.skills.filter((s) => s.blockedByAllowlist && !s.disabled);
  const agentFiltered = report.skills.filter((s) => s.eligible && s.blockedByAgentFilter);
  const promptHidden = report.skills.filter(
    (s) => s.eligible && !s.blockedByAgentFilter && !s.modelVisible,
  );
  const missingReqs = report.skills.filter(
    (s) => !s.eligible && !s.disabled && !s.blockedByAllowlist && !s.blockedByAgentFilter,
  );
  const agentId = report.agentId ?? opts.agent;

  if (opts.json) {
    return JSON.stringify(
      sanitizeJsonValue({
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
      }),
      null,
      2,
    );
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
  lines.push(`${theme.warn("⏸")} ${theme.muted("Disabled:")} ${disabled.length}`);
  lines.push(`${theme.warn("🚫")} ${theme.muted("Blocked by allowlist:")} ${blocked.length}`);
  if (agentId || agentFiltered.length > 0) {
    lines.push(
      `${theme.warn("🚫")} ${theme.muted("Excluded by agent allowlist:")} ${agentFiltered.length}`,
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
        `  ${theme.muted("Available as command:")} people, scripts, or cron jobs can call the skill explicitly.`,
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
      lines.push(`  ${emoji} ${sanitizeForLog(skill.name)}`);
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
      lines.push(`  ${emoji} ${sanitizeForLog(skill.name)} ${theme.muted(`(${reason})`)}`);
    }
  }

  if (agentFiltered.length > 0) {
    lines.push("");
    lines.push(theme.heading("Excluded by agent allowlist:"));
    for (const skill of agentFiltered) {
      const emoji = normalizeSkillEmoji(skill.emoji);
      lines.push(
        `  ${emoji} ${sanitizeForLog(skill.name)} ${theme.muted("(loaded, but this agent is not allowed to see/use it)")}`,
      );
    }
  }

  if (missingReqs.length > 0) {
    lines.push("");
    lines.push(theme.heading("Missing requirements:"));
    for (const skill of missingReqs) {
      const emoji = normalizeSkillEmoji(skill.emoji);
      const missing = formatSkillMissingSummary(skill);
      lines.push(`  ${emoji} ${sanitizeForLog(skill.name)} ${theme.muted(`(${missing})`)}`);
    }
  }

  return appendClawHubHint(lines.join("\n"), opts.json);
}
