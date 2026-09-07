import fs from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { doctorCommand } from "../../commands/doctor.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { resolveOpenClawPackageRoot } from "../../infra/openclaw-root.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import { recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import type { UpdateRunStep } from "../../infra/update-run-record.js";
import {
  acceptUpdateRecoveryHandoff,
  assertExactUpdateRecoveryClaim,
  prepareUpdateRecoveryHandoff,
  recordUpdateRecoveryFailure,
  type UpdateRecoveryFence,
  type UpdateRecoveryHandoff,
} from "../../infra/update-run-recovery.js";
import { buildUpdateDoctorEnv } from "../../infra/update-runner-doctor.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { readPackageVersion } from "./shared.js";
import {
  persistRequestedUpdateChannel,
  restoreDroppedPreUpdateChannels,
} from "./update-command-config.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";
import { runUpdateCommandMutation } from "./update-command-mutation.js";
import { updatePluginsAfterCoreUpdate } from "./update-command-plugins.js";
import type { FinishUpdateParams } from "./update-command-post-update.js";
import {
  UpdateCommandRecoveryPendingError,
  type UpdateCommandRecovery,
} from "./update-command-recovery.js";

/** Called only inside the fresh PID/start-bound executor. Runtime identity comes
 * from this executable's installation, never the parent's serialized descriptor.
 * Accepting does not migrate state or grant terminal readiness. */
export async function acceptUpdateCommandCandidate(params: {
  handoff: UpdateRecoveryHandoff;
  finalization: FinishUpdateParams;
  fence: UpdateRecoveryFence;
  moduleUrl: string;
}): Promise<UpdateCommandRecovery> {
  const { finalization, fence } = params;
  const run = finalization.opts.run;
  if (
    !run ||
    run.runId !== params.handoff.runId ||
    run.executorFence !== fence ||
    finalization.opts.recovery
  ) {
    throw new UpdateCommandRecoveryPendingError("Candidate lost its original delegated executor.");
  }
  fence.assertCurrent();
  const root = await resolveOpenClawPackageRoot({ moduleUrl: params.moduleUrl });
  if (!root) {
    throw new UpdateCommandRecoveryPendingError("Candidate installation is unavailable.");
  }
  const [nodePath, version, buildId] = await Promise.all([
    fs.realpath(process.execPath),
    readPackageVersion(root),
    readBuiltGatewayBuildId(root),
  ]);
  fence.assertCurrent();
  if (
    !version ||
    resolveUpdateInstallRoot(root) !==
      resolveUpdateInstallRoot(finalization.result.root ?? finalization.root)
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Candidate executable does not match its installation.",
    );
  }
  const options = { env: run.env };
  let record = acceptUpdateRecoveryHandoff(
    params.handoff,
    {
      root: resolveUpdateInstallRoot(root),
      nodePath,
      version,
      buildId: buildId ?? null,
    },
    fence,
    options,
  );
  const recovery: UpdateCommandRecovery = {
    options,
    fence,
    getRecord: () => record,
    onRecord(next) {
      fence.assertCurrent();
      if (next.runId !== record.runId || next.transactionId !== record.transactionId) {
        throw new UpdateCommandRecoveryPendingError("Candidate record changed transaction.");
      }
      record = next;
    },
    assertReady() {
      throw new UpdateCommandRecoveryPendingError(
        "Candidate mutation has no terminal readiness authority.",
      );
    },
  };
  finalization.opts.recovery = recovery;
  assertExactUpdateRecoveryClaim(record, fence, options);
  return recovery;
}

/** Doctor/config/plugin writes run under the real combined mutation owner. The
 * next process is necessary after plugin replacement; neither old modules nor
 * the parent's runtime are used for the post-plugin Doctor. */
