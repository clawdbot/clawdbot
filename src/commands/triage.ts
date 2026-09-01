// Collect read-only doctor findings and sanitized diagnostics for an agent handoff.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { resolveAgentEffectiveModelPrimary } from "../agents/agent-scope.js";
import { callGatewayFromCliWithTransport } from "../cli/gateway-rpc.js";
import { resolveSubprocessExitCode } from "../cli/subprocess-exit-code.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { scrubDoctorErrorMessage } from "../flows/doctor-error-message.js";
import type { HealthFindingSeverity } from "../flows/health-checks.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import {
  installationTargetEnv,
  resolveInstallationTarget,
  withInstallationTarget,
} from "../infra/installation-target-context.js";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import { select } from "./configure.shared.js";
import { renderTriagePrompt, type TriageBundle } from "./triage-prompt.js";

type TriageOptions = {
  json?: boolean;
  noExport?: boolean;
  run?: boolean;
};

type TriageExternalAgent = "claude" | "codex";
type TriageHandoff =
  | { kind: "print" }
  | { kind: "embedded" }
  | { kind: "external"; agent: TriageExternalAgent; executablePath: string };
type TriageHandoffMode = TriageHandoff | { kind: "offer" };

async function collectTriageBundle(skipExport: boolean): Promise<TriageBundle> {
  if (skipExport) {
    return { kind: "skipped" };
  }
  try {
    const rpc = { timeout: "3000", json: true };
    const [{ writeDiagnosticSupportExport }, { gatherDaemonStatus }] = await Promise.all([
      import("../logging/diagnostic-support-export.js"),
      import("../cli/daemon-cli/status.gather.js"),
    ]);
    const result = await writeDiagnosticSupportExport({
      // The exporter records failed snapshots while preserving local diagnostics.
      readHealthSnapshot: async () =>
        await callGatewayFromCliWithTransport("health", rpc, undefined, {
          defaultTimeoutMs: 3000,
          sharedStateMode: "read-only",
        }),
      readStatusSnapshot: async () =>
        await gatherDaemonStatus({ rpc, probe: true, requireRpc: false, deep: false }),
    });
    return { kind: "available", path: result.path };
  } catch (error) {
    return {
      kind: "unavailable",
      reason: scrubDoctorErrorMessage(error),
    };
  }
}

