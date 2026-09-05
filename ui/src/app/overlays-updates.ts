import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayUpdateAvailableEventPayload } from "../../../src/gateway/events.js";
import type { UpdateRunRecord } from "../../../src/infra/update-run-record.js";
import type { UpdateHoldResult } from "../api/types.ts";
import { controlUiBuildDiffersFrom } from "../build-info.ts";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import type { ConnectionBootstrapCoordinator } from "./connection-bootstrap.ts";
import type { ApplicationGateway } from "./gateway.ts";
import { readGatewayOperatorAccess } from "./operator-access.ts";
import type { ApplicationUpdateOverlaySnapshot } from "./overlays-types.ts";
import {
  createUpdateStatusRefresher,
  projectUpdateSentinel,
  projectUpdateStatusResponse,
  projectUpdateRunFailure,
  resolveUnknownUpdateOutcomeBanner,
  resolveUpdateStatusBanner,
  type UpdateRestartStatusResponse,
  type UpdateRunResponse,
  type UpdateFailureTriage,
  type UpdateTriageAdmission,
} from "./update-overlay-helpers.ts";
import { createUpdateRunReceipts } from "./update-run-receipts.ts";
import { readUpdateScheduleValue } from "./update-schedule-dto.ts";
import {
  projectConnectedUpdateSnapshot,
  projectUpdateAvailableEvent,
  resolveHeldUpdateCampaignId,
} from "./update-schedule-projection.ts";

export type ApplicationUpdateOverlayHooks = {
  connectionBootstrap?: ConnectionBootstrapCoordinator;
  getActiveSessionKey?: () => string | undefined;
  /** Barrier awaited after update-running is published and before update.run
   * is issued, so in-flight config writes cannot overlap the install. */
  drainConfigWrites?: () => Promise<void>;
  onUpdateFailure?: (failure: UpdateFailureTriage, admission: UpdateTriageAdmission) => void;
};

