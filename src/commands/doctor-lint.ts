/** CLI entrypoint for non-mutating doctor lint health checks. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveAgentWorkspaceDir, tryResolveDefaultAgentId } from "../agents/agent-scope.js";
import { createConfigIO, readConfigFileSnapshot } from "../config/config.js";
import { maybeLoadDotEnvForConfig } from "../config/io.read-helpers.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import {
  registerBundledHealthChecks,
  resolveBundledHealthCheckPluginStateMode,
} from "../flows/bundled-health-checks.js";
import { configValidationIssuesToHealthFindings } from "../flows/doctor-core-checks.js";
import { scrubDoctorErrorMessage } from "../flows/doctor-error-message.js";
import { resolveDoctorContributionHealthChecks } from "../flows/doctor-health-contributions.js";
import {
  exitCodeFromFindings,
  runDoctorLintChecks,
  selectUpdateReadinessChecks,
  type DoctorLintRunOptions,
} from "../flows/doctor-lint-flow.js";
import { listExtensionHealthChecksForDoctor } from "../flows/health-check-registry.js";
import {
  healthFindingMeetsSeverity,
  parseHealthFindingSeverity,
  type HealthCheck,
  type HealthCheckContext,
  type HealthFinding,
} from "../flows/health-checks.js";
import { prepareSqliteReadOnlyLocationSync } from "../infra/sqlite-readonly-location.js";
import {
  resolvePluginInstallRoots,
  withPluginInstallRoots,
} from "../plugins/install-root-context.js";
import type { RuntimeEnv } from "../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { isPostCoreConvergencePass } from "./doctor/shared/update-phase.js";

interface DoctorLintCliOptions {
  readonly json?: boolean;
  readonly severityMin?: string;
  readonly skipIds?: readonly string[];
  readonly onlyIds?: readonly string[];
  readonly allowExec?: boolean;
  readonly deep?: boolean;
  readonly includeAllChecks?: boolean;
  readonly updateReadiness?: "post-plugin";
}

type DoctorLintStateView = {
  pluginMetadataEnv: NodeJS.ProcessEnv;
  readConfigSnapshot: () => ReturnType<typeof readConfigFileSnapshot>;
  sourceEnv: NodeJS.ProcessEnv;
  runWithPluginStateSnapshot: <T>(
    run: (pluginMetadataEnv: NodeJS.ProcessEnv) => Promise<T>,
  ) => Promise<T>;
};

type DoctorLintExecution = {
  exitCode: number;
  findings: readonly HealthFinding[];
  writeOutput: () => void;
};

type DoctorLintStateRunner = <T>(run: () => Promise<T>) => Promise<T>;

const RUNTIME_TOOL_SCHEMA_CHECK_ID = "core/doctor/runtime-tool-schemas";
const AUTH_PROFILE_CHECK_ID = "core/doctor/auth-profiles";

class DoctorLintStateSnapshotError extends Error {
  constructor(cause: unknown) {
    super(
      `Doctor lint could not prepare a private plugin-state snapshot: ${scrubDoctorErrorMessage(cause)}`,
      { cause },
    );
    this.name = "DoctorLintStateSnapshotError";
  }
}

function detectMode(opts: DoctorLintCliOptions): "human" | "json" {
  if (opts.json === true) {
    return "json";
  }
  return process.stdout.isTTY ? "human" : "json";
}

/**
 * Runs registered doctor health checks in human or JSON mode and returns the lint exit code.
 *
 * Invalid config is reported before regular health checks because most checks need a parsed config
 * and workspace root.
 */
export async function runDoctorLintCli(
  runtime: RuntimeEnv,
  opts: DoctorLintCliOptions,
): Promise<number> {
  const execution = await prepareDoctorLintExecution(runtime, opts);
  execution.writeOutput();
  return execution.exitCode;
}

/** Collect advisory doctor findings without writing output or repairing operator state. */
export async function collectDoctorFindings(
  runtime: RuntimeEnv,
): Promise<readonly HealthFinding[]> {
  const execution = await prepareDoctorLintExecution(runtime, { severityMin: "info" });
  return execution.findings;
}

