import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolveBackupPlanFromDisk } from "../../commands/backup-shared.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { withConfigWriteLock } from "../../config/write-lock.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { acquireGatewayLifecycleCoordinator } from "../../infra/state-database-coordinator.js";
import { readUpdateStateSchemaVersionsInProcess } from "../../infra/update-candidate-state.js";
import { inspectCheckpointFile } from "../../infra/update-checkpoint-files.js";
import {
  captureUpdateCheckpoint,
  collectUpdateCheckpointResources,
  reopenUpdateCheckpoint,
  type UpdateCheckpointResource,
} from "../../infra/update-checkpoint.js";
import { currentUpdateRecoveryNativeFacts } from "../../infra/update-run-recovery-native-schema.js";
import {
  assertExactUpdateRecoveryClaim,
  bindUpdateRecoveryAfterImage,
  recordUpdateRecoveryIntent,
  recordUpdateRecoveryFailure,
} from "../../infra/update-run-recovery.js";
import { collectInstalledPluginIndexMutations } from "../../plugins/installed-plugin-index-mutations.js";
import { resolveActivatedPluginBackupInventory } from "../../plugins/manifest-backup-resources.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { withAgentDatabaseMaintenanceLease } from "../../state/openclaw-agent-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";
import { readUpdateCommandNativeObservation } from "./update-command-native-observation.js";
import {
  UpdateCommandRecoveryPendingError,
  type UpdateCommandRecovery,
} from "./update-command-recovery.js";
import { withUpdateCommandSourceOwnership } from "./update-command-source-ownership.js";

/** The candidate executes and seals one real mutation interval. The callback is
 * local executable code, never a serialized grant. Errors retain their after-image
 * while all participating database, config, plugin and native owners are held.
 */
