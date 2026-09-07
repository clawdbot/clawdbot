import { isDeepStrictEqual } from "node:util";
import { resolveGatewayService } from "../../daemon/service.js";
import {
  assertExactUpdateRecoveryClaim,
  recordUpdateRecoveryFailure,
  recordUpdateRecoveryObservation,
} from "../../infra/update-run-recovery.js";
import { getFileLockProcessStartTime, isPidAlive } from "../../shared/pid-alive.js";
import { waitForGatewayHealthyRestart } from "../daemon-cli/restart-health.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";
import { quiesceFailedUpdateCommand } from "./update-command-native-quiescence.js";
import { withUpdateCommandNativeRestoration } from "./update-command-native-restoration.js";
import { finishUpdate, type FinishUpdateParams } from "./update-command-post-update.js";
import { UpdateCommandRecoveryPendingError } from "./update-command-recovery.js";
import { restoreUpdateCommandFailure } from "./update-command-restore.js";
import { resolveUpdatedGatewayRestartPort } from "./update-command-service-plan.js";
import { hasLoadedLaunchdKeepAliveSupervisor } from "./update-command-service-recovery.js";
import { withUpdateCommandServingConnection } from "./update-command-serving-connection.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";

/** The installed candidate owns native restoration, authenticated serving proof,
 * and terminal package readback in one live interval. Failed updates still enter
 * the durable replay driver; they cannot fall into legacy compensation.
 */
async function completeCandidateAttempt(input: FinishUpdateParams) {
  let params = input;
  const recovery = params.opts.recovery;
  const run = params.opts.run;
  if (!recovery || !run) {
    throw new UpdateCommandRecoveryPendingError("Candidate completion requires its live owner.");
  }
  const previous = Boolean(recovery.getRecord().primaryFailure) || params.result.status !== "ok";
  if (previous) {
    if (!recovery.getRecord().primaryFailure) {
      recovery.onRecord(
        recordUpdateRecoveryFailure(
          recovery.getRecord(),
          { code: params.result.reason ?? "candidate-failed", effectId: null },
          recovery.fence,
          recovery.options,
        ),
      );
    }
    params = {
      ...params,
      result: {
        ...params.result,
        status: "error",
        reason: recovery.getRecord().primaryFailure!.code,
      },
    };
    await withOwnedManagedUpdateEnv(run.env, () =>
      restoreUpdateCommandFailure(params.opts, params.updateStepTimeoutMs),
    );
  }
  const runtime = previous ? ("previous" as const) : ("candidate" as const);
  const identity = previous ? recovery.getRecord().from : recovery.getRecord().to;
  const phases = recovery
    .getRecord()
    .effects.filter((effect) => effect.kind === "runtime-mutation");
  if (
    !previous &&
    (phases.map((effect) => effect.resourceId).join(",") !== "doctor,plugins,post-plugin-doctor" ||
      phases.some((effect) => effect.state !== "observed"))
  ) {
    throw new UpdateCommandRecoveryPendingError("Candidate mutation phases are incomplete.");
  }
  const env = run.env;
  return await withOwnedManagedUpdateEnv(env, () =>
    withUpdateCommandNativeRestoration(
      {
        recovery,
        env,
        runtime,
        timeoutMs: params.updateStepTimeoutMs,
        stdout: process.stdout,
      },
      async (assertNative) => {
        const expected = recovery.getRecord();
        const restart = expected.effects.at(-1);
        const assertCurrent = () => {
          assertNative();
          if (params.opts.recovery !== recovery || params.opts.run !== run) {
            throw new UpdateCommandRecoveryPendingError("Candidate completion changed owners.");
          }
        };
        if (restart?.kind !== "service-restart" || restart.runtime !== runtime) {
          throw new UpdateCommandRecoveryPendingError("Candidate start has no paired intent.");
        }
        const service = resolveGatewayService();
        const command = await service.readCommand(env);
        assertCurrent();
        const port = await resolveUpdatedGatewayRestartPort({
          serviceEnv: env,
          serviceCommand: command,
        });
        assertCurrent();
        const supervisorKeepsAlive = await hasLoadedLaunchdKeepAliveSupervisor({ service, env });
        assertCurrent();
        const health = await waitForGatewayHealthyRestart({
          service,
          port,
          env,
          requireRunningService: true,
          expectedVersion: identity.version,
          ...(identity.buildId ? { expectedBuildId: identity.buildId } : {}),
          settle: { probes: 12 },
          supervisorKeepsAlive,
        });
        assertExactUpdateRecoveryClaim(expected, { assertCurrent }, recovery.options);
        const pid = health.runtime.pid;
        const startTime = typeof pid === "number" ? getFileLockProcessStartTime(pid, env) : null;
        const gateway = {
          bootId: health.gatewayBootId,
          version: health.gatewayVersion,
          buildId: health.gatewayBuildId,
        };
        if (
          !health.healthy ||
          health.runtime.status !== "running" ||
          !gateway.bootId ||
          gateway.version !== identity.version ||
          gateway.buildId !== identity.buildId ||
          (typeof pid === "number" && !isPidAlive(pid)) ||
          health.activatedPluginErrors?.length ||
          health.channelProbeErrors?.length
        ) {
          recovery.onRecord(
            recordUpdateRecoveryFailure(
              expected,
              { code: "candidate-serving-health", effectId: restart.effectId },
              { assertCurrent },
              recovery.options,
            ),
          );
          throw new UpdateCommandRecoveryPendingError(
            "Candidate serving health remains unverified.",
          );
        }
        if (restart.state === "intent") {
          recovery.onRecord(
            recordUpdateRecoveryObservation(
              expected,
              { effectId: restart.effectId, observedIdentity: gateway.bootId },
              { assertCurrent },
              recovery.options,
            ),
          );
        } else if (restart.observedIdentity !== gateway.bootId) {
          throw new UpdateCommandRecoveryPendingError(
            "The serving boot differs from its restart observation.",
          );
        }
        const assertServingProcess = () => {
          assertCurrent();
          // The daemon's settled Windows status-only contract can omit a PID.
          // Its live boot connection remains mandatory; a readable PID adds a
          // synchronous generation check but is never fabricated from the socket.
          if (
            typeof pid === "number" &&
            (!isPidAlive(pid) ||
              (startTime !== null && getFileLockProcessStartTime(pid, env) !== startTime))
          ) {
            throw new UpdateCommandRecoveryPendingError("The serving process generation changed.");
          }
        };
        return await withUpdateCommandServingConnection(
          {
            env,
            port,
            gateway: { bootId: gateway.bootId, version: gateway.version, buildId: gateway.buildId },
            assertCurrent: assertServingProcess,
          },
          async (assertConnection) => {
            const verified = await verifyUpdatedGateway({
              result: params.result,
              opts: params.opts,
              serviceEnv: env,
              gatewayPort: port,
              expectedVersion: identity.version,
              ...(identity.buildId ? { expectedBuildId: identity.buildId } : {}),
              requireRunningService: true,
              health,
              assertCurrent: assertConnection,
            });
            assertConnection();
            if (!verified.ok) {
              recovery.onRecord(
                recordUpdateRecoveryFailure(
                  recovery.getRecord(),
                  { code: "candidate-serving-readiness", effectId: restart.effectId },
                  { assertCurrent: assertConnection },
                  recovery.options,
                ),
              );
              throw new UpdateCommandRecoveryPendingError(
                "Candidate readiness remains unverified.",
              );
            }
            const proof = structuredClone(recovery.getRecord().verification);
            if (!proof || proof.runtime !== runtime) {
              throw new UpdateCommandRecoveryPendingError(
                "Fresh candidate serving proof is missing.",
              );
            }
            const previousAssertion = recovery.assertReady;
            recovery.assertReady = () => {
              assertConnection();
              if (!isDeepStrictEqual(recovery.getRecord().verification, proof)) {
                throw new UpdateCommandRecoveryPendingError(
                  "Serving proof changed before completion.",
                );
              }
            };
            try {
              return await finishUpdate(params);
            } finally {
              recovery.assertReady = previousAssertion;
            }
          },
        );
      },
    ),
  );
}

