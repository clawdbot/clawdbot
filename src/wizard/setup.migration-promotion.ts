// Setup migration promotion owns durable journals, rollback, and path validation.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readDurableJsonFile, writeJsonAtomic } from "../infra/json-files.js";
import { isNotFoundPathError } from "../infra/path-guards.js";
import type { MigrationApplyResult, MigrationPlan } from "../plugins/types.js";

export const PROMOTION_JOURNAL_FILE = "onboarding-promotion.json";
export const PROMOTION_JOURNAL_VERSION = 1;

type PromotionStatus =
  | "prepared"
  | "promoting"
  | "committed"
  | "completed"
  | "rolled-back"
  | "indeterminate";
export type PromotionComponent = {
  name: "workspace" | "agent" | "state";
  stagedPath: string;
  finalPath: string;
  status: "staged" | "promoted" | "rolled-back";
  targetWasEmptyDirectory?: boolean;
  emptyTargetBackupPath?: string;
  createdParentPaths?: string[];
};
export type SetupMigrationPromotionOutcome =
  | { kind: "verified-inference"; modelRef: string }
  | { kind: "no-imported-inference" };

export type SetupMigrationPromotionContinuation = {
  providerLabel: string;
  source?: string;
  includeSecrets?: boolean;
  providerOptions?: Record<string, unknown>;
  plan: MigrationPlan;
  stagedResult: MigrationApplyResult;
  deferredResult?: MigrationApplyResult;
  outcome: SetupMigrationPromotionOutcome;
  continueOnboarding: boolean;
  workspaceDir: string;
  stagedReportDir: string;
  stagedRoots: string[];
};

export type PromotionJournal = {
  version: typeof PROMOTION_JOURNAL_VERSION;
  status: PromotionStatus;
  providerId: string;
  configHashBefore: string;
  configHashTarget: string;
  components: PromotionComponent[];
  continuation?: SetupMigrationPromotionContinuation;
  updatedAt: string;
};

export type SetupMigrationPromotionResume = {
  journalPath: string;
  continuation: SetupMigrationPromotionContinuation;
  copyReportArtifacts: () => Promise<void>;
  saveDeferredResult: (result: MigrationApplyResult) => Promise<void>;
  complete: () => Promise<void>;
  acknowledge: () => Promise<void>;
  cleanup: () => Promise<void>;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .toSorted()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, canonicalize(record[key])]),
  );
}

function hashConfig(config: OpenClawConfig): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(canonicalize(config)))
    .digest("hex");
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.lstat(candidate);
    return true;
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return false;
    }
    throw error;
  }
}

async function readLatestPromotionJournal(params: {
  stateDir: string;
  providerId: string;
}): Promise<{ path: string; journal: PromotionJournal } | undefined> {
  const root = path.join(params.stateDir, "migration", params.providerId);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return undefined;
    }
    throw error;
  }
  for (const entry of entries
    .filter((candidate) => candidate.isDirectory())
    .toSorted((left, right) => right.name.localeCompare(left.name))) {
    const journalPath = path.join(root, entry.name, PROMOTION_JOURNAL_FILE);
    const value = await readDurableJsonFile<PromotionJournal>(journalPath);
    if (value?.version === PROMOTION_JOURNAL_VERSION && value.providerId === params.providerId) {
      return { path: journalPath, journal: value };
    }
  }
  return undefined;
}

export async function writePromotionJournal(
  journalPath: string,
  journal: PromotionJournal,
): Promise<void> {
  await writeJsonAtomic(
    journalPath,
    { ...journal, updatedAt: new Date().toISOString() },
    { mode: 0o600, dirMode: 0o700, trailingNewline: true },
  );
}

async function copyPromotionReportArtifacts(params: {
  stagedReportDir: string;
  reportDir: string;
}): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(params.stagedReportDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return;
    }
    throw error;
  }
  await fs.mkdir(params.reportDir, { recursive: true, mode: 0o700 });
  for (const entry of entries) {
    if (
      entry.name === "report.json" ||
      entry.name === "summary.md" ||
      entry.name === PROMOTION_JOURNAL_FILE
    ) {
      continue;
    }
    await fs.cp(
      path.join(params.stagedReportDir, entry.name),
      path.join(params.reportDir, entry.name),
      { recursive: true, force: true },
    );
  }
}

