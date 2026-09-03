import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ChatGoalDraftMode } from "./chat-types.ts";

/** Browser drafts keep their interpretation with their text, including after reload. */
export function isChatGoalDraftMode(value: unknown): value is ChatGoalDraftMode {
  if (!isRecord(value) || (value.sessionId !== undefined && typeof value.sessionId !== "string")) {
    return false;
  }
  const allowed =
    value.action === "start"
      ? ["action", "sessionId"]
      : ["action", "sessionId", "goalId", "previousDraft"];
  return (
    Object.keys(value).every((key) => allowed.includes(key)) &&
    (value.action === "start" ||
      (value.action === "edit" &&
        typeof value.goalId === "string" &&
        value.goalId.length > 0 &&
        typeof value.previousDraft === "string"))
  );
}
