import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { withConsoleLogsRoutedToStderr } from "../cli/json-output-mode.js";
import { resolveStateDir } from "../config/paths.js";
import { scrubDoctorErrorMessage } from "../flows/doctor-error-message.js";
import { createEmbeddedStateSignalBridge } from "../infra/embedded-state-lock.js";
import { isGatewayExternallySupervised } from "../infra/gateway-supervision.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { detectRespawnSupervisor } from "../infra/supervisor-markers.js";
import {
  continueTriageInFreshProcess,
  queueManagedUpdateTriage,
  resolveTriageEntrypoint,
} from "../infra/triage-continuation.js";
import {
  cancelManagedServiceUpdateHandoff,
  commitManagedServiceUpdateHandoff,
  startManagedServiceUpdateHandoff,
} from "../infra/update-managed-service-handoff.js";
import { redactSupportString } from "../logging/diagnostic-support-redaction.js";
import { ExitError, type RuntimeEnv } from "../runtime.js";
import { renderTriagePrompt, type TriageFailureContext } from "./triage-prompt.js";

/** Failure owners retain their exit/result; triage only supplies a bounded repair attempt. */
export async function triageAfterFailure(
  runtime: RuntimeEnv,
  failure: TriageFailureContext,
  signal?: AbortSignal,
  updateResultPath?: string,
): Promise<void> {
  // Exec stamps its descendants. Codex also stamps shells even when its env policy
  // drops inherited variables; neither context should recursively launch a fixing agent.
  if (
    process.env.OPENCLAW_SHELL === "exec" ||
    process.env.CODEX_THREAD_ID ||
    isGatewayExternallySupervised() ||
    signal?.aborted
  ) {
    return;
  }
  const bridge = createEmbeddedStateSignalBridge();
  const cancellation = signal ? AbortSignal.any([signal, bridge.signal]) : bridge.signal;
  const redaction = { env: process.env, stateDir: resolveStateDir() };
  const boundedFailure: TriageFailureContext = {
    ...failure,
    phase: failure.phase.slice(0, 120),
    error: scrubDoctorErrorMessage(
      redactSupportString(failure.error, redaction, { maxLength: 800 }),
    ),
    ...(failure.expectedVersion ? { expectedVersion: failure.expectedVersion.slice(0, 100) } : {}),
  };
  const previousShell = process.env.OPENCLAW_SHELL;
  process.env.OPENCLAW_SHELL = "exec";
  const diagnosticRuntime: RuntimeEnv = {
    log: (...args) => runtime.error(...args),
    error: (...args) => runtime.error(...args),
    exit: (code) => {
      throw new ExitError(code);
    },
  };
  const collectDiagnostics = async () => {
    const { triageCommand } = await import("./triage.js");
    await triageCommand(
      diagnosticRuntime,
      {},
      {
        failure: boundedFailure,
        signal: cancellation,
        diagnosticOnly: true,
      },
    );
  };
  let managedStartup = false;
  try {
    await withConsoleLogsRoutedToStderr(async () => {
      const resolvedRoot =
        failure.installationRoot ?? (await resolveOpenClawPackageRoot({ argv1: process.argv[1] }));
      if (!resolvedRoot) {
        throw new Error("installed CLI root is unavailable; run openclaw triage manually");
      }
      const root = realpathSync(resolvedRoot);
      boundedFailure.installationRoot = root;
      const supervisor =
        failure.kind === "gateway-startup"
          ? detectRespawnSupervisor(process.env, process.platform, {
              includeLinuxOpenClawGatewayServiceMarker: true,
            })
          : null;
      managedStartup = Boolean(supervisor);
      if (!supervisor) {
        // Imports above survive mutation; only the installed child loads triage's
        // lazy graph. Service selector hints do not grant a foreground updater a lease.
        const commandArgv = [
          ...(await resolveTriageEntrypoint(root)),
          ...(failure.kind === "update" && updateResultPath
            ? ["--update-result", updateResultPath]
            : []),
        ];
        cancellation.throwIfAborted();
        if (
          failure.kind === "update" &&
          (await queueManagedUpdateTriage(boundedFailure, commandArgv, cancellation))
        ) {
          runtime.error(
            "Automatic triage queued after managed update settlement; inspect the handoff log for its result.",
          );
        } else {
          await continueTriageInFreshProcess({
            root,
            commandArgv,
            failure: boundedFailure,
            signal: cancellation,
            output: (output) =>
              runtime.error(redactSupportString(output, redaction, { maxLength: 32 * 1024 })),
          });
        }
        return;
      }
      if (supervisor === "systemd") {
        const [nodeRunner, entrypoint] = await resolveTriageEntrypoint(root);
        cancellation.throwIfAborted();
        const result = await startManagedServiceUpdateHandoff({
          root,
          supervisor,
          restartDrainTimeoutMs: 0,
          meta: {},
          action: { kind: "triage", failure: boundedFailure, nodeRunner, entrypoint },
        });
        if (result.status === "started") {
          const identity = {
            kind: "managed-update-handoff" as const,
            handoffId: result.handoffId,
            installRoot: result.installRoot,
          };
          if (
            cancellation.aborted ||
            !(await commitManagedServiceUpdateHandoff(identity)) ||
            cancellation.aborted
          ) {
            await cancelManagedServiceUpdateHandoff(identity);
            throw new Error("automatic triage admission cancelled or lost");
          }
        }
        runtime.error(
          `Automatic triage ${result.status === "started" ? "admitted" : "already owned"}; diagnostics: ${result.logPath}`,
        );
        return;
      }
      runtime.error(
        "Automatic managed recovery is unavailable on this supervisor; saved diagnostics and manual triage remain available.",
      );
      await collectDiagnostics();
    });
  } catch (error) {
    const reason = scrubDoctorErrorMessage(
      redactSupportString(error instanceof Error ? error.message : String(error), redaction),
    );
    runtime.error(
      `Automatic triage could not complete: ${reason}. Run \`openclaw triage\` manually.`,
    );
    if (managedStartup && !cancellation.aborted) {
      try {
        await collectDiagnostics();
      } catch {
        runtime.error(
          "Managed triage diagnostics could not complete; retain the original failure and run openclaw triage manually.",
        );
      }
    }
    if (failure.kind === "update" && failure.installationRoot && !cancellation.aborted) {
      // A missing/incompatible candidate cannot collect fresh diagnostics. Save
      // the original bounded evidence without touching the removed lazy graph.
      const outputDir = path.join(redaction.stateDir, "logs", "support");
      const promptPath = path.join(
        outputDir,
        `openclaw-triage-failure-${Date.now()}-${process.pid}.md`,
      );
      try {
        await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
        await fs.writeFile(
          promptPath,
          renderTriagePrompt({
            findings: [],
            bundle: { kind: "unavailable", reason },
            redaction,
            failure: boundedFailure,
          }),
          { mode: 0o600 },
        );
        runtime.error(
          `Saved failure diagnostics: ${promptPath}. Run openclaw triage manually after repairing the installed CLI.`,
        );
      } catch {
        runtime.error(
          "Failure diagnostics could not be saved; retain the original update error and run openclaw triage manually.",
        );
      }
    }
  } finally {
    bridge.dispose();
    if (previousShell === undefined) {
      delete process.env.OPENCLAW_SHELL;
    } else {
      process.env.OPENCLAW_SHELL = previousShell;
    }
  }
  runtime.error(
    "Original failure retained; inspect the triage verification evidence before retrying.",
  );
}
