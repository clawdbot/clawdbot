import { createHash } from "node:crypto";
import path from "node:path";
import { stableStringify } from "@openclaw/normalization-core";
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
    "OPENCLAW_PROFILE",
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
  candidate: LegacyStateMigrationPlan["candidate"];
  snapshot: LegacyStateMigrationPlan["snapshot"];
  steps: readonly PreparedLegacyStateMigrationStep[];
  warnings?: readonly string[];
}): LegacyStateMigrationPlan {
  const candidate = {
    root: path.resolve(params.candidate.root),
    version: params.candidate.version,
    digest: params.candidate.digest,
  };
  const snapshot = {
    homeDir: path.resolve(params.snapshot.homeDir),
    configPath: path.resolve(params.snapshot.configPath),
    configDigest: params.snapshot.configDigest,
    stateDir: path.resolve(params.snapshot.stateDir),
    stateDigest: params.snapshot.stateDigest,
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
  const plan = {
    schemaVersion: LEGACY_STATE_MIGRATION_PLAN_SCHEMA_VERSION,
    mutationAllowed: false as const,
    outcome: params.warnings?.length ? ("refused" as const) : ("planned" as const),
    warnings: [...(params.warnings ?? [])],
    ...(params.warnings?.length
      ? {
          refusal: {
            code: "migration-planning-warning",
            message: params.warnings.join("\n"),
          },
        }
      : {}),
    mode: params.mode,
    candidate,
    snapshot,
    steps,
  };
  return { ...plan, planIntegrity: digest(plan) };
}
