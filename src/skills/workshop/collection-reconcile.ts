import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { pathExists } from "../../infra/fs-safe.js";
import type { PluginHookSkillArtifact } from "../../plugins/hook-types.js";
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
import { loadSingleSkillDirectory } from "../loading/local-loader.js";
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
  autonomousSkillSizeError,
  MAX_RECONCILED_SKILL_BYTES,
  MAX_RECONCILED_SKILLS,
  type SkillCollectionChange,
  type SkillCollectionPlanEntry,
  type SkillCollectionReconcileResult,
  type SkillCollectionRestoreResult,
  type WritableSkillCollectionEntry,
} from "./collection-contracts.js";
import {
  pruneOlderSkillCollectionBackups,
  resolveSkillCollectionBackupRoot,
} from "./collection-paths.js";
import { validateSkillCollectionPlan } from "./collection-plan.js";
import { recordSkillCollectionReviewHistory } from "./collection-review-state.js";
import {
  discardStagedSkillCollectionDrops,
  restoreSkillCollectionBackupTransaction,
  rollbackSkillCollectionMutation,
  stageSkillCollectionDrop,
} from "./collection-rollback.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import { clearSkillUsageForRemovedSkills } from "./curator.js";
import { stripProposalFrontmatterForSkill } from "./frontmatter.js";
import { readSkillProposalTargetTreeSha256 } from "./proposal-bundle.js";
import { prepareSkillProposalDraft } from "./proposal-draft.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";
import { withSkillCollectionLock } from "./target-lock.js";
import {
  listWritableWorkshopSkillSummaries,
  type WorkshopSkillReadOptions,
} from "./workspace-skill-read.js";

/**
 * The Workshop's whole editable collection is the contents of its global directory.
 */
export function listWritableSkillCollection(
  options: WorkshopSkillReadOptions = {},
): WritableSkillCollectionEntry[] {
  return listWritableWorkshopSkillSummaries(options).map((skill) => ({
    name: skill.name,
    description: skill.description,
    baseDir: path.resolve(skill.baseDir),
    filePath: path.resolve(skill.filePath),
  }));
}

