import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { assertExperimentalClawsEnabled } from "../claws/experimental.js";
import { buildClawAddPlan } from "../claws/lifecycle.js";
import {
  CLAW_BUILD_RESULT_SCHEMA_VERSION,
  buildClawProject,
  extractBuiltClawArtifact,
} from "../claws/project-build.js";
import {
  CLAW_PROJECT_RESULT_SCHEMA_VERSION,
  ClawProjectError,
  createClawProject,
  validateClawProject,
} from "../claws/project.js";
import { readClawManifestFile } from "../claws/reader.js";
import { CLAW_OUTPUT_STABILITY, type ClawAddPlan } from "../claws/types.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { normalizeConfiguredMcpServers } from "../config/mcp-config-normalize.js";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import { formatClawDiagnostics, logClawExperimentalWarning } from "./claws-cli-output.js";
import type {
  ClawsBuildOptions,
  ClawsCreateOptions,
  ClawsDevOptions,
  ClawsValidateOptions,
} from "./claws-cli.js";

type PreparedDev = {
  build: Awaited<ReturnType<typeof buildClawProject>>;
  plan: ClawAddPlan;
};

const CLAW_DEV_RESULT_SCHEMA_VERSION = "openclaw.clawDev.v1" as const;

function reportProjectError(
  error: unknown,
  fallbackCode: string,
  schemaVersion:
    | typeof CLAW_PROJECT_RESULT_SCHEMA_VERSION
    | typeof CLAW_BUILD_RESULT_SCHEMA_VERSION
    | typeof CLAW_DEV_RESULT_SCHEMA_VERSION,
  json: boolean | undefined,
  runtime: RuntimeEnv,
): void {
  const code = error instanceof ClawProjectError ? error.code : fallbackCode;
  const message = error instanceof Error ? error.message : String(error);
  if (json) {
    writeRuntimeJson(runtime, {
      schemaVersion,
      stability: CLAW_OUTPUT_STABILITY,
      ok: false,
      error: { code, message },
    });
  } else {
    runtime.error(message);
  }
  runtime.exit(1);
}

function logDevPlanSummary(plan: ClawAddPlan, runtime: RuntimeEnv): void {
  runtime.log(`Agent: ${plan.agent.finalId}`);
  runtime.log(`Workspace: ${plan.agent.workspace}`);
  runtime.log(`Actions: ${plan.summary.totalActions}`);
  runtime.log(`Capability escalations: ${plan.capabilityChanges.length}`);
  runtime.log(`Blocked actions: ${plan.summary.blockedActions}`);
}

