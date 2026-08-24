// Collect read-only doctor findings and sanitized diagnostics for an agent handoff.
import fs from "node:fs/promises";
import path from "node:path";
import { callGatewayFromCliWithTransport } from "../cli/gateway-rpc.js";
import { resolveStateDir } from "../config/paths.js";
import { scrubDoctorErrorMessage } from "../flows/doctor-error-message.js";
import type { HealthFindingSeverity } from "../flows/health-checks.js";
import { redactTextForSupport } from "../logging/diagnostic-support-redaction.js";
import { writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import { renderTriagePrompt, type TriageBundle } from "./triage-prompt.js";

type TriageOptions = {
  json?: boolean;
  noExport?: boolean;
  run?: boolean;
};

type TriageHandoff = { kind: "print" } | { kind: "offer" } | { kind: "run" };

async function collectTriageBundle(skipExport: boolean): Promise<TriageBundle> {
  if (skipExport) {
    return { kind: "skipped" };
  }
  try {
    const rpc = { timeout: "3000", json: true };
    const health = await callGatewayFromCliWithTransport("health", rpc, undefined, {
      defaultTimeoutMs: 3000,
      sharedStateMode: "read-only",
    });
    const [{ writeDiagnosticSupportExport }, { gatherDaemonStatus }] = await Promise.all([
      import("../logging/diagnostic-support-export.js"),
      import("../cli/daemon-cli/status.gather.js"),
    ]);
    const result = await writeDiagnosticSupportExport({
      readHealthSnapshot: async () => health,
      readStatusSnapshot: async () =>
        await gatherDaemonStatus({ rpc, probe: true, requireRpc: false, deep: false }),
    });
    return { kind: "available", path: result.path };
  } catch (error) {
    return {
      kind: "unavailable",
      reason: redactTextForSupport(scrubDoctorErrorMessage(error)),
    };
  }
}

function resolveTriageHandoff(options: TriageOptions): TriageHandoff {
  if (options.json === true) {
    return { kind: "print" };
  }
  if (options.run === true) {
    return { kind: "run" };
  }
  return process.stdin.isTTY && process.stdout.isTTY ? { kind: "offer" } : { kind: "print" };
}

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Collect read-only diagnostics, write the bounded prompt, and optionally run one agent turn. */
export async function triageCommand(
  runtime: RuntimeEnv,
  options: TriageOptions = {},
): Promise<void> {
  const { collectDoctorFindings } = await import("./doctor-lint.js");
  const findings = await collectDoctorFindings(runtime);
  const bundle = await collectTriageBundle(options.noExport === true);
  const prompt = renderTriagePrompt({ findings, bundle });
  const now = new Date().toISOString().replace(/[:.]/gu, "-");
  const outputDir = path.join(resolveStateDir(), "logs", "support");
  const promptPath = path.join(outputDir, `openclaw-triage-prompt-${now}-${process.pid}.md`);
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600 });

  const quotedPath = quoteShellArgument(promptPath);
  const suggestedCommands = [
    `claude "$(cat ${quotedPath})"`,
    `codex exec - < ${quotedPath}`,
    "openclaw triage --run",
  ];
  const findingCounts: Record<HealthFindingSeverity, number> = {
    error: 0,
    warning: 0,
    info: 0,
  };
  for (const finding of findings) {
    findingCounts[finding.severity] += 1;
  }
  const report = {
    promptPath,
    bundlePath: bundle.kind === "available" ? bundle.path : null,
    bundleError: bundle.kind === "unavailable" ? bundle.reason : null,
    findings: findingCounts,
    suggestedCommands,
  };
  const handoff = resolveTriageHandoff(options);
  if (options.json === true) {
    writeRuntimeJson(runtime, report);
    return;
  }

  runtime.log(`Debugging prompt: ${promptPath}`);
  if (bundle.kind === "available") {
    runtime.log(`Sanitized diagnostics: ${bundle.path}`);
  } else if (bundle.kind === "unavailable") {
    runtime.log(`Diagnostics export unavailable: ${bundle.reason}`);
  }
  runtime.log("Ready-to-run agent handoffs:");
  for (const command of suggestedCommands) {
    runtime.log(`  ${command}`);
  }
  if (handoff.kind === "print") {
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      "Embedded triage requires an interactive terminal; use a suggested handoff command.",
    );
  }

  const { verifySetupInference } = await import("../system-agent/setup-inference.js");
  const inference = await verifySetupInference({ runtime, timeoutMs: 15_000 });
  if (!inference.ok) {
    const reason = redactTextForSupport(scrubDoctorErrorMessage(inference.error));
    const message = `Embedded agent unavailable: ${reason}. Run \`openclaw onboard\` or use a suggested handoff command.`;
    if (handoff.kind === "run") {
      throw new Error(message);
    }
    runtime.log(message);
    return;
  }
  if (handoff.kind === "offer") {
    const { promptYesNo } = await import("../cli/prompt.js");
    if (!(await promptYesNo("Run one embedded OpenClaw agent turn on this prompt?"))) {
      return;
    }
  }
  const { agentExecCommand } = await import("./agent-exec.js");
  const result = await agentExecCommand(undefined, { messageFile: promptPath }, runtime);
  if (result.exitCode !== 0) {
    runtime.exit(result.exitCode);
  }
}
