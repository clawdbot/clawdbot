import { ACCESS_MODE_ALL, ACCESS_MODE_SELECTED, OPENCLAW_TAB_GROUP_TITLE } from "./relay-core.js";
import { effectiveTabUrl, tabEligibility } from "./tab-eligibility.js";

const DENIED_TAB_IDS_KEY = "deniedTabIdsV1";
// CDP navigation receipts and session configuration survive an allowed document
// change. Page data, execution contexts, and actions still require that document.
// These are exact protocol methods, never a caller-supplied access override.
const TAB_SCOPED_COMMANDS = new Set([
  "Page.navigate",
  "Page.reload",
  "Page.navigateToHistoryEntry",
  "Page.enable",
  "Page.setLifecycleEventsEnabled",
  "Network.enable",
  "Network.setAttachDebugStack",
  "Runtime.enable",
  "Runtime.runIfWaitingForDebugger",
  "Target.setAutoAttach",
  "Debugger.enable",
  "Debugger.setSkipAllPauses",
  "Debugger.setPauseOnExceptions",
  "Debugger.setAsyncCallStackDepth",
  "Debugger.setBlackboxPatterns",
  "Log.enable",
  "Log.startViolationsReport",
  "DOM.enable",
  "CSS.enable",
  "Audits.enable",
  "Performance.enable",
  "Profiler.enable",
  "WebMCP.enable",
  "Emulation.setFocusEmulationEnabled",
]);

function isValidTabId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function initialBlankDocument(tab) {
  return tab.url === "about:blank" || (!tab.url && tab.pendingUrl === "about:blank");
}

/**
 * Owns access mode, durable browser-session pauses, and revocation epochs.
 * Every authority-bearing caller captures an epoch and checks through here.
 */
