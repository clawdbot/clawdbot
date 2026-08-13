// Workspace skill prompt helpers render bounded catalogs and reusable snapshots.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveEffectiveAgentSkillsLimits } from "../discovery/agent-filter.js";
import { filterPromptVisibleSkillEntries } from "../discovery/skill-index.js";
import type { SkillEligibilityContext, SkillEntry, SkillSnapshot } from "../types.js";
import { WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION } from "../types.js";
import { hasUnavailableSkillSecretOwners, isSkillSecretOwnerUnavailable } from "./config.js";
import { resolveSkillKey } from "./frontmatter.js";
import {
  escapeSkillXml,
  formatSkillsCompactForPrompt,
  formatSkillsForPromptCore,
  type Skill,
} from "./skill-contract.js";
import { compactPromptSkills } from "./skill-paths.js";
import { resolveWorkspaceSkillPromptEntries } from "./workspace-skill-loader.js";

const COMPACT_DESCRIPTION_MAX_CHARS = 220;
const COMPACT_DESCRIPTION_MIN_CHARS = 4;
const DEFAULT_MAX_SKILLS_IN_PROMPT = 150;
const DEFAULT_MAX_SKILLS_PROMPT_CHARS = 18_000;

type ResolvedSkillsPromptLimits = {
  maxSkillsInPrompt: number;
  maxSkillsPromptChars: number;
};

function resolveSkillsPromptLimits(
  config?: OpenClawConfig,
  agentId?: string,
): ResolvedSkillsPromptLimits {
  const limits = config?.skills?.limits;
  const agentLimits = resolveEffectiveAgentSkillsLimits(config, agentId);
  return {
    maxSkillsInPrompt: limits?.maxSkillsInPrompt ?? DEFAULT_MAX_SKILLS_IN_PROMPT,
    maxSkillsPromptChars:
      agentLimits?.maxSkillsPromptChars ??
      limits?.maxSkillsPromptChars ??
      DEFAULT_MAX_SKILLS_PROMPT_CHARS,
  };
}

type SkillsPromptFormat = { kind: "full" } | { kind: "compact"; descriptionMaxChars: number };

function buildSkillsLimitNote(params: {
  truncated: boolean;
  format: SkillsPromptFormat;
  included: number;
  total: number;
}): string {
  if (params.truncated) {
    const compactDetails =
      params.format.kind === "compact"
        ? ` (compact format, ${params.format.descriptionMaxChars > 0 ? "descriptions shortened" : "descriptions omitted"})`
        : "";
    return `⚠️ Skills truncated: included ${params.included} of ${params.total}${compactDetails}. Run \`openclaw skills check\` to audit.`;
  }
  if (params.format.kind === "compact") {
    const compactDetails =
      params.format.descriptionMaxChars > 0 ? "descriptions shortened" : "descriptions omitted";
    return `⚠️ Skills catalog using compact format (${compactDetails}). Run \`openclaw skills check\` to audit.`;
  }
  return "";
}

function buildRenderedSkillsPrompt(params: {
  remoteNote?: string;
  skills: Skill[];
  total: number;
  format: SkillsPromptFormat;
  includeLimitNote?: boolean;
}): string {
  // resolveCodeModeSkills in src/agents/code-mode-skills.ts parses this exact format; update both together.
  // The production-renderer parity test in src/agents/code-mode.test.ts enforces this coupling.
  const truncated = params.skills.length < params.total;
  const limitNote =
    params.includeLimitNote === false
      ? ""
      : buildSkillsLimitNote({
          truncated,
          format: params.format,
          included: params.skills.length,
          total: params.total,
        });
  const catalog =
    params.format.kind === "compact"
      ? formatSkillsCompactForPrompt(params.skills, {
          descriptionMaxChars: params.format.descriptionMaxChars,
        })
      : formatSkillsForPromptCore(params.skills);
  return [params.remoteNote, limitNote, catalog].filter(Boolean).join("\n");
}

