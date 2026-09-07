import { isDeepStrictEqual } from "node:util";
import { resolveBackupPlanFromDisk } from "../../commands/backup-shared.js";
import { resolveStartupConfigSnapshot } from "../../commands/doctor/shared/automatic-startup-config-repair.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { acquireGatewayLifecycleCoordinator } from "../../infra/state-database-coordinator.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import {
  captureUpdateCheckpoint,
  collectUpdateCheckpointResources,
  reopenUpdateCheckpoint,
} from "../../infra/update-checkpoint.js";
import { currentUpdateRecoveryNativeFacts } from "../../infra/update-run-recovery-native-schema.js";
import {
  assertExactUpdateRecoveryClaim,
  bindUpdateRecoveryCheckpoint,
} from "../../infra/update-run-recovery.js";
import { resolveActivatedPluginBackupInventory } from "../../plugins/manifest-backup-resources.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { withAgentDatabaseMaintenanceLease } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";
import { readUpdateCommandNativeObservation } from "./update-command-native-observation.js";
import {
  UpdateCommandRecoveryPendingError,
  type UpdateCommandRecovery,
} from "./update-command-recovery.js";
import { withUpdateCommandSourceOwnership } from "./update-command-source-ownership.js";

/** Seal the stopped-state checkpoint under actual writer owners. This publishes
 * immutable recovery facts, never permission to release a later mutation owner.
 */
