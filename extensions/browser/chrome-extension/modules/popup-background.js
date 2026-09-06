import {
  ACCESS_MODE_ALL,
  ACCESS_MODE_SELECTED,
  nearestGroupColor,
  parsePairingString,
} from "./relay-core.js";
import { isTabSelected } from "./relay-tab-groups.js";
import { isValidTabId } from "./tab-eligibility.js";

function errorResponse(sendResponse, error) {
  sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
}

/** Own manual/native pairing transactions and compact popup/options messages. */
export function createPopupMessageHandler({
  chromeApi = chrome,
  pairingConfigStore,
  policy,
  accessReady,
  getConfig,
  getRelayState,
  getRelayStatusHint,
  getNativeBootstrapStatus,
  enableNativeBootstrap,
  onManualPairing,
  onUnpairStart,
  isRetiredCopilotCustodyBlocked,
  requireAutomationAllowed,
  discardRetiredCopilotCustody,
  resetRelayState,
  suspendRelayConnections,
  resumeRelayConnections,
  reconcilePairingInvalidation,
  reconcileAccessMode,
  runAccessMutation,
  detachAllDebuggerSessions,
  syncTabsToRelay,
  closeRelaySocket,
  connectRelay,
  setBadge,
  detachDebugger,
  removeTabFromOpenClawGroup,
  addTabToOpenClawGroup,
  scheduleTabsSync,
  pauseTab,
}) {
  let pairingGeneration = 0;

  const assertPairingCurrent = (generation) => {
    if (generation !== pairingGeneration) {
      throw new Error("Pairing was superseded by a newer request.");
    }
  };

  async function applyPairing({ pairing, pairingString, accessMode, source = "manual" }) {
    await requireAutomationAllowed();
    const parsed = pairing ?? parsePairingString(pairingString);
    if (!parsed) {
      return { ok: false, error: "Invalid pairing string." };
    }
    if (source === "native" && (await getConfig()).relayUrl) {
      return { ok: false, existing: true };
    }
    if (source === "manual") {
      await onManualPairing();
    }
    const generation = ++pairingGeneration;
    suspendRelayConnections();
    closeRelaySocket();
    await accessReady;
    assertPairingCurrent(generation);
    await runAccessMutation(async () => {
      assertPairingCurrent(generation);
      if (source === "native" && (await getConfig()).relayUrl) {
        return;
      }
      suspendRelayConnections();
      closeRelaySocket();
      const normalizedMode =
        accessMode === ACCESS_MODE_SELECTED ? ACCESS_MODE_SELECTED : ACCESS_MODE_ALL;
      const downgrading =
        policy.mode === ACCESS_MODE_ALL && normalizedMode === ACCESS_MODE_SELECTED;
      if (downgrading) {
        policy.beginTransition();
      }
      try {
        await pairingConfigStore.save(parsed, nearestGroupColor(), normalizedMode);
        assertPairingCurrent(generation);
        await reconcileAccessMode(normalizedMode, { transitioning: downgrading });
        assertPairingCurrent(generation);
        policy.setEnabled(true);
      } catch (error) {
        if (downgrading) {
          policy.endTransition();
        }
        throw error;
      }
      resetRelayState();
      assertPairingCurrent(generation);
      resumeRelayConnections();
      await connectRelay(() => generation === pairingGeneration);
      if (generation !== pairingGeneration) {
        closeRelaySocket();
        setBadge("off");
        assertPairingCurrent(generation);
      }
    });
    return { ok: true };
  }

  async function unpair() {
    pairingGeneration += 1;
    const disabledPersisted = onUnpairStart();
    policy.setEnabled(false);
    policy.invalidateAll();
    suspendRelayConnections();
    resetRelayState();
    closeRelaySocket();
    setBadge("off");
    await accessReady;
    policy.setEnabled(false);
    policy.invalidateAll();
    closeRelaySocket();
    setBadge("off");
    await runAccessMutation(async () => {
      policy.setEnabled(false);
      const detaching = detachAllDebuggerSessions();
      await syncTabsToRelay();
      await disabledPersisted;
      await pairingConfigStore.clear();
      await policy.clearDenied();
      await detaching;
      await discardRetiredCopilotCustody();
      resetRelayState();
      closeRelaySocket();
      setBadge("off");
    });
    return { ok: true };
  }

  const handler = (msg, reply) => {
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
            const retiredCopilotCustodyBlocked = isRetiredCopilotCustodyBlocked();
            const nativeBootstrap = await getNativeBootstrapStatus();
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
              nativeBootstrap,
              retiredCopilotCustodyBlocked,
              ...(hint ? { hint } : {}),
            });
            return;
          }
          case "pair":
            sendResponse(
              await applyPairing({
                pairingString: msg.pairingString,
                accessMode: msg.accessMode,
                source: "manual",
              }),
            );
            return;
          case "unpair":
            sendResponse(await unpair());
            return;
          case "setNativeBootstrapEnabled":
            if (typeof msg.enabled !== "boolean") {
              sendResponse({ ok: false, error: "Invalid automatic setup setting." });
              return;
            }
            sendResponse({ ok: true, result: await enableNativeBootstrap(msg.enabled) });
            return;
          case "setAccessMode": {
            if (msg.accessMode !== ACCESS_MODE_ALL && msg.accessMode !== ACCESS_MODE_SELECTED) {
              sendResponse({ ok: false, error: "Invalid access mode." });
              return;
            }
            await requireAutomationAllowed();
            const restricting = msg.accessMode === ACCESS_MODE_SELECTED;
            if (restricting) {
              policy.beginTransition();
            }
            let storedMode;
            try {
              await accessReady;
              storedMode = await runAccessMutation(async () => {
                const mode = await pairingConfigStore.setAccessMode(msg.accessMode);
                await reconcileAccessMode(mode, { transitioning: restricting });
                return mode;
              });
            } catch (error) {
              if (restricting) {
                policy.endTransition();
              }
              throw error;
            }
            sendResponse({ ok: true, accessMode: storedMode });
            return;
          }
          case "toggleTabAccess": {
            const tabId = msg.tabId;
            if (
              !isValidTabId(tabId) ||
              (msg.accessMode !== ACCESS_MODE_ALL && msg.accessMode !== ACCESS_MODE_SELECTED) ||
              typeof msg.grant !== "boolean"
            ) {
              sendResponse({ ok: false, error: "Invalid tab access action." });
              return;
            }
            await accessReady;
            await requireAutomationAllowed();
            if (policy.mode !== msg.accessMode) {
              sendResponse({ ok: false, error: "Browser access mode changed. Refresh and retry." });
              return;
            }
            const revocation = policy.beginRevocation(tabId);
            try {
              await runAccessMutation(async () => {
                if (policy.mode !== msg.accessMode) {
                  throw new Error("Browser access mode changed. Refresh and retry.");
                }
                if (policy.mode === ACCESS_MODE_ALL) {
                  if (msg.grant && policy.isDenied(tabId)) {
                    await policy.allow(tabId);
                  } else if (!msg.grant && !policy.isDenied(tabId)) {
                    await pauseTab(tabId);
                  }
                } else {
                  const selected = await isTabSelected(await chromeApi.tabs.get(tabId));
                  if (!msg.grant && selected) {
                    policy.invalidateTab(tabId);
                    await detachDebugger(tabId);
                    await removeTabFromOpenClawGroup(tabId);
                  } else if (msg.grant && !selected) {
                    policy.invalidateTab(tabId);
                    await addTabToOpenClawGroup(tabId);
                  }
                }
                scheduleTabsSync();
                await syncTabsToRelay();
              });
            } finally {
              policy.endRevocation(revocation);
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
          default:
            sendResponse({ ok: false, error: "unknown message" });
        }
      } catch (error) {
        errorResponse(sendResponse, error);
      }
    })();
    return true;
  };

  handler.applyPairing = applyPairing;
  handler.unpair = unpair;
  return handler;
}
