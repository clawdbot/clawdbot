import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { readConfigFileSnapshot } from "../config/config.js";
import {
  configValidationIssuesToHealthFindings,
  registerCoreHealthChecks,
} from "../flows/doctor-core-checks.js";
import {
  exitCodeFromFindings,
  runDoctorLintChecks,
  type DoctorLintRunOptions,
} from "../flows/doctor-lint-flow.js";
import {
  healthFindingMeetsSeverity,
  parseHealthFindingSeverity,
  type HealthCheckContext,
  type HealthFinding,
} from "../flows/health-checks.js";
import type { RuntimeEnv } from "../runtime.js";

export interface DoctorLintCliOptions {
  readonly json?: boolean;
  readonly severityMin?: string;
  readonly skipIds?: readonly string[];
  readonly onlyIds?: readonly string[];
}

function detectMode(opts: DoctorLintCliOptions): "human" | "json" {
  if (opts.json === true) {
    return "json";
  }
  return process.stdout.isTTY ? "human" : "json";
}

export async function runDoctorLintCli(
  runtime: RuntimeEnv,
  opts: DoctorLintCliOptions,
): Promise<number> {
  registerCoreHealthChecks();

  const sevMin =
    opts.severityMin === undefined ? "info" : parseHealthFindingSeverity(opts.severityMin);
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
        const path = issue.path || "<root>";
        runtime.error(`- ${path}: ${issue.message}`);
      }
    }
    return exitCodeFromFindings(findings, sevMin);
  }

  const ctx: HealthCheckContext = {
    mode: "lint",
    runtime,
    cfg: snapshot.config,
    cwd: resolveAgentWorkspaceDir(snapshot.config, resolveDefaultAgentId(snapshot.config)),
    ...(snapshot.path !== undefined ? { configPath: snapshot.path } : {}),
  };

  const runOpts: DoctorLintRunOptions = {
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
    ...(f.fixHint !== undefined ? { fixHint: f.fixHint } : {}),
  };
}
