// Policy plugin module implements cli behavior.
import { isAbsolute, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Command } from "commander";
import { listAgentIds, resolveDefaultAgentId } from "openclaw/plugin-sdk/agent-scope-runtime";
import {
  exitCodeFromFindings,
  healthFindingMeetsSeverity,
  parseHealthFindingSeverity,
  readConfigFileSnapshot,
  resolveAgentWorkspaceDir,
  type HealthCheckContext,
  type HealthFinding,
} from "openclaw/plugin-sdk/health";
import { normalizeAgentId } from "openclaw/plugin-sdk/routing";
import { defaultRuntime as cliRuntime } from "openclaw/plugin-sdk/runtime";
import { formatCliCommand } from "openclaw/plugin-sdk/setup-tools";
import { POLICY_FIX_METADATA_BY_CHECK_ID } from "./doctor/fix-metadata.js";
import { POLICY_CHECK_IDS, evaluatePolicy } from "./doctor/register.js";
import {
  buildPolicyConformanceReport,
  type PolicyConformanceReport,
} from "./policy-conformance.js";
import { createPolicyAttestation } from "./policy-state.js";

interface PolicyCheckOptions {
  readonly agent?: string;
  readonly json?: boolean;
  readonly severityMin?: string;
}

interface PolicyWatchOptions extends PolicyCheckOptions {
  readonly intervalMs?: string | number;
  readonly once?: boolean;
}

