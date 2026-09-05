// Apply-body validation rejects malformed proposal bodies before any workspace
// mutation or rollback recording. Lives here so apply-transition.ts stays under
// its line budget and the validator is independently testable.
//
// This validator enforces structural completeness only (non-empty body, valid
// frontmatter with name and description). It deliberately does NOT restrict
// which Markdown headings a skill body may use — the skill loader accepts
// free-form Markdown after valid frontmatter, and heading-based heuristics
// cannot reliably distinguish plan documents from valid skills without
// rejecting legitimate content. Plan-document prevention is owned by the
// generation-side prompt contract (PR #108339); this apply-side check is
// defense-in-depth for structural integrity.
import { extractFrontmatterBlock } from "../../../packages/markdown-core/src/frontmatter.js";
import { parseSkillFrontmatter } from "../loading/frontmatter.js";

export function validateApplyBody(skillContent: string): void {
  const extracted = extractFrontmatterBlock(skillContent);
  const body = extracted?.body ?? skillContent;
  if (body.trim().length === 0) {
    throw new Error(
      "Skill proposal body is empty after stripping frontmatter. The proposal must contain complete skill content.",
    );
  }
  let parsed: Record<string, string>;
  try {
    parsed = parseSkillFrontmatter(skillContent);
  } catch {
    throw new Error(
      "Skill proposal body does not contain valid SKILL.md frontmatter. The proposal must be complete skill content with valid YAML frontmatter (name, description).",
    );
  }
  const name = parsed["name"];
  if (!name || name.trim().length === 0) {
    throw new Error(
      "Skill proposal frontmatter must include a non-empty name field. The proposal must be complete skill content.",
    );
  }
  const description = parsed["description"];
  if (!description || description.trim().length === 0) {
    throw new Error(
      "Skill proposal frontmatter must include a non-empty description field. The proposal must be complete skill content.",
    );
  }
}
