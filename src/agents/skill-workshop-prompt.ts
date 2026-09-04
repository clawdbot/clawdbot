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
    "Used skill proved wrong or incomplete: read it and follow the available tool's publication and autonomous policy. Where supported, autonomous mode may disable repair, stage a proposal, or apply it. Without an applicable autonomous policy, unsolicited improvements stay pending proposals when supported; otherwise describe the suggestion without publishing. Capture only durable, evidenced procedure changes—never task artifacts, transient failures, or unresolved guesses.",
    "Publication-only create/update requires an explicit user request; never present it as a pending draft. Apply/reject/quarantine only explicit user ask.",
    "proposal_content = complete final skill body, never plan/diff; update/revise preserves unchanged content.",
    "",
  ];
}
