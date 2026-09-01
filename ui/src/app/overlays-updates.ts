import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import type { GatewayUpdateAvailableEventPayload } from "../../../src/gateway/events.js";
import type { UpdateHoldResult } from "../api/types.ts";
import { controlUiBuildDiffersFrom } from "../build-info.ts";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import type { ApplicationGateway } from "./gateway.ts";
import { readGatewayOperatorAccess } from "./operator-access.ts";
import type { ApplicationUpdateOverlaySnapshot } from "./overlays-types.ts";
import {
  classifyUpdateRunResponse,
  createUpdateCampaignStatusPoller,
  createUpdateStatusRefresher,
  createUpdateVerificationController,
  projectUpdateStatusResponse,
  resolveExpectedUpdateSha,
  resolveUnknownUpdateOutcomeBanner,
  resolveUpdateStatusBanner,
  UPDATE_HANDOFF_TIMEOUT_MS,
  type ApplicationStatusBanner,
  type PendingUpdateReconciliation,
  type UpdateRestartStatusResponse,
  type UpdateRunResponse,
} from "./update-overlay-helpers.ts";
import { readUpdateScheduleValue } from "./update-schedule-dto.ts";
import {
  projectConnectedUpdateSnapshot,
  projectUpdateAvailableEvent,
  resolveHeldUpdateCampaignId,
} from "./update-schedule-projection.ts";
import {
  announceRecordedUpdateSuccess,
  announceVerifiedUpdateInstall,
  readUpdateNotice,
  writeUpdateNotice,
} from "./update-success-notice.ts";

export type ApplicationUpdateOverlayHooks = {
  /** Barrier awaited after update-running is published and before update.run
   * is issued, so in-flight config writes cannot overlap the install. */
  drainConfigWrites?: () => Promise<void>;
};