async function cleanupPromotionStaging(continuation: SetupMigrationPromotionContinuation) {
  await Promise.all(
    continuation.stagedRoots.map(
      async (root) => await fs.rm(root, { recursive: true, force: true }),
    ),
  );
}

export function createPromotionResume(
  journalPath: string,
  journal: PromotionJournal,
): SetupMigrationPromotionResume {
  const continuation = journal.continuation;
  if (!continuation) {
    throw new Error(`Onboarding migration continuation is missing from ${journalPath}.`);
  }
  return {
    journalPath,
    continuation,
    copyReportArtifacts: async () =>
      await copyPromotionReportArtifacts({
        stagedReportDir: continuation.stagedReportDir,
        reportDir: path.dirname(journalPath),
      }),
    async saveDeferredResult(result) {
      continuation.deferredResult = result;
      await writePromotionJournal(journalPath, journal);
    },
    async complete() {
      journal.status = "completed";
      await writePromotionJournal(journalPath, journal);
    },
    async acknowledge() {
      await Promise.all(
        journal.components.map(async (component) => {
          if (component.emptyTargetBackupPath) {
            await fs.rm(component.emptyTargetBackupPath, { recursive: true, force: true });
          }
        }),
      );
      await fs.rm(journalPath, { force: true });
    },
    cleanup: async () => await cleanupPromotionStaging(continuation),
  };
}

async function removeCreatedPromotionParents(components: PromotionComponent[]): Promise<void> {
  const parents = [
    ...new Set(components.flatMap((component) => component.createdParentPaths ?? [])),
  ].toSorted((left, right) => right.length - left.length || right.localeCompare(left));
  for (const parent of parents) {
    try {
      await fs.rmdir(parent);
    } catch (error) {
      if (isNotFoundPathError(error)) {
        continue;
      }
      throw error;
    }
  }
}

export async function rollbackComponents(components: PromotionComponent[]): Promise<boolean> {
  try {
    for (const component of components.toReversed()) {
      const stagedExists = await pathExists(component.stagedPath);
      const finalExists = await pathExists(component.finalPath);
      const backupExists = component.emptyTargetBackupPath
        ? await pathExists(component.emptyTargetBackupPath)
        : false;
      if (!stagedExists && !finalExists) {
        return false;
      }
      if (finalExists && !stagedExists) {
        await fs.mkdir(path.dirname(component.stagedPath), { recursive: true, mode: 0o700 });
        await fs.rename(component.finalPath, component.stagedPath);
      } else if (finalExists && stagedExists) {
        if (
          backupExists ||
          !component.targetWasEmptyDirectory ||
          (await fs.readdir(component.finalPath)).length > 0
        ) {
          return false;
        }
      }
      if (backupExists) {
        if (await pathExists(component.finalPath)) {
          return false;
        }
        await fs.rename(component.emptyTargetBackupPath!, component.finalPath);
      } else if (component.targetWasEmptyDirectory) {
        await fs.mkdir(component.finalPath, { recursive: true, mode: 0o700 });
      }
      component.status = "rolled-back";
    }
    await removeCreatedPromotionParents(components);
    return true;
  } catch {
    return false;
  }
}

async function hasPublishedPromotionComponent(components: PromotionComponent[]): Promise<boolean> {
  for (const component of components) {
    if (component.status === "promoted") {
      return true;
    }
    const [stagedExists, finalExists] = await Promise.all([
      pathExists(component.stagedPath),
      pathExists(component.finalPath),
    ]);
    if (!stagedExists && finalExists) {
      return true;
    }
  }
  return false;
}

