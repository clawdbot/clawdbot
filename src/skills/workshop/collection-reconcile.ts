import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { removePathWithinRoot } from "../../infra/fs-safe-remove.js";
import { pathExists } from "../../infra/fs-safe.js";
import type { PluginHookSkillArtifact } from "../../plugins/hook-types.js";
import { normalizeSkillIndexName } from "../discovery/skill-index.js";
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
import { resolveSkillWorkshopConfig } from "./config.js";
import { clearCuratedSkillLifecycle } from "./curator.js";
import { stripProposalFrontmatterForSkill } from "./frontmatter.js";
import { readSkillProposalTargetTreeSha256 } from "./proposal-bundle.js";
import { prepareSkillProposalDraft } from "./proposal-draft.js";
import { withSkillCollectionLock } from "./target-lock.js";
import { assertWritableSkillTarget } from "./workspace-skill-read.js";

const BACKUP_SCHEMA = "openclaw.skill-collection-backup.v1";
const BACKUP_REL_DIR = path.join("skill-workshop", "collection-backups");
export const MAX_RECONCILED_SKILLS = 200;
export const MAX_RECONCILED_SKILL_BYTES = 240_000;

export type SkillCollectionPlanEntry =
  | { action: "keep"; name: string }
  | { action: "drop"; name: string; reason: string }
  | { action: "write"; name: string; description: string; content: string };

export type SkillCollectionReconcileResult = {
  backupId: string;
  kept: string[];
  written: string[];
  dropped: Array<{ name: string; reason: string }>;
};

export type SkillCollectionRestoreResult = {
  backupId: string;
  restored: string[];
  removed: string[];
};

export type SkillCollectionReconcileContext = {
  agentIds?: string[];
  approvedSkillNames?: Set<string>;
  readSkillHashes?: Map<string, string>;
  readSkillBytes?: Map<string, number>;
  readByteCount?: number;
  result?: SkillCollectionReconcileResult;
};

