// Setup migration snapshots bind retries to unchanged source and target state.
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withFileLock } from "../infra/file-lock.js";
import type { MigrationPlan } from "../plugins/types.js";
import { resolveUserPath } from "../utils.js";

const SETUP_MIGRATION_LOCK_OPTIONS = {
  retries: { retries: 60, factor: 1, minTimeout: 500, maxTimeout: 500 },
  stale: 30 * 60 * 1000,
  staleRecovery: "remove-if-unchanged" as const,
};
const MEANINGFUL_CONFIG_IGNORED_KEYS = new Set(["$schema", "meta"]);
const MEANINGFUL_WIZARD_CONFIG_IGNORED_KEYS = new Set(["securityAcknowledgedAt"]);
const MEANINGFUL_WORKSPACE_ENTRIES = [
  "AGENTS.md",
  "SOUL.md",
  "USER.md",
  "IDENTITY.md",
  "MEMORY.md",
  "skills",
] as const;
const MEANINGFUL_STATE_ENTRIES = ["credentials", "sessions", "agents"] as const;

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .toSorted()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, canonicalizeJsonValue(record[key])]),
  );
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function hasDirectoryEntries(candidate: string): Promise<boolean> {
  try {
    return (await fs.readdir(candidate)).length > 0;
  } catch {
    return false;
  }
}

function hasMeaningfulWizardConfig(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return true;
  }
  return Object.keys(value as Record<string, unknown>).some(
    (key) => !MEANINGFUL_WIZARD_CONFIG_IGNORED_KEYS.has(key),
  );
}

function hasMeaningfulConfig(config: OpenClawConfig): boolean {
  return Object.entries(config as Record<string, unknown>).some(([key, value]) => {
    if (MEANINGFUL_CONFIG_IGNORED_KEYS.has(key)) {
      return false;
    }
    return key === "wizard" ? hasMeaningfulWizardConfig(value) : true;
  });
}

function buildSetupMigrationSnapshotConfig(config: OpenClawConfig): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config as Record<string, unknown>)) {
    if (MEANINGFUL_CONFIG_IGNORED_KEYS.has(key)) {
      continue;
    }
    if (key !== "wizard" || !value || typeof value !== "object" || Array.isArray(value)) {
      snapshot[key] = value;
      continue;
    }
    // Risk acknowledgement can be accepted between retries; freshness already ignores it.
    const wizard = Object.fromEntries(
      Object.entries(value).filter(
        ([wizardKey]) => !MEANINGFUL_WIZARD_CONFIG_IGNORED_KEYS.has(wizardKey),
      ),
    );
    if (Object.keys(wizard).length > 0) {
      snapshot[key] = wizard;
    }
  }
  return snapshot;
}

export async function inspectSetupMigrationFreshness(params: {
  baseConfig: OpenClawConfig;
  stateDir: string;
  workspaceDir: string;
}): Promise<{ fresh: boolean; reasons: string[] }> {
  const reasons: string[] = [];
  if (hasMeaningfulConfig(params.baseConfig)) {
    reasons.push("existing config values are loaded");
  }
  for (const entry of MEANINGFUL_WORKSPACE_ENTRIES) {
    if (await exists(path.join(params.workspaceDir, entry))) {
      reasons.push(`workspace ${entry} exists`);
    }
  }
  for (const entry of MEANINGFUL_STATE_ENTRIES) {
    if (await hasDirectoryEntries(path.join(params.stateDir, entry))) {
      reasons.push(`state ${entry}/ exists`);
    }
  }
  return { fresh: reasons.length === 0, reasons };
}

/** Preserves the acknowledgement accepted in-memory before the import lock is acquired. */
export function preserveSetupMigrationSecurityAcknowledgement(
  config: OpenClawConfig,
  inMemoryConfig: OpenClawConfig,
): OpenClawConfig {
  const securityAcknowledgedAt = inMemoryConfig.wizard?.securityAcknowledgedAt;
  if (!securityAcknowledgedAt || config.wizard?.securityAcknowledgedAt) {
    return config;
  }
  return {
    ...config,
    wizard: { ...config.wizard, securityAcknowledgedAt },
  };
}

async function hashTargetPath(
  hash: crypto.Hash,
  candidate: string,
  snapshotPath: string,
): Promise<void> {
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.lstat(candidate);
  } catch (error) {
    if (isMissingPathError(error)) {
      hash.update(`missing:${snapshotPath}\0`);
      return;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    hash.update(`symlink:${snapshotPath}\0${await fs.readlink(candidate)}\0`);
    return;
  }
  if (stat.isDirectory()) {
    hash.update(`directory:${snapshotPath}\0`);
    for (const entry of (await fs.readdir(candidate)).toSorted()) {
      await hashTargetPath(hash, path.join(candidate, entry), `${snapshotPath}/${entry}`);
    }
    return;
  }
  if (stat.isFile()) {
    hash.update(`file:${snapshotPath}\0${stat.size}\0`);
    for await (const chunk of createReadStream(candidate)) {
      hash.update(chunk);
    }
    hash.update("\0");
    return;
  }
  hash.update(`other:${snapshotPath}\0`);
}

