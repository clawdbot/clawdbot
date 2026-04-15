import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

export function hasModelSwitchContinuityEvidence(text: string) {
  const lower = normalizeLowercaseStringOrEmpty(text);
  const mentionsHandoff =
    lower.includes("handoff") || lower.includes("model switch") || lower.includes("switched");
  const mentionsKickoffTask =
    lower.includes("qa_kickoff_task") ||
    lower.includes("qa/scenarios/index.md") ||
    lower.includes("scenario pack") ||
    lower.includes("kickoff task") ||
    lower.includes("kickoff note") ||
    lower.includes("qa mission") ||
    (lower.includes("source and docs") &&
      lower.includes("qa-channel scenarios") &&
      lower.includes("worked") &&
      lower.includes("blocked") &&
      lower.includes("follow-up"));
  const hasScopeLeak =
    lower.includes("subagent-handoff") ||
    lower.includes("delegated task") ||
    lower.includes("final qa tally") ||
    lower.includes("qa run complete") ||
    lower.includes("all mandatory scenarios");
  const looksOverlong =
    text.length > 280 || text.includes("\n\n") || text.includes("|---") || text.includes("### ");
  return mentionsHandoff && mentionsKickoffTask && !hasScopeLeak && !looksOverlong;
}
