/** Doctor-owned migration from workspace HEARTBEAT.md files into cron job scratch. */
import fs from "node:fs/promises";
import path from "node:path";
import { TextDecoder } from "node:util";
import { note } from "../../packages/terminal-core/src/note.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { DEFAULT_HEARTBEAT_FILENAME } from "../agents/workspace.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CRON_JOB_SCRATCH_MAX_BYTES } from "../cron/scratch-contract.js";
import {
  deleteCronJobScratch,
  hashCronScratchSource,
  readCronJobScratchState,
  writeCronJobScratch,
} from "../cron/scratch-store.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import type { CronJob } from "../cron/types.js";
import type { HealthFinding } from "../flows/health-checks.js";
import { resolveHeartbeatAgents } from "../infra/heartbeat-runner.js";
import { isPathInside } from "../infra/path-guards.js";
import { readRegularFile } from "../infra/regular-file.js";
import { escapeRegExp } from "../shared/regexp.js";
import { shortenHomePath } from "../utils.js";
import { ensureHeartbeatMonitorJobs } from "./doctor-heartbeat-cadence-migration.js";

const HEARTBEAT_SCRATCH_MIGRATION_CHECK_ID = "core/doctor/heartbeat-scratch-migration";
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

type HeartbeatScratchMigrationResult = {
  changes: string[];
  warnings: string[];
};