function applySkillsPromptLimits(params: {
  skills: Skill[];
  config?: OpenClawConfig;
  agentId?: string;
  remoteNote?: string;
}): string {
  const limits = resolveSkillsPromptLimits(params.config, params.agentId);
  const total = params.skills.length;
  const byCount = params.skills.slice(0, Math.max(0, limits.maxSkillsInPrompt));
  let skillsForPrompt = byCount;

  const renderWithinLimit = (
    skills: Skill[],
    format: SkillsPromptFormat,
    includeLimitNote = true,
  ): string | undefined => {
    const remoteNotes = params.remoteNote ? [params.remoteNote, undefined] : [undefined];
    for (const remoteNote of remoteNotes) {
      const prompt = buildRenderedSkillsPrompt({
        remoteNote,
        skills,
        total,
        format,
        includeLimitNote,
      });
      if (prompt.length <= limits.maxSkillsPromptChars) {
        return prompt;
      }
    }
    return undefined;
  };

  const fitsFull = (skills: Skill[], includeLimitNote = true): boolean =>
    renderWithinLimit(skills, { kind: "full" }, includeLimitNote) !== undefined;
  const fitsCompact = (
    skills: Skill[],
    descriptionMaxChars: number,
    includeLimitNote = true,
  ): boolean =>
    renderWithinLimit(skills, { kind: "compact", descriptionMaxChars }, includeLimitNote) !==
    undefined;

  if (!fitsFull(skillsForPrompt)) {
    if (!fitsCompact(skillsForPrompt, 0)) {
      let lo = 0;
      let hi = skillsForPrompt.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fitsCompact(skillsForPrompt.slice(0, mid), 0)) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      skillsForPrompt = skillsForPrompt.slice(0, lo);
    }

    if (skillsForPrompt.length === 0 && byCount.length > 0) {
      const fullWithoutNotice = renderWithinLimit(byCount, { kind: "full" }, false);
      if (fullWithoutNotice !== undefined) {
        return fullWithoutNotice;
      }
      let lo = 0;
      let hi = byCount.length;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fitsCompact(byCount.slice(0, mid), 0, false)) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      if (lo > 0) {
        skillsForPrompt = byCount.slice(0, lo);
      }
    }

    const includeLimitNote = fitsCompact(skillsForPrompt, 0);
    let descriptionMaxChars = 0;
    if (
      skillsForPrompt.length > 0 &&
      fitsCompact(skillsForPrompt, COMPACT_DESCRIPTION_MIN_CHARS, includeLimitNote)
    ) {
      let lo = COMPACT_DESCRIPTION_MIN_CHARS;
      let hi = COMPACT_DESCRIPTION_MAX_CHARS;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fitsCompact(skillsForPrompt, mid, includeLimitNote)) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      descriptionMaxChars = lo;
    }
    return (
      renderWithinLimit(
        skillsForPrompt,
        { kind: "compact", descriptionMaxChars },
        includeLimitNote,
      ) ?? ""
    );
  }

  return renderWithinLimit(skillsForPrompt, { kind: "full" }) ?? "";
}

type WorkspaceSkillBuildOptions = {
  config?: OpenClawConfig;
  managedSkillsDir?: string;
  bundledSkillsDir?: string;
  entries?: SkillEntry[];
  agentId?: string;
  skillFilter?: string[];
  skillOverrides?: Record<string, boolean>;
  eligibility?: SkillEligibilityContext;
};

function resolveWorkspaceSkillPromptState(
  workspaceDir: string,
  opts?: WorkspaceSkillBuildOptions,
): { eligible: SkillEntry[]; prompt: string; resolvedSkills: Skill[]; skillFilter?: string[] } {
  const { eligible, skillFilter } = resolveWorkspaceSkillPromptEntries(workspaceDir, opts);
  const promptEntries = filterPromptVisibleSkillEntries(eligible);
  const remoteNote = opts?.eligibility?.remote?.note?.trim();
  const resolvedSkills = promptEntries.map((entry) => entry.skill);
  const promptSkills = compactPromptSkills(resolvedSkills).toSorted((a, b) =>
    a.name.localeCompare(b.name, "en"),
  );
  const prompt = applySkillsPromptLimits({
    skills: promptSkills,
    config: opts?.config,
    agentId: opts?.agentId,
    remoteNote,
  });
  return { eligible, prompt, resolvedSkills, skillFilter };
}

