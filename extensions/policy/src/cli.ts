import { isAbsolute, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Command } from "commander";
import {
  exitCodeFromFindings,
  healthFindingMeetsSeverity,
  parseHealthFindingSeverity,
  readConfigFileSnapshot,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  type HealthCheckContext,
  type HealthFinding,
} from "openclaw/plugin-sdk/health";
import { POLICY_CHECK_IDS, evaluatePolicy } from "./doctor/register.js";
import {
  buildPolicyConformanceReport,
  type PolicyConformanceReport,
} from "./policy-conformance.js";
import { createPolicyAttestation } from "./policy-state.js";

export type PolicyCommandRuntime = {
  writeStdout(value: string): void;
  error(value: string): void;
  sleep?(ms: number): Promise<void>;
};

export interface PolicyCheckOptions {
  readonly json?: boolean;
  readonly severityMin?: string;
  readonly cwd?: string;
}

export interface PolicyWatchOptions extends PolicyCheckOptions {
  readonly intervalMs?: string | number;
  readonly once?: boolean;
}

export interface PolicyCompareOptions {
  readonly baseline?: string;
  readonly policy?: string;
  readonly json?: boolean;
  readonly cwd?: string;
}

type PolicyCheckReport = {
  readonly ok: boolean;
  readonly attestation?: ReturnType<typeof createPolicyAttestation>;
  readonly evidence: unknown;
  readonly checksRun: number;
  readonly checksSkipped: number;
  readonly findings: readonly Record<string, unknown>[];
  readonly expectedAttestationHash?: string;
  readonly exitCode: 0 | 1;
};

const defaultRuntime: PolicyCommandRuntime = {
  writeStdout(value) {
    process.stdout.write(value);
  },
  error(value) {
    process.stderr.write(`${value}\n`);
  },
  sleep(ms) {
    return sleep(ms);
  },
};

export function registerPolicyCli(program: Command): void {
  const policy = program.command("policy").description("Verify workspace policy conformance");

  policy
    .command("compare")
    .description("Compare policy.jsonc against an authored baseline policy file")
    .requiredOption("--baseline <path>", "Baseline policy file to compare against")
    .option("--policy <path>", "Policy file to check; defaults to configured policy path")
    .option("--json", "Emit JSON output")
    .action(async (options: PolicyCompareOptions) => {
      process.exitCode = await policyCompareCommand(options);
    });

  policy
    .command("check")
    .description("Check policy requirements and emit an audit attestation")
    .option("--json", "Emit JSON output")
    .option("--severity-min <severity>", "Minimum severity: info, warning, or error")
    .action(async (options: PolicyCheckOptions) => {
      process.exitCode = await policyCheckCommand(options);
    });

  policy
    .command("watch")
    .description("Watch policy evidence and report accepted-attestation drift")
    .option("--json", "Emit JSON output")
    .option("--severity-min <severity>", "Minimum severity: info, warning, or error")
    .option("--interval-ms <ms>", "Polling interval in milliseconds")
    .option("--once", "Run one watch evaluation and exit")
    .action(async (options: PolicyWatchOptions) => {
      process.exitCode = await policyWatchCommand(options);
    });
}

