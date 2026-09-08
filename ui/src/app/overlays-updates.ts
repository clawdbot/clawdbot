import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { GatewayUpdateAvailableEventPayload } from "../../../src/gateway/events.js";
import type { UpdateRunRecord } from "../../../src/infra/update-run-record.js";
import { isReportableUpdateRun } from "../../../src/shared/update-outcome.js";
import { GatewayRequestError } from "../api/gateway.ts";
import type { UpdateHoldResult } from "../api/types.ts";
import { controlUiBuildDiffersFrom } from "../build-info.ts";
import { t } from "../i18n/index.ts";
import { formatUiError } from "../lib/format-error.ts";
import type { ConnectionBootstrapCoordinator } from "./connection-bootstrap.ts";
import type { ApplicationGateway } from "./gateway.ts";
import { readGatewayOperatorAccess } from "./operator-access.ts";
import type { ApplicationUpdateOverlaySnapshot } from "./overlays-types.ts";
import { createUpdateCampaignStatusPoller } from "./update-campaign-status-poller.ts";
import {
  canReportUpdateFailure,
  createUpdateFailureReportController,
} from "./update-failure-report-controller.ts";
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

type UpdateHistory = { kind: "unknown" } | { kind: "known"; runId: string | null };
type UpdateAdmissionAttempt = { history: UpdateHistory; requestSent: boolean };

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
    reportableUpdateFailureId: null,
    updateFailureReportBusy: false,
    updateFailureReportNotice: null,
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
  let updateHistory: UpdateHistory = { kind: "unknown" };
  let updateAttempt: UpdateAdmissionAttempt | null = null;
  let currentFailure: UpdateFailureTriage | null = null;
  let presentedFailure: UpdateFailureTriage | null = null;

  const updateFailureReporter = createUpdateFailureReportController({
    getClient: () => gateway.snapshot.client,
    isCurrent: (attemptId, client) =>
      isCurrentClient(client) &&
      !snapshot.updateRunning &&
      !snapshot.updateReconciliationPending &&
      snapshot.reportableUpdateFailureId === attemptId &&
      canReportUpdateFailure(gateway.snapshot),
    setBusy: (updateFailureReportBusy) => {
      snapshot = { ...snapshot, updateFailureReportBusy };
      publish();
    },
    setResult: (attemptId, result) => {
      snapshot = { ...snapshot, updateFailureReportNotice: { attemptId, result } };
    },
  });

  function invalidateFailureReport() {
    updateFailureReporter.invalidate();
    snapshot = {
      ...snapshot,
      updateFailureReportBusy: false,
      updateFailureReportNotice: null,
    };
  }

  function setCurrentFailure(failure: UpdateFailureTriage | null) {
    if (JSON.stringify(currentFailure) === JSON.stringify(failure)) {
      return;
    }
    currentFailure = failure;
    invalidateFailureReport();
  }

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
      snapshot.updateFailureReportBusy ||
      snapshot.updateFailureReportNotice !== null ||
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
      setCurrentFailure(null);
    }
    snapshot = {
      ...snapshot,
      reportableUpdateFailureId:
        snapshot.updateRunning || snapshot.updateReconciliationPending
          ? null
          : snapshot.updateRun
            ? isReportableUpdateRun(snapshot.updateRun)
              ? snapshot.updateRun.runId
              : null
            : currentFailure?.outcome === "failed" && currentFailure.attempt
              ? currentFailure.id
              : null,
    };
    onChange();
    presentFailureTriage();
  }

  const publishError = (error: unknown, source?: "read") => {
    snapshot = {
      ...snapshot,
      updateStatusBanner: {
        ...(source ? { source } : {}),
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
    // Ledger writes monotonically advance this revision. Keep identical
    // reconnect results, but retire consent when the authoritative row changes.
    if (current?.runId !== run.runId || current.updatedAtMs !== run.updatedAtMs) {
      invalidateFailureReport();
    }
    runId = run.runId;
    updateAttempt = null;
    const failure = projectUpdateRunFailure(run);
    setCurrentFailure(failure);
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
          void refreshUpdateStatus("completion");
        }
      } else {
        // A missing row is an explicit unknown outcome, never inferred success.
        runId = null;
        setCurrentFailure(null);
        snapshot = {
          ...snapshot,
          updateRun: null,
          updateStatusBanner: resolveUnknownUpdateOutcomeBanner(),
        };
        publish();
      }
    } catch (error) {
      if (isCurrent()) {
        publishError(error, "read");
      }
    }
  };

  const applyUpdateStatusResponse = (response: UpdateRestartStatusResponse) => {
    const { failure, updateStatusBanner, recordedUpdateAttempt, ...status } =
      projectUpdateStatusResponse(response, snapshot);
    const run = response.activeRun ?? response.lastRun;
    const history = updateAttempt?.history;
    // A failed history read is not an empty baseline. Until a current identity
    // is observed, a status check cannot certify terminal history as this attempt.
    const previousOutcome =
      history !== undefined &&
      (!run ||
        (history.kind === "known" && run.runId === history.runId) ||
        (history.kind === "unknown" && run.status !== "running" && run.runId !== runId));
    updateHistory = { kind: "known", runId: run?.runId ?? null };
    // Availability may refresh independently. Only the selected outcome owner
    // can replace a run report or its current read error.
    snapshot = { ...snapshot, ...status, updateCampaignStatusHydrated: true };
    if (
      run &&
      !previousOutcome &&
      (!snapshot.updateRun ||
        run.runId === snapshot.updateRun.runId ||
        run.createdAtMs >= snapshot.updateRun.createdAtMs)
    ) {
      applyRun(run);
    } else {
      if (!snapshot.updateRun && !previousOutcome) {
        setCurrentFailure(failure);
        snapshot = { ...snapshot, updateStatusBanner, recordedUpdateAttempt };
      }
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
    onError: (error) => publishError(error, "read"),
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
      updateFailureReporter.invalidate();
      updateRunGeneration++;
      updateReadGeneration++;
      updateStatusRevision++;
      runId = null;
      updateHistory = { kind: "unknown" };
      updateAttempt = null;
      updateRequestRunning = false;
      setCurrentFailure(null);
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
      updateFailureReporter.invalidate();
      snapshot = { ...snapshot, updateFailureReportBusy: false };
      if (
        updateAttempt?.requestSent &&
        !runId &&
        !snapshot.updateRun &&
        !snapshot.updateStatusBanner
      ) {
        snapshot = { ...snapshot, updateStatusBanner: resolveUnknownUpdateOutcomeBanner() };
      }
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
      const history = updateAttempt?.history;
      if (
        !isRecord(payload) ||
        typeof payload.runId !== "string" ||
        (history?.kind === "known" && payload.runId === history.runId) ||
        (!runId && history?.kind === "unknown" && payload.status !== "running") ||
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
      updateFailureReporter.invalidate();
      snapshot = { ...snapshot, updateFailureReportBusy: false };
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
      const attempt: UpdateAdmissionAttempt = {
        history: snapshot.updateRun
          ? { kind: "known", runId: snapshot.updateRun.runId }
          : updateHistory,
        requestSent: false,
      };
      updateAttempt = attempt;
      runId = null;
      updateRequestRunning = true;
      setCurrentFailure(null);
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
          {
            onSent: () => {
              attempt.requestSent = true;
            },
          },
        );
        if (!isCurrent()) {
          return;
        }
        if (response.runId) {
          runId = response.runId;
          await refreshRun();
        } else {
          const result = projectUpdateSentinel(response.sentinel?.payload);
          setCurrentFailure(result?.failure ?? null);
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
          // A correlated rejection is the outcome of this request. Only transport
          // loss after send needs discovery; retained history cannot replace a refusal.
          if (attempt.requestSent && !(error instanceof GatewayRequestError)) {
            await refreshUpdateStatus("completion");
          }
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
    async reportUpdateFailure(this: void, attemptId: string) {
      await updateFailureReporter.report(attemptId);
    },
    dispose() {
      disposed = true;
      updateFailureReporter.invalidate();
      updateRunGeneration++;
      updateReadGeneration++;
      updateCampaignPoller.stop();
    },
  };
}