export function buildSkillSnapshot(
  workspaceDir: string,
  opts?: WorkspaceSkillBuildOptions & { snapshotVersion?: number },
): SkillSnapshot {
  const { eligible, prompt, resolvedSkills, skillFilter } = resolveWorkspaceSkillPromptState(
    workspaceDir,
    opts,
  );
  return {
    prompt,
    skills: eligible.map((entry) => ({
      name: entry.skill.name,
      skillKey: resolveSkillKey(entry.skill, entry),
      primaryEnv: entry.metadata?.primaryEnv,
      requiredEnv: entry.metadata?.requires?.env?.slice(),
    })),
    ...(skillFilter === undefined ? {} : { skillFilter }),
    ...(opts?.skillOverrides ? { skillOverrides: opts.skillOverrides } : {}),
    ...(opts?.eligibility?.nodeSkills
      ? { nodeSkillsEligibility: opts.eligibility.nodeSkills }
      : {}),
    resolvedSkills,
    version: opts?.snapshotVersion,
    promptFormatVersion: WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION,
  };
}

export function resolveSkillsPrompt(params: {
  skillsSnapshot?: SkillSnapshot;
  entries?: SkillEntry[];
  config?: OpenClawConfig;
  workspaceDir: string;
  agentId?: string;
  eligibility?: SkillEligibilityContext;
}): string {
  const snapshotPrompt = params.skillsSnapshot?.prompt?.trim();
  if (params.skillsSnapshot && !snapshotPrompt) {
    return "";
  }
  const snapshotHasLegacySkillIdentity = params.skillsSnapshot?.skills.some(
    (skill) => !skill.skillKey,
  );
  if (snapshotPrompt) {
    const snapshotHasUnavailableSkill =
      params.skillsSnapshot?.skills.some((skill) =>
        isSkillSecretOwnerUnavailable(skill.skillKey ?? skill.name),
      ) ||
      (snapshotHasLegacySkillIdentity && hasUnavailableSkillSecretOwners());
    if (
      snapshotHasUnavailableSkill &&
      params.skillsSnapshot?.promptFormatVersion !== WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION
    ) {
      return "";
    }
    if (snapshotHasLegacySkillIdentity && hasUnavailableSkillSecretOwners()) {
      return "";
    }
    const unavailableNames = new Set(
      params.skillsSnapshot?.skills
        .filter(
          (skill) => skill.skillKey !== undefined && isSkillSecretOwnerUnavailable(skill.skillKey),
        )
        .map((skill) => escapeSkillXml(skill.name)),
    );
    if (unavailableNames.size === 0) {
      return snapshotPrompt;
    }
    const catalogOpen = "<available_skills>";
    const catalogClose = "</available_skills>";
    const catalogStart = snapshotPrompt.indexOf(catalogOpen);
    const catalogEnd = snapshotPrompt.indexOf(catalogClose, catalogStart + catalogOpen.length);
    if (
      catalogStart < 0 ||
      catalogEnd < 0 ||
      snapshotPrompt.includes(catalogOpen, catalogStart + catalogOpen.length) ||
      snapshotPrompt.includes(catalogClose, catalogEnd + catalogClose.length)
    ) {
      return "";
    }
    const bodyStart = catalogStart + catalogOpen.length;
    const catalogBody = snapshotPrompt.slice(bodyStart, catalogEnd);
    const blockPattern = /\n[ ]{2}<skill>\n[\s\S]*?\n[ ]{2}<\/skill>/g;
    let cursor = 0;
    let filteredBody = "";
    for (const match of catalogBody.matchAll(blockPattern)) {
      const gap = catalogBody.slice(cursor, match.index);
      const block = match[0];
      const name = /^[ ]{4}<name>(.*)<\/name>$/m.exec(block)?.[1];
      if (gap.trim() || !name) {
        return "";
      }
      filteredBody += gap;
      if (!unavailableNames.has(name)) {
        filteredBody += block;
      }
      cursor = (match.index ?? 0) + block.length;
    }
    const tail = catalogBody.slice(cursor);
    if (tail.trim()) {
      return "";
    }
    return `${snapshotPrompt.slice(0, bodyStart)}${filteredBody}${tail}${snapshotPrompt.slice(catalogEnd)}`.trim();
  }
  if (params.entries && params.entries.length > 0) {
    const prompt = buildSkillSnapshot(params.workspaceDir, {
      entries: params.entries,
      config: params.config,
      agentId: params.agentId,
      eligibility: params.eligibility,
    }).prompt;
    return prompt.trim() ? prompt : "";
  }
  return "";
}