export async function reconcileSkillCollection(params: {
  workspaceDir: string;
  plan: readonly SkillCollectionPlanEntry[];
  readSkillHashes: ReadonlyMap<string, string>;
  readSkillTreeHashes: ReadonlyMap<string, string>;
  config?: OpenClawConfig;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
}): Promise<SkillCollectionReconcileResult> {
  const skillsRoot = resolveWorkshopSkillsDir(params.env);
  const commit = await withSkillCollectionLock(
    async () => {
      params.assertCurrent?.();
      const current = listWritableSkillCollection({ config: params.config, env: params.env });
      const currentByName = new Map(current.map((skill) => [skill.name, skill]));
      if (currentByName.size !== current.length) {
        throw new Error("Writable skill names must be unique before collection reconciliation.");
      }
      const plan = validateSkillCollectionPlan(
        params.plan,
        current,
        params.readSkillHashes,
        MAX_RECONCILED_SKILLS,
      );
      const plannedNames = new Set(plan.map((entry) => entry.name));
      const outcome = {
        kept: current.filter((skill) => !plannedNames.has(skill.name)).map((skill) => skill.name),
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
        plannedNames,
        MAX_RECONCILED_SKILL_BYTES,
      );
      params.assertCurrent?.();
      if (plan.length === 0) {
        const backupRoot = resolveSkillCollectionBackupRoot(params.env);
        let backupId = await latestCommittedBackupId(backupRoot);
        if (!backupId) {
          const backup = await createCollectionBackup({
            skillsRoot,
            current,
            plan,
            env: params.env,
          });
          try {
            params.assertCurrent?.();
            await commitCollectionBackup(skillsRoot, backup);
            params.assertCurrent?.();
          } catch (error) {
            await discardPendingCollectionBackup(backup);
            throw error;
          }
          backupId = backup.manifest.id;
        }
        params.assertCurrent?.();
        const result: SkillCollectionReconcileResult = { backupId, ...outcome };
        recordSkillCollectionReviewHistory(
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
        skillsRoot,
        current,
        plan,
        config: params.config,
      });
      await assertResultCollectionBytes(current, plan, prepared, MAX_RECONCILED_SKILL_BYTES);
      const backup = await createCollectionBackup({
        skillsRoot,
        current,
        plan,
        env: params.env,
      });
      const shouldDispatch = hasCommittedSkillChangeHooks();
      const before = new Map<string, PluginHookSkillArtifact | undefined>();
      if (shouldDispatch) {
        for (const entry of plan) {
          const existing = currentByName.get(entry.name);
          if (!existing) {
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
        await assertCollectionMutationCurrent(
          current,
          params.readSkillTreeHashes,
          plannedNames,
          prepared,
        );
        params.assertCurrent?.();
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
          params.assertCurrent?.();
          await applyWorkspaceSkillMutation(mutation);
          appliedWrites.push(mutation);
          params.assertCurrent?.();
        }
        for (const entry of plan) {
          params.assertCurrent?.();
          if (entry.action !== "drop") {
            continue;
          }
          const skill = currentByName.get(entry.name)!;
          droppedSkills.push(await stageSkillCollectionDrop({ ...skill, skillsRoot }));
          params.assertCurrent?.();
        }
        params.assertCurrent?.();
        await commitCollectionBackup(skillsRoot, backup);
        params.assertCurrent?.();
      } catch (error) {
        try {
          await rollbackSkillCollectionMutation({
            skillsRoot,
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
      await discardStagedSkillCollectionDrops(skillsRoot, droppedSkills);
      if (droppedSkills.length > 0) {
        clearSkillUsageForRemovedSkills(
          droppedSkills.map(({ name }) => currentByName.get(name)!.filePath),
          params.env ? { env: params.env } : {},
        );
      }
      const result: SkillCollectionReconcileResult = {
        backupId: backup.manifest.id,
        ...outcome,
      };
      recordSkillCollectionReviewHistory(Date.now(), result, params.env ? { env: params.env } : {});
      await pruneOlderSkillCollectionBackups(backup.backupRoot, backup.manifest.id);
      const changes: SkillCollectionChange[] = [];
      if (shouldDispatch) {
        for (const entry of plan) {
          const existing = currentByName.get(entry.name);
          const skillDir = existing?.baseDir ?? path.join(skillsRoot, entry.name);
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
    },
    params.env ? { env: params.env } : {},
  );
  for (const change of commit.changes) {
    await dispatchCommittedSkillChangeBestEffort({
      ...change,
      source: "workshop",
      workspaceDir: params.workspaceDir,
    });
  }
  return commit.result;
}

export async function restoreLatestSkillCollectionBackup(params: {
  workspaceDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillCollectionRestoreResult> {
  const skillsRoot = resolveWorkshopSkillsDir(params.env);
  const commit = await withSkillCollectionLock(
    async () => {
      const backupRoot = resolveSkillCollectionBackupRoot(params.env);
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
        skillsRoot,
      });
      // Restoring over user edits made since the cleanup would silently lose them.
      await assertCollectionResultUnchanged(skillsRoot, manifest);
      const affectedDirs = [...new Set([...manifest.skillDirs, ...manifest.resultSkillDirs])];
      const shouldDispatch = hasCommittedSkillChangeHooks();
      const before = new Map<string, PluginHookSkillArtifact | undefined>();
      const affectedSkills: Array<{
        relativeDir: string;
        skillDir: string;
        skillKey: string;
        liveExists: boolean;
      }> = [];
      for (const relativeDir of affectedDirs) {
        const skillDir = path.join(skillsRoot, relativeDir);
        const liveExists = await pathExists(skillDir);
        const keySourceDir = liveExists ? skillDir : path.join(backupDir, "skills", relativeDir);
        const loaded = loadSingleSkillDirectory({
          skillDir: keySourceDir,
          source: "openclaw-workshop",
          rootRealPath: await fs.realpath(keySourceDir),
        });
        if (!loaded) {
          throw new Error(`Could not load Workshop skill: ${relativeDir}`);
        }
        const affectedSkill = {
          relativeDir,
          skillDir,
          skillKey: loaded.skill.name,
          liveExists,
        };
        affectedSkills.push(affectedSkill);
        if (shouldDispatch) {
          before.set(
            relativeDir,
            await snapshotCommittedSkillArtifactBestEffort({
              skillDir,
              skillKey: affectedSkill.skillKey,
              source: "workshop",
            }),
          );
        }
      }
      await assertCollectionResultUnchanged(skillsRoot, manifest);
      try {
        await restoreSkillCollectionBackupTransaction({
          skillsRoot,
          backupDir,
          skillDirs: manifest.skillDirs,
          resultSkillDirs: manifest.resultSkillDirs,
        });
      } finally {
        bumpSkillsSnapshotVersion({ reason: "workshop" });
      }
      const changes: SkillCollectionChange[] = [];
      if (shouldDispatch) {
        for (const affectedSkill of affectedSkills) {
          const afterExists = await pathExists(affectedSkill.skillDir);
          if (!affectedSkill.liveExists && !afterExists) {
            continue;
          }
          changes.push({
            action: !affectedSkill.liveExists ? "created" : afterExists ? "updated" : "removed",
            before: before.get(affectedSkill.relativeDir),
            after: afterExists
              ? await snapshotCommittedSkillArtifactBestEffort({
                  skillDir: affectedSkill.skillDir,
                  skillKey: affectedSkill.skillKey,
                  source: "workshop",
                })
              : undefined,
          });
        }
      }
      // affectedSkills keeps manifest order: restored dirs first, then result-only dirs.
      const restoredDirs = new Set(manifest.skillDirs);
      const skillKeys = (restored: boolean) =>
        affectedSkills
          .filter((affectedSkill) => restoredDirs.has(affectedSkill.relativeDir) === restored)
          .map((affectedSkill) => affectedSkill.skillKey);
      return {
        result: { backupId, restored: skillKeys(true), removed: skillKeys(false) },
        changes,
      };
    },
    params.env ? { env: params.env } : {},
  );
  for (const change of commit.changes) {
    await dispatchCommittedSkillChangeBestEffort({
      ...change,
      source: "workshop",
      workspaceDir: params.workspaceDir,
    });
  }
  return commit.result;
}

async function prepareWrites(params: {
  skillsRoot: string;
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
    const skillDir = existing?.baseDir ?? path.join(params.skillsRoot, entry.name);
    const skillFile = existing?.filePath ?? path.join(skillDir, "SKILL.md");
    if (!existing && (await pathExists(skillDir))) {
      throw new Error(`New skill directory already exists: ${skillDir}`);
    }
    const currentContent = existing ? await fs.readFile(existing.filePath, "utf8") : undefined;
    const draft = prepareSkillProposalDraft({
      name: entry.name,
      description: entry.description,
      content: entry.content,
      fallbackFrontmatterContent: currentContent,
      date: new Date().toISOString(),
      maxSkillBytes: workshop.maxSkillBytes,
    });
    if (!draft.ok) {
      throw draft.error.cause;
    }
    if (draft.value.scan.critical > 0) {
      throw new Error(`Skill security scan rejected ${entry.name}.`);
    }
    const resultContent = stripProposalFrontmatterForSkill(draft.value.content);
    const currentChars = currentContent?.length ?? 0;
    const sizeError = autonomousSkillSizeError(entry.name, currentChars, resultContent.length);
    if (sizeError) {
      throw new Error(sizeError);
    }
    writes.push(
      await prepareWorkspaceSkillMutation({
        skillsRoot: params.skillsRoot,
        skillDir,
        skillFile,
        content: resultContent,
        mode: existing ? "update" : "create",
      }),
    );
  }
  return writes;
}

async function assertCollectionResultUnchanged(
  skillsRoot: string,
  manifest: CollectionBackupManifest,
): Promise<void> {
  const resultDirs = new Set(manifest.resultSkillDirs);
  for (const relativeDir of manifest.skillDirs) {
    if (!resultDirs.has(relativeDir) && (await pathExists(path.join(skillsRoot, relativeDir)))) {
      throw new Error(`Skill collection changed after cleanup: ${relativeDir}`);
    }
  }
  for (const relativeDir of manifest.resultSkillDirs) {
    const currentHash = await readSkillProposalTargetTreeSha256(path.join(skillsRoot, relativeDir));
    if (currentHash !== manifest.resultSkillHashes[relativeDir]) {
      throw new Error(`Skill collection changed after cleanup: ${relativeDir}`);
    }
  }
}
