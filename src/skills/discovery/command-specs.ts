// Skill command spec helpers expose skill-provided commands to model/tool surfaces.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { canonicalizePath } from "../../agents/utils/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDedupeCache } from "../../infra/dedupe.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { loadEnabledClaudeBundleCommands } from "../../plugins/bundle-commands.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { resolveSkillTelemetrySource } from "../loading/source.js";
import { filterWorkspaceSkills, loadVisibleSkills } from "../loading/workspace-skill-loader.js";
import type {
  SkillEligibilityContext,
  SkillCommandSpec,
  SkillEntry,
  SkillSnapshot,
} from "../types.js";
import { resolveEffectiveAgentSkillFilter } from "./agent-filter.js";
import { sanitizeSkillCommandName, SKILL_COMMAND_MAX_LENGTH } from "./command-name.js";
import { filterUserInvocableSkillEntries, isSkillPromptVisible } from "./skill-index.js";

const skillsLogger = createSubsystemLogger("skills");
const skillCommandDebugOnce = createDedupeCache({ ttlMs: 0, maxSize: 1024 });

// De-duplicate noisy skill command diagnostics across large workspace scans.
function debugSkillCommandOnce(
  messageKey: string,
  message: string,
  meta?: Record<string, unknown>,
) {
  if (skillCommandDebugOnce.check(messageKey)) {
    return;
  }
  skillsLogger.debug(message, meta);
}

function traceSkillCommandOnce(
  messageKey: string,
  message: string,
  meta?: Record<string, unknown>,
) {
  if (skillCommandDebugOnce.check(messageKey)) {
    return;
  }
  skillsLogger.trace(message, meta);
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

/** Builds user-invocable slash command specs for visible workspace skills. */
export function buildWorkspaceSkillCommandSpecs(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    entries?: SkillEntry[];
    librarySelections?: SkillSnapshot["librarySelections"];
    agentId?: string;
    skillFilter?: string[];
    includeAllowlistHidden?: boolean;
    eligibility?: SkillEligibilityContext;
    pluginMetadataSnapshot?: PluginMetadataSnapshot;
    reservedNames?: Set<string>;
  },
): SkillCommandSpec[] {
  const effectiveSkillFilter = opts?.includeAllowlistHidden
    ? undefined
    : (opts?.skillFilter ?? resolveEffectiveAgentSkillFilter(opts?.config, opts?.agentId));
  const eligible = opts?.entries
    ? filterWorkspaceSkills(opts.entries, {
        config: opts?.config,
        skillFilter: effectiveSkillFilter,
        eligibility: opts?.eligibility,
      })
    : loadVisibleSkills(workspaceDir, {
        config: opts?.config,
        managedSkillsDir: opts?.managedSkillsDir,
        bundledSkillsDir: opts?.bundledSkillsDir,
        librarySelections: opts?.librarySelections,
        skillFilter: effectiveSkillFilter,
        eligibility: opts?.eligibility,
        pluginMetadataSnapshot: opts?.pluginMetadataSnapshot,
      });
  const userInvocable = filterUserInvocableSkillEntries(eligible);
  const used = new Set<string>();
  for (const reserved of opts?.reservedNames ?? []) {
    used.add(normalizeLowercaseStringOrEmpty(reserved));
  }

  const specs: SkillCommandSpec[] = [];
  for (const entry of userInvocable) {
    const rawName = entry.skill.name;
    const base = sanitizeSkillCommandName(rawName);
    if (base !== rawName) {
      traceSkillCommandOnce(
        `sanitize:${rawName}:${base}`,
        `Sanitized skill command name "${rawName}" to "/${base}".`,
        { rawName, sanitized: `/${base}` },
      );
    }
    const unique = resolveUniqueSkillCommandName(base, used);
    if (unique !== base) {
      traceSkillCommandOnce(
        `dedupe:${rawName}:${unique}`,
        `De-duplicated skill command name for "${rawName}" to "/${unique}".`,
        { rawName, deduped: `/${unique}` },
      );
    }
    used.add(normalizeLowercaseStringOrEmpty(unique));
    const description = entry.skill.description?.trim() || rawName;
    const dispatch = entry.disableCommandDispatch
      ? undefined
      : (() => {
          const kindRaw = normalizeLowercaseStringOrEmpty(
            entry.frontmatter?.["command-dispatch"] ??
              entry.frontmatter?.["command_dispatch"] ??
              "",
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
            entry.frontmatter?.["command-arg-mode"] ??
              entry.frontmatter?.["command_arg_mode"] ??
              "",
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
      displayName: entry.skill.displayName ?? rawName,
      skillFile: canonicalizePath(entry.skill.filePath),
      skillName: rawName,
      description,
      modelVisible: isSkillPromptVisible(entry),
      skillSource: resolveSkillTelemetrySource(entry.skill),
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
    specs.push({
      name: unique,
      skillName: entry.rawName,
      description: entry.description,
      modelVisible: false,
      promptTemplate: entry.promptTemplate,
      sourceFilePath: entry.sourceFilePath,
    });
  }
  return specs;
}
