import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
// Skill contract types describe loaded skill metadata, sources, and prompt surfaces.
import type { SourceInfo } from "../../agents/sessions/source-info.js";

export interface Skill {
  name: string;
  /** Human-readable title from the first Markdown H1, falling back to the identifier. */
  displayName?: string;
  description: string;
  /** Additional loading guidance rendered with the location in full and compact catalogs. */
  locationNote?: string;
  /** Prepared instructions for transferred bundles or non-filesystem locators such as node://. */
  readContent?: string;
  filePath: string;
  baseDir: string;
  /** @deprecated Ignored; retained for API compatibility until the next Plugin SDK major. */
  promptVersion?: string;
  sourceInfo: SourceInfo;
  disableModelInvocation: boolean;
  // Preserve legacy source reads while keeping the canonical upstream shape.
  source: string;
}

export { createSyntheticSourceInfo } from "../../agents/sessions/source-info.js";

export function escapeSkillXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function decodeSkillXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

export const COMPACT_DESCRIPTION_MAX_CHARS = 220;
const SKILL_FRONTMATTER_BLOCK = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u;
const SKILL_TITLE_HEADING = /^#\s+(.+?)\s*#*\s*$/mu;

function humanizeSkillIdentifier(value: string): string {
  return value
    .trim()
    .split(/[-_]+/u)
    .filter(Boolean)
    .map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

export function resolveSkillDisplayName(content: string, fallbackName: string): string {
  const body = content.replace(SKILL_FRONTMATTER_BLOCK, "");
  const heading = body.match(SKILL_TITLE_HEADING)?.[1]?.trim();
  const displayName = heading || humanizeSkillIdentifier(fallbackName) || fallbackName;
  // A captured heading can retain the whole skill body in metadata caches.
  // Copy UTF-16 code units without changing lone surrogates.
  return Buffer.from(displayName, "utf16le").toString("utf16le");
}

function truncateSkillDescription(description: string, maxChars: number): string {
  const normalized = description.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  if (maxChars <= 3) {
    return truncateUtf16Safe(normalized, maxChars);
  }
  return `${truncateUtf16Safe(normalized, maxChars - 3).trimEnd()}...`;
}

/** Project descriptions for a model without changing admitted identities or loading instructions. */
export function compactSkillsPromptForContext(prompt: string, contextTokenBudget?: number): string {
  if (!contextTokenBudget || !Number.isFinite(contextTokenBudget) || contextTokenBudget <= 0) {
    return prompt;
  }
  const targetChars = Math.floor(contextTokenBudget / 5);
  if (prompt.length <= targetChars) {
    return prompt;
  }
  const start = prompt.indexOf("<available_skills>");
  const end = prompt.indexOf("</available_skills>", start);
  if (start < 0 || end < start) {
    return prompt;
  }
  const catalog = prompt.slice(start, end);
  const render = (maxChars: number) =>
    prompt.slice(0, start) +
    catalog.replace(
      /<description>([\s\S]*?)<\/description>/gu,
      (_match, description: string) =>
        `<description>${escapeSkillXml(truncateSkillDescription(decodeSkillXml(description), maxChars))}</description>`,
    ) +
    prompt.slice(end);
  // Names, mapped locations and loading notes are an identity floor, not optional prose.
  // Keep a short matching description even when that floor exceeds the model's share.
  let lo = 64;
  let hi = COMPACT_DESCRIPTION_MAX_CHARS;
  let result = render(lo);
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const candidate = render(mid);
    if (candidate.length <= targetChars) {
      result = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result.length < prompt.length ? result : prompt;
}

function formatSkillCatalog(
  skills: Skill[],
  loadingInstructions: string,
  descriptionForSkill: (skill: Skill) => string | undefined,
): string {
  if (skills.length === 0) {
    return "";
  }
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    loadingInstructions,
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeSkillXml(skill.name)}</name>`);
    const description = descriptionForSkill(skill);
    if (description !== undefined) {
      lines.push(`    <description>${escapeSkillXml(description)}</description>`);
    }
    lines.push(`    <location>${escapeSkillXml(skill.filePath)}</location>`);
    if (skill.locationNote) {
      lines.push(`    <location_note>${escapeSkillXml(skill.locationNote)}</location_note>`);
    }
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

/** Render the full catalog without importing the session runtime or reapplying visibility. */
export function formatSkillsForPromptCore(skills: Skill[]): string {
  return formatSkillCatalog(
    skills,
    "Read a skill's file at its listed location when the task matches its description.",
    (skill) => skill.description,
  );
}

/** Compact prompt catalog with descriptions bounded independently from identities. */
export function formatSkillsCompactForPrompt(
  skills: Skill[],
  opts?: { descriptionMaxChars?: number },
): string {
  if (skills.length === 0) {
    return "";
  }
  const descriptionMaxChars = Math.max(
    0,
    Math.floor(opts?.descriptionMaxChars ?? COMPACT_DESCRIPTION_MAX_CHARS),
  );
  return formatSkillCatalog(
    skills,
    descriptionMaxChars > 0
      ? "Read a skill's file at its listed location when the task matches its name or description."
      : "Read a skill's file at its listed location when the task matches its name.",
    (skill) =>
      descriptionMaxChars > 0
        ? truncateSkillDescription(skill.description, descriptionMaxChars) || undefined
        : undefined,
  );
}
