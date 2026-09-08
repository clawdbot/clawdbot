import fs from "node:fs/promises";
import { finishUpdateRun } from "../cli/daemon-cli.js";
import type { UpdateCommandOptions } from "../cli/update-cli/shared.js";
import type {
  MigratedUpdateFinalizationInput,
  MigratedUpdateFinalizationResult,
} from "../cli/update-cli/update-command-migrated.js";
import { finishUpdate } from "../cli/update-cli/update-command-post-update.js";
import { UpdateCommandFailure } from "../cli/update-cli/update-command-result.js";
import { createWindowsTaskAutoStartGuard } from "../cli/update-cli/update-command-service-maintenance.js";
import { createWindowsTaskAutoStartRecovery } from "../cli/update-cli/update-command-windows-task.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createManagedUpdateRequesterAuthority } from "./update-requester-authority.js";
import { adoptUpdateRun, getUpdateRun, recordUpdateRunStep } from "./update-run-ledger.js";

async function finalizeMigratedUpdate(): Promise<void> {
  // Validation imports this whole candidate graph before activation. The helper
  // also needs the stable recovery barrel's writer after an actual schema bump.
  if (process.argv[2] === "--check") {
    if (typeof finishUpdateRun !== "function") {
      throw new Error("Candidate recovery writer is unavailable.");
    }
    process.stdout.write(
      JSON.stringify({
        state: OPENCLAW_STATE_SCHEMA_VERSION,
        agent: OPENCLAW_AGENT_SCHEMA_VERSION,
      }),
    );
    return;
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const input = JSON.parse(
    Buffer.concat(chunks).toString("utf8"),
  ) as MigratedUpdateFinalizationInput; // SAFETY: Only the typed parent continuation serializes this private input.
  const transferredRun = input.params.opts.run;
  if (
    !transferredRun ||
    (input.params.rollbackBlockedReason !== "state-migrated-no-rollback" &&
      input.params.rollbackBlockedReason !== "rollback-state-unverified")
  ) {
    throw new Error("Candidate finalization requires its migrated update run.");
  }
  const { requesterAuthority: descriptor, ...runIdentity } = transferredRun;
  // The candidate can outlive its parent; record both lifetimes before any awaits.
  adoptUpdateRun(runIdentity.runId, { env: runIdentity.env });
  // Parent closures cannot cross JSON. Only the fresh installed runtime rebinds
  // the captured requester to the same current installation policy.
  const run: NonNullable<UpdateCommandOptions["run"]> = {
    ...runIdentity,
    ...(descriptor
      ? {
          requesterAuthority: await createManagedUpdateRequesterAuthority(
            descriptor.requester,
            runIdentity.env,
          ),
        }
      : {}),
  };
  for (const step of input.bufferedSteps) {
    recordUpdateRunStep(run.runId, step, { env: run.env });
  }
  const stopped = input.params.preManagedServiceStop;
  if (input.windowsTaskAutoStartSuspended && !stopped?.serviceEnv) {
    throw new Error("Transferred Windows task suspension is missing its stopped service owner.");
  }
  const windowsRecovery =
    input.windowsTaskAutoStartSuspended && stopped?.serviceEnv
      ? createWindowsTaskAutoStartRecovery({
          serviceEnv: stopped.serviceEnv,
          alreadySuspended: true,
          assertCurrentService: createWindowsTaskAutoStartGuard({
            root: input.params.result.root ?? input.params.root,
            before: stopped,
            timeoutMs: input.params.updateStepTimeoutMs,
          }),
          assertCurrent: () => {
            if (getUpdateRun(run.runId, { env: run.env })?.status !== "running") {
              throw new Error("Update run no longer owns Windows task activation.");
            }
          },
        })
      : undefined;
  let result;
  let exitCode = 0;
  let automaticTriage: MigratedUpdateFinalizationResult["automaticTriage"];
  try {
    result = await finishUpdate({
      ...input.params,
      opts: { ...input.params.opts, run },
      ...(stopped
        ? { preManagedServiceStop: { ...stopped, windowsTaskAutoStartRecovery: windowsRecovery } }
        : {}),
    });
  } catch (error) {
    if (!(error instanceof UpdateCommandFailure)) {
      throw error;
    }
    result = error.result;
    exitCode = error.exitCode;
    automaticTriage = error.automaticTriage;
  } finally {
    await windowsRecovery?.complete(result?.status === "ok");
  }
  const terminal = getUpdateRun(run.runId, { env: run.env });
  if (!terminal || terminal.status === "running") {
    throw new Error("Candidate finalization left the update run nonterminal.");
  }
  const response: MigratedUpdateFinalizationResult = {
    result,
    exitCode,
    terminalRunId: terminal.runId,
    automaticTriage,
  };
  await fs.writeFile(input.resultPath, JSON.stringify(response), { mode: 0o600 });
}

void finalizeMigratedUpdate()
  .catch((error: unknown) => {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => closeOpenClawStateDatabase());
