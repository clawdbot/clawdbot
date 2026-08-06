/** Relay/run boundary owner for the tab-bound copilot. */
export function createCopilotRelayCustodyController({
  appendGatewayRevocation,
  broadcastStatus,
  currentGatewayScope,
  drainAborts,
  getGatewayStatus,
  invalidateGatewayEpoch,
  markGatewayAbortError,
  registry,
  revokeActiveBindings,
  runLifecycle,
}) {
  let ready = false;
  let label = "Connecting to browser relay";
  let statusRevision = 0;
  let reconciledStatusRevision = 0;
  let pendingRevocation = Promise.resolve();

  function isOperational() {
    return ready && reconciledStatusRevision === statusRevision;
  }

  function currentPanelStatus() {
    const gatewayStatus = getGatewayStatus();
    return gatewayStatus.state === "ready" && !isOperational()
      ? { state: "connecting", label }
      : gatewayStatus;
  }

  async function onStatus(status) {
    const nextReady = status.ready === true;
    const readinessChanged = ready !== nextReady;
    ready = nextReady;
    label = status.label || "Browser relay reconnecting";
    if (!readinessChanged) {
      broadcastStatus();
      return;
    }
    // Relay availability is part of the run epoch. Reconcile debugger/run
    // custody before a reconnected tool route can admit panel work again.
    invalidateGatewayEpoch();
    const revision = ++statusRevision;
    if (nextReady) {
      broadcastStatus();
      await pendingRevocation;
      await runLifecycle(async () => {
        const gatewayScope = currentGatewayScope();
        if (revision === statusRevision && ready && gatewayScope) {
          await drainAborts(gatewayScope);
        }
      });
      if (revision !== statusRevision || !ready) {
        return;
      }
      reconciledStatusRevision = revision;
      const gatewayScope = currentGatewayScope();
      if (
        gatewayScope &&
        registry.pendingAborts(gatewayScope).length > 0 &&
        getGatewayStatus().state === "ready"
      ) {
        markGatewayAbortError();
        broadcastStatus();
        return;
      }
      broadcastStatus({ ensureSetup: true, hydrateHistory: true });
      return;
    }
    reconciledStatusRevision = 0;
    broadcastStatus();
    const gatewayScope = currentGatewayScope();
    if (!gatewayScope) {
      return;
    }
    const revocation = revokeActiveBindings(gatewayScope);
    appendGatewayRevocation(revocation);
    const cleanup = runLifecycle(async () => {
      await revocation;
      if (gatewayScope === currentGatewayScope() && !ready) {
        await drainAborts(gatewayScope);
      }
    });
    pendingRevocation = cleanup.catch(() => undefined);
    await pendingRevocation;
  }

  return { currentPanelStatus, isOperational, onStatus };
}
