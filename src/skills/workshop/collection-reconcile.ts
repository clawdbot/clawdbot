import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { pathExists } from "../../infra/fs-safe.js";
import type { PluginHookSkillArtifact } from "../../plugins/hook-types.js";
import { buildWorkspaceSkillStatus } from "../discovery/status.js";
import {
  dispatchCommittedSkillChangeBestEffort,
  hasCommittedSkillChangeHooks,
  snapshotCommittedSkillArtifactBestEffort,
} from "../lifecycle/skill-change-hook.js";
import {
  applyWorkspaceSkillMutation,
  prepareWorkspaceSkillMutation,
  type PreparedWorkspaceSkillMutation,
} from "../lifecycle/workspace-skill-write.js";
import { bumpSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import {
  commitCollectionBackup,
  createCollectionBackup,
  discardPendingCollectionBackup,
  latestCommittedBackupId,
  readCollectionBackupManifest,
  type CollectionBackupManifest,
} from "./collection-backup.js";
import {
  assertCollectionMutationCurrent,
  assertCollectionReadsCurrent,
  assertResultCollectionBytes,
} from "./collection-byte-limits.js";
import {
  MAX_RECONCILED_SKILL_BYTES,
  MAX_RECONCILED_SKILLS,
  type SkillCollectionChange,
  type SkillCollectionPlanEntry,
  type SkillCollectionReconcileResult,
  type SkillCollectionRestoreResult,
  type WritableSkillCollectionEntry,
} from "./collection-contracts.js";
import {
  prepareCollectionCreateProposals,
  promoteCollectionCreateProposal,
  retireCollectionCreateProposals,
} from "./collection-create-proposal.js";
import {
  canonicalSkillCollectionWorkspace,
  pruneOlderSkillCollectionBackups,
  resolveSkillCollectionBackupRoot,
} from "./collection-paths.js";
import { validateSkillCollectionPlan } from "./collection-plan.js";
import { recordSkillCollectionReviewSuccess } from "./collection-review-state.js";
import {
  discardStagedSkillCollectionDrops,
  restoreSkillCollectionBackupTransaction,
  rollbackSkillCollectionMutation,
  stageSkillCollectionDrop,
} from "./collection-rollback.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import { clearCuratedSkillLifecycle } from "./curator.js";
import { stripProposalFrontmatterForSkill } from "./frontmatter.js";
import { listWorkshopOwnedSkillDirs, restoreWorkshopOwnershipClaims } from "./ownership.js";
import { readSkillProposalTargetTreeSha256 } from "./proposal-bundle.js";
import { prepareSkillProposalDraft } from "./proposal-draft.js";
import { withSkillCollectionLock } from "./target-lock.js";
import { assertWritableSkillTarget, isWorkspaceOwnedSkillTarget } from "./workspace-skill-read.js";

export function listWritableSkillCollection(
  workspaceDir: string,
  options: {
    agentId?: string;
    agentIds?: readonly string[];
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
  } = {},
): WritableSkillCollectionEntry[] {
  const byFile = new Map<string, WritableSkillCollectionEntry>();
  const ownedDirs = listWorkshopOwnedSkillDirs(
    workspaceDir,
    options.env ? { env: options.env } : {},
  );
  const agentIds = options.agentIds?.length ? options.agentIds : [options.agentId];
  for (const agentId of agentIds) {
    const status = buildWorkspaceSkillStatus(workspaceDir, {
      config: options.config,
      ...(agentId ? { agentId } : {}),
    });
    for (const skill of status.skills) {
      if (!skill.eligible || skill.blockedByAgentFilter) {
        continue;
      }
      try {
        assertWritableSkillTarget(workspaceDir, skill);
      } catch {
        continue;
      }
      // Autonomous reconciliation may drop whole skill directories, so its
      // inventory is narrower than manual proposal apply's explicit symlink opt-in.
      if (!isWorkspaceOwnedSkillTarget(workspaceDir, skill)) {
        continue;
      }
      const filePath = path.resolve(skill.filePath);
      byFile.set(filePath, {
        name: skill.skillKey,
        baseDir: path.resolve(skill.baseDir),
        filePath,
        workshopOwned: ownedDirs.has(path.resolve(skill.baseDir)),
        ...(skill.description ? { description: skill.description } : {}),
      });
    }
  }
  return [...byFile.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}

export async function reconcileSkillCollection(params: {
  workspaceDir: string;
  plan: readonly SkillCollectionPlanEntry[];
  readSkillHashes: ReadonlyMap<string, string>;
  readSkillTreeHashes: ReadonlyMap<string, string>;
  config?: OpenClawConfig;
  agentId?: string;
  agentIds?: readonly string[];
  approvedSkillNamesByAgent?: readonly ReadonlySet<string>[];
  env?: NodeJS.ProcessEnv;
}): Promise<SkillCollectionReconcileResult> {
  const workspaceDir = canonicalSkillCollectionWorkspace(params.workspaceDir);
  const commit = await withSkillCollectionLock(
    workspaceDir,
    async () => {
      const current = listWritableSkillCollection(workspaceDir, {
        config: params.config,
        agentId: params.agentId,
        agentIds: params.agentIds,
        env: params.env,
      });
      const currentByName = new Map(current.map((skill) => [skill.name, skill]));
      if (currentByName.size !== current.length) {
        throw new Error("Writable skill names must be unique before collection reconciliation.");
      }
      const plan = validateSkillCollectionPlan(
        params.plan,
        current,
        params.readSkillHashes,
        MAX_RECONCILED_SKILLS,
        params.approvedSkillNamesByAgent,
      );
      const outcome = {
        kept: plan.filter((entry) => entry.action === "keep").map((entry) => entry.name),
        written: plan.filter((entry) => entry.action === "write").map((entry) => entry.name),
        dropped: plan
          .filter(
            (entry): entry is Extract<SkillCollectionPlanEntry, { action: "drop" }> =>
              entry.action === "drop",
          )
          .map((entry) => ({ name: entry.name, reason: entry.reason })),
      };
      await assertCollectionReadsCurrent(
        current,
        params.readSkillHashes,
        MAX_RECONCILED_SKILL_BYTES,
      );
      if (plan.every((entry) => entry.action === "keep")) {
        const backupRoot = resolveSkillCollectionBackupRoot(workspaceDir, params.env);
        let backupId = await latestCommittedBackupId(backupRoot);
        if (!backupId) {
          const backup = await createCollectionBackup({
            workspaceDir,
            current,
            plan,
            env: params.env,
          });
          try {
            await assertCollectionMutationCurrent(current, params.readSkillTreeHashes, []);
            await commitCollectionBackup(workspaceDir, backup);
          } catch (error) {
            await discardPendingCollectionBackup(backup);
            throw error;
          }
          backupId = backup.manifest.id;
        } else {
          await assertCollectionMutationCurrent(current, params.readSkillTreeHashes, []);
        }
        clearCuratedSkillLifecycle(
          current.map((skill) => skill.filePath),
          params.env ? { env: params.env } : {},
        );
        const result: SkillCollectionReconcileResult = { backupId, ...outcome };
        recordSkillCollectionReviewSuccess(
          workspaceDir,
          Date.now(),
          result,
          params.env ? { env: params.env } : {},
        );
        return {
          result,
          changes: [],
        };
      }
      const prepared = await prepareWrites({
        workspaceDir,
        current,
        plan,
        config: params.config,
      });
      const createProposals = await prepareCollectionCreateProposals({
        workspaceDir,
        current,
        plan,
        prepared,
        config: params.config,
        agentId: params.agentId,
        env: params.env,
      });
      // Any failure from here through promotion must retire the staged pending
      // create rows: they target files that will not exist and would consume
      // the maxPending budget until an operator cleans them up.
      try {
        await assertResultCollectionBytes(current, plan, prepared, MAX_RECONCILED_SKILL_BYTES);
        const backup = await createCollectionBackup({
          workspaceDir,
          current,
          plan,
          env: params.env,
        });
        const shouldDispatch = hasCommittedSkillChangeHooks();
        const before = new Map<string, PluginHookSkillArtifact | undefined>();
        if (shouldDispatch) {
          for (const entry of plan) {
            const existing = currentByName.get(entry.name);
            if (entry.action === "keep" || !existing) {
              continue;
            }
            before.set(
              entry.name,
              await snapshotCommittedSkillArtifactBestEffort({
                skillDir: existing.baseDir,
                skillKey: existing.name,
                source: "workshop",
              }),
            );
          }
        }
        try {
          await assertCollectionMutationCurrent(current, params.readSkillTreeHashes, prepared);
        } catch (error) {
          await discardPendingCollectionBackup(backup);
          throw error;
        }
        const appliedWrites: PreparedWorkspaceSkillMutation[] = [];
        const droppedSkills: Array<
          Pick<WritableSkillCollectionEntry, "name" | "baseDir"> & { stagedDir: string }
        > = [];
        try {
          for (const mutation of prepared) {
            await applyWorkspaceSkillMutation(mutation);
            appliedWrites.push(mutation);
          }
          for (const entry of plan) {
            if (entry.action !== "drop") {
              continue;
            }
            const skill = currentByName.get(entry.name)!;
            droppedSkills.push(await stageSkillCollectionDrop({ ...skill, workspaceDir }));
          }
          await commitCollectionBackup(workspaceDir, backup);
        } catch (error) {
          try {
            await rollbackSkillCollectionMutation({
              workspaceDir,
              appliedWrites,
              droppedSkills,
            });
          } catch (restoreError) {
            throw new Error(
              `Skill collection reconciliation failed (${String(error)}) and backup ${backup.manifest.id} could not be restored.`,
              { cause: restoreError },
            );
          }
          await discardPendingCollectionBackup(backup);
          throw error;
        }
        bumpSkillsSnapshotVersion({ reason: "workshop" });
        await discardStagedSkillCollectionDrops(workspaceDir, droppedSkills);
        clearCuratedSkillLifecycle(
          current.map((skill) => skill.filePath),
          params.env ? { env: params.env } : {},
        );
        // Finalize the filesystem before recording ownership. Promotion failures
        // leave newly written skills visible but read-only.
        for (const mutation of prepared) {
          const proposal = createProposals.get(mutation.skillFile.filePath);
          if (proposal) {
            await promoteCollectionCreateProposal({
              proposal,
              workspaceDir,
              env: params.env,
            });
          }
        }
        const result: SkillCollectionReconcileResult = {
          backupId: backup.manifest.id,
          ...outcome,
        };
        recordSkillCollectionReviewSuccess(
          workspaceDir,
          Date.now(),
          result,
          params.env ? { env: params.env } : {},
          droppedSkills.map((skill) => skill.baseDir),
        );
        await pruneOlderSkillCollectionBackups(backup.backupRoot, backup.manifest.id);
        const changes: SkillCollectionChange[] = [];
        if (shouldDispatch) {
          for (const entry of plan) {
            if (entry.action === "keep") {
              continue;
            }
            const existing = currentByName.get(entry.name);
            const skillDir = existing?.baseDir ?? path.join(workspaceDir, "skills", entry.name);
            changes.push({
              action: entry.action === "drop" ? "removed" : existing ? "updated" : "created",
              before: before.get(entry.name),
              after:
                entry.action === "write"
                  ? await snapshotCommittedSkillArtifactBestEffort({
                      skillDir,
                      skillKey: entry.name,
                      source: "workshop",
                    })
                  : undefined,
            });
          }
        }
        return {
          result,
          changes,
        };
      } catch (error) {
        await retireCollectionCreateProposals({
          proposals: createProposals.values(),
          workspaceDir,
          env: params.env,
        });
        throw error;
      }
    },
    params.env ? { env: params.env } : {},
  );
  for (const change of commit.changes) {
    await dispatchCommittedSkillChangeBestEffort({
      ...change,
      source: "workshop",
      workspaceDir,
    });
  }
  return commit.result;
}

export async function restoreLatestSkillCollectionBackup(params: {
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillCollectionRestoreResult> {
  const workspaceDir = canonicalSkillCollectionWorkspace(params.workspaceDir);
  const commit = await withSkillCollectionLock(
    workspaceDir,
    async () => {
      const backupRoot = resolveSkillCollectionBackupRoot(workspaceDir, params.env);
      if (!(await pathExists(backupRoot))) {
        throw new Error("No skill collection backup is available.");
      }
      const backupId = await latestCommittedBackupId(backupRoot);
      if (!backupId) {
        throw new Error("No skill collection backup is available.");
      }
      const backupDir = path.join(backupRoot, backupId);
      const manifest = await readCollectionBackupManifest({
        backupDir,
        backupId,
        workspaceDir,
      });
      // Restore accepts legacy manifests from before ownership narrowing.
      // The content-unchanged guard below protects post-cleanup user edits.
      await assertCollectionResultUnchanged(workspaceDir, manifest);
      const affectedDirs = [...new Set([...manifest.skillDirs, ...manifest.resultSkillDirs])];
      const shouldDispatch = hasCommittedSkillChangeHooks();
      const before = new Map<string, PluginHookSkillArtifact | undefined>();
      const beforeExists = new Set<string>();
      for (const relativeDir of affectedDirs) {
        const skillDir = path.join(workspaceDir, relativeDir);
        if (await pathExists(skillDir)) {
          beforeExists.add(relativeDir);
        }
        if (shouldDispatch) {
          before.set(
            relativeDir,
            await snapshotCommittedSkillArtifactBestEffort({
              skillDir,
              skillKey: path.basename(relativeDir),
              source: "workshop",
            }),
          );
        }
      }
      await assertCollectionResultUnchanged(workspaceDir, manifest);
      try {
        await restoreSkillCollectionBackupTransaction({
          workspaceDir,
          backupDir,
          skillDirs: manifest.skillDirs,
          resultSkillDirs: manifest.resultSkillDirs,
        });
      } finally {
        bumpSkillsSnapshotVersion({ reason: "workshop" });
      }
      restoreWorkshopOwnershipClaims(
        workspaceDir,
        manifest.skillDirs.map((relativeDir) => path.join(workspaceDir, relativeDir)),
        params.env ? { env: params.env } : {},
      );
      const changes: SkillCollectionChange[] = [];
      if (shouldDispatch) {
        for (const relativeDir of affectedDirs) {
          const skillDir = path.join(workspaceDir, relativeDir);
          const afterExists = await pathExists(skillDir);
          if (!beforeExists.has(relativeDir) && !afterExists) {
            continue;
          }
          changes.push({
            action: !beforeExists.has(relativeDir)
              ? "created"
              : afterExists
                ? "updated"
                : "removed",
            before: before.get(relativeDir),
            after: afterExists
              ? await snapshotCommittedSkillArtifactBestEffort({
                  skillDir,
                  skillKey: path.basename(relativeDir),
                  source: "workshop",
                })
              : undefined,
          });
        }
      }
      const restored = manifest.skillDirs.map((relativeDir) => path.basename(relativeDir));
      const restoredDirs = new Set(manifest.skillDirs);
      return {
        result: {
          backupId,
          restored,
          removed: manifest.resultSkillDirs
            .filter((relativeDir) => !restoredDirs.has(relativeDir))
            .map((relativeDir) => path.basename(relativeDir)),
        },
        changes,
      };
    },
    params.env ? { env: params.env } : {},
  );
  for (const change of commit.changes) {
    await dispatchCommittedSkillChangeBestEffort({
      ...change,
      source: "workshop",
      workspaceDir,
    });
  }
  return commit.result;
}

async function prepareWrites(params: {
  workspaceDir: string;
  current: readonly WritableSkillCollectionEntry[];
  plan: readonly SkillCollectionPlanEntry[];
  config?: OpenClawConfig;
}): Promise<PreparedWorkspaceSkillMutation[]> {
  const workshop = resolveSkillWorkshopConfig(params.config);
  const currentByName = new Map(params.current.map((skill) => [skill.name, skill]));
  const writes: PreparedWorkspaceSkillMutation[] = [];
  for (const entry of params.plan) {
    if (entry.action !== "write") {
      continue;
    }
    const existing = currentByName.get(entry.name);
    const skillDir = existing?.baseDir ?? path.join(params.workspaceDir, "skills", entry.name);
    const skillFile = existing?.filePath ?? path.join(skillDir, "SKILL.md");
    if (!existing && (await pathExists(skillDir))) {
      throw new Error(`New skill directory already exists: ${skillDir}`);
    }
    const draft = prepareSkillProposalDraft({
      name: entry.name,
      description: entry.description,
      content: entry.content,
      fallbackFrontmatterContent: existing
        ? await fs.readFile(existing.filePath, "utf8")
        : undefined,
      date: new Date().toISOString(),
      maxSkillBytes: workshop.maxSkillBytes,
    });
    if (!draft.ok) {
      throw draft.error.cause;
    }
    if (draft.value.scan.critical > 0) {
      throw new Error(`Skill security scan rejected ${entry.name}.`);
    }
    writes.push(
      await prepareWorkspaceSkillMutation({
        workspaceDir: params.workspaceDir,
        skillDir,
        skillFile,
        content: stripProposalFrontmatterForSkill(draft.value.content),
        mode: existing ? "update" : "create",
        symlinkPolicy: {
          allowWrites: false,
          allowedTargetRealPaths: [],
        },
      }),
    );
  }
  return writes;
}

async function assertCollectionResultUnchanged(
  workspaceDir: string,
  manifest: CollectionBackupManifest,
): Promise<void> {
  const resultDirs = new Set(manifest.resultSkillDirs);
  for (const relativeDir of manifest.skillDirs) {
    if (!resultDirs.has(relativeDir) && (await pathExists(path.join(workspaceDir, relativeDir)))) {
      throw new Error(`Skill collection changed after cleanup: ${path.basename(relativeDir)}`);
    }
  }
  for (const relativeDir of manifest.resultSkillDirs) {
    const currentHash = await readSkillProposalTargetTreeSha256(
      path.join(workspaceDir, relativeDir),
    );
    if (currentHash !== manifest.resultSkillHashes[relativeDir]) {
      throw new Error(`Skill collection changed after cleanup: ${path.basename(relativeDir)}`);
    }
  }
}