/** Reconciles interrupted promotion and returns any committed finalization to resume. */
export async function recoverSetupMigrationPromotion(params: {
  stateDir: string;
  providerId: string;
  readConfigFile: () => Promise<OpenClawConfig>;
}): Promise<SetupMigrationPromotionResume | undefined> {
  const found = await readLatestPromotionJournal(params);
  if (!found) {
    return undefined;
  }
  const journal = found.journal;
  if (journal.status === "rolled-back") {
    if (journal.continuation) {
      await cleanupPromotionStaging(journal.continuation);
    }
    return undefined;
  }
  if (journal.status === "indeterminate") {
    throw new Error(
      `An onboarding migration promotion is indeterminate. Review ${found.path} and run openclaw doctor before retrying.`,
    );
  }
  const currentConfigHash = hashConfig(await params.readConfigFile());
  const allFinal = (
    await Promise.all(journal.components.map((component) => pathExists(component.finalPath)))
  ).every(Boolean);
  if (journal.status === "completed") {
    return createPromotionResume(found.path, journal);
  }
  if (journal.status === "committed") {
    if (allFinal) {
      return createPromotionResume(found.path, journal);
    }
    journal.status = "indeterminate";
    await writePromotionJournal(found.path, journal);
    throw new Error(
      `A committed onboarding migration no longer matches its promoted target. Review ${found.path} and run openclaw doctor before retrying.`,
    );
  }
  if (currentConfigHash === journal.configHashTarget && allFinal) {
    journal.status = "committed";
    await writePromotionJournal(found.path, journal);
    return createPromotionResume(found.path, journal);
  }
  if (currentConfigHash === journal.configHashBefore) {
    if (await hasPublishedPromotionComponent(journal.components)) {
      journal.status = "indeterminate";
      await writePromotionJournal(found.path, journal);
      throw new Error(
        `An interrupted onboarding migration published local data before config commit. Review ${found.path} and run openclaw doctor before retrying.`,
      );
    }
    if (await rollbackComponents(journal.components)) {
      journal.status = "rolled-back";
      await writePromotionJournal(found.path, journal);
      if (journal.continuation) {
        await cleanupPromotionStaging(journal.continuation);
      }
      return undefined;
    }
  }
  journal.status = "indeterminate";
  await writePromotionJournal(found.path, journal);
  throw new Error(
    `Could not reconcile an interrupted onboarding migration. Review ${found.path} and run openclaw doctor before retrying.`,
  );
}

async function listMissingPromotionParents(target: string): Promise<string[]> {
  const missing: string[] = [];
  let current = path.dirname(target);
  while (!(await pathExists(current))) {
    missing.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`Could not find an existing parent for migration promotion at ${target}.`);
    }
    current = parent;
  }
  return missing;
}

async function reserveEmptyTargetBackupPath(target: string): Promise<string> {
  const reserved = await fs.mkdtemp(path.join(path.dirname(target), ".openclaw-migration-empty-"));
  await fs.rmdir(reserved);
  return reserved;
}

export async function recordPromotionTargetState(component: PromotionComponent): Promise<void> {
  component.createdParentPaths = await listMissingPromotionParents(component.finalPath);
  if (!(await pathExists(component.finalPath))) {
    return;
  }
  const stat = await fs.lstat(component.finalPath);
  if (!stat.isDirectory() || (await fs.readdir(component.finalPath)).length > 0) {
    throw new Error(`Migration target changed before promotion: ${component.finalPath}`);
  }
  component.targetWasEmptyDirectory = true;
  component.emptyTargetBackupPath = await reserveEmptyTargetBackupPath(component.finalPath);
}

export async function moveRecordedEmptyTarget(component: PromotionComponent): Promise<void> {
  if (!component.targetWasEmptyDirectory) {
    return;
  }
  const entries = await fs.readdir(component.finalPath);
  if (entries.length > 0) {
    throw new Error(`Migration target changed before promotion: ${component.finalPath}`);
  }
  if (component.emptyTargetBackupPath) {
    await fs.rename(component.finalPath, component.emptyTargetBackupPath);
  } else {
    await fs.rmdir(component.finalPath);
  }
}

async function usesCaseInsensitivePaths(directory: string): Promise<boolean> {
  const probe = await fs.mkdtemp(path.join(directory, ".openclaw-case-probe-"));
  try {
    const alias = path.join(path.dirname(probe), path.basename(probe).toUpperCase());
    if (alias === probe) {
      return false;
    }
    await fs.access(alias);
    return true;
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return false;
    }
    throw error;
  } finally {
    await fs.rm(probe, { recursive: true, force: true });
  }
}