export function createApplicationUpdateOverlays(
  gateway: ApplicationGateway,
  onChange: () => void,
  hooks: ApplicationUpdateOverlayHooks = {},
) {
  let snapshot: ApplicationUpdateOverlaySnapshot = {
    updateAvailable: null,
    updateSchedule: null,
    heldUpdateCampaignId: null,
    updateRunning: false,
    updateStatusRefreshing: false,
    updateCampaignStatusHydrated: true,
    updateReconciliationPending: false,
    updateStatusBanner: null,
    recordedUpdateAttempt: null,
    controlUiRefreshRequired: false,
  };
  let disposed = false;
  let activeClient = gateway.snapshot.client;
  let activeHello = gateway.snapshot.hello;
  let connectedSource: NonNullable<typeof activeClient> | null = null;
  let connectedEpoch = 0;
  let operatorAccess = readGatewayOperatorAccess(gateway.snapshot);
  let updateGatewayScope = gatewayCredentialScope(gateway.connection.gatewayUrl);
  const savedUpdate = readUpdateNotice(updateGatewayScope);
  let pendingUpdate: PendingUpdateReconciliation | null =
    savedUpdate && savedUpdate.kind !== "verified" ? savedUpdate : null;
  let pendingUpdateProfileId = savedUpdate?.profileId ?? null;
  let pendingUpdateTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let updateRequestRunning = false;
  let updateStatusRevision = 0;
  let updateRunGeneration = 0;
  let updateHoldInFlight = false;

  function publish() {
    snapshot = {
      ...snapshot,
      updateRunning:
        updateRequestRunning || snapshot.updateSchedule?.campaign?.state === "applying",
      // The update RPC can finish before its restart handoff. Keep consumers
      // locked until the replacement Gateway reports the authoritative result.
      updateReconciliationPending: pendingUpdate !== null,
    };
    onChange();
  }
  const isCurrentClient = (client: NonNullable<typeof activeClient>) =>
    !disposed &&
    activeClient === client &&
    gateway.snapshot.client === client &&
    gateway.snapshot.phase === "connected";

  const publishUpdateBanner = (updateStatusBanner: ApplicationStatusBanner | null) => {
    snapshot = { ...snapshot, updateStatusBanner };
    publish();
  };
  const publishRecordedUpdateAttempt = (
    recordedUpdateAttempt: ApplicationUpdateOverlaySnapshot["recordedUpdateAttempt"],
  ) => {
    snapshot = { ...snapshot, recordedUpdateAttempt };
    publish();
  };
  const noticeScope = () => ({
    gateway: updateGatewayScope,
    profileId: gateway.snapshot.selfUser?.id ?? null,
  });
  const clearPendingUpdateTimer = () => {
    if (pendingUpdateTimer !== null) {
      globalThis.clearTimeout(pendingUpdateTimer);
      pendingUpdateTimer = null;
    }
  };
  const setPendingUpdate = (pending: PendingUpdateReconciliation | null) => {
    pendingUpdate = pending;
    clearPendingUpdateTimer();
    writeUpdateNotice(
      pending
        ? { ...pending, gateway: updateGatewayScope, profileId: pendingUpdateProfileId }
        : null,
    );
    if (pending) {
      // This budget belongs to admission, not reconnect. A failed-closed
      // Gateway may never return to run the verification loop below.
      pendingUpdateTimer = globalThis.setTimeout(
        () => {
          if (disposed || pendingUpdate !== pending) {
            return;
          }
          updateRunGeneration += 1;
          updateVerification.cancel();
          updateRequestRunning = false;
          setPendingUpdate(null);
          publishUpdateBanner(resolveUnknownUpdateOutcomeBanner());
        },
        Math.max(0, pending.deadlineAtMs - Date.now()),
      );
    }
  };
  const updateVerification = createUpdateVerificationController({
    getPending: () => pendingUpdate,
    clearPending: () => {
      setPendingUpdate(null);
    },
    isCurrent: (client, epoch) => epoch === connectedEpoch && isCurrentClient(client),
    getHello: () => gateway.snapshot.hello,
    publish,
    publishBanner: publishUpdateBanner,
    publishRecordedAttempt: publishRecordedUpdateAttempt,
    publishRecordedFailure: ({ attempt, banner }) => {
      // Both facts terminate the same reconciliation. Publishing either first
      // exposes a false success or a failure without its recorded cause.
      snapshot = { ...snapshot, recordedUpdateAttempt: attempt, updateStatusBanner: banner };
      publish();
    },
    onVerifiedInstall: (identity) => announceVerifiedUpdateInstall(identity, noticeScope()),
  });
  const applyUpdateStatusResponse = (response: UpdateRestartStatusResponse) => {
    // The admitted attempt has its own identity-aware verifier. A page refresh
    // must not race it with an unrelated retained sentinel.
    if (pendingUpdate) {
      return;
    }
    snapshot = {
      ...snapshot,
      ...projectUpdateStatusResponse(response, {
        updateStatusBanner: snapshot.updateStatusBanner,
        recordedUpdateAttempt: snapshot.recordedUpdateAttempt,
        heldUpdateCampaignId: snapshot.heldUpdateCampaignId,
      }),
      updateCampaignStatusHydrated: true,
    };
    publish();
  };
  const refreshUpdateStatus = createUpdateStatusRefresher({
    getClient: () => activeClient,
    getEpoch: () => connectedEpoch,
    getRevision: () => updateStatusRevision,
    canRefresh: () => !disposed && operatorAccess.canAdmin,
    isCurrent: (client, epoch) => epoch === connectedEpoch && isCurrentClient(client),
    onRefreshing: (updateStatusRefreshing) => {
      snapshot = { ...snapshot, updateStatusRefreshing };
      publish();
    },
    onStatus: applyUpdateStatusResponse,
    onError: (error) => {
      publishUpdateBanner({
        tone: "danger",
        text: t("updates.error", { error: formatUiError(error) }),
      });
    },
  });
  const updateCampaignPoller = createUpdateCampaignStatusPoller({
    canPoll: () =>
      Boolean(activeClient && isCurrentClient(activeClient) && snapshot.updateSchedule?.campaign) &&
      operatorAccess.canAdmin,
    refresh: () => refreshUpdateStatus("background"),
  });

  const synchronizeGateway = (next: ApplicationGateway["snapshot"]) => {
    const nextGatewayScope = gatewayCredentialScope(gateway.connection.gatewayUrl);
    if (nextGatewayScope !== updateGatewayScope) {
      updateRunGeneration += 1;
      updateStatusRevision += 1;
      updateVerification.cancel();
      setPendingUpdate(null);
      updateRequestRunning = false;
      updateGatewayScope = nextGatewayScope;
      snapshot = {
        ...snapshot,
        updateStatusBanner: null,
        recordedUpdateAttempt: null,
        heldUpdateCampaignId: null,
      };
    }
    const helloChanged = activeHello !== next.hello;
    const connected = next.phase === "connected";
    const nextConnectedSource = connected ? next.client : null;
    const connectedSourceChanged = connectedSource !== nextConnectedSource;
    const nextOperatorAccess = readGatewayOperatorAccess(next);
    if (operatorAccess.canAdmin && !nextOperatorAccess.canAdmin) {
      updateRunGeneration += 1;
      updateStatusRevision += 1;
      updateVerification.cancel();
      const updateStatusBanner = pendingUpdate ? resolveUnknownUpdateOutcomeBanner() : null;
      setPendingUpdate(null);
      updateRequestRunning = false;
      snapshot = {
        ...snapshot,
        updateStatusRefreshing: false,
        updateStatusBanner,
        recordedUpdateAttempt: null,
      };
    }
    operatorAccess = nextOperatorAccess;
    activeClient = next.client;
    activeHello = next.hello;
    connectedSource = nextConnectedSource;
    if (connectedSourceChanged) {
      updateRunGeneration += 1;
      updateStatusRevision += 1;
      updateVerification.cancel();
    }
    if (!connected || !next.client) {
      updateRequestRunning = false;
      snapshot = {
        ...snapshot,
        updateAvailable: null,
        updateSchedule: null,
        updateStatusRefreshing: false,
        updateCampaignStatusHydrated: true,
      };
      updateCampaignPoller.stop();
      if (next.phase === "reload-required") {
        snapshot = { ...snapshot, controlUiRefreshRequired: true };
      } else if (!next.client) {
        connectedEpoch = 0;
        snapshot = { ...snapshot, controlUiRefreshRequired: false };
      } else if (next.hello) {
        snapshot = { ...snapshot, controlUiRefreshRequired: true };
      }
      publish();
      return;
    }
    if (
      pendingUpdate &&
      (!operatorAccess.canAdmin || pendingUpdateProfileId !== (next.selfUser?.id ?? null))
    ) {
      updateRunGeneration += 1;
      updateStatusRevision += 1;
      updateVerification.cancel();
      setPendingUpdate(null);
      snapshot = { ...snapshot, updateStatusBanner: resolveUnknownUpdateOutcomeBanner() };
    }
    const serverBuildIdentity = {
      version: next.hello?.server?.version,
      buildId: next.hello?.server?.buildId,
      controlUiBuildSource: next.hello?.server?.controlUiBuildSource,
    };
    const exactBuildIdentityAvailable = Boolean(serverBuildIdentity.buildId?.trim());
    snapshot = {
      ...snapshot,
      ...(connectedSourceChanged || helloChanged
        ? projectConnectedUpdateSnapshot(snapshot, next.hello)
        : {}),
      controlUiRefreshRequired: connectedSourceChanged
        ? (exactBuildIdentityAvailable || connectedEpoch > 0) &&
          controlUiBuildDiffersFrom(serverBuildIdentity)
        : snapshot.controlUiRefreshRequired,
    };
    publish();
    updateCampaignPoller.sync();
    if (connectedSourceChanged) {
      connectedEpoch += 1;
      announceRecordedUpdateSuccess(operatorAccess.canAdmin ? noticeScope() : null);
      if (pendingUpdate && operatorAccess.canAdmin) {
        void updateVerification.verify(next.client, connectedEpoch);
      } else if (operatorAccess.canAdmin && !snapshot.updateSchedule?.campaign) {
        // A new bundle has no in-memory campaign history. Hydrate the Gateway's
        // retained result so an automatic update failure survives that reload.
        void refreshUpdateStatus("background");
      }
    }
  };

  // Construction only restores the timer. The outer overlay owner initializes
  // its snapshot before forwarding the first Gateway state that publishes here.
  if (pendingUpdate) {
    setPendingUpdate(pendingUpdate);
  }

  return {
    get snapshot() {
      return snapshot;
    },
    synchronizeGateway,
    handleUpdateAvailable(payload: GatewayUpdateAvailableEventPayload | undefined) {
      if (disposed) {
        return;
      }
      const previousCampaign = snapshot.updateSchedule?.campaign;
      updateStatusRevision += 1;
      snapshot = {
        ...snapshot,
        ...projectUpdateAvailableEvent(snapshot, payload),
      };
      publish();
      updateCampaignPoller.sync();
      if (
        previousCampaign?.state === "applying" &&
        snapshot.updateSchedule?.campaign?.state !== "applying" &&
        activeClient &&
        operatorAccess.canAdmin
      ) {
        // Completion can arrive between polls. The producer records its outcome
        // before removing the campaign, so removal still needs one final read.
        if (pendingUpdate) {
          void updateVerification.verify(activeClient, connectedEpoch);
        } else {
          void refreshUpdateStatus("completion");
        }
      }
    },
    refreshUpdateStatus,
    async runUpdate(this: void) {
      const client = gateway.snapshot.client;
      if (
        !client ||
        gateway.snapshot.phase !== "connected" ||
        disposed ||
        snapshot.updateRunning ||
        pendingUpdate !== null ||
        !readGatewayOperatorAccess(gateway.snapshot).canAdmin
      ) {
        return;
      }
      const generation = ++updateRunGeneration;
      updateStatusRevision += 1;
      updateRequestRunning = true;
      snapshot = {
        ...snapshot,
        updateStatusBanner: null,
        recordedUpdateAttempt: null,
      };
      publish();
      let admittedPending: PendingUpdateReconciliation | null = null;
      try {
        // updateRunning above suspends NEW config writes (bootstrap syncs it
        // into the runtime-config capability); this barrier drains writes
        // already in flight so none can commit or restart mid-install.
        await hooks.drainConfigWrites?.();
        if (
          disposed ||
          generation !== updateRunGeneration ||
          snapshot.updateSchedule?.campaign?.state === "applying" ||
          !readGatewayOperatorAccess(gateway.snapshot).canAdmin
        ) {
          return;
        }
        pendingUpdateProfileId = gateway.snapshot.selfUser?.id ?? null;
        admittedPending = {
          kind: "ambiguous",
          expectedVersion: snapshot.updateAvailable?.latestVersion?.trim() || null,
          expectedSha: resolveExpectedUpdateSha(snapshot.updateSchedule, snapshot.updateAvailable),
          handoffId: null,
          deadlineAtMs: Date.now() + UPDATE_HANDOFF_TIMEOUT_MS,
        };
        setPendingUpdate(admittedPending);
        publish();
        const response = await client.request<UpdateRunResponse>("update.run", {});
        if (
          disposed ||
          generation !== updateRunGeneration ||
          pendingUpdate !== admittedPending ||
          activeClient !== client ||
          gateway.snapshot.client !== client
        ) {
          return;
        }
        const accepted = classifyUpdateRunResponse(response, admittedPending);
        if (accepted) {
          setPendingUpdate(accepted.pending);
          if (accepted.banner) {
            snapshot = { ...snapshot, updateStatusBanner: accepted.banner };
          }
          return;
        }
        setPendingUpdate(null);
        snapshot = {
          ...snapshot,
          updateStatusBanner: resolveUpdateStatusBanner({
            status: response.result?.status ?? "error",
            reason: response.result?.reason,
          }),
        };
      } catch (error) {
        if (
          disposed ||
          generation !== updateRunGeneration ||
          pendingUpdate !== admittedPending ||
          activeClient !== client ||
          gateway.snapshot.client !== client
        ) {
          return;
        }
        setPendingUpdate(null);
        snapshot = {
          ...snapshot,
          updateStatusBanner: {
            tone: "danger",
            text: t("updates.error", {
              error: formatUiError(error),
            }),
          },
        };
      } finally {
        if (
          !disposed &&
          generation === updateRunGeneration &&
          activeClient === client &&
          gateway.snapshot.client === client
        ) {
          updateRequestRunning = false;
          publish();
        }
      }
    },
    async holdUpdate(this: void) {
      const client = gateway.snapshot.client;
      const campaign = snapshot.updateSchedule?.campaign;
      const busy = updateHoldInFlight || snapshot.updateRunning || pendingUpdate !== null;
      if (
        !client ||
        gateway.snapshot.phase !== "connected" ||
        disposed ||
        busy ||
        !campaign ||
        campaign.state === "applying" ||
        snapshot.heldUpdateCampaignId === campaign.id ||
        !readGatewayOperatorAccess(gateway.snapshot).canAdmin
      ) {
        return false;
      }
      const generation = updateRunGeneration;
      const revision = updateStatusRevision;
      const isCurrent = () =>
        generation === updateRunGeneration &&
        isCurrentClient(client) &&
        readGatewayOperatorAccess(gateway.snapshot).canAdmin;
      updateHoldInFlight = true;
      try {
        const response = await client.request<UpdateHoldResult>("update.hold", {});
        if (!isCurrent()) {
          return false;
        }
        const updateSchedule = response.schedule && readUpdateScheduleValue(response.schedule);
        // Campaign events can beat the hold reply; acknowledge the request
        // without replacing the newer schedule they already published.
        if (revision === updateStatusRevision && (updateSchedule !== undefined || response.ok)) {
          updateStatusRevision += 1;
          snapshot = {
            ...snapshot,
            ...(updateSchedule !== undefined ? { updateSchedule } : {}),
            heldUpdateCampaignId: response.ok
              ? campaign.id
              : resolveHeldUpdateCampaignId(
                  updateSchedule ?? snapshot.updateSchedule,
                  snapshot.heldUpdateCampaignId,
                ),
          };
          publish();
        }
        return response.ok;
      } catch (error) {
        if (isCurrent() && revision === updateStatusRevision) {
          const message = formatUiError(error);
          publishUpdateBanner({ tone: "danger", text: t("updates.error", { error: message }) });
        }
        return false;
      } finally {
        updateHoldInFlight = false;
      }
    },
    dispose() {
      disposed = true;
      updateRunGeneration += 1;
      clearPendingUpdateTimer();
      updateVerification.cancel();
      updateCampaignPoller.stop();
    },
  };
}
