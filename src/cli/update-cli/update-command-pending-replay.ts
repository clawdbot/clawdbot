import fs from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { readConfigFileSnapshot } from "../../config/config.js";
import { updateInstallRootsMatch } from "../../infra/update-install-root.js";
import {
  claimUpdateRecovery,
  recordUpdateRecoveryFailure,
} from "../../infra/update-run-recovery.js";
import type { UpdateCommandOptions } from "./shared.js";
import { completeUpdateCommandCandidate } from "./update-command-candidate-completion.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";
import { quiesceFailedUpdateCommand } from "./update-command-native-quiescence.js";
import {
  UpdateCommandRecoveryPendingError,
  type UpdateCommandRecovery,
} from "./update-command-recovery.js";
import { discoverUpdateCommandRecovery } from "./update-command-replay-inspection.js";
import { restoreUpdateCommandFailure } from "./update-command-restore.js";
import { resumeTerminalUpdateRetirement } from "./update-command-retirement-retry.js";
import { resolveUpdateCommandAdmissionEnv } from "./update-command-run.js";

/** Admission continuation, before creating a new history row. Discovery carries
 * evidence only; the new installation executor must exclude the previous actor.
 * A recovered failed update finishes that original run, never silently starts
 * another update. Unsealed/missing checkpoints remain explicit refusals. */
export async function resumePendingUpdateCommand(params: {
  opts: UpdateCommandOptions;
  root: string;
  invocationCwd?: string;
  timeoutMs?: number;
}): Promise<boolean> {
  if (params.opts.dryRun || params.opts.run || params.opts.recovery) {
    return false;
  }
  const env = await resolveUpdateCommandAdmissionEnv(params);
  const found = await discoverUpdateCommandRecovery(env);
  if (!found) {
    return false;
  }
  if (found.terminal) {
    return await resumeTerminalUpdateRetirement({ ...params, pending: found, env });
  }
  if (
    !found.checkpoint ||
    !found.package ||
    !found.nativeManager ||
    !updateInstallRootsMatch(params.root, found.from.root) ||
    (await fs.realpath(params.root)) !== found.from.root ||
    (found.restore && (!found.restore.planSha256 || found.restore.phase === "preparing"))
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Interrupted update lacks a sealed recoverable owner boundary.",
    );
  }
  return await withOwnedManagedUpdateEnv(env, () =>
    withUpdateCommandExecutor(found.runId, async (executor) => {
      const fence = await executor.enter(params.root);
      const checked = await discoverUpdateCommandRecovery(env);
      fence.assertCurrent();
      if (!isDeepStrictEqual(checked, found)) {
        throw new UpdateCommandRecoveryPendingError(
          "Interrupted update changed during executor admission.",
        );
      }
      let record = found;
      const recovery: UpdateCommandRecovery = {
        fence,
        options: { env },
        getRecord: () => record,
        onRecord(next) {
          fence.assertCurrent();
          record = next;
        },
        assertReady() {
          throw new UpdateCommandRecoveryPendingError(
            "A previous process cannot supply readiness.",
          );
        },
      };
      const opts = {
        ...params.opts,
        run: { runId: found.runId, env, executorFence: fence },
        recovery,
      };
      if (!record.restore) {
        recovery.onRecord(claimUpdateRecovery(record, fence, recovery.options));
        if (!record.primaryFailure) {
          recovery.onRecord(
            recordUpdateRecoveryFailure(
              record,
              {
                code: "interrupted-update",
                effectId: record.effects.at(-1)?.effectId ?? null,
              },
              fence,
              recovery.options,
            ),
          );
        }
        await quiesceFailedUpdateCommand({
          recovery,
          env,
          timeoutMs: params.timeoutMs,
          stdout: process.stdout,
        });
      }
      await restoreUpdateCommandFailure(opts, params.timeoutMs);
      fence.assertCurrent();
      const configSnapshot = await readConfigFileSnapshot({
        observe: false,
        skipPluginValidation: true,
      });
      fence.assertCurrent();
      await completeUpdateCommandCandidate({
        opts,
        root: record.from.root,
        ownedManagedUpdateEnv: env,
        result: {
          status: "error",
          mode: "unknown",
          root: record.from.root,
          runId: record.runId,
          reason: record.primaryFailure!.code,
          steps: [],
          durationMs: 0,
          before: { version: record.from.version },
          after: { version: record.from.version },
        },
        shouldRestart: true,
        mutationStarted: true,
        installKindChanged: false,
        configSnapshot,
        requestedChannel: null,
        storedChannel: null,
        channel: "stable",
        downgradeRisk: false,
        controlPlaneUpdateSentinelMeta: null,
        preUpdatePluginInstallRecords: {},
        startedAt: Date.now(),
        updateStepTimeoutMs: params.timeoutMs ?? 30_000,
        packageUpdateNodeRunner: record.from.nodePath,
      });
      return true;
    }),
  );
}
