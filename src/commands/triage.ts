// Collect read-only doctor findings and sanitized diagnostics for an agent handoff.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Result } from "@openclaw/normalization-core/result";
import { z } from "zod";
import { tryResolveAmbientOwnerAgentId } from "../agents/agent-scope-config.js";
import { resolveAgentEffectiveModelPrimary } from "../agents/agent-scope.js";
import {
  recordAgentCleanupFailure,
  createAgentCleanupScope,
} from "../agents/run-cleanup-timeout.js";
import { callGatewayFromCliWithTransport } from "../cli/gateway-rpc.js";
import { formatInstallationTargetCommand } from "../cli/installation-target-format.js";
import { exitCliAfterOutput } from "../cli/one-shot-exit.js";
import { resolveSubprocessExitCode } from "../cli/subprocess-exit-code.js";
import { isNodeRuntime } from "../daemon/runtime-binary.js";
import { scrubDoctorErrorMessage } from "../flows/doctor-error-message.js";
import type { HealthFinding, HealthFindingSeverity } from "../flows/health-checks.js";
import { createEmbeddedStateSignalBridge } from "../infra/embedded-state-lock.js";
import { resolveExecutablePath } from "../infra/executable-path.js";
import {
  installationTargetEnv,
  resolveInstallationTarget,
  withInstallationTarget,
  type InstallationTarget,
} from "../infra/installation-target-context.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { readRestartSentinelReadOnly } from "../infra/restart-sentinel.js";
import { acceptTriageContinuation } from "../infra/triage-continuation.js";
import type { UpdateRepairValidation } from "../infra/update-repair-protocol.js";
import {
  redactSupportString,
  type SupportRedactionContext,
} from "../logging/diagnostic-support-redaction.js";
import { resolveWindowsSpawnProgramCandidate } from "../plugin-sdk/windows-spawn.js";
import { ExitError, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import { classifyUpdateOutcome } from "../shared/update-outcome.js";
import {
  renderTriagePrompt,
  type TriageBundle,
  type TriageFailureContext,
} from "./triage-prompt.js";
import {
  readTriageUpdateFailure,
  sanitizeTriageUpdateFailure,
  writeTriageUpdateFailure,
  type TriageUpdateFailure,
} from "./triage-update.js";

const TRIAGE_EXTERNAL_AGENTS = ["claude", "codex", "opencode", "pi"] as const;
type TriageExternalAgent = (typeof TRIAGE_EXTERNAL_AGENTS)[number];

type TriageRecoveryContext = {
  target: InstallationTarget;
  cwd?: string;
  updateFailure: TriageUpdateFailure;
  isCurrent?: () => boolean;
};

type TriageOptions = {
  json?: boolean;
  noExport?: boolean;
  run?: boolean;
  nonInteractive?: boolean;
  updateResult?: string;
  agent?: TriageExternalAgent;
  recovery?: TriageRecoveryContext;
};

const triageDoctorReportSchema = z.object({
  ok: z.boolean(),
  findings: z.array(
    z.object({ severity: z.enum(["error", "warning", "info"]), message: z.string() }),
  ),
});

function triageCollectionError(error: unknown, redaction: SupportRedactionContext): string {
  const message = error instanceof Error ? error.message : String(error);
  return scrubDoctorErrorMessage(redactSupportString(message, redaction));
}

async function collectTriageBundle(
  skipExport: boolean,
  redaction: SupportRedactionContext,
): Promise<TriageBundle> {
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
    return { kind: "unavailable", reason: triageCollectionError(error, redaction) };
  }
}

