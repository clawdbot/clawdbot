import fs from "node:fs/promises";
import path from "node:path";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { canonicalizePath } from "../../agents/utils/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { RunCronAgentTurnParams } from "../../cron/isolated-agent/run-prepare-runtime.js";
import type { RunCronAgentTurnResult } from "../../cron/isolated-agent/run.types.js";
import type { CronExecutionIdentityAdmission } from "../../cron/service/state.js";
import type { PluginHookSkillArtifact } from "../../plugins/hook-types.js";
import {
  dispatchCommittedSkillChangeBestEffort,
  hasCommittedSkillChangeHooks,
  snapshotCommittedSkillArtifactBestEffort,
} from "../lifecycle/skill-change-hook.js";
import { bumpSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import {
  commitCollectionBackup,
  createCollectionBackup,
  discardPendingCollectionBackup,
} from "./collection-backup.js";
import { pruneOlderSkillCollectionBackups } from "./collection-paths.js";
import {
  inspectWorkshopReviewTree,
  MAX_WORKSHOP_REVIEW_ENTRIES,
  snapshotWorkshopSkillFiles,
} from "./collection-review-inspection.js";
import { buildCollectionReviewPrompt } from "./collection-review-prompt.js";
import {
  recordSkillCollectionReviewHistory,
  recordSkillCollectionReviewStatus,
  type SkillCollectionReviewResult,
} from "./collection-review-state.js";
import { restoreSkillCollectionReviewTree } from "./collection-rollback.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import { clearSkillUsageForRemovedSkills } from "./curator.js";
import { readSkillProposalTargetTreeSha256 } from "./proposal-bundle.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";
import { withSkillCollectionLock } from "./target-lock.js";
import { listWritableWorkshopSkillSummaries } from "./workspace-skill-read.js";

type ReviewTurn = (params: {
  job: RunCronAgentTurnParams["job"];
  message: string;
  abortSignal?: AbortSignal;
  onExecutionStarted?: RunCronAgentTurnParams["onExecutionStarted"];
  onExecutionPhase?: RunCronAgentTurnParams["onExecutionPhase"];
  onLaneWait?: RunCronAgentTurnParams["onLaneWait"];
  executionIdentity?: CronExecutionIdentityAdmission;
  executionRoot: NonNullable<RunCronAgentTurnParams["executionRoot"]>;
}) => Promise<RunCronAgentTurnResult>;

type ReviewSkill = ReturnType<typeof listWritableWorkshopSkillSummaries>[number];
type ReviewChange = {
  action: "created" | "updated" | "removed";
  before?: PluginHookSkillArtifact;
  after?: PluginHookSkillArtifact;
};
type ReviewCommit = { result: RunCronAgentTurnResult; changes: ReviewChange[] };
export async function runSkillCollectionReviewForAgent(params: {
  config: OpenClawConfig;
  agentId: string;
  job: RunCronAgentTurnParams["job"];
  env?: NodeJS.ProcessEnv;
  abortSignal?: AbortSignal;
  onExecutionStarted?: RunCronAgentTurnParams["onExecutionStarted"];
  onExecutionPhase?: RunCronAgentTurnParams["onExecutionPhase"];
  onLaneWait?: RunCronAgentTurnParams["onLaneWait"];
  executionIdentity?: CronExecutionIdentityAdmission;
  runTurn: ReviewTurn;
}): Promise<RunCronAgentTurnResult> {
  if (resolveSkillWorkshopConfig(params.config).autonomous.mode !== "auto") {
    return { status: "skipped", summary: "skill collection review disabled" };
  }
  const skillsRoot = resolveWorkshopSkillsDir(params.config, params.agentId, params.env);
  const stateOptions = { agentId: params.agentId, ...(params.env ? { env: params.env } : {}) };
  const assertCurrent = (lease: { assertOwned: () => void }) => {
    lease.assertOwned();
    params.abortSignal?.throwIfAborted();
  };
  try {
    const commit: ReviewCommit = await withSkillCollectionLock(async (lease) => {
      const attemptedAtMs = Date.now();
      let backup: Awaited<ReturnType<typeof createCollectionBackup>> | undefined;
      let phase: "prepared" | "running" | "committed" = "prepared";
      try {
        assertCurrent(lease);
        recordSkillCollectionReviewStatus(params.agentId, { attemptedAtMs }, stateOptions);
        assertCurrent(lease);
        await fs.mkdir(skillsRoot, { recursive: true });
        const beforeFiles = await snapshotWorkshopSkillFiles(skillsRoot);
        const before = await resolveReviewSkills(params.config, params.agentId, params.env);
        backup = await createCollectionBackup({
          skillsRoot,
          skillDirs: before.map((skill) => path.relative(skillsRoot, skill.baseDir)),
          config: params.config,
          agentId: params.agentId,
          env: params.env,
        });
        const shouldDispatch = hasCommittedSkillChangeHooks();
        const beforeArtifacts = new Map<string, PluginHookSkillArtifact | undefined>();
        if (shouldDispatch) {
          for (const skill of before) {
            assertCurrent(lease);
            beforeArtifacts.set(
              path.relative(skillsRoot, skill.baseDir),
              await snapshotCommittedSkillArtifactBestEffort({
                skillDir: skill.baseDir,
                skillKey: skill.skillKey,
                source: "workshop",
              }),
            );
          }
        }
        assertCurrent(lease);
        const message = buildCollectionReviewPrompt(
          before,
          beforeFiles.keys(),
          params.config,
          params.agentId,
          params.env,
        );
        phase = "running";
        const turnResult = await params.runTurn({
          job: {
            ...params.job,
            payload: { ...params.job.payload, kind: "agentTurn", message },
          },
          message,
          ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
          ...(params.onExecutionStarted ? { onExecutionStarted: params.onExecutionStarted } : {}),
          ...(params.onExecutionPhase ? { onExecutionPhase: params.onExecutionPhase } : {}),
          ...(params.onLaneWait ? { onLaneWait: params.onLaneWait } : {}),
          ...(params.executionIdentity ? { executionIdentity: params.executionIdentity } : {}),
          // File tools are rooted at the Workshop directory. Exec follows the operator's cron
          // exec-approval policy; with the default policy and no approval client it is denied.
          // Reviewed instructions cannot gain host authority the operator has not granted to automations.
          executionRoot: skillsRoot,
        });
        assertCurrent(lease);
        const beforeLoadedDirs = new Set(
          before.map((skill) => path.relative(skillsRoot, skill.baseDir)),
        );
        const { afterFiles, reviewErrors } = await inspectWorkshopReviewTree({
          skillsRoot,
          backupDir: backup.backupDir,
          beforeFiles,
          beforeLoadedDirs,
          resolveAfterLoadedDirs: async () =>
            new Set(
              (await resolveReviewSkills(params.config, params.agentId, params.env)).map((skill) =>
                path.relative(skillsRoot, skill.baseDir),
              ),
            ),
          assertCurrent: () => assertCurrent(lease),
        });
        if (turnResult.status === "error") {
          const error =
            turnResult.error ??
            `Skill collection review turn ended with status: ${turnResult.status}`;
          const unchanged =
            beforeFiles.size === afterFiles.size &&
            [...beforeFiles].every(
              ([relativePath, file]) =>
                afterFiles.get(relativePath)?.kind === file.kind &&
                afterFiles.get(relativePath)?.contentHash === file.contentHash,
            );
          if (unchanged) {
            recordSkillCollectionReviewStatus(
              params.agentId,
              { attemptedAtMs, error },
              stateOptions,
            );
            await discardPendingCollectionBackup(backup);
            return {
              result: { ...turnResult, status: "error", error, summary: error },
              changes: [],
            };
          }
        }
        const dropReasons = parseDropReasons(turnResult.outputText);
        assertCurrent(lease);
        const finalSkills = await resolveReviewSkills(params.config, params.agentId, params.env);
        const beforeByDir = new Map(
          before.map((skill) => [path.relative(skillsRoot, skill.baseDir), skill]),
        );
        const finalByDir = new Map(
          finalSkills.map((skill) => [path.relative(skillsRoot, skill.baseDir), skill]),
        );
        const result: SkillCollectionReviewResult = {
          backupId: backup.manifest.id,
          kept: before
            .filter(
              (skill) =>
                finalByDir.get(path.relative(skillsRoot, skill.baseDir))?.treeHash ===
                skill.treeHash,
            )
            .map((skill) => skill.name),
          written: finalSkills
            .filter((skill) => {
              const previous = beforeByDir.get(path.relative(skillsRoot, skill.baseDir));
              return !previous || previous.treeHash !== skill.treeHash;
            })
            .map((skill) => skill.name),
          dropped: before
            .filter((skill) => !finalByDir.has(path.relative(skillsRoot, skill.baseDir)))
            .map((skill) => ({
              name: skill.name,
              reason: dropReasons.get(skill.name) ?? "no reason given",
            })),
        };
        assertCurrent(lease);
        await commitCollectionBackup(
          skillsRoot,
          backup,
          finalSkills.map((skill) => path.relative(skillsRoot, skill.baseDir)),
        );
        phase = "committed";
        assertCurrent(lease);
        bumpSkillsSnapshotVersion({ reason: "workshop" });
        assertCurrent(lease);
        recordSkillCollectionReviewHistory(params.agentId, Date.now(), result, stateOptions);
        assertCurrent(lease);
        await pruneOlderSkillCollectionBackups(backup.backupRoot, backup.manifest.id);
        assertCurrent(lease);
        clearSkillUsageForRemovedSkills(
          before
            .filter((skill) => !finalByDir.has(path.relative(skillsRoot, skill.baseDir)))
            .map((skill) => canonicalizePath(skill.filePath)),
          stateOptions,
        );
        assertCurrent(lease);
        const turnError =
          turnResult.status === "ok"
            ? undefined
            : (turnResult.error ??
              `Skill collection review turn ended with status: ${turnResult.status}`);
        const scanError =
          reviewErrors.length > 0
            ? `Skill collection review completed with errors: ${reviewErrors.join("; ")}`
            : undefined;
        const changes = shouldDispatch
          ? await collectReviewChanges({
              before: beforeByDir,
              beforeArtifacts,
              finalSkills: finalByDir,
              assertCurrent: () => assertCurrent(lease),
            })
          : [];
        if (turnError || scanError) {
          const error = turnError
            ? `Skill collection review failed: ${turnError}${scanError ? `; ${scanError}` : ""}`
            : scanError;
          recordSkillCollectionReviewStatus(params.agentId, { attemptedAtMs, error }, stateOptions);
          return {
            result: { ...turnResult, status: "error", error, summary: error },
            changes,
          };
        }
        recordSkillCollectionReviewStatus(
          params.agentId,
          { attemptedAtMs, succeededAtMs: Date.now() },
          stateOptions,
        );
        return {
          result: turnResult,
          changes,
        };
      } catch (error) {
        lease.assertOwned();
        let failure = error;
        try {
          if (backup && phase === "running") {
            await restoreSkillCollectionReviewTree({ skillsRoot, backupDir: backup.backupDir });
          }
          if (backup && phase !== "committed") {
            lease.assertOwned();
            await discardPendingCollectionBackup(backup);
          }
        } catch (recoveryError) {
          failure = new AggregateError(
            [error, recoveryError],
            "Skill collection review failed and recovery did not finish (backup " +
              backup?.manifest.id +
              ").",
          );
        }
        lease.assertOwned();
        recordSkillCollectionReviewStatus(
          params.agentId,
          { attemptedAtMs, error: failure },
          stateOptions,
        );
        throw failure;
      }
    }, stateOptions);
    for (const change of commit.changes) {
      await dispatchCommittedSkillChangeBestEffort({
        ...change,
        source: "workshop",
        workspaceDir: skillsRoot,
      });
    }
    return commit.result;
  } catch (error) {
    const summary = `Skill collection review failed: ${String(error)}`;
    return { status: "error", error: summary, summary };
  }
}

async function collectReviewChanges(params: {
  before: ReadonlyMap<string, ReviewSkill & { treeHash: string }>;
  beforeArtifacts: ReadonlyMap<string, PluginHookSkillArtifact | undefined>;
  finalSkills: ReadonlyMap<string, ReviewSkill & { treeHash: string }>;
  assertCurrent: () => void;
}): Promise<ReviewChange[]> {
  const relativeDirs = new Set([...params.before.keys(), ...params.finalSkills.keys()]);
  const changes: ReviewChange[] = [];
  for (const relativeDir of [...relativeDirs].toSorted()) {
    const before = params.before.get(relativeDir);
    const after = params.finalSkills.get(relativeDir);
    if (before && after && before.treeHash === after.treeHash) {
      continue;
    }
    params.assertCurrent();
    changes.push({
      action: before ? (after ? "updated" : "removed") : "created",
      before: params.beforeArtifacts.get(relativeDir),
      after: after
        ? await snapshotCommittedSkillArtifactBestEffort({
            skillDir: after.baseDir,
            skillKey: after.skillKey,
            source: "workshop",
          })
        : undefined,
    });
  }
  return changes;
}

async function resolveReviewSkills(
  config: OpenClawConfig,
  agentId: string,
  env?: NodeJS.ProcessEnv,
): Promise<Array<ReviewSkill & { treeHash: string }>> {
  const skills = listWritableWorkshopSkillSummaries({
    config: resolveReviewConfig(config),
    agentId,
    env,
  });
  return await Promise.all(
    skills.map(async (skill) =>
      Object.assign(skill, {
        treeHash: await readSkillProposalTargetTreeSha256(skill.baseDir),
      }),
    ),
  );
}

function resolveReviewConfig(config: OpenClawConfig): OpenClawConfig {
  return {
    ...config,
    skills: {
      ...config.skills,
      limits: {
        ...config.skills?.limits,
        maxCandidatesPerRoot: MAX_WORKSHOP_REVIEW_ENTRIES,
        maxSkillsLoadedPerSource: MAX_WORKSHOP_REVIEW_ENTRIES,
      },
    },
  };
}

function parseDropReasons(outputText: string | undefined): Map<string, string> {
  const reasons = new Map<string, string>();
  for (const line of outputText?.split(/\r?\n/u) ?? []) {
    const match = /^DROP\s+(\S+)\s*:\s*(.*)$/u.exec(line.trim());
    if (!match?.[1]) {
      continue;
    }
    reasons.set(match[1], truncateUtf16Safe(match[2]?.trim() ?? "", 300));
  }
  return reasons;
}