export async function captureStoppedState(
  recovery: UpdateCommandRecovery | undefined,
  env: NodeJS.ProcessEnv,
  timeoutMs?: number,
): Promise<void> {
  if (!recovery) {
    return;
  }
  const options = recovery.options ?? { env };
  const expected = recovery.getRecord();
  if (!expected.source || !expected.preimages || expected.checkpoint || expected.effects.length) {
    throw new UpdateCommandRecoveryPendingError("Full capture requires untouched startup state.");
  }
  const databasePath = resolveOpenClawStateSqlitePath(env);
  if (databasePath !== resolveOpenClawStateSqlitePath(options.env)) {
    throw new UpdateCommandRecoveryPendingError(
      "Checkpoint source differs from the admitted state.",
    );
  }
  recovery.fence.assertCurrent();
  // Retain real Gateway exclusion before taking any writer lease or file snapshot.
  const gateway = acquireGatewayLifecycleCoordinator({ databasePath, busyTimeoutMs: 0 });
  try {
    await withOwnedManagedUpdateEnv(env, () =>
      withPluginLifecycleLease(
        { ...options, schemaPolicy: "existing", waitMs: timeoutMs ?? 30_000 },
        (plugin) =>
          withAgentDatabaseMaintenanceLease(
            { ...options, schemaPolicy: "existing" },
            (maintenance) =>
              withUpdateCommandSourceOwnership({ recovery, env }, async (source) => {
                const assertCurrent = () => {
                  source.assertCurrent();
                  plugin.assertOwned();
                  maintenance.assertOwned();
                };
                const fence = { assertCurrent };
                assertExactUpdateRecoveryClaim(expected, fence, recovery.options);
                const verifyNative = async () => {
                  if (expected.nativeManager) {
                    const effect = expected.nativeManager.effects.at(-1);
                    const observed = await readUpdateCommandNativeObservation({
                      record: expected,
                      env,
                      definitionPaths: source.definitionPaths,
                      assertCurrent,
                      timeoutMs,
                    });
                    if (
                      effect?.state === "intent" ||
                      !observed.facts.stopped ||
                      !isDeepStrictEqual(observed.identity, expected.nativeManager.identity) ||
                      !isDeepStrictEqual(
                        observed.facts,
                        currentUpdateRecoveryNativeFacts(expected.nativeManager),
                      )
                    ) {
                      throw new UpdateCommandRecoveryPendingError(
                        "Native stop is not confirmed for capture.",
                      );
                    }
                  } else {
                    const state = await readGatewayServiceState(resolveGatewayService(), {
                      env,
                      requireEffective: true,
                      requireLoadedCommand: true,
                      timeoutMs,
                    });
                    if (
                      state.installed ||
                      state.command ||
                      state.loadState.status !== "not-loaded" ||
                      !state.runtime?.missingUnit
                    ) {
                      throw new UpdateCommandRecoveryPendingError(
                        "Unmanaged startup gained a native service.",
                      );
                    }
                  }
                  assertCurrent();
                };
                await verifyNative();
                const authored = await readConfigFileSnapshot({ observe: false });
                const config = resolveStartupConfigSnapshot(authored) ?? authored;
                if (config.exists && !config.valid) {
                  throw new UpdateCommandRecoveryPendingError(
                    "Checkpoint ownership requires valid config discovery.",
                  );
                }
                const plan = await resolveBackupPlanFromDisk({ includeWorkspace: false });
                if (
                  plan.stateDir !== expected.source!.stateDir ||
                  plan.configPath !== expected.source!.configPath ||
                  plan.skipped.some((asset) => asset.reason === "unresolved")
                ) {
                  throw new UpdateCommandRecoveryPendingError(
                    "Checkpoint inventory has unresolved ownership.",
                  );
                }
                const plugins = resolveActivatedPluginBackupInventory({
                  config: config.config,
                  env,
                  stateDir: plan.stateDir,
                  workspaceDirs: [],
                });
                const databases = await readUpdateStateSchemaVersions({
                  stateDir: plan.stateDir,
                  config: config.config,
                  env,
                });
                assertCurrent();
                const resources = await collectUpdateCheckpointResources({
                  inventory: plan.inventory,
                  assets: plan.included,
                  databases,
                  pluginRoots: plugins.pluginRoots,
                  configFiles: source.original.manifest.resources
                    .filter((r) => r.kind === "config")
                    .map((r) => r.sourcePath),
                  serviceFiles: source.definitionPaths,
                });
                await verifyNative();
                await source.verifySources();
                assertExactUpdateRecoveryClaim(expected, fence, recovery.options);
                const capture = maintenance.withDatabaseFileExclusion;
                if (!capture) {
                  throw new UpdateCommandRecoveryPendingError(
                    "Checkpoint requires physical database exclusion.",
                  );
                }
                const access = {
                  artifactRoot: source.artifactRoot,
                  binding: source.original.manifest.binding,
                };
                await capture(
                  async (assertDatabase) => {
                    const assertQuiescent = () => {
                      assertDatabase();
                      assertCurrent();
                    };
                    const ref = await captureUpdateCheckpoint({
                      ...access,
                      assertQuiescent,
                      resources,
                      exclusions: plan.skipped.map(
                        (asset) => `${asset.reason}:${asset.sourcePath}`,
                      ),
                      preimages: {
                        checkpointRef: source.original.ref,
                        // Native preparation never changed these files. Exact original
                        // generations were rechecked under their reacquired write locks.
                        postMutationSources: source.original.manifest.resources.map((r) => ({
                          sourcePath: r.sourcePath,
                          state: r.sourceState ?? null,
                        })),
                      },
                    });
                    const reopened = await reopenUpdateCheckpoint(ref, access);
                    await source.verifySources();
                    assertQuiescent();
                    return reopened;
                  },
                  (captured, assertDatabase): undefined => {
                    const bindingFence = {
                      assertCurrent: () => {
                        assertDatabase();
                        assertCurrent();
                      },
                    };
                    const next = bindUpdateRecoveryCheckpoint(
                      expected,
                      {
                        ref: captured.ref,
                        binding: captured.manifest.binding,
                        preimageRef: captured.manifest.preimageRef,
                      },
                      bindingFence,
                      recovery.options,
                    );
                    recovery.onRecord(next);
                  },
                );
              }),
          ),
      ),
    );
  } catch (cause) {
    throw cause instanceof UpdateCommandRecoveryPendingError
      ? cause
      : new UpdateCommandRecoveryPendingError("Stopped-state checkpoint remains pending.", {
          cause,
        });
  } finally {
    gateway.release();
  }
}
