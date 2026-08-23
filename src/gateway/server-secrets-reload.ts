// Owns serialized secrets snapshot replacement and exact channel-account lifecycle recovery.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import {
  isTrustedSecretSurfaceUnavailableError,
  listActiveCredentialDegradedOwners,
  type DegradedSecretOwner,
} from "../secrets/runtime-degraded-state.js";
import {
  getActiveSecretsRuntimeSnapshotRevisionState,
  getActiveSecretsRuntimeSnapshotState,
  type PreparedSecretsRuntimeSnapshot,
} from "../secrets/runtime-state.js";
import { diffConfigPaths } from "./config-diff.js";
import {
  buildGatewayReloadPlan,
  type ChannelKind,
  type GatewayReloadPlan,
} from "./config-reload-plan.js";
import type { ChannelAutostartSuppression, createChannelManager } from "./server-channels.js";
import {
  captureSharedGatewaySessionGenerationOwnership,
  claimSharedGatewaySessionGenerationIfOwned,
  disconnectStaleSharedGatewayAuthClients,
  finalizeOwnedSharedGatewaySessionGeneration,
  isSharedGatewaySessionGenerationOwnershipCurrent,
  replaceOwnedSharedGatewaySessionGenerationState,
  type SharedGatewayAuthClient,
  type SharedGatewaySessionGenerationOwnership,
  type SharedGatewaySessionGenerationState,
} from "./server-shared-auth-generation.js";
import type { ActivateRuntimeSecrets } from "./server-startup-config.js";

type ReloadSecretsResult = { warningCount: number };
type ReloadSecretsOptions = { forceColdRefKeys?: ReadonlySet<string>; joinInFlight?: boolean };
type ReloadChannelTarget = {
  channel: ChannelKind;
  accountId?: string;
  credentialOwnerId?: string;
  inspectOnly?: boolean;
};

export type GatewaySecretsReloaderParams = {
  activateRuntimeSecrets: ActivateRuntimeSecrets;
  buildReloadPlan?: (changedPaths: string[]) => GatewayReloadPlan;
  sharedGatewaySessionGenerationState: SharedGatewaySessionGenerationState;
  resolveSharedGatewaySessionGenerationForConfig: (config: OpenClawConfig) => string | undefined;
  clients: Iterable<SharedGatewayAuthClient>;
  channelManager: Pick<
    ReturnType<typeof createChannelManager>,
    "startChannel" | "stopChannel" | "isManuallyStopped" | "resolveRuntimeAccountId"
  >;
  getChannelAutostartSuppression?: () => ChannelAutostartSuppression | null;
  logChannels: { info: (message: string) => void };
};

async function activateSnapshotIfCurrent(
  snapshot: PreparedSecretsRuntimeSnapshot,
  expectedRevision: number,
  options: { canActivate: () => boolean; onActivated: () => void },
): Promise<number | null> {
  const runtime = await import("../secrets/runtime.js");
  if (
    !options.canActivate() ||
    !runtime.activateSecretsRuntimeSnapshotIfCurrent(snapshot, expectedRevision)
  ) {
    return null;
  }
  options.onActivated();
  return runtime.getActiveSecretsRuntimeSnapshotRevision();
}

async function restoreSnapshotIfCurrent(
  snapshot: PreparedSecretsRuntimeSnapshot,
  expectedRevision: number,
  ownedSnapshot: PreparedSecretsRuntimeSnapshot,
  onActivated: () => void,
): Promise<void> {
  const runtime = await import("../secrets/runtime.js");
  if (runtime.restoreSecretsRuntimeSnapshotIfCurrent(snapshot, expectedRevision, ownedSnapshot)) {
    onActivated();
  }
}