async function usesNormalizationInsensitivePaths(directory: string): Promise<boolean> {
  const probe = await fs.mkdtemp(path.join(directory, ".openclaw-normalization-é-"));
  try {
    const alias = path.join(path.dirname(probe), path.basename(probe).normalize("NFD"));
    if (alias === probe) {
      return false;
    }
    await fs.access(alias);
    return true;
  } catch (error) {
    if (isNotFoundPathError(error)) {
      return false;
    }
    throw error;
  } finally {
    await fs.rm(probe, { recursive: true, force: true });
  }
}

async function canonicalizePromotionPath(
  candidate: string,
): Promise<{ path: string; caseInsensitive: boolean; normalizationInsensitive: boolean }> {
  const suffix: string[] = [];
  let current = path.resolve(candidate);
  while (true) {
    try {
      const ancestor = await fs.realpath(current);
      const probeDirectory = (await fs.stat(ancestor)).isDirectory()
        ? ancestor
        : path.dirname(ancestor);
      return {
        path: path.join(ancestor, ...suffix.toReversed()),
        caseInsensitive: await usesCaseInsensitivePaths(probeDirectory),
        normalizationInsensitive: await usesNormalizationInsensitivePaths(probeDirectory),
      };
    } catch (error) {
      if (!isNotFoundPathError(error)) {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`Could not resolve a promotion target for ${candidate}.`, { cause: error });
      }
      suffix.push(path.basename(current));
      current = parent;
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const relative = path.relative(left, right);
  return (
    relative.length === 0 ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export async function assertSupportedStagedStateTree(params: {
  stagedStateDir: string;
  agentId: string;
  providerId: string;
  reportDirName: string;
}): Promise<void> {
  const assertEntries = async (directory: string, allowed: ReadonlySet<string>) => {
    let entries: string[];
    try {
      entries = await fs.readdir(directory);
    } catch (error) {
      if (isNotFoundPathError(error)) {
        return;
      }
      throw error;
    }
    const unexpected = entries.filter((entry) => !allowed.has(entry));
    if (unexpected.length > 0) {
      throw new Error(
        `Migration provider wrote unsupported staged state: ${unexpected
          .map((entry) => path.join(directory, entry))
          .join(", ")}.`,
      );
    }
  };
  await assertEntries(params.stagedStateDir, new Set(["agents", "migration", "state"]));
  await assertEntries(path.join(params.stagedStateDir, "agents"), new Set([params.agentId]));
  await assertEntries(
    path.join(params.stagedStateDir, "agents", params.agentId),
    new Set(["agent"]),
  );
  await assertEntries(path.join(params.stagedStateDir, "migration"), new Set([params.providerId]));
  await assertEntries(
    path.join(params.stagedStateDir, "migration", params.providerId),
    new Set([params.reportDirName]),
  );
}

export async function assertDisjointPromotionTargets(
  components: ReadonlyArray<Pick<PromotionComponent, "finalPath">>,
): Promise<void> {
  const canonicalPaths = await Promise.all(
    components.map(async (component) => ({
      component,
      path: await canonicalizePromotionPath(component.finalPath),
    })),
  );
  for (const [index, current] of canonicalPaths.entries()) {
    for (const other of canonicalPaths.slice(index + 1)) {
      const caseInsensitive = current.path.caseInsensitive || other.path.caseInsensitive;
      const normalizationInsensitive =
        current.path.normalizationInsensitive || other.path.normalizationInsensitive;
      const normalizePath = (pathname: string) => {
        const normalized = normalizationInsensitive ? pathname.normalize("NFC") : pathname;
        return caseInsensitive ? normalized.toLocaleLowerCase("en-US") : normalized;
      };
      const currentPath = normalizePath(current.path.path);
      const otherPath = normalizePath(other.path.path);
      if (pathsOverlap(currentPath, otherPath) || pathsOverlap(otherPath, currentPath)) {
        throw new Error(
          `Migration promotion targets overlap: ${current.component.finalPath} and ${other.component.finalPath}.`,
        );
      }
    }
  }
}
