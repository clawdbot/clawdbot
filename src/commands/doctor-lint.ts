/** CLI entrypoint for non-mutating doctor lint health checks. */
import fs from "node:fs";
import path from "node:path";
import { resolveAgentWorkspaceDir, tryResolveDefaultAgentId } from "../agents/agent-scope.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { resolveConfigPath, resolveStateDir } from "../config/paths.js";
import { registerBundledHealthChecks } from "../flows/bundled-health-checks.js";
import { configValidationIssuesToHealthFindings } from "../flows/doctor-core-checks.js";
import { resolveDoctorContributionHealthChecks } from "../flows/doctor-health-contributions.js";
import {
  exitCodeFromFindings,
  runDoctorLintChecks,
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

interface DoctorLintCliOptions {
  readonly json?: boolean;
  readonly severityMin?: string;
  readonly skipIds?: readonly string[];
  readonly onlyIds?: readonly string[];
  readonly allowExec?: boolean;
  readonly deep?: boolean;
  readonly includeAllChecks?: boolean;
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
  const sevMin =
    opts.severityMin === undefined ? "warning" : parseHealthFindingSeverity(opts.severityMin);
  if (sevMin === null) {
    throw new Error("Invalid --severity-min value. Expected one of: info, warning, error.");
  }
  const snapshot = await readConfigFileSnapshot({ observe: false });
  if (snapshot.exists && !snapshot.valid) {
    const findings = configValidationIssuesToHealthFindings(snapshot.issues);
    const visible = findings.filter((finding) => healthFindingMeetsSeverity(finding, sevMin));
    if (detectMode(opts) === "json") {
      writeJsonResult({
        ok: false,
        checksRun: 1,
        checksSkipped: 0,
        findings: visible,
      });
    } else {
      runtime.error("doctor --lint: config file exists but does not parse cleanly.");
      for (const issue of snapshot.issues) {
        const issuePath = issue.path || "<root>";
        runtime.error(`- ${issuePath}: ${issue.message}`);
      }
    }
    return exitCodeFromFindings(findings, sevMin);
  }

  const sourceEnv = { ...process.env };
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
    env: sourceEnv,
    runWithPluginStateSnapshot: (run) => withReadOnlyPluginStateSnapshot(sourceEnv, run),
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
  const coreCtx = { ...ctx, deep: opts.deep === true };

  const runOpts: DoctorLintRunOptions = {
    checks: [...coreChecks.map((check) => withCoreLintContext(check, coreCtx)), ...extensionChecks],
    includeAllChecks: opts.includeAllChecks === true,
    ...(opts.skipIds && opts.skipIds.length > 0 ? { skipIds: opts.skipIds } : {}),
    ...(opts.onlyIds && opts.onlyIds.length > 0 ? { onlyIds: opts.onlyIds } : {}),
  };
  const result = await runDoctorLintChecks(ctx, runOpts);
  const visible = result.findings.filter((finding) => healthFindingMeetsSeverity(finding, sevMin));

  const mode = detectMode(opts);
  if (mode === "json") {
    writeJsonResult({
      ok: exitCodeFromFindings(result.findings, sevMin) === 0,
      checksRun: result.checksRun,
      checksSkipped: result.checksSkipped,
      findings: visible,
    });
  } else {
    process.stdout.write(
      `doctor --lint: ran ${result.checksRun} check(s), ${visible.length} finding(s)\n`,
    );
    if (visible.length === 0) {
      process.stdout.write("  no findings\n");
    } else {
      for (const f of visible) {
        const where = f.path !== undefined ? ` ${f.path}` : "";
        const line = f.line !== undefined ? `:${f.line}` : "";
        process.stdout.write(`  [${f.severity}] ${f.checkId}${where}${line} - ${f.message}\n`);
        if (f.fixHint !== undefined) {
          process.stdout.write(`    fix: ${f.fixHint}\n`);
        }
      }
    }
  }

  return exitCodeFromFindings(result.findings, sevMin);
}

async function withReadOnlyPluginStateSnapshot<T>(
  sourceEnv: NodeJS.ProcessEnv,
  run: (pluginMetadataEnv: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const sourceDatabasePath = resolveOpenClawStateSqlitePath(sourceEnv);
  if (!fs.existsSync(sourceDatabasePath)) {
    return await run(sourceEnv);
  }
  const prepared = prepareSqliteReadOnlyLocationSync(sourceDatabasePath);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    const privateStateDir = path.join(path.dirname(prepared.location), "openclaw-state");
    const privateDatabasePath = resolveOpenClawStateSqlitePath({
      ...sourceEnv,
      OPENCLAW_STATE_DIR: privateStateDir,
    });
    fs.mkdirSync(path.dirname(privateDatabasePath), { recursive: true, mode: 0o700 });
    for (const suffix of ["", "-journal", "-shm", "-wal"]) {
      const sourcePath = `${prepared.location}${suffix}`;
      if (fs.existsSync(sourcePath)) {
        fs.renameSync(sourcePath, `${privateDatabasePath}${suffix}`);
      }
    }
    const sourceConfigPath = resolveConfigPath(sourceEnv, resolveStateDir(sourceEnv));
    const privateEnv = {
      ...sourceEnv,
      OPENCLAW_CONFIG_PATH: sourceConfigPath,
      OPENCLAW_STATE_DIR: privateStateDir,
    };
    const installRoots = resolvePluginInstallRoots(sourceEnv);
    outcome = {
      ok: true,
      value: await withPluginInstallRoots(
        { ...installRoots, stateDir: privateStateDir },
        async () => await run(privateEnv),
      ),
    };
  } catch (error) {
    outcome = { ok: false, error };
  }
  if (!prepared.cleanup()) {
    throw new Error("Temporary doctor lint state snapshot cleanup did not complete.");
  }
  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

function withCoreLintContext(
  check: HealthCheck,
  ctx: HealthCheckContext & { readonly deep?: boolean },
): HealthCheck {
  return {
    ...check,
    detect(_ctx, scope) {
      return check.detect(ctx, scope);
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
