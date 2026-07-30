import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { inspectMainSessionRecoveryHealth } from "../agents/main-session-recovery-lifecycle.js";
import { transitionMainSessionRecovery } from "../agents/main-session-recovery-state.js";
import {
  applySessionEntryReplacements,
  listSessionEntries,
} from "../config/sessions/session-accessor.js";

type MainSessionRecoveryDoctorParams = {
  agentId: string;
  storePath: string;
  warnings: string[];
  changes: string[];
  confirmRepair: (params: { message: string; initialValue?: boolean }) => Promise<boolean>;
  countLabel: (count: number, singular: string, plural?: string) => string;
};

export async function noteMainSessionRecoveryIntegrity(
  params: MainSessionRecoveryDoctorParams,
): Promise<number> {
  const entries = listSessionEntries({ agentId: params.agentId, storePath: params.storePath });
  const wedged = entries.flatMap(({ entry, sessionKey }) => {
    const health = inspectMainSessionRecoveryHealth(entry);
    return health.status === "tombstoned" ? [{ key: sessionKey, health }] : [];
  });
  if (wedged.length === 0) {
    return entries.length;
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

  const visibleReasons = uniqueStrings(wedged.map(({ health }) => health.reason)).slice(0, 2);
  if (visibleReasons.length > 0) {
    params.warnings.push(visibleReasons.map((reason) => `  Reason: ${reason}`).join("\n"));
  }

  const staleAborted = wedged.filter(({ health }) => health.repair === "clear_stale_abort");
  if (staleAborted.length === 0) {
    return entries.length;
  }
  const staleCount = params.countLabel(staleAborted.length, "wedged main session");
  if (
    !(await params.confirmRepair({
      message: `Clear stale aborted recovery flags for ${staleCount}?`,
      initialValue: true,
    }))
  ) {
    return entries.length;
  }

  const repairedAt = Date.now();
  // Revalidate under the writer lock because session state can change while Doctor prompts.
  const repaired = await applySessionEntryReplacements<number>({
    sessionKeys: staleAborted.map(({ key }) => key),
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
  if (repaired > 0) {
    params.changes.push(
      `- Cleared aborted restart-recovery flags for ${params.countLabel(repaired, "wedged main session")}.`,
    );
  }
  return entries.length;
}