async function prepareDoctorLintExecution(
  runtime: RuntimeEnv,
  opts: DoctorLintCliOptions,
): Promise<DoctorLintExecution> {
  const sevMin =
    opts.severityMin === undefined ? "warning" : parseHealthFindingSeverity(opts.severityMin);
  if (sevMin === null) {
    throw new Error("Invalid --severity-min value. Expected one of: info, warning, error.");
  }
  maybeLoadDotEnvForConfig(process.env);
  const sourceEnv = { ...process.env };
  const updateReadiness = isPostCoreConvergencePass(sourceEnv) ? "post-plugin" : undefined;
  const effectiveOpts: DoctorLintCliOptions = updateReadiness ? { ...opts, updateReadiness } : opts;
  const pluginStateMode = resolveBundledHealthCheckPluginStateMode(effectiveOpts);
  const stateView: DoctorLintStateView = {
    pluginMetadataEnv: sourceEnv,
    sourceEnv,
    readConfigSnapshot: () =>
      pluginStateMode === "direct"
        ? readConfigFileSnapshot({ observe: false })
        : createConfigIO({
            env: sourceEnv,
            configPath: resolveConfigPath(sourceEnv, resolveStateDir(sourceEnv)),
            observe: false,
            pluginValidation: pluginStateMode === "deferred" ? "core-only" : undefined,
          }).readConfigFileSnapshot(),
    runWithPluginStateSnapshot: async (run) => withReadOnlyPluginStateSnapshot(sourceEnv, run),
  };
  if (pluginStateMode !== "isolated") {
    return await executeDoctorLint(runtime, effectiveOpts, sevMin, stateView);
  }
  try {
    return await withReadOnlyPluginStateSnapshot(sourceEnv, async (pluginMetadataEnv) =>
      executeDoctorLint(runtime, effectiveOpts, sevMin, {
        ...stateView,
        pluginMetadataEnv,
        runWithPluginStateSnapshot: async (run) => run(pluginMetadataEnv),
      }),
    );
  } catch (error) {
    if (!(error instanceof DoctorLintStateSnapshotError)) {
      throw error;
    }
    return createStateSnapshotFailureExecution(runtime, effectiveOpts, sevMin, error);
  }
}

async function executeDoctorLint(
  runtime: RuntimeEnv,
  opts: DoctorLintCliOptions,
  sevMin: NonNullable<ReturnType<typeof parseHealthFindingSeverity>>,
  stateView: DoctorLintStateView,
): Promise<DoctorLintExecution> {
  const snapshot = await stateView.readConfigSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    const findings = configValidationIssuesToHealthFindings(snapshot.issues);
    const visible = findings.filter((finding) => healthFindingMeetsSeverity(finding, sevMin));
    return {
      exitCode: exitCodeFromFindings(findings, sevMin),
      findings: visible,
      writeOutput() {
        if (detectMode(opts) === "json") {
          writeJsonResult({
            ok: false,
            checksRun: 1,
            checksSkipped: 0,
            findings: visible,
          });
          return;
        }
        runtime.error("doctor --lint: config file exists but does not parse cleanly.");
        for (const issue of snapshot.issues) {
          const issuePath = issue.path || "<root>";
          runtime.error(`- ${issuePath}: ${issue.message}`);
        }
      },
    };
  }

  const sourceEnv = { ...stateView.sourceEnv };
  const defaultAgentId = tryResolveDefaultAgentId(snapshot.config);
  const ctx: HealthCheckContext = {
    mode: "lint",
    runtime,
    cfg: snapshot.config,
    cwd: defaultAgentId ? resolveAgentWorkspaceDir(snapshot.config, defaultAgentId) : process.cwd(),
    env: sourceEnv,
    allowExecSecretRefs: opts.allowExec === true,
    ...(snapshot.path !== undefined ? { configPath: snapshot.path } : {}),
  };
  registerBundledHealthChecks({
    cfg: snapshot.config,
    cwd: ctx.cwd,
    env: stateView.pluginMetadataEnv,
    runWithPluginStateSnapshot: stateView.runWithPluginStateSnapshot,
    updateReadiness: opts.updateReadiness,
  });
  const registeredExtensionChecks = listExtensionHealthChecksForDoctor([]);
  const onlyRegisteredExtensionChecks =
    opts.onlyIds !== undefined &&
    opts.onlyIds.length > 0 &&
    opts.onlyIds.every((id) => registeredExtensionChecks.some((check) => check.id === id));
  const coreChecks = onlyRegisteredExtensionChecks
    ? []
    : await resolveDoctorContributionHealthChecks();
  const extensionChecks = onlyRegisteredExtensionChecks
    ? registeredExtensionChecks
    : listExtensionHealthChecksForDoctor(coreChecks);
  const runWithPrivateStateSnapshot: DoctorLintStateRunner = async (run) =>
    await stateView.runWithPluginStateSnapshot(async () => await run());
  // Update readiness keeps every declared check private until restart.
  const runWithSourceState: DoctorLintStateRunner = async (run) =>
    opts.updateReadiness ? run() : withDoctorLintStateEnv(sourceEnv, run);
  const coreCtx = {
    ...ctx,
    deep: opts.deep === true,
    runWithPrivateStateSnapshot,
    runWithSourceState,
  };

  const checks = [
    ...coreChecks.map((check) => withCoreLintContext(check, coreCtx)),
    ...extensionChecks,
  ];
  const runOpts: DoctorLintRunOptions = {
    checks: opts.updateReadiness
      ? selectUpdateReadinessChecks(checks, opts.updateReadiness)
      : checks,
    includeAllChecks: opts.updateReadiness !== undefined || opts.includeAllChecks === true,
    ...(opts.skipIds && opts.skipIds.length > 0 ? { skipIds: opts.skipIds } : {}),
    ...(opts.onlyIds && opts.onlyIds.length > 0 ? { onlyIds: opts.onlyIds } : {}),
  };
  const result = await runDoctorLintChecks(ctx, runOpts);
  const visible = result.findings.filter((finding) => healthFindingMeetsSeverity(finding, sevMin));
  const exitCode = exitCodeFromFindings(result.findings, sevMin);
  return {
    exitCode,
    findings: visible,
    writeOutput() {
      const mode = detectMode(opts);
      if (mode === "json") {
        writeJsonResult({
          ok: exitCode === 0,
          checksRun: result.checksRun,
          checksSkipped: result.checksSkipped,
          findings: visible,
        });
        return;
      }
      process.stdout.write(
        `doctor --lint: ran ${result.checksRun} check(s), ${visible.length} finding(s)\n`,
      );
      if (visible.length === 0) {
        process.stdout.write("  no findings\n");
        return;
      }
      for (const f of visible) {
        const where = f.path !== undefined ? ` ${f.path}` : "";
        const line = f.line !== undefined ? `:${f.line}` : "";
        process.stdout.write(`  [${f.severity}] ${f.checkId}${where}${line} - ${f.message}\n`);
        if (f.fixHint !== undefined) {
          process.stdout.write(`    fix: ${f.fixHint}\n`);
        }
      }
    },
  };
}