async function hashSourcePath(
  hash: crypto.Hash,
  candidate: string,
  snapshotPath: string,
  followedRealPaths = new Set<string>(),
): Promise<void> {
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.lstat(candidate);
  } catch (error) {
    if (isMissingPathError(error)) {
      hash.update(`missing:${snapshotPath}\0`);
      return;
    }
    throw error;
  }
  if (stat.isSymbolicLink()) {
    hash.update(`symlink:${snapshotPath}\0${await fs.readlink(candidate)}\0`);
    let realPath: string;
    try {
      realPath = await fs.realpath(candidate);
    } catch (error) {
      hash.update(`unresolved:${(error as NodeJS.ErrnoException).code ?? "unknown"}\0`);
      return;
    }
    if (followedRealPaths.has(realPath)) {
      hash.update(`cycle:${snapshotPath}\0`);
      return;
    }
    followedRealPaths.add(realPath);
    await hashSourcePath(hash, realPath, `${snapshotPath}/referent`, followedRealPaths);
    followedRealPaths.delete(realPath);
    return;
  }
  if (stat.isDirectory()) {
    hash.update(`directory:${snapshotPath}\0`);
    for (const entry of (await fs.readdir(candidate)).toSorted()) {
      await hashSourcePath(
        hash,
        path.join(candidate, entry),
        `${snapshotPath}/${entry}`,
        followedRealPaths,
      );
    }
    return;
  }
  if (stat.isFile()) {
    hash.update(`file:${snapshotPath}\0${stat.size}\0`);
    for await (const chunk of createReadStream(candidate)) {
      hash.update(chunk);
    }
    hash.update("\0");
    return;
  }
  hash.update(`other:${snapshotPath}\0`);
}

/** Hashes migration-owned target state without persisting raw paths or values. */
export async function buildSetupMigrationTargetSnapshot(params: {
  config: OpenClawConfig;
  stateDir: string;
  workspaceDir: string;
}): Promise<string> {
  const hash = crypto.createHash("sha256");
  const targetConfig = buildSetupMigrationSnapshotConfig(params.config);
  hash.update(`config:${JSON.stringify(canonicalizeJsonValue(targetConfig))}\0`);
  for (const entry of MEANINGFUL_WORKSPACE_ENTRIES) {
    await hashTargetPath(hash, path.join(params.workspaceDir, entry), `workspace/${entry}`);
  }
  for (const entry of MEANINGFUL_STATE_ENTRIES) {
    await hashTargetPath(hash, path.join(params.stateDir, entry), `state/${entry}`);
  }
  return hash.digest("hex");
}

/** Hashes only source paths represented by the provider's concrete migration plan. */
export async function buildSetupMigrationPlanSourceSnapshot(plan: MigrationPlan): Promise<string> {
  const hash = crypto.createHash("sha256");
  const itemSources = [
    ...new Set(
      plan.items
        .map((item) => item.source?.trim())
        .filter((source): source is string => Boolean(source))
        .map((source) => path.resolve(resolveUserPath(source))),
    ),
  ].toSorted();
  const sources = [
    ...new Set(
      itemSources.flatMap((source) =>
        path.extname(source) === ".db"
          ? [source, `${source}-wal`, `${source}-shm`, `${source}-journal`]
          : [source],
      ),
    ),
  ].toSorted();
  for (const [index, source] of sources.entries()) {
    await hashSourcePath(hash, source, `source/${index}`);
  }
  return hash.digest("hex");
}

/** Verifies planning inputs and builds the exact provider-side-effect retry boundary. */
export async function prepareSetupMigrationAttemptBoundary(params: {
  currentConfig: OpenClawConfig;
  targetConfig: OpenClawConfig;
  stateDir: string;
  workspaceDir: string;
  plan: MigrationPlan;
  expectedTargetSnapshotHash: string;
  expectedSourceSnapshotHash: string;
}): Promise<{
  sourceSnapshotHash: string;
  preparedTargetSnapshotHash: string;
  targetSnapshotHash: string;
}> {
  const currentTargetSnapshotHash = await buildSetupMigrationTargetSnapshot({
    config: params.currentConfig,
    stateDir: params.stateDir,
    workspaceDir: params.workspaceDir,
  });
  if (currentTargetSnapshotHash !== params.expectedTargetSnapshotHash) {
    throw new Error("Migration target changed while preparing the import. Review it and retry.");
  }
  const sourceSnapshotHash = await buildSetupMigrationPlanSourceSnapshot(params.plan);
  if (sourceSnapshotHash !== params.expectedSourceSnapshotHash) {
    throw new Error("Migration source changed while preparing the import. Review it and retry.");
  }
  return {
    sourceSnapshotHash,
    preparedTargetSnapshotHash: currentTargetSnapshotHash,
    targetSnapshotHash: await buildSetupMigrationTargetSnapshot({
      config: params.targetConfig,
      stateDir: params.stateDir,
      workspaceDir: params.workspaceDir,
    }),
  };
}

/** Serializes all onboarding migration writes that share one OpenClaw state target. */
export async function withSetupMigrationTargetLock<T>(
  stateDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const migrationDir = path.join(stateDir, "migration");
  await fs.mkdir(migrationDir, { recursive: true, mode: 0o700 });
  return await withFileLock(
    path.join(migrationDir, "onboarding.lock-target"),
    SETUP_MIGRATION_LOCK_OPTIONS,
    fn,
  );
}

export function assertFreshSetupMigrationTarget(freshness: {
  fresh: boolean;
  reasons: readonly string[];
}): void {
  if (freshness.fresh) {
    return;
  }
  throw new Error(
    [
      "Migration import during onboarding requires a fresh OpenClaw setup.",
      "Create a fresh setup or reset config, credentials, sessions, and workspace before importing.",
      "Backup plus overwrite/merge imports are feature-gated for now.",
      "Existing setup:",
      ...freshness.reasons.map((reason) => `- ${reason}`),
    ].join("\n"),
  );
}
