import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { removePathWithinRoot } from "../../infra/fs-safe-remove.js";
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
import { assertWorkshopOwnedSkillDirs, listWorkshopOwnedSkillDirs } from "./ownership.js";
import { readSkillProposalTargetTreeSha256 } from "./proposal-bundle.js";
import { prepareSkillProposalDraft } from "./proposal-draft.js";
import { withSkillCollectionLock } from "./target-lock.js";
import { assertWritableSkillTarget, isWorkspaceOwnedSkillTarget } from "./workspace-skill-read.js";

const BACKUP_SCHEMA = "openclaw.skill-collection-backup.v1";
type CollectionBackupManifest = {
  schema: typeof BACKUP_SCHEMA;
  id: string;
  createdAt: string;
  workspaceDir: string;
  skillDirs: string[];
  resultSkillDirs: string[];
  resultSkillHashes: Record<string, string>;
};
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
        recordSkillCollectionReviewSuccess(
          workspaceDir,
          Date.now(),
          params.env ? { env: params.env } : {},
        );
        return {
          result: {
            backupId,
            kept: plan.map((entry) => entry.name),
            written: [],
            dropped: [],
          },
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
      await assertResultCollectionBytes(current, plan, prepared, MAX_RECONCILED_SKILL_BYTES);
      const backup = await createCollectionBackup({ workspaceDir, current, plan, env: params.env });
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
          const proposal = createProposals.get(mutation.skillFile.filePath);
          if (proposal) {
            await promoteCollectionCreateProposal({
              proposal,
              workspaceDir,
              env: params.env,
            });
          }
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
      recordSkillCollectionReviewSuccess(
        workspaceDir,
        Date.now(),
        params.env ? { env: params.env } : {},
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
        result: {
          backupId: backup.manifest.id,
          kept: plan.filter((entry) => entry.action === "keep").map((entry) => entry.name),
          written: plan.filter((entry) => entry.action === "write").map((entry) => entry.name),
          dropped: plan
            .filter(
              (entry): entry is Extract<SkillCollectionPlanEntry, { action: "drop" }> =>
                entry.action === "drop",
            )
            .map((entry) => ({ name: entry.name, reason: entry.reason })),
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
      assertWorkshopOwnedSkillDirs(
        workspaceDir,
        [...manifest.skillDirs, ...manifest.resultSkillDirs],
        params.env ? { env: params.env } : {},
      );
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

async function createCollectionBackup(params: {
  workspaceDir: string;
  current: readonly WritableSkillCollectionEntry[];
  plan: readonly SkillCollectionPlanEntry[];
  env?: NodeJS.ProcessEnv;
}): Promise<{
  backupDir: string;
  committedBackupDir: string;
  backupRoot: string;
  manifest: CollectionBackupManifest;
}> {
  const backupRoot = resolveSkillCollectionBackupRoot(params.workspaceDir, params.env);
  const id = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
  const backupDir = path.join(backupRoot, `.pending-${id}`);
  const committedBackupDir = path.join(backupRoot, id);
  const currentByName = new Map(params.current.map((skill) => [skill.name, skill]));
  // A restore must never rewrite a kept, externally owned skill. Back up only paths
  // this transaction may mutate; newly created result paths are removed on restore.
  const skillDirs = [
    ...new Set(
      params.plan.flatMap((entry) => {
        if (entry.action === "keep") {
          return [];
        }
        const existing = currentByName.get(entry.name);
        return existing ? [path.relative(params.workspaceDir, existing.baseDir)] : [];
      }),
    ),
  ].toSorted();
  const manifest: CollectionBackupManifest = {
    schema: BACKUP_SCHEMA,
    id,
    createdAt: new Date().toISOString(),
    workspaceDir: params.workspaceDir,
    skillDirs,
    resultSkillDirs: params.plan
      .filter((entry) => entry.action === "write")
      .map((entry) => {
        const existing = currentByName.get(entry.name);
        return path.relative(
          params.workspaceDir,
          existing?.baseDir ?? path.join(params.workspaceDir, "skills", entry.name),
        );
      }),
    resultSkillHashes: {},
  };
  await fs.mkdir(path.join(backupDir, "workspace"), { recursive: true });
  for (const relativeDir of skillDirs) {
    await fs.cp(
      path.join(params.workspaceDir, relativeDir),
      path.join(backupDir, "workspace", relativeDir),
      {
        recursive: true,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
      },
    );
  }
  await fs.writeFile(path.join(backupDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { backupDir, committedBackupDir, backupRoot, manifest };
}

async function commitCollectionBackup(
  workspaceDir: string,
  backup: Awaited<ReturnType<typeof createCollectionBackup>>,
): Promise<void> {
  for (const relativeDir of backup.manifest.resultSkillDirs) {
    backup.manifest.resultSkillHashes[relativeDir] = await readSkillProposalTargetTreeSha256(
      path.join(workspaceDir, relativeDir),
    );
  }
  await fs.writeFile(
    path.join(backup.backupDir, "manifest.json"),
    JSON.stringify(backup.manifest, null, 2),
  );
  await fs.rename(backup.backupDir, backup.committedBackupDir);
}

async function discardPendingCollectionBackup(
  backup: Awaited<ReturnType<typeof createCollectionBackup>>,
): Promise<void> {
  if (!(await pathExists(backup.backupDir))) {
    return;
  }
  await removePathWithinRoot({
    rootDir: backup.backupRoot,
    relativePath: path.basename(backup.backupDir),
    recursive: true,
    force: true,
  });
}

async function readCollectionBackupManifest(params: {
  backupDir: string;
  backupId: string;
  workspaceDir: string;
}): Promise<CollectionBackupManifest> {
  const record = asNullableRecord(
    JSON.parse(await fs.readFile(path.join(params.backupDir, "manifest.json"), "utf8")),
  );
  const skillDirs = readBackupSkillDirs(record?.skillDirs, "skillDirs", params.workspaceDir);
  const resultSkillDirs = readBackupSkillDirs(
    record?.resultSkillDirs,
    "resultSkillDirs",
    params.workspaceDir,
  );
  const resultSkillHashes = asNullableRecord(record?.resultSkillHashes);
  if (
    record?.schema !== BACKUP_SCHEMA ||
    record.id !== params.backupId ||
    typeof record.createdAt !== "string" ||
    typeof record.workspaceDir !== "string" ||
    canonicalSkillCollectionWorkspace(record.workspaceDir) !== params.workspaceDir ||
    !resultSkillHashes ||
    Object.keys(resultSkillHashes).some((relativeDir) => !resultSkillDirs.includes(relativeDir))
  ) {
    throw new Error(`Invalid skill collection backup: ${params.backupId}`);
  }
  const parsedResultSkillHashes: Record<string, string> = {};
  for (const relativeDir of resultSkillDirs) {
    const hash = resultSkillHashes[relativeDir];
    if (typeof hash !== "string") {
      throw new Error(`Invalid skill collection backup: ${params.backupId}`);
    }
    parsedResultSkillHashes[relativeDir] = hash;
  }
  for (const relativeDir of skillDirs) {
    if (!(await pathExists(path.join(params.backupDir, "workspace", relativeDir)))) {
      throw new Error(`Skill collection backup is incomplete: ${relativeDir}`);
    }
  }
  return {
    schema: BACKUP_SCHEMA,
    id: params.backupId,
    createdAt: record.createdAt,
    workspaceDir: params.workspaceDir,
    skillDirs,
    resultSkillDirs,
    resultSkillHashes: parsedResultSkillHashes,
  };
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

function readBackupSkillDirs(value: unknown, label: string, workspaceDir: string): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new Error(`Invalid skill collection backup ${label}.`);
  }
  const skillRoots = [
    path.join(workspaceDir, "skills"),
    path.join(workspaceDir, ".agents", "skills"),
  ];
  for (const relativeDir of value) {
    const absoluteDir = path.resolve(workspaceDir, relativeDir);
    const insideWritableRoot = skillRoots.some((rootDir) => {
      const relativeToRoot = path.relative(rootDir, absoluteDir);
      return (
        relativeToRoot &&
        !path.isAbsolute(relativeToRoot) &&
        !relativeToRoot.startsWith(`..${path.sep}`)
      );
    });
    if (!insideWritableRoot) {
      throw new Error(`Skill collection backup path is outside the workspace: ${relativeDir}`);
    }
  }
  return [...new Set(value)];
}

async function latestCommittedBackupId(backupRoot: string): Promise<string | undefined> {
  if (!(await pathExists(backupRoot))) {
    return undefined;
  }
  return (await fs.readdir(backupRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".pending-"))
    .map((entry) => entry.name)
    .toSorted()
    .at(-1);
}
