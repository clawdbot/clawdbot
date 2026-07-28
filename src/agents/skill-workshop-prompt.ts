/**
 * System-prompt contribution for routing durable skill edits through the
 * Skill Workshop tool instead of direct filesystem writes.
 */
export const SKILL_WORKSHOP_TOOL_NAME = "skill_workshop";

/** Build the system-prompt section for Skill Workshop routing rules. */
export function buildSkillWorkshopPromptSection(
  params: { workboardAvailable: boolean } = { workboardAvailable: false },
): string[] {
  return [
    "## Skill Workshop",
    "Durable reusable skill/playbook/workflow work: `skill_workshop`; never write proposal/skill files directly.",
    "Generated = pending proposal. Apply/reject/quarantine only explicit user ask.",
    "proposal_content = complete final skill body, never plan/diff; update/revise preserves unchanged content.",
    "When the current-turn context contains `✨ SKILL OPPORTUNITY`, place that block near the top of the reply before ordinary narrative.",
    params.workboardAvailable
      ? "For a genuine opportunity, call `workboard_create` once before replying with status=todo and the supplied idempotencyKey; card creation does not create or apply a skill."
      : "For a genuine opportunity, Workboard capture is unavailable; show that failure explicitly in the opportunity block and do not imply a card exists.",
    "Never conflate a recommendation, a pending proposal, and a live skill; keep the explicit approval boundary visible.",
    "",
  ];
}
