// Blocks runtime use while retired exec approval state still awaits Doctor import.
import path from "node:path";
import { resolveExecApprovalsPath } from "./exec-approvals-config.js";
import { pathMayExistSync } from "./path-existence.js";

const DOCTOR_CLAIM_SUFFIX = ".doctor-importing";
// Doctor usually runs in another process, so cache only the steady-state absence;
// a present verdict must be re-probed on the next attempt after Doctor finishes.
const legacyAbsenceCache = new Set<string>();

/**
 * Doctor repairs whichever state directory its own environment resolves to, so a bare
 * `openclaw doctor --fix` repairs the default root while a scoped install stays blocked.
 * Name the directory whenever this process is scoped to a non-default one. Say it in
 * prose rather than as a `VAR=value cmd` one-liner, which no Windows shell accepts.
 */
function doctorFixInstruction(filePath: string): string {
  const command = "Run `openclaw doctor --fix`";
  return process.env.OPENCLAW_STATE_DIR?.trim()
    ? `${command} with OPENCLAW_STATE_DIR set to ${path.dirname(filePath)}`
    : command;
}

export class ExecApprovalsMigrationRequiredError extends Error {
  constructor(filePath: string) {
    super(
      `Legacy exec approvals exist at ${filePath}. ${doctorFixInstruction(filePath)} before using exec approvals.`,
    );
    this.name = "ExecApprovalsMigrationRequiredError";
  }
}

/** Refuse runtime access until Doctor owns the one-time legacy import. */
export function assertNoPendingLegacyExecApprovals(
  options: { pathMayExist?: (filePath: string) => boolean } = {},
): void {
  const sourcePath = resolveExecApprovalsPath();
  if (legacyAbsenceCache.has(sourcePath)) {
    return;
  }
  const probe = options.pathMayExist ?? pathMayExistSync;
  // Bound both Doctor rename directions: source -> claim and claim -> source.
  const sourceBefore = probe(sourcePath);
  const claim = probe(`${sourcePath}${DOCTOR_CLAIM_SUFFIX}`);
  const sourceAfter = probe(sourcePath);
  if (sourceBefore || claim || sourceAfter) {
    throw new ExecApprovalsMigrationRequiredError(sourcePath);
  }
  legacyAbsenceCache.add(sourcePath);
}

export function resetExecApprovalsMigrationGateForTest(): void {
  legacyAbsenceCache.clear();
}
