import { isDeepStrictEqual } from "node:util";
import { resolveGatewayService } from "../../daemon/service.js";
import { updateInstallRootsMatch } from "../../infra/update-install-root.js";
import { currentUpdateRecoveryNativeFacts } from "../../infra/update-run-recovery-native-schema.js";
import { UpdateRecoveryRecordSchema } from "../../infra/update-run-recovery-schema.js";
import {
  inspectUpdateRecoveries,
  type UpdateRecoveryRecord,
} from "../../infra/update-run-recovery.js";
import { defaultRuntime } from "../../runtime.js";
import { getFileLockProcessStartTime, isPidAlive } from "../../shared/pid-alive.js";
import { resolveGatewayRestartProbeContext } from "../daemon-cli/restart-health-probe.js";
import {
  inspectGatewayRestart,
  waitForGatewayHealthyRestart,
} from "../daemon-cli/restart-health.js";
import type { UpdateCommandOptions } from "./shared.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";
import { readUpdateCommandNativeObservation } from "./update-command-native-observation.js";
import {
  UpdateCommandRecoveryPendingError,
  type UpdateCommandRecovery,
} from "./update-command-recovery.js";
import { discoverUpdateCommandRecovery } from "./update-command-replay-inspection.js";
import { retireSupersededUpdateCommandPair } from "./update-command-retirement.js";
import { resolveUpdatedGatewayRestartPort } from "./update-command-service-plan.js";
import { hasLoadedLaunchdKeepAliveSupervisor } from "./update-command-service-recovery.js";
import { withUpdateCommandServingConnection } from "./update-command-serving-connection.js";
import { withUpdateCommandSourceOwnership } from "./update-command-source-ownership.js";
import { verifyUpdatedGateway } from "./update-command-verification.js";

/** Retry terminal cleanup only. Neither the old terminal receipt nor this path
 * can start a daemon, create a run, change its terminal result, or grant replay. */