async function readPendingTriageUpdateFailure(
  env: NodeJS.ProcessEnv,
  redaction: SupportRedactionContext,
): Promise<TriageUpdateFailure | undefined> {
  // A pending update notification is evidence only. Do not consume it or create
  // state while the Gateway is offline; delivery instructions are never projected.
  const sentinel = await readRestartSentinelReadOnly(env);
  if (sentinel?.payload.kind !== "update") {
    return undefined;
  }
  const { payload } = sentinel;
  const stats = payload.stats;
  if (
    classifyUpdateOutcome({ status: payload.status, reason: stats?.reason ?? undefined }) !==
    "failed"
  ) {
    return undefined;
  }
  return sanitizeTriageUpdateFailure(
    {
      result: {
        status: payload.status,
        mode: stats?.mode ?? "unknown",
        root: stats?.root,
        reason: stats?.reason ?? undefined,
        before: stats?.before ?? undefined,
        after: stats?.after ?? undefined,
        recovery: stats?.recovery,
        steps: (stats?.steps ?? []).map((step) => ({
          name: step.name,
          exitCode: step.log?.exitCode ?? null,
          stderrTail: step.log?.stderrTail,
          stdoutTail: step.log?.stdoutTail,
        })),
      },
    },
    redaction,
  );
}

