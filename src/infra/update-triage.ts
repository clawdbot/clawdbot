import { spawn } from "node:child_process";
import { z } from "zod";
import { formatInstallationTargetCommand } from "../cli/installation-target-format.js";
import { resolveSubprocessExitCode } from "../cli/subprocess-exit-code.js";
import {
  disableUpdatedPackageCompileCacheEnv,
  stripGatewayServiceMarkerEnv,
} from "../cli/update-cli/update-command-service-env.js";
import { writeTriageUpdateFailure, type TriageUpdateFailure } from "../commands/triage-update.js";
import { resolveGatewayInstallEntrypoint } from "../daemon/gateway-entrypoint.js";
import { scrubDoctorErrorMessage } from "../flows/doctor-error-message.js";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { attachChildProcessBridge } from "../process/child-process-bridge.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { formatErrorMessage } from "./errors.js";
import { installationTargetEnv, resolveInstallationTarget } from "./installation-target-context.js";

export type UpdateTriageTarget = {
  root?: string;
  env: NodeJS.ProcessEnv;
  nodeRunner?: string;
};

type UpdateTriageResult =
  | { status: "completed"; hint: string; contextPath: string }
  | { status: "failed"; hint: string; contextPath?: string }
  | { status: "cancelled" };

const triageReportPathsSchema = z.object({
  promptPath: z.string().min(1).max(4096),
  bundlePath: z.string().min(1).max(4096).nullish(),
  bundleError: z.string().max(1024).nullish(),
});
const TRIAGE_OUTPUT_HINT =
  "See the Gateway host command output for saved diagnostics and the installation-specific openclaw triage command.";

/** Run diagnostics outside the updater or serving Gateway, without changing its failure verdict. */
export async function runUpdateFailureTriage(params: {
  failure: TriageUpdateFailure;
  target: UpdateTriageTarget;
  resolveRoot?: () => Promise<string>;
  mode: "interactive" | "json" | "non-interactive";
  runtime: { log: (message: string) => void; error: (message: string) => void };
  signal?: AbortSignal;
  isCurrent?: () => boolean;
}): Promise<UpdateTriageResult> {
  const isCurrent = () => !params.signal?.aborted && (params.isCurrent?.() ?? true);
  if (!isCurrent()) {
    return { status: "cancelled" };
  }
  const targetEnv = { ...params.target.env };
  const installationTarget = resolveInstallationTarget(targetEnv);
  const redaction = { env: targetEnv, stateDir: installationTarget.stateDir };
  const { log, error: logError } = params.runtime;
  log("Update failed. Entering triage...");
  let contextPath: string | undefined;
  try {
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
    const env: NodeJS.ProcessEnv = {
      ...stripGatewayServiceMarkerEnv(disableUpdatedPackageCompileCacheEnv(targetEnv)),
      ...installationTargetEnv(installationTarget),
    };
    delete env.OPENCLAW_UPDATE_IN_PROGRESS;
    const args = [entryPath, "triage", "--update-result", contextPath];
    const nodeRunner = params.target.nodeRunner ?? process.execPath;
    let exitCode: number;
    let stdout = "";
    if (params.mode === "interactive") {
      exitCode = await new Promise<number>((resolve, reject) => {
        const child = spawn(nodeRunner, args, { cwd: root, env, stdio: "inherit" });
        attachChildProcessBridge(child);
        child.once("error", reject);
        child.once("close", (code, signal) => resolve(resolveSubprocessExitCode(code, signal)));
      });
    } else {
      args.push(params.mode === "json" ? "--json" : "--non-interactive");
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
      exitCode = resolveSubprocessExitCode(result.code, result.signal);
    }
    if (!isCurrent()) {
      return { status: "cancelled" };
    }
    if (exitCode !== 0) {
      throw new Error(`Triage exited with code ${exitCode}.`);
    }
    // Restart notices reach model context; executable paths stay in local output.
    let hint = `Triage completed. ${TRIAGE_OUTPUT_HINT}`;
    if (params.mode === "json") {
      const report = triageReportPathsSchema.parse(JSON.parse(stdout));
      if (report.bundleError) {
        const reason = scrubDoctorErrorMessage(redactSupportString(report.bundleError, redaction));
        hint += `\nDiagnostics export unavailable: ${reason}`;
      }
    }
    return { status: "completed", hint, contextPath };
  } catch (error) {
    if (!isCurrent()) {
      return { status: "cancelled" };
    }
    const reason = scrubDoctorErrorMessage(
      redactSupportString(formatErrorMessage(error), redaction),
    );
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
