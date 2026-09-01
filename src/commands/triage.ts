// Collect read-only doctor findings and sanitized diagnostics for an agent handoff.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Result } from "@openclaw/normalization-core/result";
import { callGatewayFromCliWithTransport } from "../cli/gateway-rpc.js";
import { exitCliAfterOutput } from "../cli/one-shot-exit.js";
import { resolveSubprocessExitCode } from "../cli/subprocess-exit-code.js";
import { isNodeRuntime } from "../daemon/runtime-binary.js";
import { scrubDoctorErrorMessage } from "../flows/doctor-error-message.js";
import type { HealthFinding, HealthFindingSeverity } from "../flows/health-checks.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import {
  installationTargetEnv,
  resolveInstallationTarget,
  withInstallationTarget,
  type InstallationTarget,
} from "../infra/installation-target-context.js";
import { readRestartSentinelReadOnly } from "../infra/restart-sentinel.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { resolveWindowsSpawnProgramCandidate } from "../plugin-sdk/windows-spawn.js";
import { writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import {
  renderTriagePrompt,
  type TriageBundle,
  type TriageUpdateEvidence,
} from "./triage-prompt.js";

const TRIAGE_EXTERNAL_AGENTS = ["claude", "codex", "opencode", "pi"] as const;
type TriageExternalAgent = (typeof TRIAGE_EXTERNAL_AGENTS)[number];

export type TriageRecoveryContext = {
  target: InstallationTarget;
  cwd?: string;
  update: Pick<
    UpdateRunResult,
    "status" | "mode" | "root" | "reason" | "before" | "after" | "recovery" | "steps"
  >;
};

type TriageOptions = {
  json?: boolean;
  noExport?: boolean;
  run?: boolean;
  agent?: TriageExternalAgent;
  recovery?: TriageRecoveryContext;
};

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

async function collectTriageUpdateEvidence(
  recovery: TriageRecoveryContext | undefined,
  env: NodeJS.ProcessEnv,
): Promise<TriageUpdateEvidence | undefined> {
  if (recovery) {
    return recovery.update;
  }
  // A pending update notification is evidence only; triage must not consume it or
  // create state while the Gateway is offline. Delivery instructions are excluded.
  const sentinel = await readRestartSentinelReadOnly(env);
  if (sentinel?.payload.kind !== "update" || sentinel.payload.status !== "error") {
    return undefined;
  }
  const stats = sentinel.payload.stats;
  return {
    status: sentinel.payload.status,
    mode: stats?.mode,
    root: stats?.root,
    reason: stats?.reason,
    before: stats?.before,
    after: stats?.after,
    recovery: stats?.recovery,
    steps: (stats?.steps ?? []).map((step) => ({
      name: step.name,
      exitCode: step.log?.exitCode,
      stderrTail: step.log?.stderrTail,
      stdoutTail: step.log?.stdoutTail,
    })),
  };
}

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Collect read-only diagnostics and hand the local repair to an available coding agent. */
export async function triageCommand(
  runtime: RuntimeEnv,
  options: TriageOptions = {},
): Promise<void> {
  let findings: readonly HealthFinding[] = [];
  if (!options.recovery) {
    try {
      const { collectDoctorFindings } = await import("./doctor-lint.js");
      findings = await collectDoctorFindings(runtime);
    } catch (error) {
      findings = [
        {
          checkId: "core/triage/doctor-unavailable",
          severity: "error",
          message: `Doctor checks unavailable: ${scrubDoctorErrorMessage(error)}`,
          fixHint: "Inspect the local installation and captured update outcome, then rerun Doctor.",
        },
      ];
    }
  }
  // Standalone Doctor loads dotenv; recovery carries selectors captured before mutation.
  const target = options.recovery?.target ?? resolveInstallationTarget();
  const targetEnv = installationTargetEnv(target);
  const agentOptions = options.recovery?.cwd ? { cwd: options.recovery.cwd } : {};
  const redaction = { env: process.env, stateDir: target.stateDir };
  // Recovery already has an authoritative update result. Fresh checks and exports
  // can block on the broken installation, so the fixing agent owns that enrichment.
  const bundle: TriageBundle = options.recovery
    ? { kind: "deferred" }
    : await collectTriageBundle(options.noExport === true);
  const update = await collectTriageUpdateEvidence(options.recovery, {
    ...process.env,
    ...targetEnv,
  });
  const prompt = renderTriagePrompt({ findings, bundle, redaction, update });
  // Packaged OpenClaw/Bun hosts cannot interpret npm shim entrypoints. Reuse the
  // active Node runtime or require an installed node.exe before choosing a shim.
  const nodeExecutable = isNodeRuntime(process.execPath)
    ? process.execPath
    : process.platform === "win32"
      ? resolveExecutablePath("node.exe")
      : undefined;
  const externalAgents = TRIAGE_EXTERNAL_AGENTS.flatMap((agent) => {
    const executablePath = resolveExecutablePath(agent);
    return executablePath
      ? [
          {
            agent,
            program: resolveWindowsSpawnProgramCandidate({
              command: executablePath,
              execPath: nodeExecutable,
            }),
          },
        ]
      : [];
  });
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  const handoff = externalAgents.find(({ agent, program }) => {
    const launchable =
      program.resolution !== "unresolved-wrapper" &&
      (program.resolution !== "node-entrypoint" || nodeExecutable !== undefined);
    return launchable && (options.agent === undefined || agent === options.agent);
  });
  const canStartAgent =
    options.json !== true && interactive && (options.run === true || handoff !== undefined);
  const now = new Date().toISOString().replace(/[:.]/gu, "-");
  const outputDir = path.join(redaction.stateDir, "logs", "support");
  let promptArtifact: Result<string, string>;
  try {
    const file = path.join(outputDir, `openclaw-triage-prompt-${now}-${process.pid}.md`);
    await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(file, prompt, { encoding: "utf8", mode: 0o600 });
    promptArtifact = { ok: true, value: file };
  } catch (error) {
    // Native and embedded agents consume the in-memory prompt. A support artifact
    // must not prevent an interactive agent from repairing a storage failure.
    if (!canStartAgent) {
      throw error;
    }
    promptArtifact = {
      ok: false,
      error: redactSupportString(scrubDoctorErrorMessage(error), redaction),
    };
  }
  const promptPath = promptArtifact.ok ? promptArtifact.value : null;

  // Operator-facing paths and shell commands stay real; only agent prompt content is path-redacted.
  const quotedPath = promptPath ? quoteShellArgument(promptPath) : undefined;
  const promptArgument = quotedPath ? `"$(cat ${quotedPath})"` : quoteShellArgument(prompt);
  const codexPromptArgument = quotedPath ? `- < ${quotedPath}` : promptArgument;
  const targetPrefix = `env OPENCLAW_STATE_DIR=${quoteShellArgument(target.stateDir)} OPENCLAW_CONFIG_PATH=${quoteShellArgument(target.configPath)} OPENCLAW_WORKSPACE_DIR=${quoteShellArgument(target.defaultWorkspaceDir)}`;
  const suggestedCommands = [
    ...TRIAGE_EXTERNAL_AGENTS.map((agent) =>
      agent === "codex"
        ? `${targetPrefix} codex exec --skip-git-repo-check ${codexPromptArgument}`
        : `${targetPrefix} ${agent}${agent === "opencode" ? " --prompt" : ""} ${promptArgument}`,
    ),
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

  if (promptArtifact.ok) {
    runtime.log(`Debugging prompt: ${promptArtifact.value}`);
  } else {
    runtime.error(`Debugging prompt could not be saved: ${promptArtifact.error}`);
  }
  if (bundle.kind === "available") {
    runtime.log(`Sanitized diagnostics: ${bundle.path}`);
  } else if (bundle.kind === "unavailable") {
    runtime.log(`Diagnostics export unavailable: ${report.bundleError}`);
  }

  if (!interactive || options.run === true || !handoff) {
    runtime.log(
      process.platform === "win32"
        ? "Agent handoffs (POSIX/Git Bash syntax; not PowerShell or Command Prompt):"
        : "Ready-to-run agent handoffs:",
    );
    for (const command of suggestedCommands) {
      runtime.log(`  ${command}`);
    }
    if (!interactive && options.run !== true) {
      return;
    }
  }
  if (options.run !== true) {
    if (!handoff) {
      if (options.agent) {
        runtime.error(`${options.agent} is not found or unavailable for direct launch on PATH.`);
        exitCliAfterOutput(runtime, 1);
      }
      runtime.log("No coding agent can be launched directly; use a handoff command above.");
      return;
    }
    runtime.log(`Starting ${handoff.agent}; use --agent <name> to select another coding agent.`);
    const args = handoff.agent === "opencode" ? ["--prompt", prompt] : [prompt];
    let exitCode: number;
    try {
      exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn(handoff.program.command, [...handoff.program.leadingArgv, ...args], {
          stdio: "inherit",
          env: { ...process.env, ...targetEnv },
          ...agentOptions,
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve(resolveSubprocessExitCode(code, signal)));
      });
    } catch (error) {
      const reason = redactSupportString(scrubDoctorErrorMessage(error), redaction);
      runtime.error(`Failed to launch ${handoff.agent}: ${reason}`);
      if (process.platform === "win32") {
        runtime.log("Manual handoff commands use POSIX/Git Bash syntax.");
      }
      runtime.log(
        `Run manually: ${suggestedCommands[TRIAGE_EXTERNAL_AGENTS.indexOf(handoff.agent)]}`,
      );
      exitCliAfterOutput(runtime, 1);
    }
    if (exitCode !== 0) {
      exitCliAfterOutput(runtime, exitCode);
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
    agentExecCommand(prompt, agentOptions, runtime),
  );
  if (result.exitCode !== 0) {
    exitCliAfterOutput(runtime, result.exitCode);
  }
}