function createUpdateCampaignStatusPoller(params: {
  canPoll: () => boolean;
  refresh: () => Promise<void>;
}) {
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let generation = 0;
  const stop = () => {
    generation += 1;
    if (timer !== null) {
      globalThis.clearTimeout(timer);
      timer = null;
    }
  };
  const poll = async () => {
    timer = null;
    const currentGeneration = generation;
    if (params.canPoll()) {
      await params.refresh();
    }
    if (currentGeneration === generation) {
      sync();
    }
  };
  const sync = () => {
    if (!params.canPoll()) {
      stop();
      return;
    }
    if (timer === null) {
      timer = globalThis.setTimeout(() => void poll(), 5_000);
    }
  };
  return { stop, sync };
}

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
    updateRun: null,
    updateRunAcknowledged: false,
    controlUiRefreshRequired: false,
  };
  let disposed = false;
  let activeClient = gateway.snapshot.client;
  let activeHello = gateway.snapshot.hello;
  let connectedSource: NonNullable<typeof activeClient> | null = null;
  let connectedEpoch = 0;
  let operatorAccess = readGatewayOperatorAccess(gateway.snapshot);
  let updateGatewayScope = gatewayCredentialScope(gateway.connection.gatewayUrl);
  let profileId = gateway.snapshot.selfUser?.id ?? null;
  const receipts = createUpdateRunReceipts();
  let updateRequestRunning = false;
  let updateStatusRevision = 0;
  let updateRunGeneration = 0;
  let updateReadGeneration = 0;
  let updateHoldInFlight = false;
  let runId: string | null = null;
  let currentFailure: UpdateFailureTriage | null = null;
  let presentedFailure: UpdateFailureTriage | null = null;

  const isCurrentClient = (client: NonNullable<typeof activeClient>) =>
    !disposed &&
    activeClient === client &&
    gateway.snapshot.client === client &&
    gateway.snapshot.phase === "connected" &&
    readGatewayOperatorAccess(gateway.snapshot).canAdmin;

  function presentFailureTriage() {
    const owned = currentFailure;
    const scope = updateGatewayScope;
    const profile = profileId;
    if (
      !owned ||
      owned === presentedFailure ||
      snapshot.updateRunning ||
      snapshot.updateReconciliationPending
    ) {
      return;
    }
    const isCurrent = () =>
      !disposed &&
      currentFailure === owned &&
      gatewayCredentialScope(gateway.connection.gatewayUrl) === scope &&
      (gateway.snapshot.selfUser?.id ?? null) === profile &&
      readGatewayOperatorAccess(gateway.snapshot).canAdmin;
    if (!isCurrent() || receipts.triaged(scope, profile, owned.id)) {
      return;
    }
    presentedFailure = owned;
    hooks.onUpdateFailure?.(owned, {
      isCurrent,
      admit: () =>
        isCurrent() &&
        gateway.snapshot.phase === "connected" &&
        !snapshot.updateRunning &&
        !snapshot.updateReconciliationPending &&
        !receipts.triaged(scope, profile, owned.id) &&
        receipts.recordTriage(scope, profile, owned.id),
    });
  }

  function publish() {
    const campaign = snapshot.updateSchedule?.campaign;
    const applying =
      campaign?.state === "applying" && snapshot.updateRun?.origin.campaignId !== campaign.id;
    snapshot = {
      ...snapshot,
      updateRunning: updateRequestRunning || snapshot.updateRun?.status === "running" || applying,
      updateReconciliationPending:
        runId !== null && (!snapshot.updateRun || snapshot.updateRun.status === "running"),
    };
    if (applying) {
      currentFailure = null;
    }
    onChange();
    presentFailureTriage();
  }

  const publishError = (error: unknown) => {
    snapshot = {
      ...snapshot,
      updateStatusBanner: {
        tone: "danger",
        text: t("updates.error", { error: formatUiError(error) }),
      },
    };
    publish();
  };

  const applyRun = (run: UpdateRunRecord) => {
    const current = snapshot.updateRun;
    if (current?.runId === run.runId && current.updatedAtMs > run.updatedAtMs) {
      return;
    }
    runId = run.runId;
    const failure = projectUpdateRunFailure(run);
    if (
      currentFailure?.id !== failure?.id ||
      JSON.stringify(currentFailure) !== JSON.stringify(failure)
    ) {
      currentFailure = failure;
    }
    snapshot = {
      ...snapshot,
      updateRun: run,
      updateRunAcknowledged: receipts.acknowledged(updateGatewayScope, profileId, run.runId),
      recordedUpdateAttempt: failure?.attempt ?? null,
      updateStatusBanner: failure?.banner ?? null,
    };
    publish();
  };

  const refreshRun = async () => {
    const client = activeClient;
    const id = runId;
    if (!client || !id || !isCurrentClient(client)) {
      return;
    }
    const generation = ++updateReadGeneration;
    const epoch = connectedEpoch;
    const isCurrent = () =>
      generation === updateReadGeneration &&
      epoch === connectedEpoch &&
      id === runId &&
      isCurrentClient(client);
    try {
      const response = await client.request<{ run: UpdateRunRecord | null }>("update.runs.get", {
        runId: id,
      });
      if (!isCurrent()) {
        return;
      }
      if (response.run) {
        applyRun(response.run);
        if (response.run.status !== "running") {
          // Refresh the install owner's availability after completion so closing
          // the report cannot re-offer the just-installed target.
          void refreshUpdateStatus();
        }
      } else {
        // A missing row is an explicit unknown outcome, never inferred success.
        runId = null;
        snapshot = {
          ...snapshot,
          updateRun: null,
          updateStatusBanner: resolveUnknownUpdateOutcomeBanner(),
        };
        publish();
      }
    } catch (error) {
      if (isCurrent()) {
        publishError(error);
      }
    }
  };

  const applyUpdateStatusResponse = (response: UpdateRestartStatusResponse) => {
    const { failure, ...status } = projectUpdateStatusResponse(response, snapshot);
    snapshot = { ...snapshot, ...status, updateCampaignStatusHydrated: true };
    const run = response.activeRun ?? response.lastRun;
    if (
      run &&
      (!snapshot.updateRun ||
        run.runId === snapshot.updateRun.runId ||
        run.createdAtMs >= snapshot.updateRun.createdAtMs)
    ) {
      applyRun(run);
    } else if (!snapshot.updateRun) {
      currentFailure = failure;
      publish();
    } else {
      // Schedule refreshes must not replace a run report with a retained sentinel.
      const runFailure = projectUpdateRunFailure(snapshot.updateRun);
      snapshot = {
        ...snapshot,
        updateStatusBanner: runFailure?.banner ?? null,
        recordedUpdateAttempt: runFailure?.attempt ?? null,
      };
      publish();
    }
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
    onError: publishError,
  });
  const updateCampaignPoller = createUpdateCampaignStatusPoller({
    canPoll: () =>
      Boolean(activeClient && isCurrentClient(activeClient) && snapshot.updateSchedule?.campaign),
    refresh: () => refreshUpdateStatus("background"),
  });
  const runConnectionBootstrap = (key: string, task: () => Promise<unknown>) =>
    hooks.connectionBootstrap?.run(key, task) ?? task();

  const synchronizeGateway = (next: ApplicationGateway["snapshot"]) => {
    const nextScope = gatewayCredentialScope(gateway.connection.gatewayUrl);
    const nextProfile = next.selfUser?.id ?? null;
    const nextAccess = readGatewayOperatorAccess(next);
    const accessGranted = !operatorAccess.canAdmin && nextAccess.canAdmin;
    const connected = next.phase === "connected";
    // Disconnects can omit identity. An explicit new auth grant is authoritative
    // even when build-skew fencing delays connection admission.
    const scopeChanged =
      nextScope !== updateGatewayScope ||
      (connected && nextProfile !== profileId) ||
      (Boolean(next.hello?.auth) && !nextAccess.canAdmin);
    if (scopeChanged) {
      updateRunGeneration++;
      updateReadGeneration++;
      updateStatusRevision++;
      runId = null;
      updateRequestRunning = false;
      currentFailure = null;
      snapshot = {
        ...snapshot,
        updateRun: null,
        updateRunAcknowledged: false,
        updateStatusRefreshing: false,
        updateStatusBanner: null,
        recordedUpdateAttempt: null,
        heldUpdateCampaignId: null,
      };
    }
    updateGatewayScope = nextScope;
    if (connected) {
      profileId = nextProfile;
    }
    const nextConnectedSource = connected ? next.client : null;
    const connectedSourceChanged = connectedSource !== nextConnectedSource;
    const helloChanged = activeHello !== next.hello;
    operatorAccess = nextAccess;
    activeClient = next.client;
    activeHello = next.hello;
    connectedSource = nextConnectedSource;
    if (connectedSourceChanged) {
      connectedEpoch++;
      updateReadGeneration++;
      updateStatusRevision++;
      updateRunGeneration++;
      updateRequestRunning = false;
    }
    if (!connected || !next.client) {
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
    const serverBuildIdentity = {
      version: next.hello?.server?.version,
      buildId: next.hello?.server?.buildId,
      controlUiBuildSource: next.hello?.server?.controlUiBuildSource,
    };
    snapshot = {
      ...snapshot,
      ...(connectedSourceChanged || helloChanged
        ? projectConnectedUpdateSnapshot(snapshot, next.hello)
        : {}),
      controlUiRefreshRequired: connectedSourceChanged
        ? (Boolean(serverBuildIdentity.buildId?.trim()) || connectedEpoch > 1) &&
          controlUiBuildDiffersFrom(serverBuildIdentity)
        : snapshot.controlUiRefreshRequired,
    };
    publish();
    updateCampaignPoller.sync();
    if ((connectedSourceChanged || scopeChanged || accessGranted) && operatorAccess.canAdmin) {
      void runConnectionBootstrap("update-run", () =>
        runId ? refreshRun() : refreshUpdateStatus("background"),
      );
    }
  };

  return {
    get snapshot() {
      return snapshot;
    },
    synchronizeGateway,
    handleUpdateRunChanged(payload: unknown) {
      if (
        !isRecord(payload) ||
        typeof payload.runId !== "string" ||
        typeof payload.updatedAtMs !== "number" ||
        !activeClient ||
        !isCurrentClient(activeClient)
      ) {
        return;
      }
      const current = snapshot.updateRun;
      if (current?.runId === payload.runId && payload.updatedAtMs <= current.updatedAtMs) {
        return;
      }
      // The event is an invalidation, not the run itself. Privileged facts are
      // fetched under the current authenticated connection and ordered by row revision.
      updateStatusRevision++;
      if (runId && runId !== payload.runId) {
        void refreshUpdateStatus("completion");
      } else {
        runId = payload.runId;
        void refreshRun();
      }
    },
    handleUpdateAvailable(payload: GatewayUpdateAvailableEventPayload | undefined) {
      if (disposed) {
        return;
      }
      const previousCampaign = snapshot.updateSchedule?.campaign;
      updateStatusRevision++;
      snapshot = { ...snapshot, ...projectUpdateAvailableEvent(snapshot, payload) };
      publish();
      updateCampaignPoller.sync();
      if (
        previousCampaign?.state === "applying" &&
        snapshot.updateSchedule?.campaign?.state !== "applying"
      ) {
        void refreshUpdateStatus("completion");
      }
    },
    refreshUpdateStatus,
    acknowledgeUpdateRun(this: void) {
      const run = snapshot.updateRun;
      if (run && run.status !== "running") {
        receipts.acknowledge(updateGatewayScope, profileId, run.runId);
        snapshot = { ...snapshot, updateRunAcknowledged: true };
        publish();
      }
    },
    async runUpdate(this: void, options?: { sessionKey?: string }) {
      const client = activeClient;
      if (
        !client ||
        !isCurrentClient(client) ||
        snapshot.updateRunning ||
        snapshot.updateReconciliationPending
      ) {
        return;
      }
      const generation = ++updateRunGeneration;
      const sessionKey = options?.sessionKey ?? hooks.getActiveSessionKey?.();
      updateStatusRevision++;
      updateReadGeneration++;
      runId = null;
      updateRequestRunning = true;
      currentFailure = null;
      snapshot = {
        ...snapshot,
        updateRun: null,
        updateRunAcknowledged: false,
        updateStatusBanner: null,
        recordedUpdateAttempt: null,
      };
      publish();
      const isCurrent = () => generation === updateRunGeneration && isCurrentClient(client);
      try {
        // The published interlock suspends new config writes; drain existing writes before admission.
        await hooks.drainConfigWrites?.();
        if (!isCurrent() || snapshot.updateSchedule?.campaign?.state === "applying") {
          return;
        }
        const response = await client.request<UpdateRunResponse>(
          "update.run",
          sessionKey ? { sessionKey } : {},
        );
        if (!isCurrent()) {
          return;
        }
        if (response.runId) {
          runId = response.runId;
          await refreshRun();
        } else {
          const result = projectUpdateSentinel(response.sentinel?.payload);
          currentFailure = result?.failure ?? null;
          snapshot = {
            ...snapshot,
            recordedUpdateAttempt: result?.attempt ?? null,
            updateStatusBanner:
              result?.banner ??
              resolveUpdateStatusBanner({
                status: response.result?.status ?? "error",
                reason: response.result?.reason,
              }),
          };
        }
      } catch (error) {
        if (isCurrent()) {
          publishError(error);
          // Admission may have succeeded before the response was lost. Discover
          // its durable identity now, or in the next connection's bootstrap.
          await refreshUpdateStatus("completion");
        }
      } finally {
        if (isCurrent()) {
          updateRequestRunning = false;
          publish();
        }
      }
    },
    async holdUpdate(this: void) {
      const client = gateway.snapshot.client;
      const campaign = snapshot.updateSchedule?.campaign;
      const busy =
        updateHoldInFlight || snapshot.updateRunning || snapshot.updateReconciliationPending;
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
          publishError(message);
        }
        return false;
      } finally {
        updateHoldInFlight = false;
      }
    },
    dispose() {
      disposed = true;
      updateRunGeneration++;
      updateReadGeneration++;
      updateCampaignPoller.stop();
    },
  };
}
