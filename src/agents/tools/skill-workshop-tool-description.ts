import { SKILL_AUTHORING_STANDARDS_PROMPT } from "../../skills/workshop/skill-authoring-standards.js";
import { SKILL_WORKSHOP_TOOL_DISPLAY_SUMMARY } from "../tool-description-presets.js";

export function buildSkillWorkshopToolDescription(params: {
  autonomousMode: "off" | "propose" | "auto";
  collectionOnly: boolean;
  proposalRevision: boolean;
}): string {
  if (params.proposalRevision) {
    return `Inspect and revise only the proposal revision selected by the operator. The proposal id and expected revision hash are bound by the run and cannot be replaced by tool arguments. Never apply, reject, quarantine, or create another proposal.\n\n${SKILL_AUTHORING_STANDARDS_PROMPT}`;
  }
  if (params.collectionOnly) {
    return `${SKILL_WORKSHOP_TOOL_DISPLAY_SUMMARY} Read the skills you intend to change, then finish with one reconcile call listing only writes and drops; unlisted skills stay. An empty collection records that nothing changed.\n\n${SKILL_AUTHORING_STANDARDS_PROMPT}`;
  }
  const repairPolicy =
    params.autonomousMode === "off"
      ? "Foreground repair is disabled."
      : params.autonomousMode === "propose"
        ? "A foreground patch to a skill used in this run stays pending for review."
        : "A foreground patch to a skill used in this run is scanned and applied immediately.";
  return `${SKILL_WORKSHOP_TOOL_DISPLAY_SUMMARY} Read, prepare an exact bounded patch, patch, create, update, revise, inspect, evaluate, and apply reusable-procedure skill proposals. Restore the backup retained by the last collection cleanup when the user asks to undo it. ${repairPolicy}\n\n${SKILL_AUTHORING_STANDARDS_PROMPT}`;
}
