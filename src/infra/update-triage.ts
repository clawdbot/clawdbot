import fs from "node:fs/promises";
import { z } from "zod";
import { formatInstallationTargetCommand } from "../cli/installation-target-format.js";
import { resolveSubprocessExitCode } from "../cli/subprocess-exit-code.js";
import { withOwnedManagedUpdateEnv } from "../cli/update-cli/update-command-managed-context.js";
import {
  disableUpdatedPackageCompileCacheEnv,
  resolveServiceRefreshEnv,
  resolveUpdateTargetEnv,
  stripGatewayServiceMarkerEnv,
} from "../cli/update-cli/update-command-service-env.js";
import { writeTriageUpdateFailure, type TriageUpdateFailure } from "../commands/triage-update.js";
import { resolveGatewayInstallEntrypoint } from "../daemon/gateway-entrypoint.js";
import { scrubDoctorErrorMessage } from "../flows/doctor-error-message.js";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { ExitError, type RuntimeEnv } from "../runtime.js";
import { formatErrorMessage } from "./errors.js";
import { resolveOsHomeDir } from "./home-dir.js";
import { installationTargetEnv, resolveInstallationTarget } from "./installation-target-context.js";
import { tryProcessCwd } from "./safe-cwd.js";

export type UpdateTriageTarget = {
  root?: string;
  env: NodeJS.ProcessEnv;
  nodeRunner?: string;
};

type UpdateTriageResult =
  | { status: "completed"; hint: string; contextPath?: string }
  | { status: "failed"; hint: string; contextPath?: string }
  | { status: "cancelled" };

type UpdateTriageInvocation = {
  failure: TriageUpdateFailure;
  target: UpdateTriageTarget;
  resolveRoot?: () => Promise<string>;
  signal?: AbortSignal;
  isCurrent?: () => boolean;
};

type DiagnosticTriage = {
  mode: "json" | "non-interactive";
  runtime: { log: (message: string) => void; error: (message: string) => void };
};

type PreparedTriage =
  | DiagnosticTriage
  | {
      mode: "interactive";
      runtime: RuntimeEnv;
      triageCommand: typeof import("../commands/triage.js").triageCommand;
      operatorEnv: NodeJS.ProcessEnv;
      invocationCwd?: string;
      operatorHome?: string;
    };

const triageReportPathsSchema = z.object({
  promptPath: z.string().min(1).max(4096),
  bundlePath: z.string().min(1).max(4096).nullish(),
  bundleError: z.string().max(1024).nullish(),
});
const TRIAGE_OUTPUT_HINT =
  "See the Gateway host command output for saved diagnostics and the installation-specific openclaw triage command.";

/** Capture the interactive handoff before replacement; invoke it after native cleanup releases. */
export async function prepareUpdateFailureTriage(params: {
  mode: "interactive" | "json" | "non-interactive";
  runtime: RuntimeEnv;
  invocationCwd?: string;
}): Promise<(invocation: UpdateTriageInvocation) => Promise<UpdateTriageResult>> {
  const { mode, runtime } = params;
  if (mode !== "interactive") {
    return (invocation) => runUpdateFailureTriage({ ...invocation, mode, runtime });
  }
  const invocationCwd = params.invocationCwd ?? tryProcessCwd();
  const operatorEnv = resolveServiceRefreshEnv(process.env, invocationCwd);
  const operatorHome = resolveOsHomeDir(operatorEnv);
  const { triageCommand } = await import("../commands/triage.js");
  const prepared: PreparedTriage = {
    mode,
    runtime,
    triageCommand,
    operatorEnv,
    invocationCwd,
    operatorHome,
  };
  return (invocation) => runPreparedUpdateFailureTriage(invocation, prepared);
}

/** Fresh-CLI diagnostics for callers that do not own an interactive repair terminal. */
export async function runUpdateFailureTriage(
  params: UpdateTriageInvocation & DiagnosticTriage,
): Promise<UpdateTriageResult> {
  return runPreparedUpdateFailureTriage(params, params);
}

