import { resolveBindingTarget } from "./copilot-background-shared.js";
import { isDefinitiveGatewayRejection } from "./copilot-gateway.js";
import { buildCopilotChatSendParams, deriveTabSessionKey } from "./panel-core.js";

/** Session/run owner for one tab-bound panel. */
export function createCopilotSessionController({
  chromeApi,
  gateway,
  registry,
  ensureByTab,
  tabRevisions,
  portsByTab,
  portRevisions,
  sendsByTab,
  currentGatewayScope,
  getGatewayRevision,
  getCurrentConfig,
  isConfigTransitioning,
  currentReadyEpoch,
  readyEpochIsCurrent,
  isTabShared,
  attachDebugger,
  revokeDebugger,
  restoreDebuggerIfReleased,
  subscribe,
  unsubscribeTab,
  suspendTab,
  hydrate,
  refreshPanelState,
  drainArchives,
  scheduleAbortRetry,
}) {
  function sessionSetupIsCurrent(tabId, tabRevision, configRevision, gatewayScope) {
    return (
      (tabRevisions.get(tabId) ?? 0) === tabRevision &&
      !isConfigTransitioning() &&
      getGatewayRevision() === configRevision &&
      currentGatewayScope() === gatewayScope
    );
  }

  async function sessionSetupIsAuthorized(tabId, tabRevision, configRevision, gatewayScope) {
    if (
      !sessionSetupIsCurrent(tabId, tabRevision, configRevision, gatewayScope) ||
      !portsByTab.has(tabId)
    ) {
      return false;
    }
    try {
      const shared = await isTabShared(tabId);
      return (
        shared &&
        portsByTab.has(tabId) &&
        sessionSetupIsCurrent(tabId, tabRevision, configRevision, gatewayScope)
      );
    } catch {
      return false;
    }
  }

  async function suspendUnauthorizedSetup(tabId) {
    let shared = false;
    try {
      shared = await isTabShared(tabId);
    } catch {
      // Missing or unreadable tab state is not authorized to retain CDP access.
    }
    await suspendTab(tabId, { detachInactive: !shared });
    if (portsByTab.has(tabId)) {
      void refreshPanelState(tabId);
    }
  }

  async function ensureSessionInner(
    tabId,
    tabRevision,
    configRevision,
    gatewayScope,
    hydrateHistory,
  ) {
    if (!gateway.ready || !(await isTabShared(tabId))) {
      return null;
    }
    const staleActiveSession = registry
      .list()
      .find(
        (entry) =>
          entry.tabId === tabId && entry.gatewayScope !== gatewayScope && entry.activeRunId,
      );
    if (staleActiveSession) {
      throw new Error("This tab is still stopping a run from its previous Gateway.");
    }
    const { targetId } = await attachDebugger(tabId);
    if (!sessionSetupIsCurrent(tabId, tabRevision, configRevision, gatewayScope)) {
      return null;
    }
    if (!(await sessionSetupIsAuthorized(tabId, tabRevision, configRevision, gatewayScope))) {
      await suspendUnauthorizedSetup(tabId);
      return null;
    }
    const binding = {
      kind: "tab",
      tabId,
      target: resolveBindingTarget(getCurrentConfig()),
      profile: "chrome",
      targetId,
    };
    let entry = registry.get(tabId, gatewayScope);
    if (entry) {
      await registry.updateBinding(tabId, gatewayScope, binding);
      entry = registry.get(tabId, gatewayScope);
    } else {
      const mainSessionKey = gateway.hello?.snapshot?.sessionDefaults?.mainSessionKey;
      const sessionKey = deriveTabSessionKey(mainSessionKey, crypto.randomUUID());
      if (!sessionKey) {
        throw new Error("Gateway did not provide a main session key.");
      }
      entry = await registry.put(tabId, {
        gatewayScope,
        sessionKey,
        binding,
        createdAt: Date.now(),
        provisional: true,
        creationPending: false,
      });
    }
    if (entry?.provisional) {
      if (!sessionSetupIsCurrent(tabId, tabRevision, configRevision, gatewayScope)) {
        await registry.closeTab(tabId);
        await drainArchives(gatewayScope);
        return null;
      }
      // Persist the generated key before the RPC. Retrying sessions.create with
      // that key adopts a commit whose response was lost instead of leaking it.
      entry = await registry.markSessionCreationPending(tabId, gatewayScope);
      if (!entry) {
        return null;
      }
      let created;
      try {
        created = await gateway.request("sessions.create", {
          key: entry.sessionKey,
          label: "Browser copilot",
        });
      } catch (error) {
        if (isDefinitiveGatewayRejection(error)) {
          await registry.discardProvisionalSession(tabId, gatewayScope);
        }
        throw error;
      }
      entry = await registry.confirmSession(tabId, gatewayScope, created?.sessionId);
      if (!entry) {
        return null;
      }
      try {
        await chromeApi.tabs.get(tabId);
      } catch {
        await registry.closeTab(tabId);
        await drainArchives(gatewayScope);
        return null;
      }
    }
    if (!sessionSetupIsCurrent(tabId, tabRevision, configRevision, gatewayScope)) {
      await registry.closeTab(tabId);
      await drainArchives(gatewayScope);
      return null;
    }
    if (!(await sessionSetupIsAuthorized(tabId, tabRevision, configRevision, gatewayScope))) {
      await suspendUnauthorizedSetup(tabId);
      return null;
    }
    await subscribe(entry);
    if (!sessionSetupIsCurrent(tabId, tabRevision, configRevision, gatewayScope)) {
      await unsubscribeTab(tabId, gatewayScope);
      await registry.closeTab(tabId);
      await drainArchives(gatewayScope);
      return null;
    }
    if (!(await sessionSetupIsAuthorized(tabId, tabRevision, configRevision, gatewayScope))) {
      await suspendUnauthorizedSetup(tabId);
      return null;
    }
    if (hydrateHistory) {
      await hydrate(tabId, entry);
    }
    if (!sessionSetupIsCurrent(tabId, tabRevision, configRevision, gatewayScope)) {
      await unsubscribeTab(tabId, gatewayScope);
      await registry.closeTab(tabId);
      await drainArchives(gatewayScope);
      return null;
    }
    if (!(await sessionSetupIsAuthorized(tabId, tabRevision, configRevision, gatewayScope))) {
      await suspendUnauthorizedSetup(tabId);
      return null;
    }
    return entry;
  }

  async function ensureSession(tabId, { hydrateHistory = true } = {}) {
    const current = ensureByTab.get(tabId);
    if (current) {
      current.hydrateHistory ||= hydrateHistory;
      return await current.promise;
    }
    const readyEpoch = currentReadyEpoch();
    if (!readyEpoch) {
      return null;
    }
    const gatewayScope = readyEpoch.gatewayScope;
    const tabRevision = tabRevisions.get(tabId) ?? 0;
    const configRevision = readyEpoch.configRevision;
    const request = { hydrateHistory, promise: null };
    const pending = ensureSessionInner(tabId, tabRevision, configRevision, gatewayScope, false)
      .then(async (entry) => {
        if (entry && request.hydrateHistory) {
          await hydrate(tabId, entry);
        }
        return entry;
      })
      .finally(() => {
        if (ensureByTab.get(tabId) === request) {
          ensureByTab.delete(tabId);
        }
      });
    request.promise = pending;
    ensureByTab.set(tabId, request);
    return await pending;
  }

  function panelOwnsSend(tabId, port, portRevision) {
    return portRevisions.get(tabId) === portRevision && portsByTab.get(tabId)?.has(port) === true;
  }

  async function sendMessage(tabId, port, portRevision, text) {
    if (!panelOwnsSend(tabId, port, portRevision)) {
      throw new Error("This panel is no longer attached to the tab.");
    }
    if (sendsByTab.has(tabId)) {
      throw new Error("Wait for the current turn to finish.");
    }
    const readyEpoch = currentReadyEpoch();
    if (!readyEpoch) {
      throw new Error("Gateway is still reconciling this tab.");
    }
    if (!(await isTabShared(tabId))) {
      throw new Error("This tab is not shared with OpenClaw.");
    }
    const entry = await ensureSession(tabId, { hydrateHistory: false });
    if (!entry) {
      throw new Error("This tab no longer exists.");
    }
    if (!readyEpochIsCurrent(readyEpoch) || entry.gatewayScope !== readyEpoch.gatewayScope) {
      throw new Error("Gateway connection changed while preparing this tab.");
    }
    const params = buildCopilotChatSendParams({
      binding: entry.binding,
      message: text,
      sessionId: entry.sessionId,
      sessionKey: entry.sessionKey,
    });
    if (!readyEpochIsCurrent(readyEpoch)) {
      throw new Error("Gateway connection changed while preparing this tab.");
    }
    const started = await registry.startRun(tabId, entry.gatewayScope, params.idempotencyKey);
    if (!started) {
      throw new Error("Wait for the current turn to finish.");
    }
    let submitted = false;
    try {
      const stillShared = await isTabShared(tabId);
      const stillOwnsPanel = panelOwnsSend(tabId, port, portRevision);
      const stillOwnsGateway = readyEpochIsCurrent(readyEpoch);
      if (!stillShared || !stillOwnsPanel || !stillOwnsGateway) {
        if (!stillShared || !stillOwnsPanel) {
          await suspendTab(tabId, { detachInactive: !stillShared });
        }
        throw new Error(
          !stillShared
            ? "This tab is not shared with OpenClaw."
            : !stillOwnsPanel
              ? "This panel is no longer attached to the tab."
              : "Gateway connection changed while preparing this tab.",
        );
      }
      sendsByTab.add(tabId);
      submitted = true;
      return await gateway.request("chat.send", params);
    } catch (error) {
      sendsByTab.delete(tabId);
      if (!submitted || isDefinitiveGatewayRejection(error)) {
        const finished = await registry.finishRun(
          entry.gatewayScope,
          entry.sessionKey,
          params.idempotencyKey,
        );
        if (finished) {
          await restoreDebuggerIfReleased(tabId);
        }
      } else {
        await revokeDebugger(tabId);
        const queued = await registry.queueAbort(tabId, entry.gatewayScope);
        if (queued) {
          scheduleAbortRetry();
        } else {
          await restoreDebuggerIfReleased(tabId);
        }
      }
      await refreshPanelState(tabId);
      throw error;
    }
  }

  return { ensureSession, sendMessage };
}