/** Keeps snapshot CAS, generation ownership, and exact account recovery in one transaction. */
export function createGatewaySecretsReloader(params: GatewaySecretsReloaderParams) {
  const buildReloadPlan = params.buildReloadPlan ?? buildGatewayReloadPlan;
  const manager = params.channelManager;
  let reloadInFlight: Promise<ReloadSecretsResult> | null = null;
  const runExclusiveReload = (
    fn: () => Promise<ReloadSecretsResult>,
    options: ReloadSecretsOptions = {},
  ): Promise<ReloadSecretsResult> => {
    if (reloadInFlight) {
      return options.joinInFlight === false
        ? reloadInFlight.catch(() => undefined).then(() => runExclusiveReload(fn, options))
        : reloadInFlight;
    }
    const run = (async () => {
      try {
        return await fn();
      } finally {
        reloadInFlight = null;
      }
    })();
    reloadInFlight = run;
    return run;
  };

  return (reloadOptions?: ReloadSecretsOptions) =>
    runExclusiveReload(async () => {
      let transaction:
        | {
            previousSnapshot: PreparedSecretsRuntimeSnapshot;
            previousGeneration: string | undefined;
            previousRequiredGeneration: string | undefined | null;
            prepared: PreparedSecretsRuntimeSnapshot;
            plan: GatewayReloadPlan;
            credentialOwners: DegradedSecretOwner[];
            nextGeneration: string | undefined;
            generationChanged: boolean;
            generationOwnership: SharedGatewaySessionGenerationOwnership;
            publishedSnapshotRevision: number;
          }
        | undefined;
      const touchedTargets: Array<{ target: ReloadChannelTarget; restarted: boolean }> = [];
      const startTarget = ({ channel, accountId }: ReloadChannelTarget) =>
        accountId
          ? manager.startChannel(channel, accountId, { preserveManualStop: true })
          : manager.startChannel(channel);
      const stopTarget = ({ channel, accountId }: ReloadChannelTarget) =>
        accountId
          ? manager.stopChannel(channel, accountId, { manual: false })
          : manager.stopChannel(channel);

      try {
        for (;;) {
          const previousSnapshot = getActiveSecretsRuntimeSnapshotState();
          if (!previousSnapshot) {
            throw new Error("Secrets runtime snapshot is not active.");
          }
          const previousRevision = getActiveSecretsRuntimeSnapshotRevisionState();
          const previousOwnership = captureSharedGatewaySessionGenerationOwnership(
            params.sharedGatewaySessionGenerationState,
          );
          const previousGeneration = previousOwnership.generation;
          const previousRequiredGeneration = params.sharedGatewaySessionGenerationState.required;
          const prepared = await params.activateRuntimeSecrets(previousSnapshot.sourceConfig, {
            reason: "reload",
            activate: false,
            publishFailureAsDegraded: true,
            forceColdRefKeys: reloadOptions?.forceColdRefKeys,
            canPublishFailureAsDegraded: () =>
              getActiveSecretsRuntimeSnapshotRevisionState() === previousRevision,
          });
          const plan = buildReloadPlan(diffConfigPaths(previousSnapshot.config, prepared.config));
          const nextGeneration = params.resolveSharedGatewaySessionGenerationForConfig(
            prepared.config,
          );
          // File diagnostics have channel-owned lifetimes; capture each CAS attempt
          // immediately before publication so a superseded attempt cannot reuse owners.
          const credentialOwners = listActiveCredentialDegradedOwners();
          let publishedSnapshotRevision: number | null = null;
          let generationOwnership: SharedGatewaySessionGenerationOwnership | null = null;
          const claimGeneration = () => {
            publishedSnapshotRevision = getActiveSecretsRuntimeSnapshotRevisionState();
            generationOwnership = claimSharedGatewaySessionGenerationIfOwned(
              params.sharedGatewaySessionGenerationState,
              previousOwnership,
              nextGeneration,
            );
          };
          const ownsPreviousGeneration = () =>
            isSharedGatewaySessionGenerationOwnershipCurrent(
              params.sharedGatewaySessionGenerationState,
              previousOwnership,
            );
          const activateIfCurrent = params.activateRuntimeSecrets.activatePreparedSnapshotIfCurrent;
          if (activateIfCurrent) {
            const activated = await activateIfCurrent(
              prepared,
              previousRevision,
              { reason: "reload", activate: true },
              claimGeneration,
              ownsPreviousGeneration,
            );
            if (!activated) {
              continue;
            }
          } else {
            publishedSnapshotRevision = await activateSnapshotIfCurrent(
              prepared,
              previousRevision,
              {
                canActivate: ownsPreviousGeneration,
                onActivated: claimGeneration,
              },
            );
            if (publishedSnapshotRevision === null) {
              continue;
            }
          }
          if (publishedSnapshotRevision === null || generationOwnership === null) {
            throw new Error("Secrets runtime activation did not publish ownership.");
          }
          transaction = {
            previousSnapshot,
            previousGeneration,
            previousRequiredGeneration,
            prepared,
            plan,
            credentialOwners,
            nextGeneration,
            generationChanged: previousGeneration !== nextGeneration,
            generationOwnership,
            publishedSnapshotRevision,
          };
          if (
            !isSharedGatewaySessionGenerationOwnershipCurrent(
              params.sharedGatewaySessionGenerationState,
              generationOwnership,
            )
          ) {
            throw new Error("secrets.reload was superseded by a newer config write");
          }
          break;
        }

        const { prepared, plan, credentialOwners, generationOwnership, nextGeneration } =
          transaction;
        if (transaction.generationChanged) {
          disconnectStaleSharedGatewayAuthClients({
            clients: params.clients,
            expectedGeneration: nextGeneration,
          });
        }
        const targets: ReloadChannelTarget[] = [...plan.restartChannels].map((channel) => ({
          channel,
        }));
        const accountTargets = new Map<string, ReloadChannelTarget>();
        for (const [channel, accountIds] of plan.restartChannelAccounts ?? []) {
          if (plan.restartChannels.has(channel)) {
            continue;
          }
          for (const accountId of accountIds) {
            const target = { channel, accountId };
            accountTargets.set(`${channel}\0${accountId}`, target);
            targets.push(target);
          }
        }
        for (const owner of credentialOwners) {
          if (owner.ownerKind !== "account") {
            continue;
          }
          const separator = owner.ownerId.indexOf(":");
          if (separator < 0) {
            continue;
          }
          const channel: ChannelKind = owner.ownerId.slice(0, separator);
          if (plan.restartChannels.has(channel)) {
            continue;
          }
          const accountId = manager.resolveRuntimeAccountId(
            channel,
            owner.ownerId.slice(separator + 1),
          );
          if (!accountId || manager.isManuallyStopped(channel, accountId)) {
            continue;
          }
          const key = `${channel}\0${accountId}`;
          const existing = accountTargets.get(key);
          if (existing) {
            existing.credentialOwnerId = owner.ownerId;
            continue;
          }
          const target = {
            channel,
            accountId,
            credentialOwnerId: owner.ownerId,
            inspectOnly: true,
          };
          accountTargets.set(key, target);
          targets.push(target);
        }
        const restartTargets = targets.filter(
          ({ channel, accountId }) => !accountId || !manager.isManuallyStopped(channel, accountId),
        );
        if (restartTargets.length > 0) {
          const restartChannels = [...new Set(restartTargets.map(({ channel }) => channel))];
          if (
            isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
            isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS)
          ) {
            throw new Error(
              `secrets.reload requires restarting channels: ${restartChannels.join(", ")}`,
            );
          }
          if (params.getChannelAutostartSuppression?.()) {
            throw new Error(
              `secrets.reload requires restarting channels but channel autostart is suppressed by crash-loop breaker: ${restartChannels.join(", ")}`,
            );
          }
          const failures: string[] = [];
          for (const target of restartTargets) {
            const { channel, accountId, credentialOwnerId, inspectOnly } = target;
            const label = accountId ? `${channel} account ${accountId}` : `${channel} channel`;
            const assertGenerationOwned = () => {
              if (
                !isSharedGatewaySessionGenerationOwnershipCurrent(
                  params.sharedGatewaySessionGenerationState,
                  generationOwnership,
                )
              ) {
                throw new Error("secrets.reload was superseded by a newer config write");
              }
            };
            assertGenerationOwned();
            params.logChannels.info(
              `${inspectOnly ? "reinspecting" : "restarting"} ${label} after secrets reload`,
            );
            // A rejecting hook may have already changed its exact account lifetime.
            const touched = { target, restarted: false };
            touchedTargets.push(touched);
            try {
              if (!inspectOnly) {
                await stopTarget(target);
                assertGenerationOwned();
              }
              await startTarget(target);
              touched.restarted = true;
              assertGenerationOwned();
            } catch (error) {
              if (
                credentialOwnerId &&
                isTrustedSecretSurfaceUnavailableError(error) &&
                error.ownerKind === "account" &&
                error.ownerId === credentialOwnerId &&
                listActiveCredentialDegradedOwners().some(
                  (owner) => owner.ownerKind === "account" && owner.ownerId === credentialOwnerId,
                )
              ) {
                touchedTargets.pop();
                continue;
              }
              params.logChannels.info(`failed to restart ${label} after secrets reload`);
              failures.push(accountId ? `${channel}:${accountId}` : channel);
            }
          }
          if (failures.length > 0) {
            throw new Error(
              `failed to restart channels after secrets reload: ${failures.join(", ")}`,
            );
          }
        }
        if (
          !finalizeOwnedSharedGatewaySessionGeneration(
            params.sharedGatewaySessionGenerationState,
            generationOwnership,
          )
        ) {
          throw new Error("secrets.reload was superseded by a newer config write");
        }
        return { warningCount: prepared.warnings.length };
      } catch (error) {
        let generationRestored = false;
        if (transaction) {
          const failedTransaction = transaction;
          await restoreSnapshotIfCurrent(
            failedTransaction.previousSnapshot,
            failedTransaction.publishedSnapshotRevision,
            failedTransaction.prepared,
            () => {
              generationRestored = replaceOwnedSharedGatewaySessionGenerationState(
                params.sharedGatewaySessionGenerationState,
                failedTransaction.generationOwnership,
                {
                  current: failedTransaction.previousGeneration,
                  required: failedTransaction.previousRequiredGeneration,
                },
              );
            },
          );
        }
        if (generationRestored && transaction?.generationChanged) {
          disconnectStaleSharedGatewayAuthClients({
            clients: params.clients,
            expectedGeneration: transaction.previousGeneration,
          });
        }
        // Generation fences snapshot rollback, never exact-account liveness recovery.
        for (const { target, restarted } of touchedTargets) {
          const { channel, accountId, inspectOnly } = target;
          const label = accountId ? `${channel} account ${accountId}` : `${channel} channel`;
          params.logChannels.info(`rolling back ${label} after secrets reload failure`);
          try {
            if (restarted || inspectOnly) {
              await stopTarget(target);
            }
            if (!inspectOnly) {
              await startTarget(target);
            }
          } catch {
            params.logChannels.info(`failed to roll back ${label} after secrets reload`);
          }
        }
        throw error;
      }
    }, reloadOptions);
}
