import { SKILL_AUTHORING_STANDARDS_PROMPT } from "../../skills/workshop/skill-authoring-standards.js";

export function buildSkillWorkshopToolDescription(params: {
  proposalOnly: boolean;
  supportsCompletion: boolean;
  updateProposals: boolean;
  autonomousMode: "off" | "propose" | "auto";
  collectionOnly: boolean;
}): string {
  if (params.collectionOnly) {
    return `Read every current writable skill, then replace the collection with one reconcile call. Every current skill needs exactly one keep, write, or drop decision.\n\n${SKILL_AUTHORING_STANDARDS_PROMPT}`;
  }
  if (!params.proposalOnly) {
    const repairPolicy =
      params.autonomousMode === "off"
        ? "Foreground repair is disabled."
        : params.autonomousMode === "propose"
          ? "A foreground patch to a skill used in this run stays pending for review."
          : "A foreground patch to a skill used in this run is scanned and applied immediately.";
    return `Read, patch, create, update, revise, inspect, evaluate, and apply reusable-procedure skill proposals. Restore the backup retained by the last collection cleanup when the user asks to undo it. ${repairPolicy}\n\n${SKILL_AUTHORING_STANDARDS_PROMPT}`;
  }
  const completion = params.supportsCompletion ? " complete = durably finish this review." : "";
  const draftKinds = params.updateProposals ? "create, update, or revise" : "create or revise";
  return `Inspect reusable-procedure skill proposals and draft pending ${draftKinds} proposals.${completion} Nothing writes a live skill directly; lifecycle actions are unavailable.\n\n${SKILL_AUTHORING_STANDARDS_PROMPT}`;
}
