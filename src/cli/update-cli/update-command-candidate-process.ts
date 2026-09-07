import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import type { UpdateRunStep } from "../../infra/update-run-record.js";
import {
  inspectUpdateRecoveries,
  prepareUpdateRecoveryHandoff,
  type UpdateRecoveryHandoff,
} from "../../infra/update-run-recovery.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { withUpdateCommandExecutorChild } from "./update-command-executor.js";
import type {
  MigratedUpdateFinalizationInput,
  MigratedUpdateFinalizationResult,
} from "./update-command-migrated.js";
import type { FinishUpdateParams } from "./update-command-post-update.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";
import {
  resolveUpdatedInstallCommandEnv,
  stripGatewayServiceMarkerEnv,
} from "./update-command-service-env.js";

export type CandidateContinuation = {
  executorDelegation: "pid-start-v1";
  candidateContinuation: UpdateRecoveryHandoff;
  result: FinishUpdateParams["result"];
};

/** The old runtime only transports private descriptors. After handoff it never
 * opens the canonical writer, compensates native effects or retires packages.
 * A new sibling process observes newly installed plugins without old module caches. */
export async function continueDurableUpdateInFreshProcess(
  params: FinishUpdateParams,
  bufferedSteps: UpdateRunStep[],
): Promise<Omit<MigratedUpdateFinalizationResult, "terminalRunId">> {
  const run = params.opts.run;
  const recovery = params.opts.recovery;
  const fence = run?.executorFence;
  if (!run || !recovery || !fence || !params.result.root) {
    throw new UpdateCommandRecoveryPendingError(
      "Durable continuation requires its live installation executor.",
    );
  }
  fence.assertCurrent();
  const original = recovery.getRecord();
  if (!original.checkpoint || original.terminal || original.to.root !== params.result.root) {
    throw new UpdateCommandRecoveryPendingError(
      "Candidate handoff requires its full stopped checkpoint.",
    );
  }
  const command = [
    original.to.nodePath,
    path.join(
      original.to.root,
      "dist",
      runtimeProcessEntrypoints.updateMigratedFinalize.distWorkerPath,
    ),
  ];
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-candidate-"));
  // Retain this private directory on refusal/unknown outcome for reconciliation.
  const env = {
    ...stripGatewayServiceMarkerEnv(
      resolveUpdatedInstallCommandEnv({ processEnv: params.ownedManagedUpdateEnv ?? run.env }),
    ),
    OPENCLAW_UPDATE_IN_PROGRESS: "1",
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
  };
  const check = await runUtf8CommandWithTimeout([...command, "--check"], {
    cwd: original.to.root,
    baseEnv: {},
    env,
    timeoutMs: 30_000,
    killProcessTree: true,
    requireProcessTreeExtinction: true,
    killGraceMs: 500,
    maxOutputBytes: 64 * 1024,
  });
  fence.assertCurrent();
  let contract: unknown;
  try {
    contract = JSON.parse(check.stdout);
  } catch (cause) {
    throw new UpdateCommandRecoveryPendingError("Candidate ownership contract is unreadable.", {
      cause,
    });
  }
  if (
    check.code !== 0 ||
    check.termination !== "exit" ||
    check.cleanup !== "normal" ||
    !isRecord(contract) ||
    contract.executorDelegation !== "pid-start-v1" ||
    contract.candidateMutation !== "checkpoint-owned-v1"
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Candidate lacks checkpoint-owned continuation; no handoff was prepared.",
    );
  }
  const prepared = prepareUpdateRecoveryHandoff(original, recovery.fence, recovery.options);
  recovery.onRecord(prepared.record);
  const {
    packageTransaction: _package,
    preManagedServiceStop,
    opts: _opts,
    failure: _failure,
    ...serializable
  } = params;
  const { recovery: _recovery, run: _run, ...options } = params.opts;
  const { executorFence: _executor, requesterAuthority, ...runIdentity } = run;
  let stopped: MigratedUpdateFinalizationInput["params"]["preManagedServiceStop"];
  if (preManagedServiceStop) {
    const { windowsTaskAutoStartRecovery: _windows, ...snapshot } = preManagedServiceStop;
    stopped = snapshot;
  }
  const input: MigratedUpdateFinalizationInput = {
    params: {
      ...serializable,
      opts: {
        ...options,
        run: {
          ...runIdentity,
          ...(requesterAuthority
            ? { requesterAuthority: { requester: requesterAuthority.requester } }
            : {}),
        },
      },
      ...(preManagedServiceStop ? { preManagedServiceStop: stopped } : {}),
    },
    bufferedSteps,
    resultPath: path.join(scratch, "result-0.json"),
    recoveryHandoff: prepared.handoff,
  };
  for (let phase = 0; phase < 2; phase++) {
    fence.assertCurrent();
    input.resultPath = path.join(scratch, `result-${phase}.json`);
    const child = await withUpdateCommandExecutorChild(fence, (executor, beforeInput) =>
      runUtf8CommandWithTimeout(command, {
        cwd: original.to.root,
        baseEnv: {},
        env,
        input: JSON.stringify({ ...input, executor }),
        beforeInput,
        timeoutMs: Math.max(30 * 60_000, params.updateStepTimeoutMs * 6),
        killProcessTree: true,
        requireProcessTreeExtinction: true,
        killGraceMs: 500,
        maxOutputBytes: 1024 * 1024,
      }),
    );
    fence.assertCurrent();
    if (child.stdout) {
      process.stdout.write(child.stdout);
    }
    if (child.stderr) {
      process.stderr.write(child.stderr);
    }
    if (child.code !== 0 || child.termination !== "exit" || child.cleanup !== "normal") {
      throw new UpdateCommandRecoveryPendingError(
        "Candidate did not settle its durable continuation.",
      );
    }
    // SAFETY: The settled PID/start-bound worker alone writes this private transport. Exact durable records below, not this result, authorize continuation.
    const response = JSON.parse(await fs.readFile(input.resultPath, "utf8")) as
      | CandidateContinuation
      | MigratedUpdateFinalizationResult;
    fence.assertCurrent();
    if (response.executorDelegation !== "pid-start-v1" || response.result.runId !== run.runId) {
      throw new UpdateCommandRecoveryPendingError("Candidate response changed the admitted run.");
    }
    // Read-only inspection handles any legacy siblings without treating them as absence.
    const inspected = inspectUpdateRecoveries({ env: run.env }).find(
      (entry) => entry.record.runId === run.runId,
    );
    fence.assertCurrent();
    if (
      !inspected ||
      inspected.format !== "current" ||
      inspected.record.transactionId !== original.transactionId
    ) {
      throw new UpdateCommandRecoveryPendingError(
        "Candidate response has no matching durable record.",
      );
    }
    const record = inspected.record;
    if ("candidateContinuation" in response) {
      const next = response.candidateContinuation;
      if (
        phase !== 0 ||
        record.handoff?.state !== "prepared" ||
        record.revision <= prepared.record.revision ||
        !isDeepStrictEqual(next, {
          runId: record.runId,
          transactionId: record.transactionId,
          revision: record.revision,
          claimId: record.claimId,
          handoffId: record.handoff.handoffId,
        })
      ) {
        throw new UpdateCommandRecoveryPendingError(
          "Candidate continuation is not its exact prepared handoff.",
        );
      }
      input.recoveryHandoff = next;
      input.params.result = response.result;
      input.bufferedSteps = [];
      continue;
    }
    if (
      !record.terminal ||
      response.terminalRunId !== run.runId ||
      !Number.isInteger(response.exitCode)
    ) {
      throw new UpdateCommandRecoveryPendingError("Candidate left the admitted run nonterminal.");
    }
    return {
      result: response.result,
      exitCode: response.exitCode,
      automaticTriage: response.automaticTriage,
    };
  }
  throw new UpdateCommandRecoveryPendingError("Candidate exceeded its admitted phase sequence.");
}