export function createTabAccessPolicy({ chromeApi = chrome, isSelectedTab, getGroupColor }) {
  const deniedTabIds = new Set();
  // Only createTab below mints these records. Group membership and Tab snapshots
  // cannot recreate initial-document ownership after navigation or worker restart.
  const createdTabs = new Map();
  const tabRevisions = new Map();
  const provenEpochs = new WeakMap();
  let fileAccessGranted = false;
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

  function eligibilityForTab(tab) {
    const created = createdTabs.get(tab?.id);
    if (created && tab.url && tab.url !== "about:blank") {
      if (created.initialBlank && !created.handedOff) {
        invalidateTab(tab.id);
      }
      created.initialBlank = false;
      if (created.handedOff) {
        createdTabs.delete(tab.id);
        if (!created.isCurrent()) {
          invalidateTab(tab.id);
        }
      }
    }
    const options = { fileAccessAllowed: fileAccessGranted };
    const eligibility = tabEligibility(tab, options);
    if (
      eligibility.reason !== "restricted" ||
      !created?.initialBlank ||
      !created.isCurrent() ||
      !initialBlankDocument(tab)
    ) {
      return eligibility;
    }
    // A pending ordinary destination does not replace the initial document yet.
    // Check it independently; restricted pending URLs never inherit admission.
    return tab.pendingUrl && tab.pendingUrl !== "about:blank"
      ? tabEligibility({ ...tab, url: tab.pendingUrl }, options)
      : { eligible: true, reason: null };
  }

  function tabIsEligible(tab) {
    return eligibilityForTab(tab).eligible;
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
    const next = ++discoveryRevision;
    tabRevisions.set(tabId, { access: next, document: next });
  }

  function retireTab(tabId) {
    createdTabs.delete(tabId);
    invalidateTab(tabId);
  }

  function capture(tabId, method) {
    const current = tabRevisions.get(tabId);
    return {
      revision,
      tabRevision: current?.access ?? 0,
      ...(!TAB_SCOPED_COMMANDS.has(method) ? { documentRevision: current?.document ?? 0 } : {}),
    };
  }

  function tabIsRevoking(tabId) {
    for (const revokedTabId of revocationBarriers.values()) {
      if (revokedTabId === tabId) {
        return true;
      }
    }
    return false;
  }

  function epochMatches(tabId, epoch) {
    return (
      enabled &&
      !transitioning &&
      !tabIsRevoking(tabId) &&
      epoch.revision === revision &&
      epoch.tabRevision === (tabRevisions.get(tabId)?.access ?? 0) &&
      (epoch.documentRevision === undefined ||
        epoch.documentRevision === (tabRevisions.get(tabId)?.document ?? 0))
    );
  }

  function epochIsCurrent(tabId, epoch) {
    const created = createdTabs.get(tabId);
    return (
      epochMatches(tabId, epoch) &&
      (!created ||
        (created.isCurrent() && (created.handedOff || epochMatches(tabId, created.epoch))))
    );
  }

  function invalidateAll(group) {
    const naming = [...createdTabs.values()].filter(
      (created) =>
        !created.handedOff &&
        created.namingGroup === group?.id &&
        group?.title === OPENCLAW_TAB_GROUP_TITLE &&
        epochIsCurrent(created.tab.id, created.epoch),
    );
    revision += 1;
    discoveryRevision += 1;
    // Renew only the exact expected naming event of a still-current creation.
    // An earlier pause/mode/group revocation cannot be recaptured here.
    for (const created of naming) {
      // Only this private creation epoch is shared with its pending attachment.
      // Updating it also covers a naming event delivered after the API callback.
      created.epoch.revision = revision;
      created.namingGroup = undefined;
    }
  }

  function observeTabUpdate(tabId, change, tab) {
    const accessChanged =
      typeof change.url === "string" ||
      change.status === "loading" ||
      (mode === ACCESS_MODE_SELECTED && typeof change.groupId === "number") ||
      (typeof tab?.pendingUrl === "string" && !tabIsEligible(tab));
    const created = createdTabs.get(tabId);
    if (!created) {
      if (mode === ACCESS_MODE_SELECTED && typeof change.groupId === "number") {
        invalidateTab(tabId);
      }
      return accessChanged;
    }
    if (typeof change.url === "string") {
      if (created.initialBlank && change.url === "about:blank" && tabIsEligible(tab)) {
        // The pending initial blank can commit after handoff. This is still the
        // creator's document; settling it must not cancel client initialization.
        created.tab = { ...created.tab, url: tab.url, pendingUrl: tab.pendingUrl };
        return false;
      }
      eligibilityForTab(tab);
    }
    if (!created.handedOff && typeof change.groupId === "number") {
      if (
        created.grouping &&
        change.groupId >= 0 &&
        (created.expectedGroupId === undefined || created.expectedGroupId === change.groupId) &&
        epochIsCurrent(tabId, created.epoch) &&
        tab?.id === tabId
      ) {
        created.groupId = change.groupId;
        created.expectedGroupId = change.groupId;
        created.grouping = false;
        return false;
      }
      invalidateTab(tabId);
    }
    return accessChanged;
  }

  async function addTabToGroup(tabId, created) {
    const assertCurrent = () => created?.assertCurrent();
    const tab = await chromeApi.tabs.get(tabId);
    assertCurrent();
    if (created && (tab.groupId !== created.groupId || tab.windowId !== created.tab.windowId)) {
      throw new Error(`tab ${tabId} changed during creation`);
    }
    const groups = await chromeApi.tabGroups
      .query({ title: OPENCLAW_TAB_GROUP_TITLE })
      .catch(() => []);
    assertCurrent();
    const group = groups.find((candidate) => candidate.windowId === tab.windowId);
    const color = group ? undefined : await getGroupColor();
    assertCurrent();
    if (created) {
      created.grouping = true;
      created.expectedGroupId = group?.id;
    }
    const groupId = await chromeApi.tabs.group({
      tabIds: [tabId],
      ...(group ? { groupId: group.id } : {}),
    });
    assertCurrent();
    if (created) {
      if (created.expectedGroupId !== undefined && created.expectedGroupId !== groupId) {
        throw new Error(`tab ${tabId} group changed during creation`);
      }
      created.groupId = groupId;
      created.expectedGroupId = groupId;
    }
    if (!group) {
      if (created) {
        created.namingGroup = groupId;
      }
      await chromeApi.tabGroups.update(groupId, { title: OPENCLAW_TAB_GROUP_TITLE, color });
      assertCurrent();
    }
  }

  async function createTab(message, { isCurrent, attachDebugger, handoff }) {
    const operationRevision = revision;
    const started = discoveryRevision;
    if (!enabled || transitioning || !isCurrent()) {
      throw new Error("tab creation access was revoked");
    }
    const tab = await chromeApi.tabs.create({
      url: message.url,
      active: message.background !== true,
    });
    const created = {
      tab,
      // Creation owns a tab, not its first HTTP document (which may redirect).
      epoch: { revision: operationRevision, tabRevision: tabRevisions.get(tab.id)?.access ?? 0 },
      isCurrent,
      initialBlank: message.url === "about:blank" && initialBlankDocument(tab),
      handedOff: false,
      groupId: tab.groupId,
      grouping: false,
      expectedGroupId: undefined,
      namingGroup: undefined,
      assertCurrent: () => {
        if (createdTabs.get(tab.id) !== created || !epochIsCurrent(tab.id, created.epoch)) {
          throw new Error(`tab ${tab.id} creation access was revoked`);
        }
      },
    };
    // A removal/replacement observed before the create callback invalidates it.
    if (!isValidTabId(tab.id) || (tabRevisions.get(tab.id)?.access ?? 0) > started) {
      throw new Error("created tab is no longer available");
    }
    createdTabs.set(tab.id, created);
    try {
      created.assertCurrent();
      await addTabToGroup(tab.id, created);
      created.assertCurrent();
      await requireTab(tab.id, created.epoch);
      created.assertCurrent();
      const attached = await attachDebugger(tab.id, created.assertCurrent, created.epoch);
      created.assertCurrent();
      if (message.focus === true && typeof tab.windowId === "number") {
        await chromeApi.windows.update(tab.windowId, { focused: true });
        created.assertCurrent();
      }
      await requireTab(tab.id, created.epoch);
      created.assertCurrent();
      handoff({ tabId: tab.id, ...attached });
      created.handedOff = true;
    } catch (error) {
      // Rollback belongs to the creator, before any id is handed to the relay.
      // Never use ordinary close as a privileged bypass or close a user-revoked tab.
      const ownsRollback = () =>
        createdTabs.get(tab.id) === created &&
        !deniedTabIds.has(tab.id) &&
        epochMatches(tab.id, created.epoch);
      try {
        if (ownsRollback()) {
          const current = await chromeApi.tabs.get(tab.id);
          if (
            ownsRollback() &&
            current.id === tab.id &&
            current.windowId === tab.windowId &&
            ((created.initialBlank &&
              initialBlankDocument(current) &&
              (!current.pendingUrl || current.pendingUrl === "about:blank")) ||
              (effectiveTabUrl(current) === effectiveTabUrl(created.tab) &&
                (!current.url || current.url === effectiveTabUrl(created.tab)))) &&
            current.groupId === created.groupId &&
            current.incognito === tab.incognito
          ) {
            await chromeApi.tabs.remove(tab.id);
          }
        }
      } catch {
        console.warn(`Cleanup failed for created tab ${tab.id}; close it manually.`);
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}; cleanup failed for created tab ${tab.id}; close it manually.`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      if (!created.handedOff || !created.initialBlank) {
        if (createdTabs.get(tab.id) === created) {
          createdTabs.delete(tab.id);
          if (!created.handedOff) {
            invalidateTab(tab.id);
          }
        }
      }
    }
  }

  async function initialize(initialMode = ACCESS_MODE_SELECTED, initialEnabled = false) {
    if (initialized) {
      return await initialized;
    }
    mode = initialMode === ACCESS_MODE_ALL ? ACCESS_MODE_ALL : ACCESS_MODE_SELECTED;
    enabled = initialEnabled;
    initialized = (async () => {
      const [stored, tabs, allowFiles] = await Promise.all([
        chromeApi.storage.session.get([DENIED_TAB_IDS_KEY]),
        chromeApi.tabs.query({}),
        fileAccessAllowed(),
      ]);
      // Chrome reloads the extension and closes its debugger sessions when this
      // permission changes (Chromium extension_util.cc: SetAllowFileAccess).
      fileAccessGranted = allowFiles;
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

  function renewTabAccess(tabId, attachedEpoch, tab) {
    const proof = attachedEpoch && provenEpochs.get(attachedEpoch);
    const canRenew =
      proof?.tabId === tabId &&
      epochIsCurrent(tabId, attachedEpoch) &&
      tab?.id === tabId &&
      tabIsEligible(tab) &&
      (mode === ACCESS_MODE_ALL || tab.groupId === proof.groupId);
    // An allowed document change retires page reads/actions, not tab authority.
    // Only an already-proven attachment gets synchronous event renewal. Without
    // an attachment, an eligible initial HTTP commit can precede create's callback.
    if (!tabIsEligible(tab) || (attachedEpoch && !canRenew)) {
      invalidateTab(tabId);
    } else {
      tabRevisions.set(tabId, {
        access: tabRevisions.get(tabId)?.access ?? 0,
        document: ++discoveryRevision,
      });
    }
    if (!canRenew) {
      return undefined;
    }
    const epoch = capture(tabId);
    provenEpochs.set(epoch, { tabId, groupId: tab.groupId });
    return epoch;
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
    const eligibility = eligibilityForTab(tab);
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
      const currentEligible = tabIsEligible(current);
      const currentSelected = await isSelectedTab(current);
      if (!epochIsCurrent(tabId, epoch)) {
        return { accessible: false, eligible: false, denied, reason: "revoked", tab: current };
      }
      if (
        current.groupId !== tab.groupId ||
        (epoch.documentRevision !== undefined &&
          effectiveTabUrl(current) !== effectiveTabUrl(tab)) ||
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
    if (!denied && selected) {
      provenEpochs.set(epoch, { tabId, groupId: tab.groupId });
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
        if (!tabIsEligible(tab)) {
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
    if (!tabIsEligible(tab)) {
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
    retireTab(tabId);
    if (!deniedTabIds.delete(tabId)) {
      return;
    }
    await mutateStorage(persistDeniedIds);
  }

  async function replaceTab(addedTabId, removedTabId) {
    retireTab(removedTabId);
    retireTab(addedTabId);
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
    retireTab,
    renewTabAccess,
    invalidateAll,
    observeTabUpdate,
    createTab,
    addTabToGroup,
    inspectTab,
    requireTab,
    listAccessibleTabs,
    canPublishTab: (tabId) => !createdTabs.has(tabId) || createdTabs.get(tabId).handedOff,
    pause,
    allow,
    forgetTab,
    replaceTab,
    clearDenied,
    isDenied: (tabId) => deniedTabIds.has(tabId),
  };
}