async function prepareDev(projectPath: string, opts: ClawsDevOptions): Promise<PreparedDev> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "openclaw-claw-dev-"));
  try {
    const build = await buildClawProject(projectPath, join(temporaryDirectory, "claw.tgz"));
    const extracted = await extractBuiltClawArtifact(build.artifact);
    try {
      const result = await readClawManifestFile(extracted.packageRoot);
      if (!result.ok) {
        throw new ClawProjectError(
          "artifact_verification_failed",
          formatClawDiagnostics(result.diagnostics),
        );
      }
      const configSnapshot = await readConfigFileSnapshot({
        observe: false,
        skipPluginValidation: true,
      });
      if (!configSnapshot.valid) {
        throw new ClawProjectError(
          "config_unavailable",
          "OpenClaw config is invalid; fix it before previewing a Claw project.",
        );
      }
      const config = configSnapshot.resolved;
      const existingMcpServers = normalizeConfiguredMcpServers(config.mcp?.servers);
      const existingAgentIds = listAgentIds(config);
      const plan = await buildClawAddPlan({
        manifest: result.manifest,
        clawMarkdownBody: result.clawMarkdownBody,
        packageBootstrap: result.packageBootstrap,
        openClawProfile: result.openClawProfile,
        source: {
          ...result.source,
          integrityKind: "artifact",
          integrity: build.integrity,
          byteLength: build.byteLength,
        },
        diagnostics: result.diagnostics,
        context: {
          ...(opts.agentId ? { agentId: opts.agentId } : {}),
          ...(opts.workspace ? { workspace: opts.workspace } : {}),
          existingAgentIds,
          existingWorkspacePaths: existingAgentIds.map((agentId) =>
            resolveAgentWorkspaceDir(config, agentId),
          ),
          existingMcpServers,
          sourceReferenceRoot: `claw-artifact:${build.integrity}`,
        },
      });
      return { build, plan };
    } finally {
      await extracted.dispose();
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

export async function runClawsCreateCommand(
  projectPath: string,
  opts: ClawsCreateOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  try {
    const result = await createClawProject(projectPath, {
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
    });
    if (opts.json) {
      writeRuntimeJson(runtime, {
        schemaVersion: CLAW_PROJECT_RESULT_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        ok: true,
        ...result,
      });
      return;
    }
    logClawExperimentalWarning(runtime);
    runtime.log(`Created Claw project: ${result.root}`);
    runtime.log(`Package: ${result.packageJson.name}@${result.packageJson.version}`);
  } catch (error) {
    reportProjectError(
      error,
      "project_create_failed",
      CLAW_PROJECT_RESULT_SCHEMA_VERSION,
      opts.json,
      runtime,
    );
  }
}

export async function runClawsValidateCommand(
  projectPath: string,
  opts: ClawsValidateOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  const result = await validateClawProject(projectPath);
  if (!result.ok) {
    if (opts.json) {
      writeRuntimeJson(runtime, {
        schemaVersion: CLAW_PROJECT_RESULT_SCHEMA_VERSION,
        stability: CLAW_OUTPUT_STABILITY,
        ok: false,
        root: result.root,
        diagnostics: result.diagnostics,
      });
    } else {
      runtime.error(formatClawDiagnostics(result.diagnostics));
    }
    runtime.exit(1);
    return;
  }
  if (opts.json) {
    writeRuntimeJson(runtime, {
      schemaVersion: CLAW_PROJECT_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      ok: true,
      root: result.root,
      source: result.claw.source,
      manifest: result.claw.manifest,
      ...(result.claw.openClawProfile ? { openClawProfile: result.claw.openClawProfile } : {}),
      excludedPaths: result.excludedPaths,
      diagnostics: result.diagnostics,
    });
    return;
  }
  logClawExperimentalWarning(runtime);
  runtime.log(`Valid Claw project: ${result.root}`);
  runtime.log(`Package: ${result.packageJson.name}@${result.packageJson.version}`);
  for (const path of result.excludedPaths) {
    runtime.log(`Excluded: ${path}`);
  }
}

export async function runClawsBuildCommand(
  projectPath: string,
  opts: ClawsBuildOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  try {
    const result = await buildClawProject(projectPath, opts.out);
    if (opts.json) {
      writeRuntimeJson(runtime, { ...result, stability: CLAW_OUTPUT_STABILITY, ok: true });
      return;
    }
    logClawExperimentalWarning(runtime);
    runtime.log(`Built Claw: ${result.claw.name}@${result.claw.version}`);
    runtime.log(`Artifact: ${result.artifact}`);
    runtime.log(`Integrity: ${result.integrity}`);
    runtime.log(`Excluded project paths: ${result.excludedPaths.length}`);
  } catch (error) {
    reportProjectError(
      error,
      "project_build_failed",
      CLAW_BUILD_RESULT_SCHEMA_VERSION,
      opts.json,
      runtime,
    );
  }
}

export async function runClawsDevCommand(
  projectPath: string,
  opts: ClawsDevOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  assertExperimentalClawsEnabled();
  let prepared: PreparedDev;
  try {
    prepared = await prepareDev(projectPath, opts);
  } catch (error) {
    reportProjectError(
      error,
      "project_dev_failed",
      CLAW_DEV_RESULT_SCHEMA_VERSION,
      opts.json,
      runtime,
    );
    return;
  }
  const { build, plan } = prepared;
  if (opts.json) {
    writeRuntimeJson(runtime, {
      schemaVersion: CLAW_DEV_RESULT_SCHEMA_VERSION,
      stability: CLAW_OUTPUT_STABILITY,
      offline: true,
      mutationAllowed: false,
      build: {
        integrity: build.integrity,
        byteLength: build.byteLength,
        files: build.files,
        excludedPaths: build.excludedPaths,
        claw: build.claw,
      },
      plan,
    });
  } else {
    logClawExperimentalWarning(runtime);
    runtime.log(`Claw dev preview: ${build.claw.name}@${build.claw.version}`);
    runtime.log(`Artifact integrity: ${build.integrity}`);
    logDevPlanSummary(plan, runtime);
    if (plan.blockers.length > 0) {
      runtime.error(formatClawDiagnostics(plan.blockers));
    }
  }
  if (plan.blockers.length > 0) {
    runtime.exit(1);
  }
}
