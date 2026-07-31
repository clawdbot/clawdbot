import { archiveCopilotSession } from "./copilot-background-shared.js";
import { waitForCopilotGatewayReady } from "./copilot-gateway.js";

/** Gateway cleanup owner. All destructive scope recovery runs through the lifecycle queue. */
export function createCopilotRecoveryController({
  gateway,
  recoveryGatewayFactory,
  registry,
  subscribedKeys,
  sendsByTab,
  currentGatewayScope,
  getGatewayStatus,
  getGatewayStatusRevision,
  getLastReadyStatus,
  isConfigTransitioning,
  setReconciledGatewayStatus,
  restoreDebuggerIfReleased,
  broadcastTab,
  broadcastStatus,
  refreshPanelState,
  runLifecycle,
}) {
  let abortRetryTimer = null;
  let abortRetryDelayMs = 250;
  let staleRecovery = null;
  let staleRecoveryRetryTimer = null;

  async function drainArchives(gatewayScope = currentGatewayScope()) {
    if (!gateway.ready || !gatewayScope) {
      return;
    }
    for (const entry of registry.pendingArchives(gatewayScope)) {
      try {
        await archiveCopilotSession(gateway, entry);
        subscribedKeys.delete(entry.sessionKey);
        await registry.resolveArchive(gatewayScope, entry.sessionKey);
        if (typeof entry.tabId === "number") {
          await restoreDebuggerIfReleased(entry.tabId);
        }
      } catch {
        // The watchdog retries after reconnect or after an active run reaches terminal state.
      }
    }
  }

  async function abortEntry(entry) {
    try {
      await gateway.request("sessions.abort", {
        key: entry.sessionKey,
        runId: entry.activeRunId,
      });
    } catch {
      scheduleAbortRetry(entry.gatewayScope);
      return false;
    }
    sendsByTab.delete(entry.tabId);
    const finished = await registry.finishRun(
      entry.gatewayScope,
      entry.sessionKey,
      entry.activeRunId,
    );
    if (finished) {
      await restoreDebuggerIfReleased(entry.tabId);
      broadcastTab(entry.tabId, { type: "panel.turn-reset" });
      void refreshPanelState(entry.tabId);
    }
    return true;
  }

  async function drainAborts(gatewayScope = currentGatewayScope()) {
    if (!gateway.ready || !gatewayScope) {
      return;
    }
    for (const entry of registry.pendingAborts(gatewayScope)) {
      await abortEntry(entry);
    }
  }

  function clearAbortRetry() {
    if (abortRetryTimer) {
      clearTimeout(abortRetryTimer);
      abortRetryTimer = null;
    }
    abortRetryDelayMs = 250;
  }

  function scheduleAbortRetry(gatewayScope = currentGatewayScope()) {
    const statusRevision = getGatewayStatusRevision();
    if (
      abortRetryTimer ||
      !gateway.ready ||
      !gatewayScope ||
      isConfigTransitioning() ||
      currentGatewayScope() !== gatewayScope
    ) {
      return;
    }
    const delayMs = abortRetryDelayMs;
    abortRetryTimer = setTimeout(() => {
      abortRetryTimer = null;
      void (async () => {
        if (
          currentGatewayScope() !== gatewayScope ||
          getGatewayStatusRevision() !== statusRevision ||
          !gateway.ready
        ) {
          return;
        }
        await drainAborts(gatewayScope);
        if (
          currentGatewayScope() !== gatewayScope ||
          getGatewayStatusRevision() !== statusRevision ||
          !gateway.ready
        ) {
          return;
        }
        if (registry.pendingAborts(gatewayScope).length > 0) {
          abortRetryDelayMs = Math.min(abortRetryDelayMs * 2, 5_000);
          scheduleAbortRetry();
        } else {
          abortRetryDelayMs = 250;
          const readyStatus = getLastReadyStatus();
          if (getGatewayStatus().state === "error" && readyStatus) {
            setReconciledGatewayStatus(readyStatus, statusRevision);
            broadcastStatus({ ensureSetup: true, hydrateHistory: true });
          }
        }
      })();
    }, delayMs);
  }

  async function reconcileGatewayReady(status, statusRevision, gatewayScope, revocation) {
    await revocation;
    if (
      !gatewayScope ||
      statusRevision !== getGatewayStatusRevision() ||
      isConfigTransitioning() ||
      !gateway.ready ||
      currentGatewayScope() !== gatewayScope
    ) {
      return;
    }
    // A connection gap loses terminal events. Abort durable active custody
    // before panels can send again.
    await registry.queueActiveAborts(gatewayScope);
    await drainAborts(gatewayScope);
    await drainArchives(gatewayScope);
    if (
      statusRevision !== getGatewayStatusRevision() ||
      isConfigTransitioning() ||
      !gateway.ready ||
      currentGatewayScope() !== gatewayScope
    ) {
      return;
    }
    const hasPendingAborts = registry.pendingAborts(gatewayScope).length > 0;
    setReconciledGatewayStatus(
      hasPendingAborts ? { state: "error", label: "Could not stop the previous tab run" } : status,
      hasPendingAborts ? 0 : statusRevision,
    );
    broadcastStatus(hasPendingAborts ? undefined : { ensureSetup: true, hydrateHistory: true });
  }

  function scheduleStaleRecovery() {
    if (staleRecoveryRetryTimer) {
      return;
    }
    staleRecoveryRetryTimer = setTimeout(() => {
      staleRecoveryRetryTimer = null;
      void drainStaleScopes();
    }, 5_000);
  }

  function drainStaleScopes() {
    if (staleRecovery) {
      return staleRecovery;
    }
    if (staleRecoveryRetryTimer) {
      clearTimeout(staleRecoveryRetryTimer);
      staleRecoveryRetryTimer = null;
    }
    let retry = false;
    const pending = runLifecycle(async () => {
      const currentScope = currentGatewayScope();
      const staleScopes = registry.gatewayScopes().filter((scope) => scope !== currentScope);
      for (const staleScope of staleScopes) {
        if (await recoverPersistedScope(staleScope)) {
          continue;
        }
        await registry.closeInactiveScope(staleScope);
        retry = true;
      }
      if (gateway.ready && getGatewayStatus().state === "ready") {
        broadcastStatus({ ensureSetup: true, hydrateHistory: true });
      }
    }).catch(() => {
      retry = true;
    });
    staleRecovery = pending;
    void pending.then(() => {
      if (staleRecovery === pending) {
        staleRecovery = null;
      }
      if (retry) {
        scheduleStaleRecovery();
      }
    });
    return pending;
  }

  async function recoverPersistedScope(gatewayScope) {
    const scopedEntries = registry.list().filter((entry) => entry.gatewayScope === gatewayScope);
    const needsGateway =
      registry.pendingArchives(gatewayScope).length > 0 ||
      scopedEntries.some(
        (entry) => !entry.provisional || entry.creationPending || entry.activeRunId,
      );
    if (!needsGateway) {
      await registry.closeScope(gatewayScope);
      return true;
    }
    const recoveryGateway = recoveryGatewayFactory();
    try {
      await waitForCopilotGatewayReady(recoveryGateway, gatewayScope);
      await registry.queueActiveAborts(gatewayScope);
      for (const entry of registry.pendingAborts(gatewayScope)) {
        await recoveryGateway.request("sessions.abort", {
          key: entry.sessionKey,
          runId: entry.activeRunId,
        });
        const finished = await registry.finishRun(
          entry.gatewayScope,
          entry.sessionKey,
          entry.activeRunId,
        );
        if (finished) {
          await restoreDebuggerIfReleased(entry.tabId);
        }
      }
      await registry.closeScope(gatewayScope);
      for (const entry of registry.pendingArchives(gatewayScope)) {
        await archiveCopilotSession(recoveryGateway, entry);
        await registry.resolveArchive(gatewayScope, entry.sessionKey);
        if (typeof entry.tabId === "number") {
          await restoreDebuggerIfReleased(entry.tabId);
        }
      }
      return (
        registry.pendingAborts(gatewayScope).length === 0 &&
        registry.pendingArchives(gatewayScope).length === 0
      );
    } catch {
      return false;
    } finally {
      recoveryGateway.stop();
    }
  }

  return {
    abortEntry,
    clearAbortRetry,
    drainAborts,
    drainArchives,
    drainStaleScopes,
    reconcileGatewayReady,
    scheduleAbortRetry,
    scheduleStaleRecovery,
  };
}