function resolveTriageHandoff(options: TriageOptions): TriageHandoffMode {
  if (options.json === true) {
    return { kind: "print" };
  }
  if (options.run === true) {
    return { kind: "embedded" };
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
  // Doctor has loaded dotenv; capture selectors before agent exec redirects run state.
  const target = resolveInstallationTarget();
  const targetEnv = installationTargetEnv(target);
  const redaction = { env: process.env, stateDir: target.stateDir };
  const bundle = await collectTriageBundle(options.noExport === true);
  const prompt = renderTriagePrompt({ findings, bundle, redaction });
  const now = new Date().toISOString().replace(/[:.]/gu, "-");
  const outputDir = path.join(redaction.stateDir, "logs", "support");
  const promptPath = path.join(outputDir, `openclaw-triage-prompt-${now}-${process.pid}.md`);
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(promptPath, prompt, { encoding: "utf8", mode: 0o600 });

  // Operator-facing paths and shell commands stay real; only agent prompt content is path-redacted.
  const quotedPath = quoteShellArgument(promptPath);
  const targetPrefix = `env OPENCLAW_STATE_DIR=${quoteShellArgument(target.stateDir)} OPENCLAW_CONFIG_PATH=${quoteShellArgument(target.configPath)} OPENCLAW_WORKSPACE_DIR=${quoteShellArgument(target.defaultWorkspaceDir)}`;
  const suggestedCommands = [
    `${targetPrefix} claude "$(cat ${quotedPath})"`,
    `${targetPrefix} codex exec --skip-git-repo-check - < ${quotedPath}`,
    `${targetPrefix} openclaw triage --run`,
  ];
  const findingCounts: Record<HealthFindingSeverity, number> = {
    error: 0,
    warning: 0,
    info: 0,
  };
  for (const finding of findings) {
    findingCounts[finding.severity] += 1;
  }
  let handoff = resolveTriageHandoff(options);
  const externalAgents =
    options.json === true || handoff.kind === "offer"
      ? (["claude", "codex"] as const).flatMap((agent) => {
          const executablePath = resolveExecutablePath(agent);
          return executablePath ? [{ agent, executablePath }] : [];
        })
      : [];
  const detectedAgents = externalAgents.map(({ agent }) => agent);
  const report = {
    promptPath,
    bundlePath: bundle.kind === "available" ? bundle.path : null,
    bundleError:
      bundle.kind === "unavailable" ? redactSupportString(bundle.reason, redaction) : null,
    findings: findingCounts,
    detectedAgents,
    suggestedCommands,
  };
  if (options.json === true) {
    writeRuntimeJson(runtime, report);
    return;
  }

  runtime.log(`Debugging prompt: ${promptPath}`);
  if (bundle.kind === "available") {
    runtime.log(`Sanitized diagnostics: ${bundle.path}`);
  } else if (bundle.kind === "unavailable") {
    runtime.log(`Diagnostics export unavailable: ${report.bundleError}`);
  }

  if (handoff.kind === "offer") {
    const snapshot = await readConfigFileSnapshot({ observe: false });
    const config = snapshot.runtimeConfig ?? snapshot.config;
    const agentId = tryResolveAmbientOwnerAgentId(config);
    const choices: Parameters<typeof select<TriageHandoff>>[0]["options"] = [];
    if (
      snapshot.exists &&
      snapshot.valid &&
      agentId &&
      resolveAgentEffectiveModelPrimary(config, agentId)
    ) {
      choices.push({ value: { kind: "embedded" }, label: "OpenClaw embedded agent" });
    }
    for (const { agent, executablePath } of externalAgents) {
      // Windows command shims need a shell, so keep them manual-only rather than offering a broken launch.
      if (process.platform === "win32" && /\.(?:cmd|bat)$/iu.test(executablePath)) {
        continue;
      }
      choices.push({
        value: { kind: "external", agent, executablePath },
        label: agent === "claude" ? "Claude Code" : "Codex CLI",
      });
    }
    choices.push({ value: { kind: "print" }, label: "Just print the commands" });
    const selected = await select<TriageHandoff>({
      message: "Choose an agent to investigate this OpenClaw installation",
      options: choices,
    });
    if (typeof selected === "symbol") {
      runtime.exit(130);
      return;
    }
    handoff = selected;
  }

  if (handoff.kind === "print" || handoff.kind === "embedded") {
    runtime.log("Ready-to-run agent handoffs:");
    for (const command of suggestedCommands) {
      runtime.log(`  ${command}`);
    }
    if (handoff.kind === "print") {
      return;
    }
  }
  if (handoff.kind === "external") {
    let exitCode: number;
    try {
      exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn(handoff.executablePath, [prompt], {
          stdio: "inherit",
          env: { ...process.env, ...targetEnv },
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve(resolveSubprocessExitCode(code, signal)));
      });
    } catch (error) {
      runtime.error(`Failed to launch ${handoff.agent}: ${scrubDoctorErrorMessage(error)}`);
      runtime.log(`Run manually: ${suggestedCommands[handoff.agent === "claude" ? 0 : 1]}`);
      runtime.exit(1);
      return;
    }
    if (exitCode !== 0) {
      runtime.exit(exitCode);
    }
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
    const reason = redactSupportString(scrubDoctorErrorMessage(inference.error), redaction);
    throw new Error(
      `Embedded agent unavailable: ${reason}. Run \`openclaw onboard\` or use a suggested handoff command.`,
    );
  }
  const { agentExecCommand } = await import("./agent-exec.js");
  const result = await withInstallationTarget(target, () =>
    agentExecCommand(undefined, { messageFile: promptPath }, runtime),
  );
  if (result.exitCode !== 0) {
    runtime.exit(result.exitCode);
  }
}