/** Recover a candidate failure only after its source interval has drained. The
 * previous-runtime attempt is not recursively retried and cannot hide failure. */
export async function completeUpdateCommandCandidate(params: FinishUpdateParams) {
  const recovery = params.opts.recovery;
  const run = params.opts.run;
  const recovering = Boolean(recovery?.getRecord().primaryFailure) || params.result.status !== "ok";
  try {
    return await completeCandidateAttempt(params);
  } catch (error) {
    if (!recovery || !run || recovering || recovery.getRecord().terminal) {
      throw error;
    }
    recovery.fence.assertCurrent();
    if (!recovery.getRecord().primaryFailure) {
      recovery.onRecord(
        recordUpdateRecoveryFailure(
          recovery.getRecord(),
          {
            code: "candidate-completion-failed",
            effectId: recovery.getRecord().effects.at(-1)?.effectId ?? null,
          },
          recovery.fence,
          recovery.options,
        ),
      );
    }
    try {
      await withOwnedManagedUpdateEnv(run.env, () =>
        quiesceFailedUpdateCommand({
          recovery,
          env: run.env,
          timeoutMs: params.updateStepTimeoutMs,
          stdout: process.stdout,
        }),
      );
      return await completeCandidateAttempt({
        ...params,
        result: {
          ...params.result,
          status: "error",
          reason: recovery.getRecord().primaryFailure!.code,
        },
      });
    } catch (recoveryError) {
      if (recovery.getRecord().terminal) {
        throw recoveryError;
      }
      throw new UpdateCommandRecoveryPendingError(
        "Candidate failed and durable restoration remains pending.",
        {
          cause: new AggregateError([error, recoveryError], "Candidate and recovery failures", {
            cause: error,
          }),
        },
      );
    }
  }
}
