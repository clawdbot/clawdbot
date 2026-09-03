import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import { createConfigIO } from "../config/io.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { sha256File } from "./crypto-digest.js";
import { formatErrorMessage } from "./errors.js";
import {
  LEGACY_STATE_MIGRATION_PLAN_SCHEMA_VERSION,
  type LegacyStateMigrationMode,
  type LegacyStateMigrationEndpoint,
  type LegacyStateMigrationPlan,
  type LegacyStateMigrationStepPlan,
} from "./state-migrations.types.js";

export type PreparedLegacyStateMigrationStep = Omit<LegacyStateMigrationStepPlan, "outcome">;

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

async function digestFile(filePath: string): Promise<string> {
  const before = await fs.lstat(filePath);
  if (!before.isFile()) {
    throw new Error(`Snapshot path is not a regular file: ${filePath}`);
  }
  const fileDigest = await sha256File(filePath);
  const after = await fs.lstat(filePath);
  if (
    !after.isFile() ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error(`Snapshot file changed while hashing: ${filePath}`);
  }
  return `sha256:${fileDigest}`;
}

async function digestDirectory(directory: string): Promise<string> {
  const rootStat = await fs.lstat(directory);
  if (!rootStat.isDirectory()) {
    throw new Error(`Snapshot state path is not a directory: ${directory}`);
  }
  const hash = createHash("sha256");
  const visit = async (current: string, relative: string): Promise<void> => {
    const stat = await fs.lstat(current);
    // A symlink can escape the copied tree after identity capture. Plans bind only
    // regular entries owned by the supplied snapshot.
    if (stat.isSymbolicLink()) {
      throw new Error(`Snapshot tree contains a symbolic link: ${current}`);
    }
    const portableRelative = relative.split(path.sep).join("/");
    if (stat.isFile()) {
      const fileDigest = await sha256File(current);
      const after = await fs.lstat(current);
      if (
        !after.isFile() ||
        stat.dev !== after.dev ||
        stat.ino !== after.ino ||
        stat.size !== after.size ||
        stat.mtimeMs !== after.mtimeMs
      ) {
        throw new Error(`Snapshot file changed while hashing: ${current}`);
      }
      hash.update("file\0").update(portableRelative).update("\0").update(fileDigest).update("\0");
      return;
    }
    if (!stat.isDirectory()) {
      throw new Error(`Snapshot tree contains a non-file entry: ${current}`);
    }
    hash.update("directory\0").update(portableRelative).update("\0");
    const entries = (await fs.readdir(current)).toSorted();
    for (const entry of entries) {
      await visit(path.join(current, entry), path.join(relative, entry));
    }
    const verifiedEntries = (await fs.readdir(current)).toSorted();
    if (
      entries.length !== verifiedEntries.length ||
      entries.some((entry, i) => entry !== verifiedEntries[i])
    ) {
      throw new Error(`Snapshot directory changed while hashing: ${current}`);
    }
    const after = await fs.lstat(current);
    if (
      !after.isDirectory() ||
      stat.dev !== after.dev ||
      stat.ino !== after.ino ||
      stat.mtimeMs !== after.mtimeMs
    ) {
      throw new Error(`Snapshot directory changed while hashing: ${current}`);
    }
  };
  await visit(directory, "");
  return `sha256:${hash.digest("hex")}`;
}

