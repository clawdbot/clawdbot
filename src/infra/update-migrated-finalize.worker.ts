import fs from "node:fs/promises";
import { finishUpdateRun } from "../cli/daemon-cli.js";
import { retainCliProcessJobUntilExit, withCliProcessScope } from "../cli/runtime-cleanup-scope.js";
import type { UpdateCommandOptions } from "../cli/update-cli/shared.js";
import { completeUpdateCommandCandidate } from "../cli/update-cli/update-command-candidate-completion.js";
import type { CandidateContinuation } from "../cli/update-cli/update-command-candidate-process.js";
import {
  acceptUpdateCommandCandidate,
  runUpdateCommandCandidateMutations,
} from "../cli/update-cli/update-command-candidate.js";
import { withDelegatedUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import type {
  MigratedUpdateFinalizationInput,
  MigratedUpdateFinalizationResult,
} from "../cli/update-cli/update-command-migrated.js";
import { finishUpdate } from "../cli/update-cli/update-command-post-update.js";
import {
  UpdateCommandFailure,
  UpdateCommandFinalizedRecoveryFailure,
} from "../cli/update-cli/update-command-result.js";
import { createWindowsTaskAutoStartGuard } from "../cli/update-cli/update-command-service-maintenance.js";
import { createWindowsTaskAutoStartRecovery } from "../cli/update-cli/update-command-windows-task.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db-contract.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import { closeOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { createManagedUpdateRequesterAuthority } from "./update-requester-authority.js";
import { getUpdateRun, recordUpdateRunStep } from "./update-run-ledger.js";
import type { UpdateRecoveryFence } from "./update-run-recovery.js";

async function finalizeMigratedUpdate(): Promise<void> {
  // Validation imports this whole candidate graph before activation. The helper
  // also needs the stable recovery barrel's writer after an actual schema bump.
  if (process.argv[2] === "--check") {
    if (typeof finishUpdateRun !== "function") {
      throw new Error("Candidate recovery writer is unavailable.");
    }
    process.stdout.write(
      JSON.stringify({
        executorDelegation: "pid-start-v1",
        candidateMutation: "checkpoint-owned-v1",
        state: OPENCLAW_STATE_SCHEMA_VERSION,
        agent: OPENCLAW_AGENT_SCHEMA_VERSION,
      }),
    );
    return;
  }
  // The normal CLI bootstrap retains this native Job. This executable worker
  // bypasses that bootstrap, so install the same kill-on-close owner before input.
  // POSIX callers own the detached process group and join its kernel extinction.
  await withCliProcessScope(retainCliProcessJobUntilExit);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const input = JSON.parse(
    Buffer.concat(chunks).toString("utf8"),
  ) as MigratedUpdateFinalizationInput; // SAFETY: Only the typed parent continuation serializes this private input.
  if (input.executor) {
    await withDelegatedUpdateCommandExecutor(
      input.executor,
      input.params.opts.run?.runId ?? "",
      input.params.result.root ?? input.params.root,
      async (fence) => finalizeInput(input, fence),
    );
  } else {
    await finalizeInput(input);
  }
}

async function finalizeInput(
  input: MigratedUpdateFinalizationInput,
  executorFence?: UpdateRecoveryFence,
): Promise<void> {
  const transferredRun = input.params.opts.run;
  if (
    !transferredRun ||
    "executorFence" in transferredRun ||
    (!input.recoveryHandoff &&
      input.params.rollbackBlockedReason !== "state-migrated-no-rollback" &&
      input.params.rollbackBlockedReason !== "rollback-state-unverified")
  ) {
    throw new Error("Candidate finalization requires its migrated update run.");
  }
  const { requesterAuthority: descriptor, ...runIdentity } = transferredRun;
  // Parent closures cannot cross JSON. Only the fresh installed runtime rebinds
  // the captured requester to the same current installation policy.
  const run: NonNullable<UpdateCommandOptions["run"]> = {
    ...runIdentity,
    ...(executorFence ? { executorFence } : {}),
    ...(descriptor
      ? {
          requesterAuthority: await createManagedUpdateRequesterAuthority(
            descriptor.requester,
            runIdentity.env,
          ),
        }
      : {}),
  };
  executorFence?.assertCurrent();
  if (input.recoveryHandoff) {
    if (!executorFence) {
      throw new Error("Durable candidate requires live delegated ownership.");
    }
    const params = { ...input.params, opts: { ...input.params.opts, run } };
    await acceptUpdateCommandCandidate({
      handoff: input.recoveryHandoff,
      finalization: params,
      fence: executorFence,
      moduleUrl: import.meta.url,
    });
    const next = await runUpdateCommandCandidateMutations(params, input.bufferedSteps);
    if (next) {
      const response: CandidateContinuation = {
        executorDelegation: "pid-start-v1",
        candidateContinuation: next,
        result: params.result,
      };
      executorFence.assertCurrent();
      await fs.writeFile(input.resultPath, JSON.stringify(response), { mode: 0o600 });
      executorFence.assertCurrent();
      return;
    }
    // Durable completion owns recovery, restoration and terminal output. Never
    // fall through to the legacy Windows or parent package compensation paths.
    let result;
    let exitCode = 0;
    try {
      result = await completeUpdateCommandCandidate(params);
    } catch (error) {
      if (!(error instanceof UpdateCommandFinalizedRecoveryFailure)) {
        throw error;
      }
      result = error.result;
      exitCode = error.exitCode;
    }
    executorFence.assertCurrent();
    const terminal = getUpdateRun(run.runId, { env: run.env });
    if (!terminal || terminal.status === "running") {
      throw new Error("Candidate recovery remains nonterminal.");
    }
    const response: MigratedUpdateFinalizationResult = {
      result,
      exitCode,
      terminalRunId: run.runId,
      executorDelegation: "pid-start-v1",
    };
    await fs.writeFile(input.resultPath, JSON.stringify(response), { mode: 0o600 });
    executorFence.assertCurrent();
    return;
  }
  for (const step of input.bufferedSteps) {
    executorFence?.assertCurrent();
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
          updateRun: run,
          alreadySuspended: true,
          assertCurrentService: createWindowsTaskAutoStartGuard({
            root: input.params.result.root ?? input.params.root,
            before: stopped,
            timeoutMs: input.params.updateStepTimeoutMs,
          }),
          assertCurrent: () => {
            run.executorFence?.assertCurrent();
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
  executorFence?.assertCurrent();
  const terminal = getUpdateRun(run.runId, { env: run.env });
  if (!terminal || terminal.status === "running") {
    throw new Error("Candidate finalization left the update run nonterminal.");
  }
  const response: MigratedUpdateFinalizationResult = {
    result,
    exitCode,
    terminalRunId: terminal.runId,
    ...(executorFence ? { executorDelegation: "pid-start-v1" as const } : {}),
    automaticTriage,
  };
  executorFence?.assertCurrent();
  await fs.writeFile(input.resultPath, JSON.stringify(response), { mode: 0o600 });
  executorFence?.assertCurrent();
}

void finalizeMigratedUpdate()
  .catch((error: unknown) => {
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => closeOpenClawStateDatabase());