async function runPreparedUpdateFailureTriage(
  params: UpdateTriageInvocation,
  prepared: PreparedTriage,
): Promise<UpdateTriageResult> {
  const isCurrent = () => !params.signal?.aborted && (params.isCurrent?.() ?? true);
  if (!isCurrent()) {
    return { status: "cancelled" };
  }
  const targetEnv =
    prepared.mode === "interactive"
      ? resolveServiceRefreshEnv(params.target.env, prepared.invocationCwd)
      : { ...params.target.env };
  const installationTarget = resolveInstallationTarget(targetEnv);
  // Executables and authentication belong to the operator; selectors belong to
  // the latest owned Gateway target, which can change during package replacement.
  const env: NodeJS.ProcessEnv = {
    ...stripGatewayServiceMarkerEnv(
      prepared.mode === "interactive"
        ? resolveUpdateTargetEnv({ baseEnv: prepared.operatorEnv, serviceEnv: targetEnv })
        : disableUpdatedPackageCompileCacheEnv(targetEnv),
    ),
    ...installationTargetEnv(installationTarget),
  };
  delete env.OPENCLAW_UPDATE_IN_PROGRESS;
  const redaction = { env, stateDir: installationTarget.stateDir };
  const { log, error: logError } = prepared.runtime;
  log("Update failed. Entering triage...");
  let contextPath: string | undefined;
  try {
    let stdout = "";
    if (prepared.mode === "interactive") {
      // Replacement can remove cwd; inaccessible state must not prevent the
      // repair agent from using the operator's already-captured OS home.
      let cwd = prepared.invocationCwd;
      if (cwd) {
        try {
          if (!(await fs.stat(cwd)).isDirectory()) {
            cwd = undefined;
          } else {
            await fs.access(cwd, fs.constants.X_OK);
          }
        } catch {
          cwd = undefined;
        }
      }
      if (!isCurrent()) {
        return { status: "cancelled" };
      }
      await withOwnedManagedUpdateEnv(env, () =>
        prepared.triageCommand(
          {
            ...prepared.runtime,
            exit: (code) => {
              throw new ExitError(code);
            },
          },
          {
            recovery: {
              target: installationTarget,
              cwd: cwd ?? prepared.operatorHome,
              updateFailure: params.failure,
              isCurrent,
            },
          },
        ),
      ).catch((error: unknown) => {
        if (!(error instanceof ExitError) || error.code !== 0) {
          throw error;
        }
      });
    } else {
      contextPath = await writeTriageUpdateFailure(params.failure, { env: targetEnv });
      if (!isCurrent()) {
        return { status: "cancelled" };
      }
      const root = params.target.root ?? (await params.resolveRoot?.());
      const entryPath = await resolveGatewayInstallEntrypoint(root);
      if (!isCurrent()) {
        return { status: "cancelled" };
      }
      if (!entryPath) {
        throw new Error("The installed OpenClaw entrypoint is unavailable.");
      }
      const args = [
        entryPath,
        "triage",
        "--update-result",
        contextPath,
        prepared.mode === "json" ? "--json" : "--non-interactive",
      ];
      const nodeRunner = params.target.nodeRunner ?? process.execPath;
      const result = await runCommandWithTimeout([nodeRunner, ...args], {
        cwd: root,
        baseEnv: {},
        env,
        input: "",
        timeoutMs: 60_000,
        killProcessTree: true,
        maxOutputBytes: 64 * 1024,
        ...(params.signal ? { signal: params.signal } : {}),
      });
      if (!isCurrent()) {
        return { status: "cancelled" };
      }
      stdout = result.stdout.trimEnd();
      if (stdout) {
        log(stdout);
      }
      if (result.stderr.trim()) {
        logError(result.stderr.trimEnd());
      }
      if (result.termination !== "exit") {
        throw new Error(`Triage stopped (${result.termination}).`);
      }
      const exitCode = resolveSubprocessExitCode(result.code, result.signal);
      if (exitCode !== 0) {
        throw new Error(`Triage exited with code ${exitCode}.`);
      }
    }
    if (!isCurrent()) {
      return { status: "cancelled" };
    }
    // Restart notices reach model context; executable paths stay in local output.
    let hint = `Triage completed. ${TRIAGE_OUTPUT_HINT}`;
    if (prepared.mode === "json") {
      const report = triageReportPathsSchema.parse(JSON.parse(stdout));
      if (report.bundleError) {
        const reason = scrubDoctorErrorMessage(redactSupportString(report.bundleError, redaction));
        hint += `\nDiagnostics export unavailable: ${reason}`;
      }
    }
    return { status: "completed", hint, ...(contextPath ? { contextPath } : {}) };
  } catch (error) {
    if (!isCurrent()) {
      return { status: "cancelled" };
    }
    const detail =
      error instanceof ExitError
        ? `Triage exited with code ${error.code}.`
        : formatErrorMessage(error);
    const reason = scrubDoctorErrorMessage(redactSupportString(detail, redaction));
    const message = `Triage could not complete: ${reason}`;
    const command = formatInstallationTargetCommand(
      ["openclaw", "triage", ...(contextPath ? ["--update-result", contextPath] : [])],
      installationTarget,
      { env: targetEnv },
    );
    const guidance = `On the Gateway host, run ${command} after resolving the diagnostic error.`;
    logError(message);
    if (contextPath) {
      log(`Saved update failure: ${contextPath}`);
    }
    log(guidance);
    return {
      status: "failed",
      hint: `${message}\n${TRIAGE_OUTPUT_HINT}`,
      ...(contextPath ? { contextPath } : {}),
    };
  }
}