async function withReadOnlyPluginStateSnapshot<T>(
  sourceEnv: NodeJS.ProcessEnv,
  run: (pluginMetadataEnv: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const sourceDatabasePath = resolveOpenClawStateSqlitePath(sourceEnv);
  let cleanup: () => boolean;
  let privateRoot: string;
  let prepared: ReturnType<typeof prepareSqliteReadOnlyLocationSync> | undefined;
  try {
    if (fs.existsSync(sourceDatabasePath)) {
      prepared = prepareSqliteReadOnlyLocationSync(sourceDatabasePath);
      privateRoot = path.dirname(prepared.location);
      cleanup = prepared.cleanup;
    } else {
      privateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-lint-state-"));
      cleanup = () => {
        try {
          fs.rmSync(privateRoot, { force: true, recursive: true });
          return true;
        } catch {
          return false;
        }
      };
    }
  } catch (error) {
    throw new DoctorLintStateSnapshotError(error);
  }
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  let runStarted = false;
  try {
    const privateStateDir = path.join(privateRoot, "openclaw-state");
    const privateDatabasePath = resolveOpenClawStateSqlitePath({
      ...sourceEnv,
      OPENCLAW_STATE_DIR: privateStateDir,
    });
    fs.mkdirSync(path.dirname(privateDatabasePath), { recursive: true, mode: 0o700 });
    if (prepared) {
      for (const suffix of ["", "-journal", "-shm", "-wal"]) {
        const sourcePath = `${prepared.location}${suffix}`;
        if (fs.existsSync(sourcePath)) {
          fs.renameSync(sourcePath, `${privateDatabasePath}${suffix}`);
        }
      }
    }
    const sourceConfigPath = resolveConfigPath(sourceEnv, resolveStateDir(sourceEnv));
    const privateEnv = {
      ...sourceEnv,
      OPENCLAW_CONFIG_PATH: sourceConfigPath,
      OPENCLAW_STATE_DIR: privateStateDir,
    };
    const installRoots = resolvePluginInstallRoots(sourceEnv);
    // Global readers and OAuth refresh/challenge writers share the private state view.
    outcome = {
      ok: true,
      value: await withDoctorLintStateEnv(privateEnv, () =>
        withPluginInstallRoots({ ...installRoots, stateDir: privateStateDir }, async () => {
          runStarted = true;
          return await run(privateEnv);
        }),
      ),
    };
  } catch (error) {
    outcome = { ok: false, error };
  }
  if (!cleanup()) {
    throw new DoctorLintStateSnapshotError(
      new Error("Temporary doctor lint state snapshot cleanup did not complete."),
    );
  }
  if (!outcome.ok) {
    throw runStarted ? outcome.error : new DoctorLintStateSnapshotError(outcome.error);
  }
  return outcome.value;
}

async function withDoctorLintStateEnv<T>(
  env: NodeJS.ProcessEnv,
  run: () => Promise<T>,
): Promise<T> {
  const stateDir = resolveStateDir(env);
  const overrides = {
    OPENCLAW_CONFIG_PATH: resolveConfigPath(env, stateDir),
    OPENCLAW_STATE_DIR: stateDir,
  };
  const previous = Object.keys(overrides).map((key) => [key, process.env[key]] as const);
  // Doctor checks run serially. Scope ambient auth/global-store owners together,
  // restoring the enclosing private view even when a detector throws.
  Object.assign(process.env, overrides);
  try {
    return await run();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function createStateSnapshotFailureExecution(
  runtime: RuntimeEnv,
  opts: DoctorLintCliOptions,
  sevMin: NonNullable<ReturnType<typeof parseHealthFindingSeverity>>,
  error: DoctorLintStateSnapshotError,
): DoctorLintExecution {
  const finding: HealthFinding = {
    checkId: "core/doctor/lint-state-inspection",
    severity: "error",
    source: "doctor",
    target: "plugin-state",
    requirement: "read-only-plugin-state-inspection",
    message:
      "Doctor lint could not inspect plugin state without mutating the live state database " +
      `(${scrubDoctorErrorMessage(error.cause ?? error)}).`,
    fixHint:
      "Keep the current Gateway running, resolve the state database inspection error, then rerun this check.",
  };
  const visible = healthFindingMeetsSeverity(finding, sevMin) ? [finding] : [];
  return {
    exitCode: exitCodeFromFindings([finding], sevMin),
    findings: visible,
    writeOutput() {
      if (detectMode(opts) === "json") {
        writeJsonResult({
          ok: false,
          checksRun: 0,
          checksSkipped: 0,
          findings: visible,
        });
        return;
      }
      runtime.error(`doctor --lint: ${finding.message}`);
      runtime.error(`fix: ${finding.fixHint}`);
    },
  };
}

function withCoreLintContext(
  check: HealthCheck,
  ctx: HealthCheckContext & {
    readonly deep?: boolean;
    readonly runWithPrivateStateSnapshot: DoctorLintStateRunner;
    readonly runWithSourceState: DoctorLintStateRunner;
  },
): HealthCheck {
  return {
    ...check,
    detect(_ctx, scope) {
      const detect = async () => await check.detect(ctx, scope);
      if (check.id === RUNTIME_TOOL_SCHEMA_CHECK_ID) {
        return ctx.runWithPrivateStateSnapshot(detect);
      }
      // Auth health uses read-only loaders but needs uncopied agent stores and source paths.
      return check.id === AUTH_PROFILE_CHECK_ID ? ctx.runWithSourceState(detect) : detect();
    },
  };
}

function writeJsonResult(result: {
  ok: boolean;
  checksRun: number;
  checksSkipped: number;
  findings: readonly HealthFinding[];
}): void {
  process.stdout.write(
    JSON.stringify({
      ok: result.ok,
      checksRun: result.checksRun,
      checksSkipped: result.checksSkipped,
      findings: result.findings.map(toJsonFinding),
    }) + "\n",
  );
}

function toJsonFinding(f: HealthFinding): Record<string, unknown> {
  return {
    checkId: f.checkId,
    severity: f.severity,
    message: f.message,
    ...(f.source !== undefined ? { source: f.source } : {}),
    ...(f.path !== undefined ? { path: f.path } : {}),
    ...(f.line !== undefined ? { line: f.line } : {}),
    ...(f.column !== undefined ? { column: f.column } : {}),
    ...(f.ocPath !== undefined ? { ocPath: f.ocPath } : {}),
    ...(f.target !== undefined ? { target: f.target } : {}),
    ...(f.requirement !== undefined ? { requirement: f.requirement } : {}),
    ...(f.fixHint !== undefined ? { fixHint: f.fixHint } : {}),
  };
}