type HeartbeatSource = {
  path: string;
  /** Canonical parent directory + basename: the identity of the removable entry. */
  entryKey: string;
  content: string;
  sha256: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readHeartbeatSource(
  cfg: OpenClawConfig,
  agentId: string,
  options?: { recoverClaims?: boolean },
): Promise<HeartbeatSource | undefined> {
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const heartbeatPath = path.join(workspaceDir, DEFAULT_HEARTBEAT_FILENAME);
  let sourceStat;
  try {
    sourceStat = await fs.lstat(heartbeatPath);
    // A claim sibling next to an existing canonical file means an interrupted
    // migration raced a recreation. Neither copy is provably authoritative, so
    // stop instead of migrating one and silently resurrecting the other later.
    const orphanClaim = await findStaleHeartbeatClaim(heartbeatPath);
    if (orphanClaim) {
      throw new Error(
        `both ${heartbeatPath} and an interrupted migration claim at ${orphanClaim} exist; reconcile them manually before rerunning doctor`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    // Crash recovery: a killed run can leave the only copy at a claim path
    // after the rename but before scratch release. Surface it here so both
    // findings and repair see the interrupted migration instead of "no file".
    const staleClaim = await findStaleHeartbeatClaim(heartbeatPath);
    if (!staleClaim) {
      return undefined;
    }
    if (!options?.recoverClaims) {
      throw new Error(
        `an interrupted migration claim exists at ${staleClaim}; run openclaw doctor --fix to restore it`,
        { cause: error },
      );
    }
    await restoreClaimNoClobber(staleClaim, heartbeatPath);
    sourceStat = await fs.lstat(heartbeatPath);
  }
  if (!sourceStat.isFile() && !sourceStat.isSymbolicLink()) {
    throw new Error("HEARTBEAT.md must be a regular file or contained symlink");
  }
  if (sourceStat.isFile() && sourceStat.nlink > 1) {
    throw new Error("HEARTBEAT.md has multiple hard links; refusing automatic removal");
  }

  const workspaceRealPath = await fs.realpath(workspaceDir);
  const sourceRealPath = await fs.realpath(heartbeatPath);
  if (sourceRealPath !== workspaceRealPath && !isPathInside(workspaceRealPath, sourceRealPath)) {
    throw new Error("HEARTBEAT.md symlink target escapes the agent workspace");
  }
  const file = await readRegularFile({
    filePath: sourceRealPath,
    maxBytes: CRON_JOB_SCRATCH_MAX_BYTES,
  });
  let content: string;
  try {
    content = utf8Decoder.decode(file.buffer);
  } catch {
    throw new Error("HEARTBEAT.md is not valid UTF-8");
  }
  return {
    path: heartbeatPath,
    entryKey: path.join(workspaceRealPath, DEFAULT_HEARTBEAT_FILENAME),
    content,
    sha256: hashCronScratchSource(content),
  };
}

function archivePathForSource(agentId: string, sha256: string, env: NodeJS.ProcessEnv): string {
  const safeAgentId = agentId.replace(/[^A-Za-z0-9._-]+/g, "-");
  return path.join(
    resolveStateDir(env),
    "backups",
    "heartbeat-migration",
    `${safeAgentId}-${sha256}.md`,
  );
}

type HeartbeatSourceClaim = {
  claimPath: string;
  restore(cause: unknown): Promise<void>;
  release(params: { archivePath: string }): Promise<void>;
};

const HEARTBEAT_CLAIM_INFIX = ".doctor-importing-";
const HEARTBEAT_CLAIM_CHANGED_ERROR = "HeartbeatClaimChangedError";

/** Interrupted-claim sibling for a missing canonical heartbeat path. */
async function findStaleHeartbeatClaim(heartbeatPath: string): Promise<string | undefined> {
  const dir = path.dirname(heartbeatPath);
  // Match the exact generated claim shape so an unrelated user file that
  // merely shares the prefix is never consumed by recovery.
  const claimPattern = new RegExp(
    `^${escapeRegExp(path.basename(heartbeatPath))}${escapeRegExp(HEARTBEAT_CLAIM_INFIX)}\\d+-[0-9a-f]{12}$`,
  );
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return undefined;
  }
  const claims = entries.filter((entry) => claimPattern.test(entry));
  if (claims.length > 1) {
    throw new Error(
      `multiple interrupted migration claims exist for ${heartbeatPath}; remove or restore the stale .doctor-importing-* files manually`,
    );
  }
  const claim = claims[0];
  if (!claim) {
    return undefined;
  }
  // The claim name embeds the owning PID. A live owner means another doctor
  // run is mid-migration; stealing its claim could delete both copies.
  const ownerPid = Number(
    claim
      .slice(claim.lastIndexOf(HEARTBEAT_CLAIM_INFIX) + HEARTBEAT_CLAIM_INFIX.length)
      .split("-")[0],
  );
  if (Number.isSafeInteger(ownerPid) && ownerPid !== process.pid && isProcessAlive(ownerPid)) {
    throw new Error(
      `a migration claim for ${heartbeatPath} is held by running process ${ownerPid}; wait for that doctor run to finish`,
    );
  }
  return path.join(dir, claim);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is not signalable by this user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Restore a claim without clobbering: `link` fails with EEXIST when another
 * process recreated the destination while we held the claim, so both files
 * survive (the recreation in place, the claimed original at a conflict path).
 */
async function restoreClaimNoClobber(claimPath: string, destinationPath: string): Promise<void> {
  try {
    await fs.link(claimPath, destinationPath);
    await fs.unlink(claimPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const conflictPath = `${claimPath}.conflict-${Date.now()}`;
    await fs.rename(claimPath, conflictPath);
    throw new Error(
      `HEARTBEAT.md was recreated during migration; the claimed original is preserved at ${conflictPath}`,
      { cause: error },
    );
  }
}

/**
 * Move the source aside and prove the claimed bytes still match what was read.
 * The claim happens before any scratch write so a concurrent edit can never
 * leave stale content committed while the replacement file is restored.
 */
async function claimHeartbeatSource(source: HeartbeatSource): Promise<HeartbeatSourceClaim> {
  const claimPath = `${source.path}${HEARTBEAT_CLAIM_INFIX}${process.pid}-${source.sha256.slice(0, 12)}`;
  await fs.rename(source.path, claimPath);
  const restore = async (cause: unknown) => {
    await restoreClaimNoClobber(claimPath, source.path).catch((restoreError: unknown) => {
      throw restoreError instanceof Error && restoreError.message.includes("preserved at")
        ? restoreError
        : new Error(`HEARTBEAT.md migration claim could not be restored from ${claimPath}`, {
            cause: cause ?? restoreError,
          });
    });
  };
  try {
    const workspaceRealPath = await fs.realpath(path.dirname(source.path));
    const claimRealPath = await fs.realpath(claimPath);
    if (claimRealPath !== workspaceRealPath && !isPathInside(workspaceRealPath, claimRealPath)) {
      throw new Error("claimed HEARTBEAT.md target escapes the agent workspace");
    }
    const claimed = await readRegularFile({
      filePath: claimRealPath,
      maxBytes: CRON_JOB_SCRATCH_MAX_BYTES,
    });
    const claimedContent = utf8Decoder.decode(claimed.buffer);
    if (hashCronScratchSource(claimedContent) !== source.sha256) {
      throw new Error("HEARTBEAT.md changed before the migration claim was acquired");
    }
  } catch (error) {
    await restore(error);
    throw error;
  }
  return {
    claimPath,
    restore,
    release: async ({ archivePath }) => {
      // Every verification failure here means "do not trust the import":
      // restore the claim and tag the error so the caller rolls scratch back.
      const failChanged = async (message: string, cause?: unknown): Promise<never> => {
        const error = new Error(message, cause !== undefined ? { cause } : undefined);
        error.name = HEARTBEAT_CLAIM_CHANGED_ERROR;
        await restore(error).catch(() => undefined);
        throw error;
      };
      // A holder of an already-open descriptor can still mutate the claimed
      // inode; re-verify the bytes so release never deletes an unseen edit.
      // The claim may itself be a contained symlink (renaming a symlink keeps
      // it a symlink), so resolve and containment-check it like the claim did.
      let finalContent: string;
      try {
        const workspaceRealPath = await fs.realpath(path.dirname(source.path));
        const claimRealPath = await fs.realpath(claimPath);
        if (
          claimRealPath !== workspaceRealPath &&
          !isPathInside(workspaceRealPath, claimRealPath)
        ) {
          throw new Error("claimed HEARTBEAT.md target escapes the agent workspace");
        }
        const finalBytes = await readRegularFile({
          filePath: claimRealPath,
          maxBytes: CRON_JOB_SCRATCH_MAX_BYTES,
        });
        finalContent = utf8Decoder.decode(finalBytes.buffer);
      } catch (error) {
        await failChanged("claimed HEARTBEAT.md could not be re-verified before removal", error);
        throw error;
      }
      if (hashCronScratchSource(finalContent) !== source.sha256) {
        await failChanged("HEARTBEAT.md changed while the migration claim was held");
      }
      // An editor atomic-save can recreate the original path while the claim
      // is held. That recreation is the newest instruction set; treat it like
      // a changed claim so the import rolls back instead of shadowing it.
      let recreated: boolean;
      try {
        await fs.lstat(source.path);
        recreated = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          await failChanged(
            "could not verify the original HEARTBEAT.md path before removal",
            error,
          );
        }
        recreated = false;
      }
      if (recreated) {
        await failChanged("HEARTBEAT.md was recreated while the migration claim was held");
      }
      // Retire the claim by moving the inode into the archive instead of
      // unlinking it: a writer holding an open descriptor that lands a write
      // after the hash check above still writes into the preserved archive
      // file, never into a deleted inode.
      const claimStat = await fs.lstat(claimPath);
      if (claimStat.isSymbolicLink()) {
        // The removable entry is the symlink itself; its target file stays in
        // the workspace, so no open-descriptor write can be lost here.
        await fs.unlink(claimPath);
        return;
      }
      try {
        await fs.rename(claimPath, archivePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
          throw error;
        }
        // Cross-device archive: the pre-written archive copy already holds the
        // verified bytes. Accepted tradeoff: the unlink below reopens the
        // microsecond open-descriptor window only when workspace and state dir
        // sit on different filesystems.
        await fs.unlink(claimPath);
      }
    },
  };
}

async function archiveSource(params: {
  agentId: string;
  source: HeartbeatSource;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const archivePath = archivePathForSource(params.agentId, params.source.sha256, params.env);
  await fs.mkdir(path.dirname(archivePath), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(archivePath, params.source.content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
    const existing = await fs.readFile(archivePath, "utf8");
    if (hashCronScratchSource(existing) !== params.source.sha256) {
      throw new Error(`heartbeat migration archive collision at ${archivePath}`, { cause: error });
    }
  }
}

function migrationFinding(params: {
  agentId: string;
  path: string;
  requirement: string;
  message: string;
  severity?: HealthFinding["severity"];
}): HealthFinding {
  return {
    checkId: HEARTBEAT_SCRATCH_MIGRATION_CHECK_ID,
    severity: params.severity ?? "warning",
    message: params.message,
    path: params.path,
    target: params.agentId,
    requirement: params.requirement,
    fixHint: `Run ${formatCliCommand("openclaw doctor --fix")} to migrate HEARTBEAT.md into cron scratch.`,
  };
}

/** Reports remaining workspace heartbeat files without changing them. */
export async function collectHeartbeatScratchMigrationFindings(
  cfg: OpenClawConfig,
): Promise<readonly HealthFinding[]> {
  const findings: HealthFinding[] = [];
  for (const agent of resolveHeartbeatAgents(cfg)) {
    const heartbeatPath = path.join(
      resolveAgentWorkspaceDir(cfg, agent.agentId),
      DEFAULT_HEARTBEAT_FILENAME,
    );
    try {
      const source = await readHeartbeatSource(cfg, agent.agentId);
      if (!source) {
        continue;
      }
      findings.push(
        migrationFinding({
          agentId: agent.agentId,
          path: heartbeatPath,
          requirement: "legacy-heartbeat-file",
          message: `Agent "${agent.agentId}" still stores heartbeat instructions in HEARTBEAT.md.`,
        }),
      );
    } catch (error) {
      findings.push(
        migrationFinding({
          agentId: agent.agentId,
          path: heartbeatPath,
          requirement: "heartbeat-file-migration-blocked",
          severity: "error",
          message: `Agent "${agent.agentId}" HEARTBEAT.md cannot be migrated: ${errorMessage(error)}`,
        }),
      );
    }
  }
  return findings;
}

/** Migrates each enrolled agent's heartbeat file into its stable monitor job. */
export async function maybeMigrateHeartbeatFilesToScratch(params: {
  cfg: OpenClawConfig;
  shouldRepair: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<HeartbeatScratchMigrationResult> {
  const env = params.env ?? process.env;
  const storePath = resolveCronJobsStorePathFromConfig(params.cfg, env);
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!params.shouldRepair) {
    for (const agent of resolveHeartbeatAgents(params.cfg)) {
      try {
        const source = await readHeartbeatSource(params.cfg, agent.agentId);
        if (source) {
          note(
            `${shortenHomePath(source.path)} will migrate into scratch for Heartbeat (${agent.agentId}).`,
            "Heartbeat migration preview",
          );
        }
      } catch (error) {
        warnings.push(
          `Agent "${agent.agentId}" HEARTBEAT.md cannot be migrated: ${errorMessage(error)}`,
        );
      }
    }
    if (warnings.length > 0) {
      note(warnings.join("\n"), "Doctor warnings");
    }
    return { changes, warnings };
  }

  let monitors: Map<string, CronJob>;
  try {
    monitors = await ensureHeartbeatMonitorJobs(params.cfg, storePath, env);
  } catch (error) {
    return {
      changes,
      warnings: [`Could not prepare heartbeat monitor jobs: ${errorMessage(error)}`],
    };
  }

  // Agents can share one workspace file. Group monitors by source path and
  // import into every monitor before the file is archived and removed once, so
  // the first agent's cleanup cannot starve its siblings.
  const groups = new Map<string, { source: HeartbeatSource; agents: [string, CronJob][] }>();
  for (const [agentId, monitor] of monitors) {
    let source: HeartbeatSource | undefined;
    try {
      source = await readHeartbeatSource(params.cfg, agentId, { recoverClaims: true });
    } catch (error) {
      warnings.push(`Agent "${agentId}" HEARTBEAT.md was not migrated: ${errorMessage(error)}`);
      continue;
    }
    if (!source) {
      continue;
    }
    // Group by the directory entry being removed (canonical parent directory +
    // basename), not its resolved file target: two distinct symlinks pointing
    // at one shared file are each claimed and removed, while agents reaching
    // the same workspace through path aliases dedupe onto one entry.
    const group = groups.get(source.entryKey) ?? { source, agents: [] };
    group.agents.push([agentId, monitor]);
    groups.set(source.entryKey, group);
  }

  for (const { source, agents } of groups.values()) {
    // Precondition pass first: operator-owned scratch (different content or an
    // explicit unset tombstone) blocks the whole group before the file is
    // touched, so nothing is claimed or committed for a source that must stay.
    // The revision seen here is also the CAS token for the later write, so a
    // concurrent edit in between surfaces as a conflict, never an overwrite.
    let blocked = false;
    const plannedRevisionByJobId = new Map<string, number>();
    for (const [agentId, monitor] of agents) {
      const state = readCronJobScratchState(storePath, monitor.id, { env });
      const current = state.scratch;
      plannedRevisionByJobId.set(monitor.id, state.currentRevision);
      if (state.currentRevision > 0 && !current) {
        warnings.push(
          `Agent "${agentId}" scratch was explicitly unset; ${shortenHomePath(source.path)} was left unchanged.`,
        );
        blocked = true;
      } else if (
        current &&
        current.content !== source.content &&
        current.sourceSha256 !== source.sha256
      ) {
        warnings.push(
          `Agent "${agentId}" already has different cron scratch; ${shortenHomePath(source.path)} was left unchanged.`,
        );
        blocked = true;
      }
    }
    if (blocked) {
      continue;
    }

    // Archive before the claim rename: if doctor dies mid-claim, the content is
    // already durable under the state backups instead of only at a hidden
    // .doctor-importing-* path nothing rescans.
    try {
      await archiveSource({ agentId: agents[0]![0], source, env });
    } catch (error) {
      warnings.push(
        `${shortenHomePath(source.path)} was not migrated: ${errorMessage(error)}. Rerun doctor to retry safely.`,
      );
      continue;
    }

    // Claim before committing: once the file is renamed aside and hash-verified,
    // no concurrent editor can change the bytes that reach scratch, and a claim
    // failure restores the file with nothing committed.
    let claim: HeartbeatSourceClaim;
    try {
      claim = await claimHeartbeatSource(source);
    } catch (error) {
      warnings.push(
        `${shortenHomePath(source.path)} was not migrated: ${errorMessage(error)}. Rerun doctor to retry safely.`,
      );
      continue;
    }

    let importedAll = true;
    const groupChanges: string[] = [];
    const committedThisRun: Array<{
      agentId: string;
      monitor: CronJob;
      previous: ReturnType<typeof readCronJobScratchState>["scratch"];
      newRevision: number;
    }> = [];
    for (const [agentId, monitor] of agents) {
      try {
        const state = readCronJobScratchState(storePath, monitor.id, { env });
        if (state.scratch?.sourceSha256 !== source.sha256) {
          const write = writeCronJobScratch({
            storePath,
            jobId: monitor.id,
            content: source.content,
            expectedRevision: plannedRevisionByJobId.get(monitor.id) ?? state.currentRevision,
            sourceSha256: source.sha256,
            options: { env },
          });
          if (!write.ok) {
            throw new Error("scratch changed during migration");
          }
          committedThisRun.push({
            agentId,
            monitor,
            previous: state.scratch,
            newRevision: write.currentRevision,
          });
        }
        const verified = readCronJobScratchState(storePath, monitor.id, { env }).scratch;
        if (
          !verified ||
          verified.content !== source.content ||
          verified.sourceSha256 !== source.sha256
        ) {
          throw new Error("scratch verification failed after write");
        }
        groupChanges.push(
          `Migrated ${shortenHomePath(source.path)} into cron scratch for ${monitor.displayName ?? monitor.name}.`,
        );
      } catch (error) {
        warnings.push(
          `Agent "${agentId}" scratch was not finalized: ${errorMessage(error)}. Rerun doctor to retry safely.`,
        );
        importedAll = false;
      }
    }
    // The restored legacy file is authoritative again after any rollback, so
    // this run's scratch imports must revert too — otherwise those agents keep
    // serving the imported copy and ignore later edits to the restored file.
    // A monitor that had no row before must return to no-row (not a tombstone),
    // or a future migration retry treats the rolled-back import as explicitly unset.
    const rollbackCommitted = () => {
      for (const commit of committedThisRun.toReversed()) {
        if (!commit.previous) {
          // Revision-guarded atomic delete restores the pre-migration no-row
          // state so a future migration retry can import it. Accepted
          // tradeoff: this resets the revision counter to 0, so a writer still
          // holding a pre-migration expectedRevision:0 token could CAS through
          // after the rollback; that requires a third concurrent writer racing
          // doctor and is preferred over permanently blocking migration.
          const deleted = deleteCronJobScratch(
            storePath,
            commit.monitor.id,
            { env },
            {
              expectedRevision: commit.newRevision,
            },
          );
          if (!deleted) {
            warnings.push(
              `Agent "${commit.agentId}" scratch changed before the migration rollback; leaving current scratch in place.`,
            );
          }
          continue;
        }
        const revert = writeCronJobScratch({
          storePath,
          jobId: commit.monitor.id,
          content: commit.previous.content,
          expectedRevision: commit.newRevision,
          sourceSha256: commit.previous.sourceSha256,
          options: { env },
        });
        if (!revert.ok) {
          warnings.push(
            `Agent "${commit.agentId}" scratch changed before the migration rollback; leaving current scratch in place.`,
          );
        }
      }
    };
    if (!importedAll) {
      rollbackCommitted();
      try {
        await claim.restore(undefined);
      } catch (error) {
        warnings.push(errorMessage(error));
      }
      continue;
    }
    try {
      // release() re-verifies the claimed bytes; when they changed it restores
      // the newer file itself and reports HeartbeatClaimChangedError.
      await claim.release({
        archivePath: archivePathForSource(agents[0]![0], source.sha256, env),
      });
      changes.push(...groupChanges);
    } catch (error) {
      if (error instanceof Error && error.name === HEARTBEAT_CLAIM_CHANGED_ERROR) {
        // The changed file is authoritative; committed scratch must not shadow it.
        rollbackCommitted();
        warnings.push(
          `${shortenHomePath(source.path)} was not migrated: ${errorMessage(error)}. Rerun doctor to retry safely.`,
        );
        continue;
      }
      changes.push(...groupChanges);
      warnings.push(
        `${shortenHomePath(source.path)} was migrated but not removed: ${errorMessage(error)}. Rerun doctor to retry safely.`,
      );
    }
  }

  if (changes.length > 0) {
    note(changes.join("\n"), "Doctor changes");
  }
  if (warnings.length > 0) {
    note(warnings.join("\n"), "Doctor warnings");
  }
  return { changes, warnings };
}
