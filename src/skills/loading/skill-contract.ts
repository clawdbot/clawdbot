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
  /** Runtime-only content for non-filesystem skill locators such as node://. */
  readContent?: string;
  filePath: string;
  baseDir: string;
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
  return heading || humanizeSkillIdentifier(fallbackName) || fallbackName;
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

/**
 * Keep this formatter's XML layout byte-for-byte aligned with the upstream
 * Agent Skills formatter so we can avoid importing the full session runtime
 * package root on the cold skills path. Visibility policy is applied upstream
 * before calling this helper.
 */
export function formatSkillsForPromptCore(skills: Skill[]): string {
  if (skills.length === 0) {
    return "";
  }
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeSkillXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeSkillXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeSkillXml(skill.filePath)}</location>`);
    if (skill.locationNote) {
      lines.push(`    <location_note>${escapeSkillXml(skill.locationNote)}</location_note>`);
    }
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
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
  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    descriptionMaxChars > 0
      ? "Use the read tool to load a skill's file when the task matches its name or description."
      : "Use the read tool to load a skill's file when the task matches its name.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "<available_skills>",
  ];
  for (const skill of skills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeSkillXml(skill.name)}</name>`);
    if (descriptionMaxChars > 0) {
      const description = truncateSkillDescription(skill.description, descriptionMaxChars);
      if (description) {
        lines.push(`    <description>${escapeSkillXml(description)}</description>`);
      }
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