interface PolicyCompareOptions {
  readonly agent?: string;
  readonly baseline?: string;
  readonly policy?: string;
  readonly json?: boolean;
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

export function registerPolicyCli(program: Command): void {
  const policy = program.command("policy").description("Verify workspace policy conformance");

  policy
    .command("compare")
    .description("Compare policy.jsonc against an authored baseline policy file")
    .requiredOption("--baseline <path>", "Baseline policy file to compare against")
    .option("--policy <path>", "Policy file to check; defaults to configured policy path")
    .option("--agent <id>", "Agent id for relative policy workspace paths")
    .option("--json", "Emit JSON output")
    .action(async (options: PolicyCompareOptions) => {
      process.exitCode = await policyCompareCommand(options);
    });

  policy
    .command("check")
    .description("Check policy requirements and emit an audit attestation")
    .option("--agent <id>", "Agent id (required when multiple agents are configured)")
    .option("--json", "Emit JSON output")
    .option("--severity-min <severity>", "Minimum severity: info, warning, or error")
    .action(async (options: PolicyCheckOptions) => {
      process.exitCode = await policyCheckCommand(options);
    });

  policy
    .command("watch")
    .description("Watch policy evidence and report accepted-attestation drift")
    .option("--agent <id>", "Agent id (required when multiple agents are configured)")
    .option("--json", "Emit JSON output")
    .option("--severity-min <severity>", "Minimum severity: info, warning, or error")
    .option("--interval-ms <ms>", "Polling interval in milliseconds")
    .option("--once", "Run one watch evaluation and exit")
    .action(async (options: PolicyWatchOptions) => {
      process.exitCode = await policyWatchCommand(options);
    });
}

async function policyCompareCommand(options: PolicyCompareOptions): Promise<number> {
  return runPolicyCommand(async () => {
    if (options.baseline === undefined || options.baseline.trim() === "") {
      throw new Error("Missing required --baseline value.");
    }
    const policyPath = await policyCompareCandidatePath(options);
    const report = await buildPolicyConformanceReport({
      baselinePath: options.baseline,
      policyPath,
    });
    writePolicyConformanceReport(report, options);
    return report.ok ? 0 : 1;
  });
}

async function policyCheckCommand(options: PolicyCheckOptions): Promise<number> {
  return runPolicyCommand(async () => {
    const report = await buildPolicyCheckReport(options, "policy check");
    writePolicyCheckReport(report, options);
    return report.exitCode;
  });
}

async function policyWatchCommand(options: PolicyWatchOptions): Promise<number> {
  return runPolicyCommand(async () => {
    const intervalMs = normalizeWatchIntervalMs(options.intervalMs);
    let previousKey: string | undefined;
    for (;;) {
      const report = await buildPolicyCheckReport(options, "policy watch");
      const status = policyWatchStatus(report);
      const key = `${status}:${report.attestation?.attestationHash ?? ""}:${report.exitCode}`;
      if (previousKey === undefined || previousKey !== key || options.once === true) {
        writePolicyWatchReport(report, status, options);
        previousKey = key;
      }
      if (options.once === true) {
        return status === "stale" ? 1 : report.exitCode;
      }
      await sleep(intervalMs);
    }
  });
}

async function runPolicyCommand(run: () => Promise<number>): Promise<number> {
  try {
    return await run();
  } catch (err) {
    cliRuntime.error(err instanceof Error ? err.message : String(err));
    return 2;
  }
}

async function buildPolicyCheckReport(
  options: PolicyCheckOptions,
  ownerSurface: "policy check" | "policy watch",
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
  const cwd = resolveAgentWorkspaceDir(
    cfg,
    resolvePolicyCommandAgentId(cfg, options.agent, ownerSurface),
  );
  const ctx: HealthCheckContext = {
    mode: "lint",
    runtime: {
      log(value) {
        process.stdout.write(`${String(value)}\n`);
      },
      error(value) {
        cliRuntime.error(String(value));
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
  const attestedFindings = evaluation.attestedFindings.map(toAttestedJsonFinding);
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

function resolvePolicyCommandAgentId(
  cfg: HealthCheckContext["cfg"],
  rawAgentId: string | undefined,
  surface: "policy check" | "policy watch" | "policy compare",
): string {
  const requestedAgentId = rawAgentId?.trim();
  if (rawAgentId !== undefined && !requestedAgentId) {
    throw new Error("--agent must not be blank");
  }
  if (requestedAgentId) {
    const agentId = normalizeAgentId(requestedAgentId);
    if (!listAgentIds(cfg).includes(agentId)) {
      throw new Error(
        `Unknown agent id "${requestedAgentId}". Run ${formatCliCommand("openclaw agents list")} to see configured agents.`,
      );
    }
    return agentId;
  }
  return resolveDefaultAgentId(cfg, {
    surface,
    hint: "Pass --agent <id>.",
  });
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
  const cwd = resolveAgentWorkspaceDir(
    snapshot.config,
    resolvePolicyCommandAgentId(snapshot.config, options.agent, "policy compare"),
  );
  return resolve(cwd, policyPath);
}

function writePolicyCheckReport(report: PolicyCheckReport, options: PolicyCheckOptions): void {
  if (options.json === true || !process.stdout.isTTY) {
    process.stdout.write(
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
    process.stdout.write(
      `policy check: no findings (policy ${policyHash}, evidence ${evidenceHash})\n`,
    );
  } else {
    process.stdout.write(`policy check: ${report.findings.length} finding(s)\n`);
    for (const finding of report.findings) {
      const where = typeof finding.path === "string" ? ` ${finding.path}` : "";
      const line = typeof finding.line === "number" ? `:${finding.line}` : "";
      const severity = typeof finding.severity === "string" ? finding.severity : "unknown";
      const checkId = typeof finding.checkId === "string" ? finding.checkId : "unknown";
      const message = typeof finding.message === "string" ? finding.message : "";
      process.stdout.write(`  [${severity}] ${checkId}${where}${line} - ${message}\n`);
    }
  }
}

function writePolicyConformanceReport(
  report: PolicyConformanceReport,
  options: PolicyCompareOptions,
): void {
  if (options.json === true || !process.stdout.isTTY) {
    process.stdout.write(JSON.stringify(report) + "\n");
    return;
  }
  if (report.findings.length === 0) {
    process.stdout.write(
      `policy compare: no findings (${report.policyPath} is at least as strict as ${report.baselinePath}; ${report.rulesChecked} rule(s) checked)\n`,
    );
    return;
  }
  process.stdout.write(
    `policy compare: ${report.findings.length} finding(s) (${report.rulesChecked} rule(s) checked)\n`,
  );
  for (const finding of report.findings) {
    process.stdout.write(`  [${finding.severity}] ${finding.checkId} - ${finding.message}\n`);
  }
}

function writePolicyWatchReport(
  report: PolicyCheckReport,
  status: "clean" | "findings" | "stale",
  options: PolicyWatchOptions,
): void {
  if (options.json === true || !process.stdout.isTTY) {
    process.stdout.write(
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
    process.stdout.write(
      `policy watch: accepted attestation is stale (current ${report.attestation?.attestationHash}, expected ${report.expectedAttestationHash}). Review policy check output, then update the supervisor/gateway accepted attestation.\n`,
    );
    return;
  }
  if (status === "findings") {
    process.stdout.write(
      `policy watch: ${report.findings.length} finding(s); accepted attestation cannot be updated until policy check is clean.\n`,
    );
    return;
  }
  process.stdout.write(
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

function toAttestedJsonFinding(finding: HealthFinding): Record<string, unknown> {
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

function toJsonFinding(finding: HealthFinding): Record<string, unknown> {
  return {
    ...toAttestedJsonFinding(finding),
    ...policyFindingMetadata(finding),
  };
}

function policyFindingMetadata(finding: HealthFinding): Record<string, unknown> {
  const metadata = POLICY_FIX_METADATA_BY_CHECK_ID.get(
    finding.checkId as (typeof POLICY_CHECK_IDS)[number],
  );
  if (metadata === undefined) {
    return {};
  }
  return {
    policy: {
      fixRecommendation: {
        fixClass: metadata.fixClass,
        ...(metadata.policyPath !== undefined ? { policyPath: metadata.policyPath } : {}),
        ...(metadata.configTargets !== undefined ? { configTargets: metadata.configTargets } : {}),
        summary: metadata.summary,
      },
    },
  };
}
