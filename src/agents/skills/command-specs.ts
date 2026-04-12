import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { loadEnabledClaudeBundleCommands } from "../../plugins/bundle-commands.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../../shared/string-coerce.js";
import { resolveEffectiveAgentSkillFilter } from "./agent-filter.js";
import type { SkillEligibilityContext, SkillCommandSpec, SkillEntry } from "./types.js";
import {
  filterWorkspaceSkillEntriesWithOptions,
  loadVisibleWorkspaceSkillEntries,
} from "./workspace.js";

const skillsLogger = createSubsystemLogger("skills");
const skillCommandDebugOnce = new Set<string>();
const SKILL_COMMAND_MAX_LENGTH = 32;
const SKILL_COMMAND_FALLBACK = "skill";
const SKILL_COMMAND_DESCRIPTION_MAX_LENGTH = 100;

function debugSkillCommandOnce(
  messageKey: string,
  message: string,
  meta?: Record<string, unknown>,
) {
  if (skillCommandDebugOnce.has(messageKey)) {
    return;
  }
  skillCommandDebugOnce.add(messageKey);
  skillsLogger.debug(message, meta);
}

function sanitizeSkillCommandName(raw: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(raw)
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const trimmed = normalized.slice(0, SKILL_COMMAND_MAX_LENGTH);
  return trimmed || SKILL_COMMAND_FALLBACK;
}

function resolveUniqueSkillCommandName(base: string, used: Set<string>): string {
  const normalizedBase = normalizeLowercaseStringOrEmpty(base);
  if (!used.has(normalizedBase)) {
    return base;
  }
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `_${index}`;
    const maxBaseLength = Math.max(1, SKILL_COMMAND_MAX_LENGTH - suffix.length);
    const trimmedBase = base.slice(0, maxBaseLength);
    const candidate = `${trimmedBase}${suffix}`;
    const candidateKey = normalizeLowercaseStringOrEmpty(candidate);
    if (!used.has(candidateKey)) {
      return candidate;
    }
  }
  return `${base.slice(0, Math.max(1, SKILL_COMMAND_MAX_LENGTH - 2))}_x`;
}

export function buildWorkspaceSkillCommandSpecs(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    entries?: SkillEntry[];
    agentId?: string;
    skillFilter?: string[];
    eligibility?: SkillEligibilityContext;
    reservedNames?: Set<string>;
  },
): SkillCommandSpec[] {
  const effectiveSkillFilter =
    opts?.skillFilter ?? resolveEffectiveAgentSkillFilter(opts?.config, opts?.agentId);
  const eligible = opts?.entries
    ? filterWorkspaceSkillEntriesWithOptions(opts.entries, {
        config: opts?.config,
        skillFilter: effectiveSkillFilter,
        eligibility: opts?.eligibility,
      })
    : loadVisibleWorkspaceSkillEntries(workspaceDir, {
        config: opts?.config,
        managedSkillsDir: opts?.managedSkillsDir,
        bundledSkillsDir: opts?.bundledSkillsDir,
        skillFilter: effectiveSkillFilter,
        eligibility: opts?.eligibility,
      });
  const userInvocable = eligible.filter((entry) => entry.invocation?.userInvocable !== false);
  const used = new Set<string>();
  for (const reserved of opts?.reservedNames ?? []) {
    used.add(normalizeLowercaseStringOrEmpty(reserved));
  }

  const specs: SkillCommandSpec[] = [];
  for (const entry of userInvocable) {
    const rawName = entry.skill.name;
    const base = sanitizeSkillCommandName(rawName);
    if (base !== rawName) {
      debugSkillCommandOnce(
        `sanitize:${rawName}:${base}`,
        `Sanitized skill command name "${rawName}" to "/${base}".`,
        { rawName, sanitized: `/${base}` },
      );
    }
    const unique = resolveUniqueSkillCommandName(base, used);
    if (unique !== base) {
      debugSkillCommandOnce(
        `dedupe:${rawName}:${unique}`,
        `De-duplicated skill command name for "${rawName}" to "/${unique}".`,
        { rawName, deduped: `/${unique}` },
      );
    }
    used.add(normalizeLowercaseStringOrEmpty(unique));
    const rawDescription = entry.skill.description?.trim() || rawName;
    const description =
      rawDescription.length > SKILL_COMMAND_DESCRIPTION_MAX_LENGTH
        ? rawDescription.slice(0, SKILL_COMMAND_DESCRIPTION_MAX_LENGTH - 1) + "…"
        : rawDescription;
    const dispatch = (() => {
      const kindRaw = normalizeLowercaseStringOrEmpty(
        entry.frontmatter?.["command-dispatch"] ?? entry.frontmatter?.["command_dispatch"] ?? "",
      );
      if (!kindRaw || kindRaw !== "tool") {
        return undefined;
      }

      const toolName = (
        entry.frontmatter?.["command-tool"] ??
        entry.frontmatter?.["command_tool"] ??
        ""
      ).trim();
      if (!toolName) {
        debugSkillCommandOnce(
          `dispatch:missingTool:${rawName}`,
          `Skill command "/${unique}" requested tool dispatch but did not provide command-tool. Ignoring dispatch.`,
          { skillName: rawName, command: unique },
        );
        return undefined;
      }

      const argModeRaw = normalizeOptionalLowercaseString(
        entry.frontmatter?.["command-arg-mode"] ?? entry.frontmatter?.["command_arg_mode"] ?? "",
      );
      const argMode = !argModeRaw || argModeRaw === "raw" ? "raw" : null;
      if (!argMode) {
        debugSkillCommandOnce(
          `dispatch:badArgMode:${rawName}:${argModeRaw}`,
          `Skill command "/${unique}" requested tool dispatch but has unknown command-arg-mode. Falling back to raw.`,
          { skillName: rawName, command: unique, argMode: argModeRaw },
        );
      }

      return { kind: "tool", toolName, argMode: "raw" } as const;
    })();

    specs.push({
      name: unique,
      skillName: rawName,
      description,
      ...(dispatch ? { dispatch } : {}),
    });
  }

  const bundleCommands = loadEnabledClaudeBundleCommands({
    workspaceDir,
    cfg: opts?.config,
  });
  for (const entry of bundleCommands) {
    const base = sanitizeSkillCommandName(entry.rawName);
    if (base !== entry.rawName) {
      debugSkillCommandOnce(
        `bundle-sanitize:${entry.rawName}:${base}`,
        `Sanitized bundle command name "${entry.rawName}" to "/${base}".`,
        { rawName: entry.rawName, sanitized: `/${base}` },
      );
    }
    const unique = resolveUniqueSkillCommandName(base, used);
    if (unique !== base) {
      debugSkillCommandOnce(
        `bundle-dedupe:${entry.rawName}:${unique}`,
        `De-duplicated bundle command name for "${entry.rawName}" to "/${unique}".`,
        { rawName: entry.rawName, deduped: `/${unique}` },
      );
    }
    used.add(normalizeLowercaseStringOrEmpty(unique));
    const description =
      entry.description.length > SKILL_COMMAND_DESCRIPTION_MAX_LENGTH
        ? entry.description.slice(0, SKILL_COMMAND_DESCRIPTION_MAX_LENGTH - 1) + "…"
        : entry.description;
    specs.push({
      name: unique,
      skillName: entry.rawName,
      description,
      promptTemplate: entry.promptTemplate,
      sourceFilePath: entry.sourceFilePath,
    });
  }
  return specs;
}
