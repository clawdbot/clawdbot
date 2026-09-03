import type { UpdateRunResult } from "../../infra/update-runner.js";
import { formatCliCommand } from "../command-format.js";

type UnsafeUpdateRecovery = Extract<
  NonNullable<UpdateRunResult["recovery"]>,
  { serviceRestartSafe: false }
>;

export function resolveUnsafeUpdateRecoveryGuidance(
  reason?: UnsafeUpdateRecovery["reason"],
): string {
  const triageCommand = formatCliCommand("openclaw triage");
  const guidance = `Run \`${triageCommand}\` on this machine to open a coding agent that can diagnose and repair the installation.`;
  if (reason === "state-migration-started") {
    return `${guidance} Candidate Doctor may have migrated state; keep the candidate installed and do not roll back code alone.`;
  }
  return guidance;
}