export async function resumeTerminalUpdateRetirement(params: {
  pending: UpdateRecoveryRecord;
  env: NodeJS.ProcessEnv;
  root: string;
  opts: UpdateCommandOptions;
  timeoutMs?: number;
}): Promise<boolean> {
  const { pending, env } = params;
  if (
    !pending.terminal ||
    pending.retainedPair?.state !== "superseded" ||
    pending.effects.at(-1)?.state !== "intent" ||
    pending.effects.at(-1)?.package?.intent.action !== "retire"
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Terminal history has no recoverable retirement intent.",
    );
  }
  const entry = inspectUpdateRecoveries({ env }).find(
    (value) => value.record.runId === pending.retainedPair!.replacementRunId,
  );
  if (entry?.format !== "current") {
    throw new UpdateCommandRecoveryPendingError(
      "Selected replacement cannot supply current readiness.",
    );
  }
  const selected = UpdateRecoveryRecordSchema.parse(entry.record);
  if (
    selected.terminal?.status !== "succeeded" ||
    selected.retainedPair?.state !== "selected" ||
    !selected.nativeManager ||
    !selected.checkpoint ||
    !updateInstallRootsMatch(params.root, selected.to.root)
  ) {
    throw new UpdateCommandRecoveryPendingError(
      "Retirement replacement is not the installed selected owner.",
    );
  }
  return await withOwnedManagedUpdateEnv(env, () =>
    withUpdateCommandExecutor(selected.runId, async (executor) => {
      const fence = await executor.enter(params.root);
      if (!isDeepStrictEqual(await discoverUpdateCommandRecovery(env), pending)) {
        throw new UpdateCommandRecoveryPendingError(
          "Pending retirement changed during executor admission.",
        );
      }
      const recovery: UpdateCommandRecovery = {
        fence,
        options: { env },
        getRecord: () => selected,
        onRecord() {
          throw new Error("Cleanup cannot rewrite selected terminal history");
        },
        assertReady() {
          throw new Error("Fresh serving readiness is required");
        },
      };
      await withUpdateCommandSourceOwnership({ recovery, env, mutation: true }, async (source) => {
        const native = await readUpdateCommandNativeObservation({
          record: selected,
          env,
          definitionPaths: source.definitionPaths,
          assertCurrent: source.assertCurrent,
          timeoutMs: params.timeoutMs,
        });
        source.assertCurrent();
        if (
          native.facts.stopped ||
          !isDeepStrictEqual(native.identity, selected.nativeManager!.identity) ||
          !isDeepStrictEqual(
            native.facts,
            currentUpdateRecoveryNativeFacts(selected.nativeManager!),
          )
        ) {
          throw new UpdateCommandRecoveryPendingError(
            "Selected service no longer matches its native owner.",
          );
        }
        const service = resolveGatewayService();
        const command = await service.readCommand(env);
        source.assertCurrent();
        const port = await resolveUpdatedGatewayRestartPort({
          serviceEnv: env,
          serviceCommand: command,
        });
        source.assertCurrent();
        const supervisorKeepsAlive = await hasLoadedLaunchdKeepAliveSupervisor({ service, env });
        source.assertCurrent();
        const identity = selected.to;
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
        source.assertCurrent();
        if (
          !health.healthy ||
          health.runtime.status !== "running" ||
          !health.gatewayBootId ||
          health.gatewayVersion !== identity.version ||
          health.gatewayBuildId !== identity.buildId ||
          health.activatedPluginErrors?.length ||
          health.channelProbeErrors?.length
        ) {
          throw new UpdateCommandRecoveryPendingError(
            "Current selected service is not ready for retirement.",
          );
        }
        const pid = health.runtime.pid;
        const start = typeof pid === "number" ? getFileLockProcessStartTime(pid, env) : null;
        const assertCurrent = () => {
          source.assertCurrent();
          if (
            typeof pid === "number" &&
            (!isPidAlive(pid) ||
              (start !== null && getFileLockProcessStartTime(pid, env) !== start))
          ) {
            throw new UpdateCommandRecoveryPendingError(
              "Selected serving process generation changed.",
            );
          }
        };
        await withUpdateCommandServingConnection(
          {
            env,
            port,
            gateway: {
              bootId: health.gatewayBootId,
              version: identity.version,
              buildId: identity.buildId,
            },
            assertCurrent,
          },
          async (assertConnection) => {
            const result = {
              status: "ok" as const,
              mode: "unknown" as const,
              root: selected.to.root,
              steps: [],
              durationMs: 0,
            };
            // No run/recovery is supplied: this invocation must not append history or
            // replace the terminal's historical receipt. Its live connection is required.
            const ready = await verifyUpdatedGateway({
              result,
              opts: { json: true },
              serviceEnv: env,
              gatewayPort: port,
              expectedVersion: identity.version,
              ...(identity.buildId ? { expectedBuildId: identity.buildId } : {}),
              requireRunningService: true,
              health,
              assertCurrent: assertConnection,
            });
            assertConnection();
            const context = await resolveGatewayRestartProbeContext(env);
            assertConnection();
            const final = await inspectGatewayRestart({
              service,
              port,
              env,
              expectedVersion: identity.version,
              ...(identity.buildId ? { expectedBuildId: identity.buildId } : {}),
              probeContext: context,
            });
            assertConnection();
            if (
              !ready.ok ||
              !final.healthy ||
              final.runtime.status !== "running" ||
              final.gatewayBootId !== health.gatewayBootId ||
              final.gatewayVersion !== identity.version ||
              final.gatewayBuildId !== identity.buildId ||
              final.activatedPluginErrors?.length ||
              final.channelProbeErrors?.length
            ) {
              throw new UpdateCommandRecoveryPendingError(
                "Retirement readiness changed across the final probe.",
              );
            }
            recovery.assertReady = assertConnection;
            try {
              await retireSupersededUpdateCommandPair(recovery);
            } finally {
              recovery.assertReady = () => {
                throw new Error("Retirement serving interval closed");
              };
            }
          },
        );
      });
      if (params.opts.json) {
        defaultRuntime.writeJson({
          status: "ok",
          runId: selected.runId,
          reason: "retirement-reconciled",
        });
      } else {
        defaultRuntime.log("Recovered interrupted update cleanup.");
      }
      return true;
    }),
  );
}