export async function runUpdateCommandCandidateMutations(
  params: FinishUpdateParams,
  bufferedSteps: readonly UpdateRunStep[] = [],
): Promise<UpdateRecoveryHandoff | undefined> {
  const recovery = params.opts.recovery;
  const run = params.opts.run;
  if (!recovery || !run) {
    throw new UpdateCommandRecoveryPendingError("Candidate requires its accepted recovery.");
  }
  const record = recovery.getRecord();
  if (record.primaryFailure) {
    params.result.status = "error";
    params.result.reason = record.primaryFailure.code;
    return undefined;
  }
  if (params.result.status !== "ok") {
    return undefined;
  }
  const phases = record.effects.filter((effect) => effect.kind === "runtime-mutation");
  if (
    phases.some((effect) => effect.state !== "observed") ||
    !["", "doctor", "doctor,plugins", "doctor,plugins,post-plugin-doctor"].includes(
      phases.map((effect) => effect.resourceId).join(","),
    )
  ) {
    throw new UpdateCommandRecoveryPendingError("Candidate phase history needs reconciliation.");
  }
  const env = params.ownedManagedUpdateEnv ?? run.env;
  const runtime: RuntimeEnv = {
    log: (...args) => defaultRuntime[params.opts.json ? "error" : "log"](...args),
    error: (...args) => defaultRuntime.error(...args),
    exit(code) {
      throw new Error(`Candidate Doctor exited before completion (${code}).`);
    },
  };
  const execute = async <T>(
    phase: "doctor" | "plugins" | "post-plugin-doctor",
    operation: () => Promise<T>,
  ) => {
    const outcome = await runUpdateCommandMutation({
      recovery,
      env,
      phase,
      timeoutMs: params.updateStepTimeoutMs,
      run: operation,
    });
    if ("error" in outcome) {
      if (!recovery.getRecord().primaryFailure) {
        recovery.onRecord(
          recordUpdateRecoveryFailure(
            recovery.getRecord(),
            {
              code: `candidate-${phase}`,
              effectId: recovery.getRecord().effects.at(-1)?.effectId ?? null,
            },
            recovery.fence,
            recovery.options,
          ),
        );
      }
      params.result.status = "error";
      params.result.reason = recovery.getRecord().primaryFailure?.code ?? `candidate-${phase}`;
      params.failure = { cause: outcome.error, detail: "Candidate phase requires restoration." };
    }
    return outcome;
  };
  const doctor = (postPlugin: boolean) =>
    withOwnedManagedUpdateEnv(
      {
        ...env,
        ...buildUpdateDoctorEnv({
          allowGatewayServiceRepair: false,
          allowGatewayActivation: false,
          serviceRepairPolicy: "external",
          deferConfiguredPluginInstallRepair: true,
        }),
        OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: postPlugin ? "1" : undefined,
      },
      () =>
        doctorCommand(runtime, {
          repair: true,
          nonInteractive: true,
          yes: params.opts.yes === true,
          workspaceSuggestions: false,
        }),
    );
  if (phases.length === 0) {
    const doctorOutcome = await execute("doctor", async () => {
      for (const step of bufferedSteps) {
        recovery.fence.assertCurrent();
        recordUpdateRunStep(run.runId, step, { env: run.env });
      }
      await doctor(false);
    });
    if ("error" in doctorOutcome) {
      return undefined;
    }
  }
  if (phases.length <= 1) {
    const pluginUpdate = await execute("plugins", async () => {
      let snapshot = await readConfigFileSnapshot({ observe: false, skipPluginValidation: true });
      snapshot = await persistRequestedUpdateChannel({
        configSnapshot: snapshot,
        requestedChannel: params.requestedChannel,
      });
      const original = params.configSnapshot;
      const restored = restoreDroppedPreUpdateChannels(
        snapshot,
        original.valid
          ? {
              sourceConfig: original.sourceConfig,
              authoredConfig: isRecord(original.parsed) ? original.parsed : original.sourceConfig,
            }
          : undefined,
      );
      const result = await updatePluginsAfterCoreUpdate({
        root: params.result.root ?? params.root,
        channel: params.channel,
        configSnapshot: restored.snapshot,
        configChanged: restored.changed,
        restoredAuthoredChannels: restored.authoredChannels,
        json: params.opts.json,
        acceptCapabilities: params.opts.acceptCapabilities,
        timeoutMs: params.updateStepTimeoutMs,
        pluginInstallRecords: await loadInstalledPluginIndexInstallRecords(),
        runtime,
      });
      if (result.status === "error") {
        throw new Error("Candidate plugin convergence failed.");
      }
      return result;
    });
    if ("error" in pluginUpdate) {
      return undefined;
    }
    params.result.postUpdate = { ...params.result.postUpdate, plugins: pluginUpdate.value };
    const prepared = prepareUpdateRecoveryHandoff(
      recovery.getRecord(),
      recovery.fence,
      recovery.options,
    );
    recovery.onRecord(prepared.record);
    return prepared.handoff;
  }
  if (phases.length === 2) {
    await execute("post-plugin-doctor", () => doctor(true));
  }
  return undefined;
}
