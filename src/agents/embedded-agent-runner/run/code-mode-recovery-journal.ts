import type { NestedToolActivity } from "../../../sessions/nested-tool-activity.js";
import type { ToolEffectReceipt } from "../../tool-effect-receipt.js";

export type CodeModeRecoveryJournalEntry = {
  actionKey: string;
  effectState: ToolEffectReceipt["state"];
};

const recoveryFacts = new WeakMap<NestedToolActivity, CodeModeRecoveryJournalEntry>();

/** Bind host-only execution facts to the nested activity recorded for that exact call. */
export function registerCodeModeRecoveryJournalEntry(
  activity: NestedToolActivity,
  entry: CodeModeRecoveryJournalEntry,
): void {
  recoveryFacts.set(activity, entry);
}

export function readCodeModeRecoveryJournalEntry(
  activity: NestedToolActivity,
): CodeModeRecoveryJournalEntry | undefined {
  return recoveryFacts.get(activity);
}