/** Collect read-only diagnostics and hand the local repair to an available coding agent. */
export async function triageCommand(
  runtime: RuntimeEnv,
  options: TriageOptions = {},
  automatic?: { failure: TriageFailureContext; signal: AbortSignal } & (
    | { diagnosticOnly: true }
    | { diagnosticOnly?: false; assertCurrent: () => void }
  ),
): Promise<void> {
  if (
    !automatic &&
    !options.json &&
    !options.run &&
    !options.noExport &&
    !options.nonInteractive &&
    !options.agent
  ) {
    const continuation = await acceptTriageContinuation();
    if (continuation) {
      const bridge = createEmbeddedStateSignalBridge();
      try {
        const automaticRuntime: RuntimeEnv = {
          ...runtime,
          exit: (code) => {
            throw new ExitError(code);
          },
        };
        const cleanup = createAgentCleanupScope();
        try {
          return await cleanup.run(() =>
            triageCommand(automaticRuntime, options, {
              failure: continuation.failure,
              signal: AbortSignal.any([continuation.signal, bridge.signal]),
              assertCurrent: continuation.assertCurrent,
            }),
          );
        } finally {
          await continuation.finish(cleanup.outcome);
        }
      } finally {
        bridge.dispose();
      }
    }
  }
  const isCurrent = () => {
    automatic?.signal.throwIfAborted();
    if (automatic && !automatic.diagnosticOnly) {
      automatic.assertCurrent();
    }
    return options.recovery?.isCurrent?.() !== false;
  };
  if (!isCurrent()) {
    return;
  }
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  const allowAgent = automatic
    ? !automatic.diagnosticOnly
    : options.json !== true && options.nonInteractive !== true && interactive;
  const deferDiagnostics =
    !automatic && allowAgent && Boolean(options.recovery || options.updateResult);
  let findings: readonly HealthFinding[] = [];
  if (!deferDiagnostics) {
    try {
      const { collectDoctorFindings } = await import("./doctor-lint.js");
      findings = await collectDoctorFindings(runtime);
    } catch (error) {
      findings = [
        {
          checkId: "core/triage/doctor-collection",
          severity: "error",
          message: `Doctor checks unavailable: ${triageCollectionError(error, {
            env: process.env,
            stateDir: options.recovery?.target.stateDir ?? resolveInstallationTarget().stateDir,
          })}`,
        },
      ];
    }
  }
  // Standalone Doctor loads dotenv; recovery carries selectors captured before mutation.
  const target = options.recovery?.target ?? resolveInstallationTarget();
  const targetEnv = { ...process.env, ...installationTargetEnv(target) };
  const agentCwd = automatic?.failure.installationRoot ?? options.recovery?.cwd;
  const agentOptions = agentCwd ? { cwd: agentCwd } : {};
  const redaction = { env: targetEnv, stateDir: target.stateDir };
  const updateFailure = options.recovery
    ? sanitizeTriageUpdateFailure(options.recovery.updateFailure, redaction)
    : options.updateResult
      ? await readTriageUpdateFailure(options.updateResult, redaction)
      : await readPendingTriageUpdateFailure(targetEnv, redaction);
  // Captured interactive recovery must reach the repair agent before fresh checks
  // or exports can block on the broken installation. Unattended runs still collect.
  const bundle: TriageBundle = deferDiagnostics
    ? { kind: "deferred" }
    : await collectTriageBundle(options.noExport === true, redaction);
  const prompt = renderTriagePrompt({
    findings,
    bundle,
    redaction,
    updateFailure,
    failure: automatic?.failure,
  });
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
  const handoff = externalAgents.find(({ agent, program }) => {
    const launchable =
      program.resolution !== "unresolved-wrapper" &&
      (program.resolution !== "node-entrypoint" || nodeExecutable !== undefined);
    return (
      launchable &&
      (automatic
        ? agent === "claude" || agent === "codex"
        : options.agent === undefined || agent === options.agent)
    );
  });
  let runEmbedded = options.run === true;
  if (automatic && !automatic.diagnosticOnly) {
    const { readConfigFileSnapshot } = await import("../config/config.js");
    const snapshot = await readConfigFileSnapshot({ observe: false });
    const config = snapshot.runtimeConfig ?? snapshot.config;
    const agentId = tryResolveAmbientOwnerAgentId(config);
    runEmbedded = Boolean(
      snapshot.exists &&
      snapshot.valid &&
      agentId &&
      resolveAgentEffectiveModelPrimary(config, agentId),
    );
  }
  const canStartAgent = allowAgent && (runEmbedded || handoff !== undefined);
  const now = new Date().toISOString().replace(/[:.]/gu, "-");
  const outputDir = path.join(target.stateDir, "logs", "support");
  let updateResultPath: string | undefined;
  let promptArtifact: Result<string, string>;
  try {
    // Private handoff inputs can be deleted by their caller. Saved commands use a
    // sanitized support export that remains readable after the updater completes.
    updateResultPath = updateFailure
      ? await writeTriageUpdateFailure(updateFailure, { env: targetEnv })
      : undefined;
    if (!isCurrent()) {
      return;
    }
    const file = path.join(outputDir, `openclaw-triage-prompt-${now}-${process.pid}.md`);
    await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(file, prompt, { encoding: "utf8", mode: 0o600 });
    promptArtifact = { ok: true, value: file };
  } catch (error) {
    // Both agent routes consume the in-memory prompt. Support artifact failures
    // must not block an interactive repair of the installation's storage access.
    if (!canStartAgent) {
      throw error;
    }
    promptArtifact = { ok: false, error: triageCollectionError(error, redaction) };
  }
  if (!isCurrent()) {
    return;
  }
  const promptPath = promptArtifact.ok ? promptArtifact.value : null;
  const stdin = promptPath ? { stdinPath: promptPath, env: targetEnv } : { env: targetEnv };
  const suggestedCommands = [
    ["claude", "-p", ...(promptPath ? [] : [prompt])],
    ["codex", "exec", "--skip-git-repo-check", promptPath ? "-" : prompt],
    ["opencode", "run", ...(promptPath ? [] : [prompt])],
    ["pi", "--print", ...(promptPath ? [] : [prompt])],
  ].map((command) => formatInstallationTargetCommand(command, target, stdin));
  suggestedCommands.push(
    formatInstallationTargetCommand(
      [
        "openclaw",
        "triage",
        "--run",
        ...(updateResultPath ? ["--update-result", updateResultPath] : []),
      ],
      target,
      { env: targetEnv },
    ),
  );
  const findingCounts: Record<HealthFindingSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) {
    findingCounts[finding.severity] += 1;
  }
  const report = {
    promptPath,
    bundlePath: bundle.kind === "available" ? bundle.path : null,
    bundleError: bundle.kind === "unavailable" ? bundle.reason : null,
    findings: findingCounts,
    detectedAgents: externalAgents.map(({ agent }) => agent),
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
    runtime.log(`Diagnostics export unavailable: ${bundle.reason}`);
  }
  if (!allowAgent || runEmbedded || !handoff) {
    runtime.log("Ready-to-run agent handoffs:");
    for (const command of suggestedCommands) {
      runtime.log(`  ${command}`);
    }
    if (!allowAgent && !runEmbedded) {
      return;
    }
  }
  if (!runEmbedded) {
    if (!handoff) {
      if (options.agent) {
        runtime.error(`${options.agent} is not found or unavailable for direct launch on PATH.`);
        exitCliAfterOutput(runtime, 1);
      }
      if (automatic) {
        runtime.error(
          "No configured embedded agent or directly launchable external agent is available. Use a handoff command above.",
        );
      } else {
        runtime.log("No coding agent can be launched directly; use a handoff command above.");
      }
      return;
    }
    runtime.log(`Starting ${handoff.agent}; use --agent <name> to select another coding agent.`);
    const args = handoff.agent === "opencode" ? ["--prompt", prompt] : [prompt];
    // Artifact I/O can outlive the admitted update attempt. Recheck its exact
    // owner immediately before handing control to a local coding agent.
    if (!isCurrent()) {
      return;
    }
    let exitCode: number;
    try {
      if (automatic) {
        const { runUtf8CommandWithTimeout } = await import("../process/exec.js");
        const automaticArgs =
          handoff.agent === "claude"
            ? ["--safe-mode", "-p"]
            : ["exec", "--skip-git-repo-check", "-"];
        if (!isCurrent()) {
          return;
        }
        const result = await runUtf8CommandWithTimeout(
          [handoff.program.command, ...handoff.program.leadingArgv, ...automaticArgs],
          {
            input: prompt,
            env: { ...targetEnv, OPENCLAW_SHELL: "exec" },
            ...agentOptions,
            signal: automatic.signal,
            timeoutMs: 600_000,
            killProcessTree: true,
            killSignal: "SIGINT",
            outputCapture: "tail",
            maxOutputBytes: 32 * 1024,
          },
        );
        // External runtimes own native commands in independent process groups.
        // Their root/group exit is not a descendant-cleanup receipt.
        recordAgentCleanupFailure();
        for (const output of [result.stdout, result.stderr]) {
          if (output.trim()) {
            runtime.log(redactSupportString(output, redaction, { maxLength: 32 * 1024 }));
          }
        }
        exitCode = result.termination === "exit" ? (result.code ?? 1) : 1;
        if (exitCode !== 0) {
          runtime.error(
            `${handoff.agent} triage failed (${result.termination}, exit ${result.code ?? "unknown"}).`,
          );
          runtime.log(
            `Run manually: ${suggestedCommands[TRIAGE_EXTERNAL_AGENTS.indexOf(handoff.agent)]}`,
          );
        }
      } else {
        exitCode = await new Promise<number>((resolve, reject) => {
          const child = spawn(handoff.program.command, [...handoff.program.leadingArgv, ...args], {
            stdio: "inherit",
            env: targetEnv,
            ...agentOptions,
          });
          child.once("error", reject);
          child.once("exit", (code, signal) => resolve(resolveSubprocessExitCode(code, signal)));
        });
      }
    } catch (error) {
      if (
        automatic &&
        isRecord(error) &&
        (error.cleanup === "uncertain" || error.cleanup === "forced")
      ) {
        recordAgentCleanupFailure();
      }
      runtime.error(
        `Failed to launch ${handoff.agent}: ${triageCollectionError(error, redaction)}`,
      );
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
  if (!allowAgent) {
    throw new Error(
      "Embedded triage requires an interactive terminal; use a suggested handoff command.",
    );
  }

  if (automatic && !automatic.diagnosticOnly) {
    const result = await withInstallationTarget(target, async () => {
      const { agentExecCommand } = await import("./agent-exec.js");
      if (!isCurrent()) {
        return { exitCode: 1 };
      }
      return agentExecCommand(prompt, agentOptions, runtime, {
        abortSignal: automatic.signal,
        timeoutMs: 600_000,
        maxToolCalls: 40,
        assertSourceCurrent: automatic.assertCurrent,
      });
    });
    if (result.exitCode !== 0) {
      exitCliAfterOutput(runtime, result.exitCode);
    }

    return;
  }

  const { runUpdateRepairLoop } = await import("../infra/update-repair-agent.js");
  const installRoot = await resolveOpenClawPackageRoot({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
  });
  if (!isCurrent()) {
    return;
  }
  if (!installRoot) {
    throw new Error("Cannot locate the OpenClaw installation; use a suggested handoff command.");
  }
  const failedResult =
    updateFailure && "result" in updateFailure ? updateFailure.result : undefined;
  const result = await runUpdateRepairLoop({
    target: {
      stateDir: target.stateDir,
      configPath: target.configPath,
      workspaceDir: target.defaultWorkspaceDir,
      installRoot,
    },
    context: {
      ...(updateFailure ?? { error: "Operator requested installation triage" }),
      phase: "verifying",
      beforeVersion: failedResult?.before?.version ?? undefined,
      targetVersion: failedResult?.after?.version ?? undefined,
      symptoms: findings
        .slice(0, 20)
        .map((finding) =>
          redactSupportString(
            `[${finding.severity}] ${finding.checkId}: ${finding.message}`,
            redaction,
            { maxLength: 200 },
          ),
        ),
    },
    budget: { maxTurns: 1 },
    isCurrent,
    onEvent: (event) => {
      if (event.type === "turn-started" && isCurrent()) {
        runtime.log(`Starting repair turn ${event.turn} with ${event.provider}/${event.model}.`);
      }
    },
    validate: async (signal): Promise<UpdateRepairValidation> => {
      try {
        const [{ resolveGatewayInstallEntrypoint }, { runUtf8CommandWithTimeout }] =
          await Promise.all([
            import("../daemon/gateway-entrypoint.js"),
            import("../process/exec.js"),
          ]);
        const entrypoint = await resolveGatewayInstallEntrypoint(installRoot);
        signal.throwIfAborted();
        if (!entrypoint) {
          throw new Error("The installed OpenClaw entrypoint is unavailable.");
        }
        // A fresh child reads the repaired installation and can be cancelled without
        // leaving Doctor's temporary process-global state active in this CLI.
        const doctorCommand = await runUtf8CommandWithTimeout(
          [
            isNodeRuntime(process.execPath) ? process.execPath : "node",
            entrypoint,
            "doctor",
            "--lint",
            "--json",
            "--severity-min",
            "error",
          ],
          {
            cwd: installRoot,
            baseEnv: {},
            env: targetEnv,
            input: "",
            signal,
            killProcessTree: true,
            maxOutputBytes: { stdout: 1024 * 1024, stderr: 16 * 1024 },
            terminateOnOutputLimit: true,
          },
        );
        signal.throwIfAborted();
        if (doctorCommand.termination !== "exit" || doctorCommand.outputLimitExceeded) {
          throw new Error("Doctor lint did not complete within its execution or output budget.");
        }
        const doctorReport = triageDoctorReportSchema.parse(JSON.parse(doctorCommand.stdout));
        const errors = doctorReport.findings.filter((finding) => finding.severity === "error");
        if (errors.length === 0 && (doctorCommand.code !== 0 || !doctorReport.ok)) {
          throw new Error("Doctor lint failed without reporting an error finding.");
        }
        return {
          ok: errors.length === 0,
          score: errors.length === 0 ? 0 : -errors.length,
          summary:
            errors.length === 0
              ? "Doctor lint reports no errors."
              : `${errors.length} Doctor lint error(s): ${errors
                  .slice(0, 3)
                  .map((finding) =>
                    redactSupportString(finding.message, redaction, { maxLength: 200 }),
                  )
                  .join("; ")}`,
        };
      } catch (error) {
        signal.throwIfAborted();
        return {
          ok: false,
          // An unavailable oracle must never appear better than known Doctor errors.
          score: Number.MIN_SAFE_INTEGER,
          summary: `Doctor checks unavailable: ${triageCollectionError(error, redaction)}`,
        };
      }
    },
  });
  if (!isCurrent()) {
    return;
  }
  if (result.status === "unavailable") {
    if (result.reason === "exec-denied-by-policy") {
      throw new Error(
        "The operator's policy denies unattended repair (exec-denied-by-policy). Use `openclaw triage` for an external handoff.",
      );
    }
    throw new Error(
      `Embedded agent unavailable: ${result.reason}. Run \`openclaw onboard\` or use a suggested handoff command.`,
    );
  }
  for (const attempt of result.attempts) {
    runtime.log(attempt.summary);
  }
  runtime.log(`Embedded repair ${result.status}: ${result.finalValidation.summary}`);
  if (result.status !== "repaired") {
    if (result.reason) {
      runtime.error(result.reason);
    }
    const timedOut = result.reason === "per-turn-budget" || result.reason === "wall-clock-budget";
    exitCliAfterOutput(runtime, timedOut ? 2 : 1);
  }
}
