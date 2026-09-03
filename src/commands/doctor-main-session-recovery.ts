import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { transitionMainSessionRecovery } from "../agents/main-session-recovery/main-session-recovery-state.js";
import type { InternalSessionEntry, SessionEntry } from "../config/sessions.js";
import {
  applySessionEntryReplacements,
  iterateDoctorSessionKeyBatches,
} from "../config/sessions/session-accessor.js";

export type MainSessionRecoveryIntegrityCandidate = {
  clearStaleAbort: boolean;
  key: string;
  reason: string;
};

type MainSessionRecoveryDoctorParams = {
  storePath: string;
  wedged: MainSessionRecoveryIntegrityCandidate[];
  warnings: string[];
  changes: string[];
  confirmRepair: (params: { message: string; initialValue?: boolean }) => Promise<boolean>;
  countLabel: (count: number, singular: string, plural?: string) => string;
};

export function inspectMainSessionRecoveryEntry(
  key: string,
  entry: SessionEntry,
): MainSessionRecoveryIntegrityCandidate | undefined {
  const internalEntry = entry as InternalSessionEntry;
  const tombstone = internalEntry.mainRestartRecovery?.tombstone;
  return tombstone
    ? {
        clearStaleAbort: internalEntry.abortedLastRun === true,
        key,
        reason:
          tombstone.reason.trim() || "main-session restart recovery is tombstoned for this session",
      }
    : undefined;
}

export async function noteMainSessionRecoveryIntegrity(
  params: MainSessionRecoveryDoctorParams,
): Promise<void> {
  const { wedged } = params;
  if (wedged.length === 0) {
    return;
  }

  const wedgedCount = params.countLabel(wedged.length, "wedged main session");
  params.warnings.push(
    [
      `- Found ${wedgedCount} with automatic restart recovery tombstoned.`,
      "  OpenClaw will not auto-resume these sessions again; inspect the failed turn, then use /new or reset to replace the session.",
      `  Examples: ${wedged
        .slice(0, 3)
        .map(({ key }) => key)
        .join(", ")}`,
    ].join("\n"),
  );

  const visibleReasons = uniqueStrings(wedged.map(({ reason }) => reason)).slice(0, 2);
  if (visibleReasons.length > 0) {
    params.warnings.push(visibleReasons.map((reason) => `  Reason: ${reason}`).join("\n"));
  }

  const staleAborted = wedged.filter(({ clearStaleAbort }) => clearStaleAbort);
  if (staleAborted.length === 0) {
    return;
  }
  const staleCount = params.countLabel(staleAborted.length, "wedged main session");
  if (
    !(await params.confirmRepair({
      message: `Clear stale aborted recovery flags for ${staleCount}?`,
      initialValue: true,
    }))
  ) {
    return;
  }

  const repairedAt = Date.now();
  // Revalidate under the writer lock because session state can change while Doctor prompts.
  let repaired = 0;
  for (const sessionKeys of iterateDoctorSessionKeyBatches(staleAborted.map(({ key }) => key))) {
    repaired += await applySessionEntryReplacements<number>({
      consumePendingReset: true,
      sessionKeys,
      storePath: params.storePath,
      update: (currentEntries) => {
        const replacements = currentEntries.flatMap(({ sessionKey, entry }) => {
          const transition = transitionMainSessionRecovery(entry, {
            kind: "doctor_repair",
            now: repairedAt,
          });
          return transition.kind === "doctor_repaired" ? [{ sessionKey, entry }] : [];
        });
        return { replacements, result: replacements.length };
      },
    });
  }
  if (repaired > 0) {
    params.changes.push(
      `- Cleared aborted restart-recovery flags for ${params.countLabel(repaired, "wedged main session")}.`,
    );
  }
}
