import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createConfigIO } from "../config/io.js";
import { formatConfigIssueLines } from "../config/issue-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "./errors.js";
import { resolveRuntimeProcessEntrypointUrl } from "./runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "./runtime-worker-url.js";
import type {
  ConfigInputHashes,
  LegacyStateSnapshotInput,
  LegacyStateSnapshotIdentity,
} from "./state-migrations.snapshot.worker.js";
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

export async function captureLegacyStateSnapshotIdentity(
  params: LegacyStateSnapshotInput,
): Promise<LegacyStateSnapshotIdentity> {
  const worker = resolveRuntimeProcessEntrypointUrl("stateMigrationSnapshot");
  const input = JSON.stringify(params);
  return new Promise((resolve) => {
    let result: LegacyStateSnapshotIdentity | undefined;
    let inputError: Error | undefined;
    let failure = "Snapshot worker returned no result";
    const child = execFile(
      process.execPath,
      [...resolveRuntimeWorkerArgv(worker), "--openclaw-state-snapshot"],
      { encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          failure = `${formatErrorMessage(error)}${stderr ? `\n${stderr.trim()}` : ""}`;
          return;
        }
        try {
          const parsed: unknown = JSON.parse(stdout);
          if (
            !isRecord(parsed) ||
            !Array.isArray(parsed.warnings) ||
            !parsed.warnings.every((warning) => typeof warning === "string") ||
            (parsed.configDigest !== undefined && typeof parsed.configDigest !== "string") ||
            (parsed.stateDigest !== undefined && typeof parsed.stateDigest !== "string")
          ) {
            throw new Error("Snapshot worker returned an invalid identity");
          }
          result = {
            ...(typeof parsed.configDigest === "string"
              ? { configDigest: parsed.configDigest }
              : {}),
            ...(typeof parsed.stateDigest === "string" ? { stateDigest: parsed.stateDigest } : {}),
            warnings: parsed.warnings,
          };
        } catch (parseError) {
          failure = formatErrorMessage(parseError);
        }
      },
    );
    // Include inventories can exceed OS argv limits. The owned pipe carries the
    // same request without imposing a new limit on accepted configuration.
    child.stdin?.once("error", (error) => {
      inputError = error;
    });
    child.stdin?.end(input);
    // A failed launch/output may report before close. Settle all owned pipes
    // before the planner can continue or return its refusal.
    child.once("close", () => {
      if (inputError) {
        result = undefined;
        failure = `${failure}; writing snapshot input: ${formatErrorMessage(inputError)}`;
      }
      resolve(result ?? { warnings: [`Could not bind copied snapshot: ${failure}`] });
    });
  });
}

export async function readLegacyStateMigrationPlanConfig(params: {
  configPath: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
}): Promise<{
  config: OpenClawConfig;
  configIncludedPaths: string[];
  configDigest?: string;
  rootDigest?: string;
  configInputHashes?: ConfigInputHashes;
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
      return { config: snapshot.sourceConfig, configIncludedPaths: [], warnings };
    }
    const configIncludedPaths = [
      ...new Set(snapshot.includedPaths?.map((inputPath) => path.resolve(inputPath)) ?? []),
    ]
      .filter((includePath) => includePath !== path.resolve(snapshot.path))
      .toSorted();
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
        inputPaths: [path.resolve(snapshot.path), ...configIncludedPaths],
        resolved: snapshot.sourceConfig,
      }),
      configIncludedPaths,
      rootDigest: `sha256:${rootHash}`,
      configInputHashes: { root: rootHash, includes },
      warnings,
    };
  } catch (error) {
    warnings.push(`Could not inspect snapshot config: ${formatErrorMessage(error)}`);
    return { config: {}, configIncludedPaths: [], warnings };
  }
}

function normalizeEndpoint(endpoint: LegacyStateMigrationEndpoint): LegacyStateMigrationEndpoint {
  return endpoint.kind === "owner" ? endpoint : { ...endpoint, path: path.resolve(endpoint.path) };
}

export function createLegacyStateMigrationCallerEnv(params: {
  env?: NodeJS.ProcessEnv;
  snapshot: LegacyStateMigrationPlan["snapshot"];
}): NodeJS.ProcessEnv {
  const env = { ...(params.env ?? process.env) };
  // Direct execution treats an explicit state root as authoritative and skips
  // default-root relocation. Preserve that caller fact until discovery is complete.
  for (const key of ["OPENCLAW_HOME", "OPENCLAW_OAUTH_DIR", "STATE_DIRECTORY"]) {
    delete env[key];
  }
  env.HOME = path.resolve(params.snapshot.homeDir);
  env.USERPROFILE = env.HOME;
  env.OPENCLAW_CONFIG_PATH = path.resolve(params.snapshot.configPath);
  return env;
}

export function createLegacyStateMigrationPlanEnv(params: {
  env?: NodeJS.ProcessEnv;
  snapshot: LegacyStateMigrationPlan["snapshot"];
}): NodeJS.ProcessEnv {
  const env = createLegacyStateMigrationCallerEnv(params);
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
