// Skill prompt limits keep every catalog producer within one shared model-context budget.
import {
  COMPACT_DESCRIPTION_MAX_CHARS,
  formatSkillsCompactForPrompt,
  formatSkillsForPromptCore,
  type Skill,
} from "./skill-contract.js";

const COMPACT_DESCRIPTION_MIN_CHARS = 4;
const DEFAULT_MAX_SKILLS_IN_PROMPT = 150;
const DEFAULT_MAX_SKILLS_PROMPT_CHARS = 18_000;

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

type SkillsPromptParams = {
  skills: Skill[];
  maxSkillsInPrompt?: number;
  maxSkillsPromptChars?: number;
  remoteNote?: string;
  preserveOrder?: boolean;
};

/** Render a deterministic skills catalog within the shared model-context budget. */
export function formatSkillsForPromptBounded(params: SkillsPromptParams): string {
  return prepareSkillsForPrompt(params).prompt;
}

/** Keep resource selection tied to the exact catalog admitted by the prompt budget. */
export function prepareSkillsForPrompt(params: SkillsPromptParams): {
  prompt: string;
  skills: Skill[];
} {
  const maxSkillsInPrompt = params.maxSkillsInPrompt ?? DEFAULT_MAX_SKILLS_IN_PROMPT;
  const maxSkillsPromptChars = params.maxSkillsPromptChars ?? DEFAULT_MAX_SKILLS_PROMPT_CHARS;
  const orderedSkills = params.preserveOrder
    ? params.skills
    : params.skills.toSorted((a, b) => a.name.localeCompare(b.name, "en"));
  const total = orderedSkills.length;
  const byCount = orderedSkills.slice(0, Math.max(0, maxSkillsInPrompt));
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
      if (prompt.length <= maxSkillsPromptChars) {
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

  if (fitsFull(skillsForPrompt)) {
    return {
      prompt: renderWithinLimit(skillsForPrompt, { kind: "full" }) ?? "",
      skills: skillsForPrompt,
    };
  }

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
      return { prompt: fullWithoutNotice, skills: byCount };
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
  const prompt =
    renderWithinLimit(
      skillsForPrompt,
      { kind: "compact", descriptionMaxChars },
      includeLimitNote,
    ) ?? "";
  return { prompt, skills: prompt ? skillsForPrompt : [] };
}
