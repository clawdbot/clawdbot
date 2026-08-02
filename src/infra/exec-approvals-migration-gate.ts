// Blocks runtime use while retired exec approval state still awaits Doctor import.
import fs from "node:fs";
import path from "node:path";
import { resolveExecApprovalsPath } from "./exec-approvals-config.js";

const DOCTOR_CLAIM_SUFFIX = ".doctor-importing";
const legacyPresenceCache = new Map<string, boolean>();

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

function pathMayExist(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** Refuse runtime access until Doctor owns the one-time legacy import. */
export function assertNoPendingLegacyExecApprovals(
  options: { pathMayExist?: (filePath: string) => boolean } = {},
): void {
  const sourcePath = resolveExecApprovalsPath();
  let hasLegacy = legacyPresenceCache.get(sourcePath);
  if (hasLegacy === undefined) {
    const probe = options.pathMayExist ?? pathMayExist;
    // Bound both Doctor rename directions: source -> claim and claim -> source.
    const sourceBefore = probe(sourcePath);
    const claim = probe(`${sourcePath}${DOCTOR_CLAIM_SUFFIX}`);
    const sourceAfter = probe(sourcePath);
    hasLegacy = sourceBefore || claim || sourceAfter;
    legacyPresenceCache.set(sourcePath, hasLegacy);
  }
  if (hasLegacy) {
    throw new ExecApprovalsMigrationRequiredError(sourcePath);
  }
}

/** Forget one process-local legacy probe after Doctor resolves the source. */
export function resetLegacyExecApprovalsPresenceCache(env: NodeJS.ProcessEnv = process.env): void {
  legacyPresenceCache.delete(resolveExecApprovalsPath(env));
}

export function resetExecApprovalsMigrationGateForTest(): void {
  legacyPresenceCache.clear();
}
