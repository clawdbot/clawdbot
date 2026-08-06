/**
 * System-prompt contribution for routing durable skill edits through the
 * Skill Workshop tool instead of direct filesystem writes.
 */
export const SKILL_WORKSHOP_TOOL_NAME = "skill_workshop";

/** Build the system-prompt section for Skill Workshop routing rules. */
export function buildSkillWorkshopPromptSection(): string[] {
  return [
    "## Skill Workshop",
    "Durable reusable skill/playbook/workflow work: `skill_workshop`; never write proposal/skill files directly.",
    "Generated = pending proposal. Apply/reject/quarantine only explicit user ask.",
    "proposal_content = complete final skill body, never plan/diff; update/revise preserves unchanged content.",
    "",
  ];
}
