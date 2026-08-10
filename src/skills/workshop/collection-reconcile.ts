import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { removePathWithinRoot } from "../../infra/fs-safe-remove.js";
import { pathExists } from "../../infra/fs-safe.js";
import { withOpenClawStateLease } from "../../state/openclaw-state-lease.js";
import { normalizeSkillIndexName } from "../discovery/skill-index.js";
import { buildWorkspaceSkillStatus } from "../discovery/status.js";
import {
  applyWorkspaceSkillMutation,
  prepareWorkspaceSkillMutation,
  type PreparedWorkspaceSkillMutation,
} from "../lifecycle/workspace-skill-write.js";
import { bumpSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { resolveSkillWorkshopConfig } from "./config.js";
import { clearCuratedSkillLifecycle } from "./curator.js";
import { stripProposalFrontmatterForSkill } from "./frontmatter.js";
import { prepareSkillProposalDraft } from "./proposal-draft.js";
import { assertWritableSkillTarget } from "./workspace-skill-read.js";

const BACKUP_SCHEMA = "openclaw.skill-collection-backup.v1";
const BACKUP_REL_DIR = path.join("skill-workshop", "collection-backups");
const RECONCILE_LEASE_MS = 10 * 60_000;
const RECONCILE_LEASE_WAIT_MS = 5_000;
export const MAX_RECONCILED_SKILLS = 200;

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

export type SkillCollectionReconcileContext = {
  readSkillHashes?: Map<string, string>;
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
};

export function listWritableSkillCollection(
  workspaceDir: string,
  options: { agentId?: string; config?: OpenClawConfig } = {},
): WritableSkillCollectionEntry[] {
  const status = buildWorkspaceSkillStatus(workspaceDir, options);
  const byFile = new Map<string, WritableSkillCollectionEntry>();
  for (const skill of status.skills) {
    try {
      assertWritableSkillTarget(workspaceDir, skill);
    } catch {
      continue;
    }
    const filePath = path.resolve(skill.filePath);
    const entry = {
      name: skill.skillKey,
      baseDir: path.resolve(skill.baseDir),
      filePath,
      ...(skill.description ? { description: skill.description } : {}),
    };
    byFile.set(filePath, entry);
  }
  return [...byFile.values()].toSorted((left, right) => left.name.localeCompare(right.name));
}

export async function reconcileSkillCollection(params: {
  workspaceDir: string;
  plan: readonly SkillCollectionPlanEntry[];
  readSkillHashes: ReadonlyMap<string, string>;
  config?: OpenClawConfig;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<SkillCollectionReconcileResult> {
  const workspaceDir = path.resolve(params.workspaceDir);
  return await withOpenClawStateLease(
    {
      scope: "skill-collection",
      key: sha256Hex(workspaceDir),
      database: { scope: "shared", options: params.env ? { env: params.env } : {} },
      leaseMs: RECONCILE_LEASE_MS,
      waitMs: RECONCILE_LEASE_WAIT_MS,
      leaseLabel: "skill collection lease",
      operationLabel: "skill-collection.reconcile",
    },
    async () => {
      const current = listWritableSkillCollection(workspaceDir, {
        config: params.config,
        agentId: params.agentId,
      });
      const currentByName = new Map(current.map((skill) => [skill.name, skill]));
      if (currentByName.size !== current.length) {
        throw new Error("Writable skill names must be unique before collection reconciliation.");
      }
      const plan = validatePlan(params.plan, current, params.readSkillHashes);
      await assertReadsAreCurrent(current, params.readSkillHashes);
      const prepared = await prepareWrites({
        workspaceDir,
        current,
        plan,
        config: params.config,
      });
      const backup = await createCollectionBackup({ workspaceDir, current, plan, env: params.env });
      await pruneOlderBackups(backup.backupRoot, backup.manifest.id);
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
        throw error;
      }
      bumpSkillsSnapshotVersion({ reason: "workshop" });
      return {
        backupId: backup.manifest.id,
        kept: plan.filter((entry) => entry.action === "keep").map((entry) => entry.name),
        written: plan.filter((entry) => entry.action === "write").map((entry) => entry.name),
        dropped: plan
          .filter(
            (entry): entry is Extract<SkillCollectionPlanEntry, { action: "drop" }> =>
              entry.action === "drop",
          )
          .map((entry) => ({ name: entry.name, reason: entry.reason })),
      };
    },
  );
}

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
  for (const skill of current) {
    if (readSkillHashes.get(skill.name) !== sha256Hex(await fs.readFile(skill.filePath, "utf8"))) {
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
  backupRoot: string;
  manifest: CollectionBackupManifest;
}> {
  const backupRoot = collectionBackupRoot(params.workspaceDir, params.env);
  const id = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`;
  const backupDir = path.join(backupRoot, id);
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
  return { backupDir, backupRoot, manifest };
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

function collectionBackupRoot(workspaceDir: string, env?: NodeJS.ProcessEnv): string {
  return path.join(
    resolveStateDir(env),
    BACKUP_REL_DIR,
    sha256Hex(path.resolve(workspaceDir)).slice(0, 16),
  );
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
