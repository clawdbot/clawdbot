// Owns serialized secrets snapshot replacement and dependent runtime lifecycle recovery.
import {
  getRuntimeConfigSnapshot,
  getRuntimeConfigSourceSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import type { PreparedPluginMetadata } from "../plugins/plugin-metadata-collection.js";
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
import { refreshModelRuntimeAfterHotReload } from "./server-reload-model-runtime-scope.js";
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
type SecretsReloadPublication = {
  publishedSnapshotRevision: number;
  generationOwnership: SharedGatewaySessionGenerationOwnership;
  modelPublication: Promise<void>;
  isCurrent: () => boolean;
};

export type GatewaySecretsReloaderParams = {
  activateRuntimeSecrets: ActivateRuntimeSecrets;
  getPluginMetadata: () => PreparedPluginMetadata | undefined;
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

async function restoreSnapshotIfCurrent(
  snapshot: PreparedSecretsRuntimeSnapshot,
  expectedRevision: number,
  ownedSnapshot: PreparedSecretsRuntimeSnapshot,
  onActivated: () => void,
  runtimeSourceConfig: OpenClawConfig | undefined,
): Promise<void> {
  const runtime = await import("../secrets/runtime.js");
  if (
    runtime.restoreSecretsRuntimeSnapshotIfCurrent(snapshot, expectedRevision, ownedSnapshot, {
      runtimeSourceConfig,
    })
  ) {
    onActivated();
  }
}

/** Keeps snapshot CAS, generation ownership, and exact account recovery in one transaction. */
export function createGatewaySecretsReloader(params: GatewaySecretsReloaderParams) {
  const buildReloadPlan = params.buildReloadPlan ?? buildGatewayReloadPlan;
  const manager = params.channelManager;
  const capturePublication = (
    generationOwnership: SharedGatewaySessionGenerationOwnership,
  ): SecretsReloadPublication => {
    const publishedSnapshotRevision = getActiveSecretsRuntimeSnapshotRevisionState();
    const runtimeConfig = getRuntimeConfigSnapshot();
    const pluginMetadata = params.getPluginMetadata();
    if (!runtimeConfig) {
      throw new Error("Secrets runtime activation did not publish config.");
    }
    const isCurrent = () =>
      getActiveSecretsRuntimeSnapshotRevisionState() === publishedSnapshotRevision &&
      getRuntimeConfigSnapshot() === runtimeConfig &&
      isSharedGatewaySessionGenerationOwnershipCurrent(
        params.sharedGatewaySessionGenerationState,
        generationOwnership,
      );
    // This publisher retires captured model config synchronously at the secrets commit edge.
    // Observe rejection immediately: activation may throw before the normal tail can await it.
    const modelPublication = refreshModelRuntimeAfterHotReload({
      config: runtimeConfig,
      agentIds: undefined,
      pluginMetadata,
      isPublicationCurrent: isCurrent,
    });
    void modelPublication.catch(() => undefined);
    return { publishedSnapshotRevision, generationOwnership, modelPublication, isCurrent };
  };
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
        | (SecretsReloadPublication & {
            previousSnapshot: PreparedSecretsRuntimeSnapshot;
            previousRuntimeSourceConfig: OpenClawConfig | undefined;
            previousGeneration: string | undefined;
            previousRequiredGeneration: string | undefined | null;
            prepared: PreparedSecretsRuntimeSnapshot;
            plan: GatewayReloadPlan;
            credentialOwners: DegradedSecretOwner[];
            generationChanged: boolean;
          })
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
          // Credential refresh must not promote catalog defaults into authored transport policy.
          const previousRuntimeSourceConfig = getRuntimeConfigSourceSnapshot() ?? undefined;
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
          const claimGeneration = () => {
            const generationOwnership = claimSharedGatewaySessionGenerationIfOwned(
              params.sharedGatewaySessionGenerationState,
              previousOwnership,
              nextGeneration,
            );
            if (!generationOwnership) {
              throw new Error("Secrets runtime activation did not publish ownership.");
            }
            if (previousGeneration !== nextGeneration) {
              disconnectStaleSharedGatewayAuthClients({
                clients: params.clients,
                expectedGeneration: nextGeneration,
              });
            }
            transaction = {
              ...capturePublication(generationOwnership),
              previousSnapshot,
              previousRuntimeSourceConfig,
              previousGeneration,
              previousRequiredGeneration,
              prepared,
              plan,
              credentialOwners,
              generationChanged: previousGeneration !== nextGeneration,
            };
          };
          const ownsPreviousGeneration = () =>
            isSharedGatewaySessionGenerationOwnershipCurrent(
              params.sharedGatewaySessionGenerationState,
              previousOwnership,
            );
          const activated = await params.activateRuntimeSecrets.activatePreparedSnapshotIfCurrent(
            prepared,
            previousRevision,
            {
              reason: "reload",
              activate: true,
              runtimeSourceConfig: previousRuntimeSourceConfig,
            },
            claimGeneration,
            ownsPreviousGeneration,
          );
          if (!activated) {
            continue;
          }
          if (!transaction) {
            throw new Error("Secrets runtime activation did not publish ownership.");
          }
          if (!transaction.isCurrent()) {
            throw new Error("secrets.reload was superseded by a newer config write");
          }
          break;
        }

        const { prepared, plan, credentialOwners, generationOwnership, isCurrent } = transaction;
        await transaction.modelPublication;
        if (!isCurrent()) {
          throw new Error("secrets.reload was superseded by a newer config write");
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
              if (!isCurrent()) {
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
          !isCurrent() ||
          !finalizeOwnedSharedGatewaySessionGeneration(
            params.sharedGatewaySessionGenerationState,
            generationOwnership,
          )
        ) {
          throw new Error("secrets.reload was superseded by a newer config write");
        }
        return { warningCount: prepared.warnings.length };
      } catch (error) {
        if (transaction) {
          const failedTransaction = transaction;
          let restoration: SecretsReloadPublication | undefined;
          try {
            await restoreSnapshotIfCurrent(
              failedTransaction.previousSnapshot,
              failedTransaction.publishedSnapshotRevision,
              failedTransaction.prepared,
              () => {
                const generationRestored = replaceOwnedSharedGatewaySessionGenerationState(
                  params.sharedGatewaySessionGenerationState,
                  failedTransaction.generationOwnership,
                  {
                    current: failedTransaction.previousGeneration,
                    required: failedTransaction.previousRequiredGeneration,
                  },
                );
                if (generationRestored && failedTransaction.generationChanged) {
                  disconnectStaleSharedGatewayAuthClients({
                    clients: params.clients,
                    expectedGeneration: failedTransaction.previousGeneration,
                  });
                }
                // Restoration can preserve newer credential state; rebuild from what actually won,
                // not the predecessor snapshot. A newer config publication still fences this tail.
                restoration = capturePublication(
                  captureSharedGatewaySessionGenerationOwnership(
                    params.sharedGatewaySessionGenerationState,
                  ),
                );
              },
              failedTransaction.previousRuntimeSourceConfig,
            );
            await restoration?.modelPublication;
          } catch {
            params.logChannels.info("failed to restore model runtime after secrets reload");
          }
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
