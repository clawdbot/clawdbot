import { ACCESS_MODE_ALL, ACCESS_MODE_SELECTED } from "./relay-core.js";

/** Register Chrome lifecycle events that can grant, revoke, or project tab access. */
export function registerTabAccessEvents({
  chromeApi = chrome,
  accessReady,
  policy,
  attachments,
  nativeDetached,
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
    const accessEpoch = attachments.get(source.tabId)?.epoch;
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
    // Preserve controlled-document pause evidence before native retirement revokes it.
    const revocation =
      reason === "canceled_by_user" ? policy.beginRevocation(source.tabId) : undefined;
    nativeDetached(source.tabId);
    send({ type: "detached", tabId: source.tabId, reason });
    if (revocation === undefined) {
      return;
    }
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
    void detachDebugger(tabId).catch((error) =>
      console.warn("Debugger removal cleanup failed", error),
    );
    void (async () => {
      await accessReady;
      scheduleTabsSync();
      await policy.forgetTab(tabId).catch(() => undefined);
    })();
  });

  chromeApi.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    const revocation = policy.beginRevocation(addedTabId);
    policy.retireTab(addedTabId);
    policy.retireTab(removedTabId);
    const detaching = [detachDebugger(removedTabId), detachDebugger(addedTabId)];
    scheduleTabsSync();
    void (async () => {
      try {
        await accessReady;
        await policy.replaceTab(addedTabId, removedTabId);
        await Promise.allSettled(detaching);
      } finally {
        policy.endRevocation(revocation);
        scheduleTabsSync();
      }
    })().catch(() => undefined);
  });

  chromeApi.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    scheduleTabsSync();
    const generation = attachments.get(tabId);
    const pendingAttach = generation?.pending;
    if (policy.observeTabUpdate(tabId, changeInfo, tab)) {
      const renewed = policy.renewTabAccess(tabId, generation?.epoch, tab);
      if (renewed && generation) {
        generation.epoch = renewed;
      }
    }
    const eventEpoch = policy.capture(tabId);
    void (async () => {
      await accessReady;
      const eventIsCurrent = () =>
        policy.epochIsCurrent(tabId, eventEpoch) &&
        attachments.get(tabId) === generation &&
        generation?.pending === pendingAttach &&
        !generation?.retired;
      if (!eventIsCurrent()) {
        return;
      }
      const state = await policy.inspectTab(tabId, eventEpoch);
      if (!eventIsCurrent()) {
        return;
      }
      if (!state.accessible) {
        await detachDebugger(tabId);
        return;
      }
      if (generation?.epoch) {
        generation.epoch = eventEpoch;
      }
    })();
  });

  const onGroupChanged = (group, removed = false) => {
    const eventRevision = ++groupEventRevision;
    scheduleTabsSync();
    policy.invalidateGroup(group, removed);
    if (policy.mode !== ACCESS_MODE_SELECTED) {
      return;
    }
    const generations = [...attachments]
      .filter(([, record]) => !record.retired)
      .map(([tabId, generation]) => [tabId, generation, policy.capture(tabId)]);
    void accessReady.then(async () => {
      if (eventRevision !== groupEventRevision || policy.mode !== ACCESS_MODE_SELECTED) {
        return;
      }
      await Promise.allSettled([...attachments.values()].map((record) => record.pending));
      if (eventRevision !== groupEventRevision) {
        return;
      }
      const selected = new Set((await policy.listAccessibleTabs()).map((tab) => tab.id));
      if (eventRevision !== groupEventRevision) {
        return;
      }
      await Promise.allSettled(
        generations
          .filter(
            ([tabId, generation]) => !selected.has(tabId) && attachments.get(tabId) === generation,
          )
          .map(([tabId]) => detachDebugger(tabId)),
      );
      if (eventRevision !== groupEventRevision) {
        return;
      }
      for (const [tabId, generation, epoch] of generations) {
        if (!selected.has(tabId) || attachments.get(tabId) !== generation) {
          continue;
        }
        const state = await policy.inspectTab(tabId, epoch);
        if (eventRevision !== groupEventRevision || attachments.get(tabId) !== generation) {
          return;
        }
        if (!policy.epochIsCurrent(tabId, epoch)) {
          // The newer tab event owns validation. Replaying this old group event
          // would revoke commands admitted after that validation completed.
          continue;
        }
        if (state.accessible) {
          generation.epoch = epoch;
        } else {
          await detachDebugger(tabId);
          if (eventRevision !== groupEventRevision) {
            return;
          }
        }
      }
    });
  };
  chromeApi.tabGroups.onUpdated.addListener(onGroupChanged);
  chromeApi.tabGroups.onRemoved.addListener((group) => onGroupChanged(group, true));
}