export type WritableSkillCollectionEntry = {
  name: string;
  description?: string;
  baseDir: string;
  filePath: string;
};

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
  options: { agentId?: string; agentIds?: readonly string[]; config?: OpenClawConfig } = {},
): WritableSkillCollectionEntry[] {
  const agentIds = options.agentIds?.length ? options.agentIds : [options.agentId];
  const byFile = new Map<string, WritableSkillCollectionEntry>();
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
      const filePath = path.resolve(skill.filePath);
      byFile.set(filePath, {
        name: skill.skillKey,
        baseDir: path.resolve(skill.baseDir),
        filePath,
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
  config?: OpenClawConfig;
  agentId?: string;
  agentIds?: readonly string[];
  env?: NodeJS.ProcessEnv;
}): Promise<SkillCollectionReconcileResult> {
  const workspaceDir = path.resolve(params.workspaceDir);
  const commit = await withSkillCollectionLock(
    workspaceDir,
    async () => {
      const current = listWritableSkillCollection(workspaceDir, {
        config: params.config,
        agentId: params.agentId,
        agentIds: params.agentIds,
      });
      const currentByName = new Map(current.map((skill) => [skill.name, skill]));
      if (currentByName.size !== current.length) {
        throw new Error("Writable skill names must be unique before collection reconciliation.");
      }
      const plan = validatePlan(params.plan, current, params.readSkillHashes);
      await assertReadsAreCurrent(current, params.readSkillHashes);
      if (plan.every((entry) => entry.action === "keep")) {
        clearCuratedSkillLifecycle(
          current.map((skill) => skill.filePath),
          params.env ? { env: params.env } : {},
        );
        const backupRoot = collectionBackupRoot(workspaceDir, params.env);
        let backupId = await latestCommittedBackupId(backupRoot);
        if (!backupId) {
          const backup = await createCollectionBackup({
            workspaceDir,
            current,
            plan,
            env: params.env,
          });
          await commitCollectionBackup(workspaceDir, backup);
          backupId = backup.manifest.id;
        }
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
        for (const mutation of prepared) {
          await applyWorkspaceSkillMutation(mutation);
        }
        for (const entry of plan) {
          if (entry.action !== "drop") {
            continue;
          }
          const skill = currentByName.get(entry.name)!;
          await removeSkillDirectory(workspaceDir, skill.baseDir);
        }
        clearCuratedSkillLifecycle(
          current.map((skill) => skill.filePath),
          params.env ? { env: params.env } : {},
        );
        await commitCollectionBackup(workspaceDir, backup);
      } catch (error) {
        try {
          await restoreCollectionBackup({
            workspaceDir,
            backupDir: backup.backupDir,
            manifest: backup.manifest,
          });
        } catch (restoreError) {
          throw new Error(
            `Skill collection reconciliation failed (${String(error)}) and backup ${backup.manifest.id} could not be restored.`,
            { cause: restoreError },
          );
        }
        if (await pathExists(backup.backupDir)) {
          await removePathWithinRoot({
            rootDir: backup.backupRoot,
            relativePath: path.basename(backup.backupDir),
            recursive: true,
            force: true,
          });
        }
        throw error;
      }
      await pruneOlderBackups(backup.backupRoot, backup.manifest.id);
      bumpSkillsSnapshotVersion({ reason: "workshop" });
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
  const workspaceDir = path.resolve(params.workspaceDir);
  const commit = await withSkillCollectionLock(
    workspaceDir,
    async () => {
      const backupRoot = collectionBackupRoot(workspaceDir, params.env);
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
      await restoreCollectionBackup({ workspaceDir, backupDir, manifest });
      bumpSkillsSnapshotVersion({ reason: "workshop" });
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

type SkillCollectionChange = {
  action: "created" | "updated" | "removed";
  before?: PluginHookSkillArtifact;
  after?: PluginHookSkillArtifact;
};

function validatePlan(
  input: readonly SkillCollectionPlanEntry[],
  current: readonly WritableSkillCollectionEntry[],
  readSkillHashes: ReadonlyMap<string, string>,
): SkillCollectionPlanEntry[] {
  if (input.length > MAX_RECONCILED_SKILLS) {
    throw new Error(`A skill collection can contain at most ${MAX_RECONCILED_SKILLS} decisions.`);
  }
  const currentNames = new Set(current.map((skill) => skill.name));
  const unread = current.map((skill) => skill.name).filter((name) => !readSkillHashes.has(name));
  if (unread.length > 0) {
    throw new Error(`Read every current skill before reconciling: ${unread.join(", ")}`);
  }
  const seen = new Set<string>();
  for (const entry of input) {
    const normalized = normalizeSkillIndexName(entry.name);
    if (!normalized || normalized !== entry.name) {
      throw new Error(`Invalid skill name: ${entry.name}`);
    }
    if (seen.has(entry.name)) {
      throw new Error(`Duplicate skill decision: ${entry.name}`);
    }
    seen.add(entry.name);
    if (entry.action !== "write" && !currentNames.has(entry.name)) {
      throw new Error(`Cannot ${entry.action} a skill that does not exist: ${entry.name}`);
    }
    if (entry.action === "drop" && !entry.reason.trim()) {
      throw new Error(`Drop reason required: ${entry.name}`);
    }
    if (entry.action === "write" && (!entry.description.trim() || !entry.content.trim())) {
      throw new Error(`Complete description and content required: ${entry.name}`);
    }
  }
  const missing = current.map((skill) => skill.name).filter((name) => !seen.has(name));
  if (missing.length > 0) {
    throw new Error(`Every current skill needs one decision: ${missing.join(", ")}`);
  }
  return [...input];
}

async function assertReadsAreCurrent(
  current: readonly WritableSkillCollectionEntry[],
  readSkillHashes: ReadonlyMap<string, string>,
): Promise<void> {
  let totalBytes = 0;
  for (const skill of current) {
    const content = await fs.readFile(skill.filePath, "utf8");
    totalBytes += Buffer.byteLength(content);
    if (totalBytes > MAX_RECONCILED_SKILL_BYTES) {
      throw new Error(
        `Writable skill collection exceeds the ${MAX_RECONCILED_SKILL_BYTES}-byte review limit.`,
      );
    }
    if (readSkillHashes.get(skill.name) !== sha256Hex(content)) {
      throw new Error(`Skill changed after it was read: ${skill.name}`);
    }
  }
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
  const backupRoot = collectionBackupRoot(params.workspaceDir, params.env);
  const id = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
  const backupDir = path.join(backupRoot, `.pending-${id}`);
  const committedBackupDir = path.join(backupRoot, id);
  const skillDirs = [
    ...new Set(params.current.map((skill) => path.relative(params.workspaceDir, skill.baseDir))),
  ].toSorted();
  const currentByName = new Map(params.current.map((skill) => [skill.name, skill]));
  const manifest: CollectionBackupManifest = {
    schema: BACKUP_SCHEMA,
    id,
    createdAt: new Date().toISOString(),
    workspaceDir: params.workspaceDir,
    skillDirs,
    resultSkillDirs: params.plan
      .filter((entry) => entry.action !== "drop")
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

async function restoreCollectionBackup(params: {
  workspaceDir: string;
  backupDir: string;
  manifest: CollectionBackupManifest;
}): Promise<void> {
  const removeDirs = new Set([
    ...params.manifest.skillDirs.map((relativeDir) => path.join(params.workspaceDir, relativeDir)),
    ...params.manifest.resultSkillDirs.map((relativeDir) =>
      path.join(params.workspaceDir, relativeDir),
    ),
  ]);
  for (const skillDir of [...removeDirs].toSorted((left, right) => right.length - left.length)) {
    if (await pathExists(skillDir)) {
      await removeSkillDirectory(params.workspaceDir, skillDir);
    }
  }
  for (const relativeDir of params.manifest.skillDirs) {
    await fs.mkdir(path.dirname(path.join(params.workspaceDir, relativeDir)), { recursive: true });
    await fs.cp(
      path.join(params.backupDir, "workspace", relativeDir),
      path.join(params.workspaceDir, relativeDir),
      { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true },
    );
  }
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
    path.resolve(record.workspaceDir) !== params.workspaceDir ||
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
  const skillsDir = path.join(workspaceDir, "skills");
  for (const relativeDir of value) {
    const relativeToSkills = path.relative(skillsDir, path.resolve(workspaceDir, relativeDir));
    if (
      !relativeToSkills ||
      path.isAbsolute(relativeToSkills) ||
      relativeToSkills.startsWith(`..${path.sep}`)
    ) {
      throw new Error(`Skill collection backup path is outside the workspace: ${relativeDir}`);
    }
  }
  return [...new Set(value)];
}

function collectionBackupRoot(workspaceDir: string, env?: NodeJS.ProcessEnv): string {
  return path.join(
    resolveStateDir(env),
    BACKUP_REL_DIR,
    sha256Hex(path.resolve(workspaceDir)).slice(0, 16),
  );
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

async function pruneOlderBackups(backupRoot: string, keepId: string): Promise<void> {
  for (const entry of await fs.readdir(backupRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name !== keepId) {
      await removePathWithinRoot({
        rootDir: backupRoot,
        relativePath: entry.name,
        recursive: true,
        force: true,
      });
    }
  }
}

async function removeSkillDirectory(workspaceDir: string, skillDir: string): Promise<void> {
  const relativePath = path.relative(workspaceDir, skillDir);
  if (!relativePath || path.isAbsolute(relativePath) || relativePath.startsWith(`..${path.sep}`)) {
    throw new Error(`Skill directory must be inside the workspace: ${skillDir}`);
  }
  await removePathWithinRoot({
    rootDir: workspaceDir,
    relativePath,
    recursive: true,
    force: false,
  });
}