export async function policyCompareCommand(
  options: PolicyCompareOptions,
  runtime: PolicyCommandRuntime = defaultRuntime,
): Promise<number> {
  try {
    if (options.baseline === undefined || options.baseline.trim() === "") {
      throw new Error("Missing required --baseline value.");
    }
    const policyPath = await policyCompareCandidatePath(options);
    const report = await buildPolicyConformanceReport({
      baselinePath: options.baseline,
      policyPath,
      cwd: options.cwd,
    });
    writePolicyConformanceReport(report, options, runtime);
    return report.ok ? 0 : 1;
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

export async function policyCheckCommand(
  options: PolicyCheckOptions,
  runtime: PolicyCommandRuntime = defaultRuntime,
): Promise<number> {
  try {
    const report = await buildPolicyCheckReport(options, runtime);
    writePolicyCheckReport(report, options, runtime);
    return report.exitCode;
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

export async function policyWatchCommand(
  options: PolicyWatchOptions,
  runtime: PolicyCommandRuntime = defaultRuntime,
): Promise<number> {
  try {
    const intervalMs = normalizeWatchIntervalMs(options.intervalMs);
    let previousKey: string | undefined;
    for (;;) {
      const report = await buildPolicyCheckReport(options, runtime);
      const status = policyWatchStatus(report);
      const key = `${status}:${report.attestation?.attestationHash ?? ""}:${report.exitCode}`;
      if (previousKey === undefined || previousKey !== key || options.once === true) {
        writePolicyWatchReport(report, status, options, runtime);
        previousKey = key;
      }
      if (options.once === true) {
        return status === "stale" ? 1 : report.exitCode;
      }
      if (runtime.sleep !== undefined) {
        await runtime.sleep(intervalMs);
      } else {
        await sleep(intervalMs);
      }
    }
  } catch (err) {
    runtime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

async function buildPolicyCheckReport(
  options: PolicyCheckOptions,
  runtime: PolicyCommandRuntime,
): Promise<PolicyCheckReport> {
  const severityMin =
    options.severityMin === undefined ? "info" : parseHealthFindingSeverity(options.severityMin);
  if (severityMin === null) {
    throw new Error("Invalid --severity-min value. Expected one of: info, warning, error.");
  }
  const snapshot = await readConfigFileSnapshot({ observe: false });
  if (!snapshot.valid) {
    const findings: HealthFinding[] = snapshot.issues.map((issue) => ({
      checkId: "policy/config-invalid",
      severity: "error",
      message: issue.message,
      source: "policy",
      path: issue.path,
    }));
    const visibleFindings = findings.filter((finding) =>
      healthFindingMeetsSeverity(finding, severityMin),
    );
    return {
      ok: visibleFindings.length === 0,
      evidence: { channels: [] },
      checksRun: 1,
      checksSkipped: POLICY_CHECK_IDS.length,
      findings: visibleFindings.map(toJsonFinding),
      exitCode: visibleFindings.length === 0 ? 0 : 1,
    };
  }
  const cfg = snapshot.valid ? policyCommandConfig(snapshot.config) : {};
  const cwd = options.cwd ?? resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
  const ctx: HealthCheckContext = {
    mode: "lint",
    runtime: {
      log(value) {
        runtime.writeStdout(`${String(value)}\n`);
      },
      error(value) {
        runtime.error(String(value));
      },
      exit(code) {
        process.exitCode = code;
      },
    },
    cfg,
    cwd,
    ...(snapshot.path !== undefined ? { configPath: snapshot.path } : {}),
  };
  const evaluation = await evaluatePolicy(ctx);
  const findings = evaluation.findings.filter((finding) =>
    healthFindingMeetsSeverity(finding, severityMin),
  );
  const jsonFindings = findings.map(toJsonFinding);
  const attestedFindings = evaluation.attestedFindings.map(toJsonFinding);
  const ok = exitCodeFromFindings(evaluation.findings, severityMin) === 0;
  const attestation = createPolicyAttestation({
    ok: evaluation.attestedFindings.length === 0,
    checkedAt: new Date().toISOString(),
    policyPath: evaluation.policyPath,
    policyHash: evaluation.policy?.hash,
    evidence: evaluation.evidence,
    findings: attestedFindings,
  });
  return {
    ok,
    attestation,
    evidence: evaluation.evidence,
    checksRun: POLICY_CHECK_IDS.length,
    checksSkipped: 0,
    findings: jsonFindings,
    expectedAttestationHash: evaluation.expectedAttestationHash,
    exitCode: exitCodeFromFindings(evaluation.findings, severityMin),
  };
}

function policyCommandConfig(cfg: HealthCheckContext["cfg"]): HealthCheckContext["cfg"] {
  return {
    ...cfg,
    plugins: {
      ...cfg.plugins,
      entries: {
        ...cfg.plugins?.entries,
        policy: {
          ...cfg.plugins?.entries?.["policy"],
          enabled: true,
          config: {
            enabled: true,
            ...(typeof cfg.plugins?.entries?.["policy"]?.config === "object" &&
            cfg.plugins.entries["policy"].config !== null
              ? cfg.plugins.entries["policy"].config
              : {}),
          },
        },
      },
    },
  };
}

async function policyCompareCandidatePath(options: PolicyCompareOptions): Promise<string> {
  if (options.policy !== undefined && options.policy.trim() !== "") {
    return options.policy.trim();
  }
  const snapshot = await readConfigFileSnapshot({ observe: false });
  if (!snapshot.valid) {
    return "policy.jsonc";
  }
  const pluginConfig = snapshot.config.plugins?.entries?.["policy"]?.config;
  const configured =
    typeof pluginConfig === "object" && pluginConfig !== null && "path" in pluginConfig
      ? pluginConfig.path
      : undefined;
  const policyPath =
    typeof configured === "string" && configured.trim() !== "" ? configured.trim() : "policy.jsonc";
  if (isAbsolute(policyPath)) {
    return policyPath;
  }
  const cwd =
    options.cwd ??
    resolveAgentWorkspaceDir(snapshot.config, resolveDefaultAgentId(snapshot.config));
  return resolve(cwd, policyPath);
}

function writePolicyCheckReport(
  report: PolicyCheckReport,
  options: PolicyCheckOptions,
  runtime: PolicyCommandRuntime,
): void {
  if (options.json === true || !process.stdout.isTTY) {
    runtime.writeStdout(
      JSON.stringify({
        ok: report.ok,
        attestation: report.attestation,
        evidence: report.evidence,
        checksRun: report.checksRun,
        checksSkipped: report.checksSkipped,
        findings: report.findings,
      }) + "\n",
    );
  } else if (report.findings.length === 0) {
    const policyHash = report.attestation?.policy?.hash ?? "missing";
    const evidenceHash = report.attestation?.workspace.hash ?? "unavailable";
    runtime.writeStdout(
      `policy check: no findings (policy ${policyHash}, evidence ${evidenceHash})\n`,
    );
  } else {
    runtime.writeStdout(`policy check: ${report.findings.length} finding(s)\n`);
    for (const finding of report.findings) {
      const where = typeof finding.path === "string" ? ` ${finding.path}` : "";
      const line = typeof finding.line === "number" ? `:${finding.line}` : "";
      const severity = typeof finding.severity === "string" ? finding.severity : "unknown";
      const checkId = typeof finding.checkId === "string" ? finding.checkId : "unknown";
      const message = typeof finding.message === "string" ? finding.message : "";
      runtime.writeStdout(`  [${severity}] ${checkId}${where}${line} - ${message}\n`);
    }
  }
}

function writePolicyConformanceReport(
  report: PolicyConformanceReport,
  options: PolicyCompareOptions,
  runtime: PolicyCommandRuntime,
): void {
  if (options.json === true || !process.stdout.isTTY) {
    runtime.writeStdout(JSON.stringify(report) + "\n");
    return;
  }
  if (report.findings.length === 0) {
    runtime.writeStdout(
      `policy compare: no findings (${report.policyPath} is at least as strict as ${report.baselinePath}; ${report.rulesChecked} rule(s) checked)\n`,
    );
    return;
  }
  runtime.writeStdout(
    `policy compare: ${report.findings.length} finding(s) (${report.rulesChecked} rule(s) checked)\n`,
  );
  for (const finding of report.findings) {
    runtime.writeStdout(`  [${finding.severity}] ${finding.checkId} - ${finding.message}\n`);
  }
}

function writePolicyWatchReport(
  report: PolicyCheckReport,
  status: "clean" | "findings" | "stale",
  options: PolicyWatchOptions,
  runtime: PolicyCommandRuntime,
): void {
  if (options.json === true || !process.stdout.isTTY) {
    runtime.writeStdout(
      JSON.stringify({
        status,
        ok: report.ok,
        expectedAttestationHash: report.expectedAttestationHash,
        attestation: report.attestation,
        findings: report.findings,
      }) + "\n",
    );
    return;
  }
  if (status === "stale") {
    runtime.writeStdout(
      `policy watch: accepted attestation is stale (current ${report.attestation?.attestationHash}, expected ${report.expectedAttestationHash}). Review policy check output, then update the supervisor/gateway accepted attestation.\n`,
    );
    return;
  }
  if (status === "findings") {
    runtime.writeStdout(
      `policy watch: ${report.findings.length} finding(s); accepted attestation cannot be updated until policy check is clean.\n`,
    );
    return;
  }
  runtime.writeStdout(
    `policy watch: clean (attestation ${report.attestation?.attestationHash}, evidence ${report.attestation?.workspace.hash})\n`,
  );
}

function policyWatchStatus(report: PolicyCheckReport): "clean" | "findings" | "stale" {
  if (
    !report.ok &&
    report.findings.some((finding) => finding.checkId !== "policy/attestation-hash-mismatch")
  ) {
    return "findings";
  }
  const expected = report.expectedAttestationHash?.trim();
  if (
    expected &&
    report.attestation !== undefined &&
    report.attestation.attestationHash !== expected
  ) {
    return "stale";
  }
  return report.ok ? "clean" : "findings";
}

function normalizeWatchIntervalMs(value: string | number | undefined): number {
  if (value === undefined) {
    return 2000;
  }
  const raw =
    typeof value === "number"
      ? value
      : /^\+?\d+$/.test(value.trim())
        ? Number(value.trim())
        : Number.NaN;
  if (!Number.isSafeInteger(raw) || raw < 250) {
    throw new Error("--interval-ms must be an integer >= 250.");
  }
  return raw;
}

function toJsonFinding(finding: HealthFinding): Record<string, unknown> {
  return {
    checkId: finding.checkId,
    severity: finding.severity,
    message: finding.message,
    ...(finding.source !== undefined ? { source: finding.source } : {}),
    ...(finding.path !== undefined ? { path: finding.path } : {}),
    ...(finding.line !== undefined ? { line: finding.line } : {}),
    ...(finding.ocPath !== undefined ? { ocPath: finding.ocPath } : {}),
    ...(finding.target !== undefined ? { target: finding.target } : {}),
    ...(finding.requirement !== undefined ? { requirement: finding.requirement } : {}),
    ...(finding.fixHint !== undefined ? { fixHint: finding.fixHint } : {}),
  };
}
