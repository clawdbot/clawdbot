import { ACCESS_MODE_ALL, ACCESS_MODE_SELECTED } from "./relay-core.js";
import { effectiveTabUrl, tabEligibility } from "./tab-eligibility.js";

const DENIED_TAB_IDS_KEY = "deniedTabIdsV1";

function isValidTabId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * Owns access mode, durable browser-session pauses, and revocation epochs.
 * Every authority-bearing caller captures an epoch and checks through here.
 */
export function createTabAccessPolicy({ chromeApi = chrome, isSelectedTab }) {
  const deniedTabIds = new Set();
  const tabRevisions = new Map();
  let mode = ACCESS_MODE_SELECTED;
  let enabled = false;
  let transitioning = false;
  // Single-tab mutations fail closed without retiring unrelated attachment epochs.
  const revocationBarriers = new Map();
  let revision = 0;
  let discoveryRevision = 0;
  let initialized = null;
  let storageChain = Promise.resolve();

  const mutateStorage = (task) => {
    const pending = storageChain.then(task, task);
    storageChain = pending.catch(() => undefined);
    return pending;
  };

  const persistedIds = () => [...deniedTabIds].toSorted((left, right) => left - right);

  async function fileAccessAllowed() {
    try {
      return (await chromeApi.extension?.isAllowedFileSchemeAccess?.()) === true;
    } catch {
      return false;
    }
  }

  async function tabIsEligible(tab) {
    return tabEligibility(tab, {
      fileAccessAllowed:
        tab?.url?.startsWith("file:") || tab?.pendingUrl?.startsWith("file:")
          ? await fileAccessAllowed()
          : true,
    }).eligible;
  }

  async function persistDeniedIds() {
    const ids = persistedIds();
    if (ids.length === 0) {
      await chromeApi.storage.session.remove([DENIED_TAB_IDS_KEY]);
      return;
    }
    await chromeApi.storage.session.set({ [DENIED_TAB_IDS_KEY]: ids });
  }

  function invalidateTab(tabId) {
    tabRevisions.set(tabId, (tabRevisions.get(tabId) ?? 0) + 1);
    discoveryRevision += 1;
  }

  function capture(tabId) {
    return { revision, tabRevision: tabRevisions.get(tabId) ?? 0 };
  }

  function tabIsRevoking(tabId) {
    for (const revokedTabId of revocationBarriers.values()) {
      if (revokedTabId === tabId) {
        return true;
      }
    }
    return false;
  }

  function epochIsCurrent(tabId, epoch) {
    return (
      enabled &&
      !transitioning &&
      !tabIsRevoking(tabId) &&
      epoch.revision === revision &&
      epoch.tabRevision === (tabRevisions.get(tabId) ?? 0)
    );
  }

  async function initialize(initialMode = ACCESS_MODE_SELECTED, initialEnabled = false) {
    if (initialized) {
      return await initialized;
    }
    mode = initialMode === ACCESS_MODE_ALL ? ACCESS_MODE_ALL : ACCESS_MODE_SELECTED;
    enabled = initialEnabled;
    initialized = (async () => {
      const [stored, tabs] = await Promise.all([
        chromeApi.storage.session.get([DENIED_TAB_IDS_KEY]),
        chromeApi.tabs.query({}),
      ]);
      const existingIds = new Set();
      for (const tab of tabs) {
        if (isValidTabId(tab.id)) {
          existingIds.add(tab.id);
        }
      }
      const raw = stored[DENIED_TAB_IDS_KEY];
      if (Array.isArray(raw)) {
        for (const tabId of raw) {
          if (isValidTabId(tabId) && existingIds.has(tabId)) {
            deniedTabIds.add(tabId);
          }
        }
      }
      const normalized = persistedIds();
      if (
        !Array.isArray(raw) ||
        raw.length !== normalized.length ||
        raw.some((tabId, index) => tabId !== normalized[index])
      ) {
        await persistDeniedIds();
      }
    })();
    return await initialized;
  }

  function setMode(nextMode) {
    const normalized = nextMode === ACCESS_MODE_ALL ? ACCESS_MODE_ALL : ACCESS_MODE_SELECTED;
    if (normalized !== mode) {
      mode = normalized;
      revision += 1;
      discoveryRevision += 1;
    }
    return mode;
  }

  function setEnabled(nextEnabled) {
    const normalized = nextEnabled === true;
    if (normalized !== enabled) {
      enabled = normalized;
      revision += 1;
      discoveryRevision += 1;
    }
  }

  function beginTransition() {
    if (!transitioning) {
      transitioning = true;
      revision += 1;
      discoveryRevision += 1;
    }
  }

  function endTransition() {
    if (transitioning) {
      transitioning = false;
      revision += 1;
      discoveryRevision += 1;
    }
  }

  function beginRevocation(tabId) {
    const token = Symbol("tab-access-revocation");
    revocationBarriers.set(token, tabId);
    invalidateTab(tabId);
    return token;
  }

  function endRevocation(token) {
    const tabId = revocationBarriers.get(token);
    if (tabId === undefined) {
      return;
    }
    revocationBarriers.delete(token);
    // An epoch captured behind the barrier must not become valid when it opens.
    invalidateTab(tabId);
  }

  async function inspectTab(tabId, epoch = capture(tabId)) {
    if (!isValidTabId(tabId)) {
      return { accessible: false, eligible: false, denied: false, reason: "missing", tab: null };
    }
    if (!enabled || transitioning || tabIsRevoking(tabId)) {
      return { accessible: false, eligible: false, denied: false, reason: "revoked", tab: null };
    }
    if (!epochIsCurrent(tabId, epoch)) {
      return { accessible: false, eligible: false, denied: false, reason: "revoked", tab: null };
    }
    let tab;
    try {
      tab = await chromeApi.tabs.get(tabId);
    } catch {
      return { accessible: false, eligible: false, denied: false, reason: "missing", tab: null };
    }
    if (!epochIsCurrent(tabId, epoch)) {
      return { accessible: false, eligible: false, denied: false, reason: "revoked", tab };
    }
    let allowedFileAccess = true;
    if (tab?.url?.startsWith("file:") || tab?.pendingUrl?.startsWith("file:")) {
      allowedFileAccess = await fileAccessAllowed();
      if (!epochIsCurrent(tabId, epoch)) {
        return { accessible: false, eligible: false, denied: false, reason: "revoked", tab };
      }
    }
    const eligibility = tabEligibility(tab, {
      fileAccessAllowed: allowedFileAccess,
    });
    if (!eligibility.eligible) {
      return { accessible: false, eligible: false, denied: false, reason: eligibility.reason, tab };
    }
    const denied = mode === ACCESS_MODE_ALL && deniedTabIds.has(tabId);
    const selected = mode === ACCESS_MODE_SELECTED ? await isSelectedTab(tab) : true;
    if (!epochIsCurrent(tabId, epoch)) {
      return { accessible: false, eligible: true, denied, reason: "revoked", tab };
    }
    if (mode === ACCESS_MODE_SELECTED && selected) {
      let current;
      try {
        current = await chromeApi.tabs.get(tabId);
      } catch {
        return { accessible: false, eligible: false, denied: false, reason: "missing", tab: null };
      }
      if (!epochIsCurrent(tabId, epoch)) {
        return { accessible: false, eligible: false, denied, reason: "revoked", tab: current };
      }
      const currentEligible = await tabIsEligible(current);
      if (!epochIsCurrent(tabId, epoch)) {
        return { accessible: false, eligible: false, denied, reason: "revoked", tab: current };
      }
      const currentSelected = await isSelectedTab(current);
      if (!epochIsCurrent(tabId, epoch)) {
        return { accessible: false, eligible: false, denied, reason: "revoked", tab: current };
      }
      if (
        current.groupId !== tab.groupId ||
        effectiveTabUrl(current) !== effectiveTabUrl(tab) ||
        current.incognito !== tab.incognito ||
        !currentEligible ||
        !currentSelected
      ) {
        return { accessible: false, eligible: false, denied, reason: "revoked", tab: current };
      }
    }
    if (!epochIsCurrent(tabId, epoch)) {
      return { accessible: false, eligible: true, denied, reason: "revoked", tab };
    }
    return {
      accessible: !denied && selected,
      eligible: true,
      denied,
      reason: denied ? "paused" : selected ? null : "not-selected",
      tab,
    };
  }

  async function requireTab(tabId, epoch = capture(tabId)) {
    const state = await inspectTab(tabId, epoch);
    if (state.accessible) {
      return state.tab;
    }
    if (state.reason === "revoked") {
      throw new Error(`tab ${tabId} access was revoked`);
    }
    if (state.reason === "paused") {
      throw new Error(`tab ${tabId} is paused for OpenClaw`);
    }
    if (state.reason === "not-selected") {
      throw new Error(`tab ${tabId} is not in the OpenClaw tab group`);
    }
    if (state.reason === "incognito") {
      throw new Error(`tab ${tabId} is incognito and unavailable to OpenClaw`);
    }
    throw new Error(`tab ${tabId} is restricted or unavailable to OpenClaw`);
  }

  async function listAccessibleTabs({ allowDuringTransition = false } = {}) {
    await initialize(mode);
    for (;;) {
      const listRevision = discoveryRevision;
      if (!enabled || (transitioning && !allowDuringTransition)) {
        return [];
      }
      const tabs = await chromeApi.tabs.query({});
      const accessible = [];
      for (const tab of tabs) {
        if (tabIsRevoking(tab.id)) {
          continue;
        }
        if (!(await tabIsEligible(tab))) {
          continue;
        }
        if (mode === ACCESS_MODE_ALL) {
          if (!deniedTabIds.has(tab.id)) {
            accessible.push(tab);
          }
        } else if (await isSelectedTab(tab)) {
          accessible.push(tab);
        }
      }
      if (listRevision === discoveryRevision) {
        return accessible;
      }
    }
  }

  async function pause(tabId) {
    // Revoke synchronously: Chrome lookup and session persistence may yield,
    // but newly arriving authority must already fail closed.
    invalidateTab(tabId);
    deniedTabIds.add(tabId);
    let tab;
    try {
      tab = await chromeApi.tabs.get(tabId);
    } catch (error) {
      deniedTabIds.delete(tabId);
      invalidateTab(tabId);
      throw error;
    }
    if (!(await tabIsEligible(tab))) {
      deniedTabIds.delete(tabId);
      invalidateTab(tabId);
      throw new Error(`tab ${tabId} is restricted or unavailable to OpenClaw`);
    }
    await mutateStorage(persistDeniedIds);
  }

  async function allow(tabId) {
    if (!deniedTabIds.has(tabId)) {
      return;
    }
    invalidateTab(tabId);
    await mutateStorage(async () => {
      deniedTabIds.delete(tabId);
      try {
        await persistDeniedIds();
      } catch (error) {
        deniedTabIds.add(tabId);
        throw error;
      }
    });
    invalidateTab(tabId);
  }

  async function forgetTab(tabId) {
    invalidateTab(tabId);
    if (!deniedTabIds.delete(tabId)) {
      return;
    }
    await mutateStorage(persistDeniedIds);
  }

  async function replaceTab(addedTabId, removedTabId) {
    invalidateTab(removedTabId);
    invalidateTab(addedTabId);
    if (!deniedTabIds.delete(removedTabId)) {
      return false;
    }
    deniedTabIds.add(addedTabId);
    try {
      await mutateStorage(persistDeniedIds);
    } catch (error) {
      // Keep both identities denied in memory when persistence fails; widening
      // access is worse than retaining a harmless stale ID until restart.
      deniedTabIds.add(removedTabId);
      throw error;
    }
    return true;
  }

  async function clearDenied() {
    revision += 1;
    discoveryRevision += 1;
    deniedTabIds.clear();
    await mutateStorage(persistDeniedIds);
  }

  return {
    initialize,
    get mode() {
      return mode;
    },
    setMode,
    setEnabled,
    beginTransition,
    endTransition,
    beginRevocation,
    endRevocation,
    capture,
    epochIsCurrent,
    invalidateTab,
    invalidateAll: () => {
      revision += 1;
      discoveryRevision += 1;
    },
    inspectTab,
    requireTab,
    listAccessibleTabs,
    pause,
    allow,
    forgetTab,
    replaceTab,
    clearDenied,
    isDenied: (tabId) => deniedTabIds.has(tabId),
  };
}
