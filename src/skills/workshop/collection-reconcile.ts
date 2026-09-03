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
import { resolveSkillManifestMetadata } from "../loading/frontmatter.js";
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
import { listWritableWorkshopSkillSummaries } from "./workspace-skill-read.js";

export async function reconcileSkillCollection(params: {
  workspaceDir: string;
  plan: readonly SkillCollectionPlanEntry[];
  readSkillHashes: ReadonlyMap<string, string>;
  readSkillTreeHashes: ReadonlyMap<string, string>;
  config: OpenClawConfig;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
}): Promise<SkillCollectionReconcileResult> {
  if (!params.agentId) {
    throw new Error("Skill Workshop collection review requires the active agent id.");
  }
  const config = params.config;
  const agentId = params.agentId;
  const skillsRoot = resolveWorkshopSkillsDir(config, agentId, params.env);
  const commit = await withSkillCollectionLock(
    async () => {
      params.assertCurrent?.();
      const current: WritableSkillCollectionEntry[] = listWritableWorkshopSkillSummaries({
        config,
        agentId,
        env: params.env,
      });
      const currentBySkillKey = new Map(current.map((skill) => [skill.skillKey, skill]));
      if (currentBySkillKey.size !== current.length) {
        throw new Error("Writable skill keys must be unique before collection reconciliation.");
      }
      const plan = validateSkillCollectionPlan(
        params.plan,
        current,
        params.readSkillHashes,
        MAX_RECONCILED_SKILLS,
      );
      const plannedSkillKeys = new Set(plan.map((entry) => entry.skillKey));
      const outcome = {
        kept: current
          .filter((skill) => !plannedSkillKeys.has(skill.skillKey))
          .map((skill) => skill.skillKey),
        written: plan.filter((entry) => entry.action === "write").map((entry) => entry.skillKey),
        dropped: plan
          .filter(
            (entry): entry is Extract<SkillCollectionPlanEntry, { action: "drop" }> =>
              entry.action === "drop",
          )
          .map((entry) => ({ name: entry.skillKey, reason: entry.reason })),
      };
      await assertCollectionReadsCurrent(
        current,
        params.readSkillHashes,
        plannedSkillKeys,
        MAX_RECONCILED_SKILL_BYTES,
      );
      params.assertCurrent?.();
      if (plan.length === 0) {
        const backupRoot = resolveSkillCollectionBackupRoot(config, agentId, params.env);
        let backupId = await latestCommittedBackupId(backupRoot);
        if (!backupId) {
          const backup = await createCollectionBackup({
            skillsRoot,
            current,
            plan,
            backupRoot,
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
        recordSkillCollectionReviewHistory(agentId, Date.now(), result, { env: params.env });
        return {
          result,
          changes: [],
        };
      }
      const prepared = await prepareWrites({
        skillsRoot,
        current,
        plan,
        config,
      });
      await assertResultCollectionBytes(current, plan, prepared, MAX_RECONCILED_SKILL_BYTES);
      const backup = await createCollectionBackup({
        skillsRoot,
        current,
        plan,
        backupRoot: resolveSkillCollectionBackupRoot(config, agentId, params.env),
      });
      const shouldDispatch = hasCommittedSkillChangeHooks();
      const before = new Map<string, PluginHookSkillArtifact | undefined>();
      if (shouldDispatch) {
        for (const entry of plan) {
          const existing = currentBySkillKey.get(entry.skillKey);
          if (!existing) {
            continue;
          }
          before.set(
            entry.skillKey,
            await snapshotCommittedSkillArtifactBestEffort({
              skillDir: existing.baseDir,
              skillKey: existing.skillKey,
              source: "workshop",
            }),
          );
        }
      }
      try {
        await assertCollectionMutationCurrent(
          current,
          params.readSkillTreeHashes,
          plannedSkillKeys,
          prepared,
        );
        params.assertCurrent?.();
      } catch (error) {
        await discardPendingCollectionBackup(backup);
        throw error;
      }
      const appliedWrites: PreparedWorkspaceSkillMutation[] = [];
      const droppedSkills: Array<{ skillKey: string; baseDir: string; stagedDir: string }> = [];
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
          const skill = currentBySkillKey.get(entry.skillKey)!;
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
          droppedSkills.map(({ skillKey }) => currentBySkillKey.get(skillKey)!.filePath),
          { env: params.env },
        );
      }
      const result: SkillCollectionReconcileResult = {
        backupId: backup.manifest.id,
        ...outcome,
      };
      recordSkillCollectionReviewHistory(agentId, Date.now(), result, {
        env: params.env,
        agentId,
      });
      await pruneOlderSkillCollectionBackups(backup.backupRoot, backup.manifest.id);
      const changes: SkillCollectionChange[] = [];
      if (shouldDispatch) {
        for (const entry of plan) {
          const existing = currentBySkillKey.get(entry.skillKey);
          const skillDir = existing?.baseDir ?? path.join(skillsRoot, entry.skillKey);
          changes.push({
            action: entry.action === "drop" ? "removed" : existing ? "updated" : "created",
            before: before.get(entry.skillKey),
            after:
              entry.action === "write"
                ? await snapshotCommittedSkillArtifactBestEffort({
                    skillDir,
                    skillKey: entry.skillKey,
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
    { env: params.env, agentId },
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
  config: OpenClawConfig;
  agentId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillCollectionRestoreResult> {
  const skillsRoot = resolveWorkshopSkillsDir(params.config, params.agentId, params.env);
  const commit = await withSkillCollectionLock(
    async () => {
      const backupRoot = resolveSkillCollectionBackupRoot(
        params.config,
        params.agentId,
        params.env,
      );
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
      if (manifest.restoreUnavailableReason) {
        throw new Error(
          `Skill collection backup is history-only and cannot be restored: ${manifest.restoreUnavailableReason}`,
        );
      }
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
          skillKey: resolveSkillManifestMetadata(loaded.frontmatter)?.skillKey ?? loaded.skill.name,
          liveExists,
        };
        affectedSkills.push(affectedSkill);
        if (shouldDispatch) {
          before.set(
            affectedSkill.skillKey,
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
            before: before.get(affectedSkill.skillKey),
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
      const restoredDirs = new Set(manifest.skillDirs);
      const restored = affectedSkills
        .filter((affectedSkill) => restoredDirs.has(affectedSkill.relativeDir))
        .map((affectedSkill) => affectedSkill.skillKey);
      const removed = affectedSkills
        .filter((affectedSkill) => !restoredDirs.has(affectedSkill.relativeDir))
        .map((affectedSkill) => affectedSkill.skillKey);
      return {
        result: { backupId, restored, removed },
        changes,
      };
    },
    { env: params.env, agentId: params.agentId },
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
  config: OpenClawConfig;
}): Promise<PreparedWorkspaceSkillMutation[]> {
  const workshop = resolveSkillWorkshopConfig(params.config);
  const currentBySkillKey = new Map(params.current.map((skill) => [skill.skillKey, skill]));
  const writes: PreparedWorkspaceSkillMutation[] = [];
  for (const entry of params.plan) {
    if (entry.action !== "write") {
      continue;
    }
    const existing = currentBySkillKey.get(entry.skillKey);
    const skillDir = existing?.baseDir ?? path.join(params.skillsRoot, entry.skillKey);
    const skillFile = existing?.filePath ?? path.join(skillDir, "SKILL.md");
    if (!existing && (await pathExists(skillDir))) {
      throw new Error(`New skill directory already exists: ${skillDir}`);
    }
    const currentContent = existing ? await fs.readFile(existing.filePath, "utf8") : undefined;
    const draft = prepareSkillProposalDraft({
      name: existing?.name ?? entry.skillKey,
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
      throw new Error(`Skill security scan rejected ${entry.skillKey}.`);
    }
    const resultContent = stripProposalFrontmatterForSkill(draft.value.content);
    const currentChars = currentContent?.length ?? 0;
    const sizeError = autonomousSkillSizeError(entry.skillKey, currentChars, resultContent.length);
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