export async function captureLegacyStateSnapshotIdentity(params: {
  configPath: string;
  stateDir: string;
}): Promise<{ configDigest?: string; stateDigest?: string; warnings: string[] }> {
  const warnings: string[] = [];
  const capture = async (label: string, pathname: string, read: () => Promise<string>) => {
    try {
      return await read();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Could not bind copied ${label} at ${pathname}: ${message}`);
      return undefined;
    }
  };
  const configPath = path.resolve(params.configPath);
  const stateDir = path.resolve(params.stateDir);
  const configDigest = await capture("config", configPath, () => digestFile(configPath));
  const stateDigest = await capture("state", stateDir, () => digestDirectory(stateDir));
  return {
    ...(configDigest ? { configDigest } : {}),
    ...(stateDigest ? { stateDigest } : {}),
    warnings,
  };
}

export async function readLegacyStateMigrationPlanConfig(params: {
  configPath: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<{
  config: OpenClawConfig;
  configDigest?: string;
  rootDigest?: string;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const logger = {
    error: (...values: unknown[]) => warnings.push(values.map(String).join(" ")),
    warn: (...values: unknown[]) => warnings.push(values.map(String).join(" ")),
  };
  try {
    const { snapshot, writeOptions } = await createConfigIO({
      configPath: params.configPath,
      env: params.env,
      homedir: () => params.homeDir,
      logger,
      observe: false,
      pluginValidation: "core-only",
      shellEnvFallback: "defer",
    }).readConfigFileSnapshotForWrite();
    if (!snapshot.exists) {
      warnings.push(`Snapshot config does not exist: ${params.configPath}`);
    }
    warnings.push(
      ...formatConfigIssueLines(
        [...snapshot.issues, ...snapshot.legacyIssues, ...snapshot.warnings],
        "",
        { normalizeRoot: true },
      ),
    );
    const rootHash = snapshot.hash;
    if (!rootHash) {
      warnings.push(`Could not hash snapshot config: ${params.configPath}`);
      return { config: snapshot.sourceConfig, warnings };
    }
    const includes = Object.entries(writeOptions.includeFileHashesForWrite ?? {})
      .map(([includePath, includeHash]) => ({
        path: path.resolve(includePath),
        hash: includeHash,
      }))
      .toSorted((left, right) => left.path.localeCompare(right.path));
    return {
      config: snapshot.sourceConfig,
      configDigest: digest({
        root: { path: path.resolve(snapshot.path), hash: rootHash },
        includes,
        resolved: snapshot.sourceConfig,
      }),
      rootDigest: `sha256:${rootHash}`,
      warnings,
    };
  } catch (error) {
    warnings.push(`Could not inspect snapshot config: ${formatErrorMessage(error)}`);
    return { config: {}, warnings };
  }
}

function normalizeEndpoint(endpoint: LegacyStateMigrationEndpoint): LegacyStateMigrationEndpoint {
  return endpoint.kind === "owner" ? endpoint : { ...endpoint, path: path.resolve(endpoint.path) };
}

export function createLegacyStateMigrationPlanEnv(params: {
  env?: NodeJS.ProcessEnv;
  snapshot: LegacyStateMigrationPlan["snapshot"];
}): NodeJS.ProcessEnv {
  const env = { ...(params.env ?? process.env) };
  for (const key of [
    "OPENCLAW_AGENT_DIR",
    "OPENCLAW_HOME",
    "OPENCLAW_OAUTH_DIR",
    "PI_CODING_AGENT_DIR",
    "STATE_DIRECTORY",
  ]) {
    delete env[key];
  }
  env.HOME = path.resolve(params.snapshot.homeDir);
  env.USERPROFILE = env.HOME;
  env.OPENCLAW_CONFIG_PATH = path.resolve(params.snapshot.configPath);
  env.OPENCLAW_STATE_DIR = path.resolve(params.snapshot.stateDir);
  return env;
}

export function createLegacyStateMigrationPlan(params: {
  mode: LegacyStateMigrationMode;
  candidate: Pick<LegacyStateMigrationPlan["candidate"], "root" | "version">;
  snapshot: LegacyStateMigrationPlan["snapshot"];
  steps: readonly PreparedLegacyStateMigrationStep[];
  warnings?: readonly string[];
  refusal?: { code: string; message: string };
}): LegacyStateMigrationPlan {
  // This planner does not own staged package bytes. Keep every result closed until
  // the staged-candidate owner adds and revalidates its immutable artifact identity.
  const artifact = {
    outcome: "deferred" as const,
    refusal: {
      code: "candidate-artifact-digest-required" as const,
      message:
        "Candidate artifact content identity must be supplied by the staged-candidate owner.",
    },
  };
  const candidate = {
    root: path.resolve(params.candidate.root),
    version: params.candidate.version,
    artifact,
  };
  const snapshot = {
    homeDir: path.resolve(params.snapshot.homeDir),
    configPath: path.resolve(params.snapshot.configPath),
    stateDir: path.resolve(params.snapshot.stateDir),
    ...(params.snapshot.configDigest ? { configDigest: params.snapshot.configDigest } : {}),
    ...(params.snapshot.stateDigest ? { stateDigest: params.snapshot.stateDigest } : {}),
  };
  const stepIds = new Set<string>();
  const steps = params.steps.map((step): LegacyStateMigrationStepPlan => {
    if (stepIds.has(step.id)) {
      throw new Error(`duplicate legacy state migration step id: ${step.id}`);
    }
    stepIds.add(step.id);
    return {
      ...step,
      source: step.source.map(normalizeEndpoint),
      target: step.target.map(normalizeEndpoint),
      outcome:
        step.refusal !== undefined
          ? "deferred"
          : step.requiredness === "not-required"
            ? "skipped"
            : "planned",
    };
  });
  const warnings = [...(params.warnings ?? [])];
  const candidateRefusal =
    candidate.artifact.outcome === "deferred" ? candidate.artifact.refusal : undefined;
  const refusal =
    params.refusal ??
    (warnings.length > 0
      ? {
          code: "migration-planning-warning",
          message: warnings.join("\n"),
        }
      : candidateRefusal);
  const plan = {
    schemaVersion: LEGACY_STATE_MIGRATION_PLAN_SCHEMA_VERSION,
    mutationAllowed: false as const,
    outcome: refusal ? ("refused" as const) : ("planned" as const),
    warnings,
    ...(refusal ? { refusal } : {}),
    mode: params.mode,
    candidate,
    snapshot,
    steps,
  };
  return { ...plan, planDigest: digest(plan) };
}

export function refuseLegacyStateMigrationPlan(
  plan: LegacyStateMigrationPlan,
  refusal: { code: string; message: string },
): LegacyStateMigrationPlan {
  const { planDigest: _planDigest, ...unsignedPlan } = plan;
  const warnings = unsignedPlan.warnings.includes(refusal.message)
    ? unsignedPlan.warnings
    : [...unsignedPlan.warnings, refusal.message];
  return createLegacyStateMigrationPlan({
    mode: unsignedPlan.mode,
    candidate: unsignedPlan.candidate,
    snapshot: unsignedPlan.snapshot,
    steps: unsignedPlan.steps.map(({ outcome: _outcome, ...step }) => step),
    warnings,
    refusal,
  });
}
