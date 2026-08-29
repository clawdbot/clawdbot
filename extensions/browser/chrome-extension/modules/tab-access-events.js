import { ACCESS_MODE_ALL, ACCESS_MODE_SELECTED } from "./relay-core.js";

/** Register Chrome lifecycle events that can grant, revoke, or project tab access. */
export function registerTabAccessEvents({
  chromeApi = chrome,
  accessReady,
  policy,
  attachedTabs,
  attachedAccessEpochs,
  attachingTabs,
  send,
  scheduleTabsSync,
  detachDebugger,
  pauseTab,
  removeTabFromOpenClawGroup,
  runAccessMutation,
}) {
  let groupEventRevision = 0;

  chromeApi.debugger.onEvent.addListener((source, method, params) => {
    if (typeof source.tabId !== "number") {
      return;
    }
    const accessEpoch = attachedAccessEpochs.get(source.tabId);
    if (!accessEpoch || !policy.epochIsCurrent(source.tabId, accessEpoch)) {
      return;
    }
    policy.forwardDocumentEvent(
      {
        type: "cdpEvent",
        tabId: source.tabId,
        ...(source.sessionId ? { sessionId: source.sessionId } : {}),
        method,
        params,
      },
      send,
    );
  });

  chromeApi.debugger.onDetach.addListener((source, reason) => {
    if (typeof source.tabId !== "number") {
      return;
    }
    attachedTabs.delete(source.tabId);
    attachedAccessEpochs.delete(source.tabId);
    send({ type: "detached", tabId: source.tabId, reason });
    if (reason !== "canceled_by_user") {
      policy.retireTabDocument(source.tabId);
      return;
    }
    const revocation = policy.beginRevocation(source.tabId);
    policy.retireTabDocument(source.tabId);
    void runAccessMutation(async () => {
      try {
        await accessReady;
        if (policy.mode === ACCESS_MODE_ALL) {
          await pauseTab(source.tabId);
        } else {
          policy.invalidateTab(source.tabId);
          await removeTabFromOpenClawGroup(source.tabId);
          scheduleTabsSync();
        }
      } finally {
        policy.endRevocation(revocation);
      }
    }).catch(() => undefined);
  });

  chromeApi.tabs.onRemoved.addListener((tabId) => {
    policy.retireTab(tabId);
    void (async () => {
      await accessReady;
      attachedTabs.delete(tabId);
      attachedAccessEpochs.delete(tabId);
      scheduleTabsSync();
      await policy.forgetTab(tabId).catch(() => undefined);
    })();
  });

  chromeApi.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    const revocation = policy.beginRevocation(addedTabId);
    policy.retireTab(addedTabId);
    policy.retireTab(removedTabId);
    attachedTabs.delete(removedTabId);
    attachedAccessEpochs.delete(removedTabId);
    scheduleTabsSync();
    void (async () => {
      try {
        await accessReady;
        await policy.replaceTab(addedTabId, removedTabId);
        await Promise.allSettled([attachingTabs.get(removedTabId), attachingTabs.get(addedTabId)]);
        await Promise.allSettled([detachDebugger(removedTabId), detachDebugger(addedTabId)]);
      } finally {
        policy.endRevocation(revocation);
        scheduleTabsSync();
      }
    })().catch(() => undefined);
  });

  chromeApi.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    scheduleTabsSync();
    if (policy.observeTabUpdate(tabId, changeInfo, tab)) {
      const renewed = policy.renewTabAccess(tabId, attachedAccessEpochs.get(tabId), tab);
      if (renewed && attachedTabs.has(tabId)) {
        attachedAccessEpochs.set(tabId, renewed);
      }
    }
    const eventEpoch = policy.capture(tabId);
    void (async () => {
      await accessReady;
      const eventIsCurrent = () => policy.epochIsCurrent(tabId, eventEpoch);
      if (!eventIsCurrent()) {
        return;
      }
      const state = await policy.inspectTab(tabId, eventEpoch);
      if (!eventIsCurrent()) {
        return;
      }
      if (!state.accessible) {
        await Promise.allSettled([attachingTabs.get(tabId)]);
        if (!eventIsCurrent()) {
          return;
        }
        await detachDebugger(tabId);
      }
      if (attachedTabs.has(tabId) && attachedAccessEpochs.has(tabId)) {
        attachedAccessEpochs.set(tabId, eventEpoch);
      }
    })();
  });

  const onGroupChanged = (group) => {
    const eventRevision = ++groupEventRevision;
    scheduleTabsSync();
    policy.invalidateDocumentGroup(group);
    if (policy.mode !== ACCESS_MODE_SELECTED) {
      return;
    }
    // Group title/removal changes mutate the selected-mode ACL. Retire every
    // attachment epoch synchronously before any readiness or Chrome lookup.
    policy.invalidateAll(group);
    void accessReady.then(async () => {
      if (eventRevision !== groupEventRevision || policy.mode !== ACCESS_MODE_SELECTED) {
        return;
      }
      const epochs = new Map(
        [...attachedAccessEpochs.keys()]
          .filter((tabId) => attachedTabs.has(tabId))
          .map((tabId) => [tabId, policy.capture(tabId)]),
      );
      await Promise.allSettled(attachingTabs.values());
      if (eventRevision !== groupEventRevision) {
        return;
      }
      const selected = new Set((await policy.listAccessibleTabs()).map((tab) => tab.id));
      if (eventRevision !== groupEventRevision) {
        return;
      }
      await Promise.allSettled(
        [...attachedTabs]
          .filter((tabId) => !selected.has(tabId))
          .map((tabId) => detachDebugger(tabId)),
      );
      if (eventRevision !== groupEventRevision) {
        return;
      }
      let newerTabEventOwnsAccess = false;
      for (const [tabId, epoch] of epochs) {
        if (!selected.has(tabId) || !attachedTabs.has(tabId)) {
          continue;
        }
        const state = await policy.inspectTab(tabId, epoch);
        if (eventRevision !== groupEventRevision) {
          return;
        }
        if (!policy.epochIsCurrent(tabId, epoch)) {
          // A newer tab event owns this attachment's revision.
          newerTabEventOwnsAccess = true;
          continue;
        }
        if (state.accessible) {
          attachedAccessEpochs.set(tabId, epoch);
        } else {
          await detachDebugger(tabId);
          if (eventRevision !== groupEventRevision) {
            return;
          }
        }
      }
      if (eventRevision !== groupEventRevision) {
        return;
      }
      if (newerTabEventOwnsAccess) {
        onGroupChanged();
      }
    });
  };
  chromeApi.tabGroups.onUpdated.addListener(onGroupChanged);
  chromeApi.tabGroups.onRemoved.addListener((group) => onGroupChanged(group));
}
