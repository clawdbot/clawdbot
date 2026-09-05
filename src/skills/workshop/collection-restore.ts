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
import { resolveSkillManifestMetadata } from "../loading/frontmatter.js";
import { loadSingleSkillDirectory } from "../loading/local-loader.js";
import { bumpSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import {
  latestCommittedBackupId,
  readCollectionBackupManifest,
  type CollectionBackupManifest,
} from "./collection-backup.js";
import type { SkillCollectionRestoreResult } from "./collection-contracts.js";
import { resolveSkillCollectionBackupRoot } from "./collection-paths.js";
import { restoreSkillCollectionBackupTransaction } from "./collection-rollback.js";
import { readSkillProposalTargetTreeSha256 } from "./proposal-bundle.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";
import { withSkillCollectionLock } from "./target-lock.js";

type SkillCollectionChange = {
  action: "created" | "updated" | "removed";
  before?: PluginHookSkillArtifact;
  after?: PluginHookSkillArtifact;
};

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
