// Setup migration snapshots bind retries to unchanged source and target state.
import { AsyncLocalStorage } from "node:async_hooks";
import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { FILE_LOCK_TIMEOUT_ERROR_CODE, withFileLock } from "../infra/file-lock.js";
import { readJsonFile } from "../infra/json-files.js";
import { isNotFoundPathError } from "../infra/path-guards.js";
import type { MigrationPlan } from "../plugins/types.js";
import { resolveUserPath } from "../utils.js";
import { canonicalizeSetupMigrationValue } from "./setup.migration-canonical.js";

const ONBOARDING_TARGET_LOCK_OPTIONS = {
  retries: { retries: 0, factor: 1, minTimeout: 1, maxTimeout: 1 },
  stale: 30 * 60 * 1000,
  staleRecovery: "remove-if-unchanged" as const,
};
const activeSetupMigrationTargetLock = new AsyncLocalStorage<string>();
const MEANINGFUL_CONFIG_IGNORED_KEYS = new Set(["$schema", "meta", "telemetry"]);
const MEANINGFUL_WIZARD_CONFIG_IGNORED_KEYS = new Set(["securityAcknowledgedAt"]);
const MEANINGFUL_WORKSPACE_ENTRIES = [
  "AGENTS.md",
  "SOUL.md",
  "USER.md",
  "IDENTITY.md",
  "MEMORY.md",
  "skills",
] as const;
const IMPORT_BLOCKING_STATE_ENTRIES = ["credentials", "sessions", "agents"] as const;

export class SetupTargetLockedError extends Error {
  readonly code = "setup_target_locked";

  constructor(
    public readonly holderPid: number | undefined,
    profile: string | undefined,
    cause: unknown,
  ) {
    const target = profile ? `profile ${profile}` : "the current profile";
    const owner = holderPid === undefined ? "" : ` (pid ${holderPid})`;
    super(
      `Another onboarding/config operation is running for ${target}${owner}. Finish or abort it, then re-run.`,
      { cause },
    );
    this.name = "SetupTargetLockedError";
  }
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
  if (
    reasons.every((reason) => !reason.startsWith("workspace ")) &&
    (await hasDirectoryEntries(params.workspaceDir))
  ) {
    reasons.push("workspace directory is not empty");
  }
  for (const entry of IMPORT_BLOCKING_STATE_ENTRIES) {
    if (await hasDirectoryEntries(path.join(params.stateDir, entry))) {
      reasons.push(`state ${entry}/ exists`);
    }
  }
  return { fresh: reasons.length === 0, reasons };
}

/** Preserve interactive consent decisions made before the import lock rereads config. */
export function preserveSetupMigrationOnboardingConsents(
  config: OpenClawConfig,
  inMemoryConfig: OpenClawConfig,
): OpenClawConfig {
  const securityAcknowledgedAt = inMemoryConfig.wizard?.securityAcknowledgedAt;
  const preserveSecurity = securityAcknowledgedAt && !config.wizard?.securityAcknowledgedAt;
  const preserveTelemetry = inMemoryConfig.telemetry?.consentedAt && !config.telemetry?.consentedAt;
  if (!preserveSecurity && !preserveTelemetry) {
    return config;
  }
  return {
    ...config,
    ...(preserveSecurity ? { wizard: { ...config.wizard, securityAcknowledgedAt } } : {}),
    ...(preserveTelemetry ? { telemetry: inMemoryConfig.telemetry } : {}),
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
    if (isNotFoundPathError(error)) {
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
    if (isNotFoundPathError(error)) {
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
  hash.update(`config:${JSON.stringify(canonicalizeSetupMigrationValue(targetConfig))}\0`);
  await hashTargetPath(hash, params.workspaceDir, "workspace");
  for (const entry of IMPORT_BLOCKING_STATE_ENTRIES) {
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
    throw new SetupMigrationTargetChangedError(
      "Migration target changed while preparing the import. Review it and retry.",
    );
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

/** Serializes onboarding writes that share one OpenClaw state target. */
export async function withSetupMigrationTargetLock<T>(
  stateDir: string,
  fn: () => Promise<T>,
): Promise<T> {
  const resolvedStateDir = path.resolve(stateDir);
  const activeStateDir = activeSetupMigrationTargetLock.getStore();
  if (activeStateDir) {
    if (activeStateDir !== resolvedStateDir) {
      throw new Error("nested onboarding target lock cannot switch the OpenClaw state directory");
    }
    return await fn();
  }
  const migrationDir = path.join(resolvedStateDir, "migration");
  await fs.mkdir(migrationDir, { recursive: true, mode: 0o700 });
  const lockTarget = path.join(migrationDir, "onboarding.lock-target");
  let acquired = false;
  try {
    return await withFileLock(lockTarget, ONBOARDING_TARGET_LOCK_OPTIONS, async () => {
      acquired = true;
      return await activeSetupMigrationTargetLock.run(resolvedStateDir, fn);
    });
  } catch (error) {
    if (acquired || (error as { code?: unknown }).code !== FILE_LOCK_TIMEOUT_ERROR_CODE) {
      throw error;
    }
    const payload = await readJsonFile<{ pid?: unknown }>(`${lockTarget}.lock`, {
      maxBytes: 1_024,
    });
    const pid = payload?.pid;
    const holderPid =
      typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
    throw new SetupTargetLockedError(holderPid, process.env.OPENCLAW_PROFILE?.trim(), error);
  }
}

export function assertFreshSetupMigrationTarget(freshness: {
  fresh: boolean;
  reasons: readonly string[];
}): void {
  if (freshness.fresh) {
    return;
  }
  throw new SetupMigrationFreshnessError(
    [
      "Migration import during onboarding requires a fresh OpenClaw setup.",
      "Create a fresh setup or reset config, credentials, sessions, and workspace before importing.",
      "Backup plus overwrite/merge imports are feature-gated for now.",
      "Existing setup:",
      ...freshness.reasons.map((reason) => `- ${reason}`),
    ].join("\n"),
  );
}

export class SetupMigrationFreshnessError extends Error {}
export class SetupMigrationTargetChangedError extends Error {}
