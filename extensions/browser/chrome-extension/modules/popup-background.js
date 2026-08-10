import {
  ACCESS_MODE_ALL,
  ACCESS_MODE_SELECTED,
  nearestGroupColor,
  parsePairingString,
} from "./relay-core.js";
import { isTabSelected } from "./relay-tab-groups.js";

function isValidTabId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function errorResponse(sendResponse, error) {
  sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
}

/** Own pairing/settings/popup messages; authority stays in the injected access policy. */
export function createPopupMessageHandler({
  chromeApi = chrome,
  pairingConfigStore,
  policy,
  accessReady,
  getConfig,
  getRelayState,
  getRelayStatusHint,
  resetRelayState,
  suspendRelayConnections,
  resumeRelayConnections,
  reconcilePairingInvalidation,
  reconcileAccessMode,
  runAccessMutation,
  detachAllDebuggerSessions,
  syncTabsToRelay,
  clearRelayOpeningDeadline,
  closeRelaySocket,
  connectRelay,
  setBadge,
  getCopilot,
  attachingTabs,
  detachDebugger,
  removeTabFromOpenClawGroup,
  addTabToOpenClawGroup,
  scheduleTabsSync,
  pauseTab,
  pageShare,
}) {
  let pairingGeneration = 0;

  const assertPairingCurrent = (generation) => {
    if (generation !== pairingGeneration) {
      throw new Error("Pairing was superseded by a newer request.");
    }
  };

  return (msg, reply) => {
    let settled = false;
    const sendResponse = (response) => {
      if (!settled) {
        settled = true;
        reply(response);
      }
    };
    void (async () => {
      try {
        switch (msg?.type) {
          case "getStatus": {
            await accessReady;
            const { relayUrl, accessMode } = await getConfig();
            await reconcilePairingInvalidation();
            const accessible = await policy.listAccessibleTabs();
            const hint = getRelayStatusHint();
            sendResponse({
              paired: Boolean(relayUrl),
              state: getRelayState(),
              accessMode,
              accessibleTabCount: accessible.length,
              relayUrl: relayUrl ?? "",
              ...(hint ? { hint } : {}),
            });
            return;
          }
          case "pair": {
            const parsed = parsePairingString(msg.pairingString);
            if (!parsed) {
              sendResponse({ ok: false, error: "Invalid pairing string." });
              return;
            }
            const generation = ++pairingGeneration;
            suspendRelayConnections();
            clearRelayOpeningDeadline();
            closeRelaySocket();
            await accessReady;
            assertPairingCurrent(generation);
            await runAccessMutation(async () => {
              assertPairingCurrent(generation);
              // A newer request may have waited behind an older save. Reassert
              // transport custody when this generation reaches the queue head.
              suspendRelayConnections();
              clearRelayOpeningDeadline();
              closeRelaySocket();
              // A replacement pairing must never inherit a later, wider policy.
              // Retire its authenticated socket before storage or mode can yield.
              const accessMode =
                msg.accessMode === ACCESS_MODE_SELECTED ? ACCESS_MODE_SELECTED : ACCESS_MODE_ALL;
              const downgrading =
                policy.mode === ACCESS_MODE_ALL && accessMode === ACCESS_MODE_SELECTED;
              if (downgrading) {
                policy.beginTransition();
              }
              try {
                await pairingConfigStore.save(
                  parsed,
                  nearestGroupColor(msg.groupColor),
                  accessMode,
                );
                assertPairingCurrent(generation);
                await reconcileAccessMode(accessMode, { transitioning: downgrading });
                assertPairingCurrent(generation);
                policy.setEnabled(true);
              } catch (error) {
                if (downgrading) {
                  policy.endTransition();
                }
                throw error;
              }
              resetRelayState();
              await getCopilot().refreshConfig();
              assertPairingCurrent(generation);
              resumeRelayConnections();
              await connectRelay(() => generation === pairingGeneration);
              if (generation !== pairingGeneration) {
                clearRelayOpeningDeadline();
                closeRelaySocket();
                setBadge("off");
                assertPairingCurrent(generation);
              }
            });
            sendResponse({ ok: true });
            return;
          }
          case "unpair": {
            pairingGeneration += 1;
            // Revocation is synchronous. Queued storage and debugger cleanup
            // must not leave the old authority or relay alive in the meantime.
            policy.setEnabled(false);
            policy.invalidateAll();
            suspendRelayConnections();
            resetRelayState();
            clearRelayOpeningDeadline();
            closeRelaySocket();
            setBadge("off");
            await accessReady;
            // Initialization can finish after the synchronous revoke above.
            // Reassert it before waiting on any older queued bookkeeping.
            policy.setEnabled(false);
            policy.invalidateAll();
            clearRelayOpeningDeadline();
            closeRelaySocket();
            setBadge("off");
            await runAccessMutation(async () => {
              // Initialization or an older mutation may have completed while
              // this request was waiting for the queue; keep revocation sticky.
              policy.setEnabled(false);
              const detaching = detachAllDebuggerSessions();
              await syncTabsToRelay();
              await pairingConfigStore.clear();
              await policy.clearDenied();
              await detaching;
              resetRelayState();
              clearRelayOpeningDeadline();
              closeRelaySocket();
              setBadge("off");
              await getCopilot().refreshConfig();
            });
            sendResponse({ ok: true });
            return;
          }
          case "setAccessMode": {
            if (msg.accessMode !== ACCESS_MODE_ALL && msg.accessMode !== ACCESS_MODE_SELECTED) {
              sendResponse({ ok: false, error: "Invalid access mode." });
              return;
            }
            const restricting = msg.accessMode === ACCESS_MODE_SELECTED;
            if (restricting) {
              // A queued widening may not have updated policy.mode yet. Every
              // Selected request revokes before older mutations can hold the queue.
              policy.beginTransition();
            }
            let accessMode;
            try {
              await accessReady;
              accessMode = await runAccessMutation(async () => {
                const storedMode = await pairingConfigStore.setAccessMode(msg.accessMode);
                await reconcileAccessMode(storedMode, { transitioning: restricting });
                return storedMode;
              });
            } catch (error) {
              if (restricting) {
                policy.endTransition();
              }
              throw error;
            }
            sendResponse({ ok: true, accessMode });
            return;
          }
          case "toggleTabAccess": {
            const tabId = msg.tabId;
            if (!isValidTabId(tabId)) {
              sendResponse({ ok: false, error: "No tab." });
              return;
            }
            if (
              (msg.accessMode !== ACCESS_MODE_ALL && msg.accessMode !== ACCESS_MODE_SELECTED) ||
              typeof msg.grant !== "boolean"
            ) {
              sendResponse({ ok: false, error: "Invalid tab access action." });
              return;
            }
            await accessReady;
            if (policy.mode !== msg.accessMode) {
              sendResponse({ ok: false, error: "Browser access mode changed. Refresh and retry." });
              return;
            }
            const revocation = policy.beginRevocation(tabId);
            let restoredAccess = false;
            try {
              await runAccessMutation(async () => {
                if (policy.mode !== msg.accessMode) {
                  throw new Error("Browser access mode changed. Refresh and retry.");
                }
                if (policy.mode === ACCESS_MODE_ALL) {
                  const denied = policy.isDenied(tabId);
                  if (msg.grant && denied) {
                    await policy.allow(tabId);
                    restoredAccess = true;
                  } else if (!msg.grant && !denied) {
                    await pauseTab(tabId);
                  }
                } else {
                  const wasSelected = await isTabSelected(await chromeApi.tabs.get(tabId));
                  if (!msg.grant && wasSelected) {
                    policy.invalidateTab(tabId);
                    await Promise.allSettled([attachingTabs.get(tabId)]);
                    await detachDebugger(tabId);
                    await removeTabFromOpenClawGroup(tabId);
                    scheduleTabsSync();
                    await getCopilot().onConsentChanged(tabId, { revoked: true });
                  } else if (msg.grant && !wasSelected) {
                    policy.invalidateTab(tabId);
                    await addTabToOpenClawGroup(tabId);
                    restoredAccess = true;
                  }
                }
              });
            } finally {
              policy.endRevocation(revocation);
            }
            if (restoredAccess) {
              scheduleTabsSync();
              await syncTabsToRelay();
              await getCopilot().onConsentChanged(tabId, { revoked: false });
            }
            const state = await policy.inspectTab(tabId);
            sendResponse({ ok: true, accessible: state.accessible, denied: state.denied });
            return;
          }
          case "getTabAccess": {
            await accessReady;
            const state = await policy.inspectTab(msg.tabId);
            sendResponse({
              accessMode: policy.mode,
              accessible: state.accessible,
              eligible: state.eligible,
              denied: state.denied,
            });
            return;
          }
          case "sendPageToOpenClaw": {
            if (typeof msg.tabId !== "number") {
              sendResponse({ ok: false, error: "No tab." });
              return;
            }
            await pageShare.sendPage(msg.tabId, msg.note);
            sendResponse({ ok: true });
            return;
          }
          case "prepareCopilotPanel": {
            const options = await getCopilot().preparePanel(msg.tabId);
            sendResponse({ ok: true, ...options });
            return;
          }
          default:
            sendResponse({ ok: false, error: "unknown message" });
        }
      } catch (error) {
        errorResponse(sendResponse, error);
      }
    })();
    return true;
  };
}