export async function runUpdateCommandMutation<T>(params: {
  recovery: UpdateCommandRecovery;
  env: NodeJS.ProcessEnv;
  phase: "doctor" | "plugins" | "post-plugin-doctor";
  timeoutMs: number;
  run: (assertCurrent: () => void) => Promise<T>;
}): Promise<{ value: T } | { error: unknown }> {
  const { recovery, env } = params;
  const expected = recovery.getRecord();
  const checkpoint = expected.checkpoint;
  if (!checkpoint || expected.handoff?.state !== "accepted" || expected.terminal) {
    throw new UpdateCommandRecoveryPendingError("Candidate mutation has no accepted checkpoint");
  }
  const databasePath = resolveOpenClawStateSqlitePath(env);
  if (databasePath !== resolveOpenClawStateSqlitePath(recovery.options?.env)) {
    throw new UpdateCommandRecoveryPendingError("Candidate mutation changed its admitted state");
  }
  recovery.fence.assertCurrent();
  const gateway = acquireGatewayLifecycleCoordinator({ databasePath, busyTimeoutMs: 0 });
  // These real durable expiries bound the paused-worker interval. No heartbeat
  // or captured timestamp is treated as renewal while physical exclusion is held.
  const leaseMs = Math.max(60_000, params.timeoutMs + 30_000);
  try {
    return await withOwnedManagedUpdateEnv(env, () =>
      withPluginLifecycleLease({ env, schemaPolicy: "existing", leaseMs }, (plugin) =>
        withAgentDatabaseMaintenanceLease(
          { env, schemaPolicy: "existing", leaseMs },
          (maintenance) =>
            withUpdateCommandSourceOwnership({ recovery, env, mutation: true }, async (source) => {
              const assertCurrent = () => {
                source.assertCurrent();
                plugin.assertOwned();
                maintenance.assertOwned();
              };
              const fence = { assertCurrent };
              assertExactUpdateRecoveryClaim(expected, fence, recovery.options);
              if (expected.nativeManager) {
                const observed = await readUpdateCommandNativeObservation({
                  record: expected,
                  env,
                  definitionPaths: source.definitionPaths,
                  assertCurrent,
                  timeoutMs: params.timeoutMs,
                });
                assertCurrent();
                const facts = currentUpdateRecoveryNativeFacts(expected.nativeManager);
                if (
                  !observed.facts.stopped ||
                  !isDeepStrictEqual(observed.identity, expected.nativeManager.identity) ||
                  !isDeepStrictEqual(observed.facts, facts)
                ) {
                  throw new UpdateCommandRecoveryPendingError(
                    "Candidate mutation lost its stopped native manager",
                  );
                }
              }
              if (!expected.nativeManager) {
                const state = await readGatewayServiceState(resolveGatewayService(), {
                  env,
                  requireEffective: true,
                  requireLoadedCommand: true,
                  timeoutMs: params.timeoutMs,
                });
                assertCurrent();
                if (
                  state.installed ||
                  state.command ||
                  state.loadState.status !== "not-loaded" ||
                  !state.runtime?.missingUnit
                ) {
                  throw new UpdateCommandRecoveryPendingError(
                    "Unmanaged candidate gained a native service",
                  );
                }
              }
              const effectId = randomUUID();
              recovery.onRecord(
                recordUpdateRecoveryIntent(
                  expected,
                  {
                    effectId,
                    kind: "runtime-mutation",
                    runtime: "candidate",
                    resourceId: params.phase,
                  },
                  fence,
                  recovery.options,
                ),
              );
              const mutate = maintenance.withDatabaseFileMutation;
              if (!mutate) {
                throw new UpdateCommandRecoveryPendingError(
                  "Candidate requires live physical mutation ownership",
                );
              }
              return await mutate({
                assertCurrent,
                mutate: async (assertMutation) => {
                  let primary: { error: unknown } | undefined;
                  try {
                    const collected = await collectInstalledPluginIndexMutations(
                      assertMutation,
                      () =>
                        withConfigWriteLock(
                          checkpoint.binding.configPath,
                          () => params.run(assertMutation),
                          env,
                          assertMutation,
                        ),
                    );
                    if ("error" in collected.outcome) {
                      primary = collected.outcome;
                    }
                    // Agent connections may have been opened by Doctor. Join and close
                    // them before retaining any snapshot output, including failure output.
                    await closeOpenClawAgentDatabasesAsync();
                    assertMutation();
                    const snapshot = await readConfigFileSnapshot({
                      observe: false,
                      skipPluginValidation: true,
                    });
                    const plan = await resolveBackupPlanFromDisk({ includeWorkspace: false });
                    if (
                      plan.stateDir !== checkpoint.binding.stateDir ||
                      plan.configPath !== checkpoint.binding.configPath ||
                      plan.skipped.some((asset) => asset.reason === "unresolved")
                    ) {
                      throw new UpdateCommandRecoveryPendingError(
                        "Candidate inventory has unresolved ownership",
                      );
                    }
                    const plugins = resolveActivatedPluginBackupInventory({
                      config: snapshot.config,
                      env,
                      stateDir: plan.stateDir,
                      workspaceDirs: [],
                    });
                    assertMutation();
                    return {
                      ready: true as const,
                      ...collected,
                      plan,
                      config: snapshot.config,
                      plugins,
                    };
                  } catch (error) {
                    // A live owner can report failed sealing, but never acknowledge it.
                    assertMutation();
                    return {
                      ready: false as const,
                      error: primary
                        ? new AggregateError(
                            [primary.error, error],
                            "Candidate operation and inventory failed",
                            { cause: primary.error },
                          )
                        : error,
                    };
                  }
                },
                capture: async (written, assertDatabase) => {
                  const assertQuiescent = () => {
                    assertDatabase();
                    assertCurrent();
                  };
                  if (!written.ready) {
                    return { sealed: false as const, error: written.error };
                  }
                  try {
                    const databases = await readUpdateStateSchemaVersionsInProcess({
                      stateDir: written.plan.stateDir,
                      config: written.config,
                      env,
                    });
                    assertQuiescent();
                    const discovered = await collectUpdateCheckpointResources({
                      inventory: written.plan.inventory,
                      assets: written.plan.included,
                      databases,
                      pluginRoots: written.plugins.pluginRoots,
                      configFiles: source.current.manifest.resources
                        .filter((r) => r.kind === "config")
                        .map((r) => r.sourcePath),
                      serviceFiles: source.definitionPaths,
                    });
                    const resources = new Map<string, UpdateCheckpointResource>();
                    for (const { sourcePath, kind, restore } of [
                      ...source.current.manifest.resources,
                      ...discovered,
                    ]) {
                      const old = resources.get(sourcePath);
                      if (old && (old.kind !== kind || old.restore !== restore)) {
                        throw new UpdateCommandRecoveryPendingError(
                          "Candidate changed checkpoint resource ownership",
                        );
                      }
                      resources.set(sourcePath, { sourcePath, kind, restore });
                    }
                    const retainedResources = [...resources.values()];
                    const expectedSources = [];
                    for (const resource of retainedResources) {
                      if (resource.restore === "replace" && resource.kind !== "sqlite") {
                        expectedSources.push({
                          sourcePath: resource.sourcePath,
                          state: await inspectCheckpointFile(resource.sourcePath),
                        });
                        assertQuiescent();
                      }
                    }
                    const access = {
                      artifactRoot: source.artifactRoot,
                      binding: checkpoint.binding,
                    };
                    const ref = await captureUpdateCheckpoint({
                      ...access,
                      assertQuiescent,
                      resources: retainedResources,
                      exclusions: source.current.manifest.exclusions,
                      expectedSources,
                      pluginIndexMutations: written.mutations,
                    });
                    const after = await reopenUpdateCheckpoint(ref, access);
                    assertQuiescent();
                    return { sealed: true as const, after, outcome: written.outcome };
                  } catch (error) {
                    assertQuiescent();
                    return {
                      sealed: false as const,
                      error:
                        "error" in written.outcome
                          ? new AggregateError(
                              [written.outcome.error, error],
                              "Candidate operation and after-image capture failed",
                              { cause: written.outcome.error },
                            )
                          : error,
                    };
                  }
                },
                bind: (captured, assertDatabase): undefined => {
                  const bindingFence = {
                    assertCurrent: () => {
                      assertDatabase();
                      assertCurrent();
                    },
                  };
                  const record = recovery.getRecord();
                  if (!captured.sealed) {
                    recovery.onRecord(
                      recordUpdateRecoveryFailure(
                        record,
                        {
                          code: `candidate-${params.phase}-after-image`,
                          effectId,
                        },
                        bindingFence,
                        recovery.options,
                      ),
                    );
                    return;
                  }
                  const covered =
                    record.afterImages?.flatMap((image) => image.effectIds).length ?? 0;
                  recovery.onRecord(
                    bindUpdateRecoveryAfterImage(
                      record,
                      {
                        checkpointRef: checkpoint.ref,
                        afterUpdate: {
                          ref: captured.after.ref,
                          binding: captured.after.manifest.binding,
                        },
                        effectIds: record.effects.slice(covered).map((effect) => effect.effectId),
                        mutation: {
                          effectId,
                          observedIdentity: `${params.phase}:${effectId}:${"error" in captured.outcome ? "failed" : "completed"}`,
                          ...("error" in captured.outcome
                            ? { failureCode: `candidate-${params.phase}` }
                            : {}),
                        },
                      },
                      bindingFence,
                      recovery.options,
                    ),
                  );
                },
              }).then((captured) =>
                captured.sealed ? captured.outcome : { error: captured.error },
              );
            }),
        ),
      ),
    );
  } finally {
    gateway.release();
  }
}
