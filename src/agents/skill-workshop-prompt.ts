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
    "Used skill proved wrong or incomplete: call `skill_workshop` read, then patch it now; the configured autonomous mode disables repair, leaves it pending, or applies it immediately. Capture only durable, evidenced procedure changes—never task artifacts, transient failures, or unresolved guesses.",
    "Other generated work = pending proposal. Apply/reject/quarantine only explicit user ask.",
    "proposal_content = complete final skill body, never plan/diff; update/revise preserves unchanged content.",
    "",
  ];
}
