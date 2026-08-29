/** Physical debugger attachments belong to one authenticated relay transport. */
export function createRelayDebugger({ policy, requireAutomationAllowed }) {
  const attachedTabs = new Set();
  const attachedAccessEpochs = new Map();
  const attachingTabs = new Map();
  const detachingTabs = new Map();
  let retirement = Promise.resolve();
  const owners = new Set();

  async function detach(tabId) {
    // Native programmatic detach emits no onDetach. Retire document authority
    // before yielding, including while the native attachment is still pending.
    policy.retireTabDocument(tabId);
    attachedTabs.delete(tabId);
    attachedAccessEpochs.delete(tabId);
    const existing = detachingTabs.get(tabId);
    if (existing) {
      await existing;
      return;
    }
    const pending = chrome.debugger.detach({ tabId }).catch((error) => {
      // Chromium debugger_api.cc formats these terminal states for tab targets.
      // Other failures cannot establish a fresh physical Runtime for a successor.
      if (
        error?.message !== `Debugger is not attached to the tab with id: ${tabId}.` &&
        error?.message !== `No tab with given id ${tabId}.`
      ) {
        throw error;
      }
    });
    detachingTabs.set(tabId, pending);
    try {
      await pending;
    } finally {
      if (detachingTabs.get(tabId) === pending) {
        detachingTabs.delete(tabId);
      }
    }
  }

  function createOwner(isCurrent) {
    const ownedTabs = new Set();
    const ownedAttaches = new Set();
    let active = true;
    let retired;
    const current = () => active && isCurrent();
    const assertCurrent = () => {
      if (!current()) {
        throw new Error("Relay transport retired");
      }
    };
    async function attach(tabId, assertCreation, creationEpoch) {
      assertCurrent();
      await retirement;
      assertCurrent();
      assertCreation();
      const epoch = creationEpoch ?? policy.capture(tabId);
      const existing = attachingTabs.get(tabId);
      if (existing) {
        const result = await existing;
        assertCurrent();
        assertCreation();
        await policy.requireTab(tabId, epoch);
        assertCurrent();
        assertCreation();
        return result;
      }
      const pending = (async () => {
        await requireAutomationAllowed();
        assertCurrent();
        const assertAccess = () => {
          assertCurrent();
          assertCreation();
          if (!policy.epochIsCurrent(tabId, epoch)) {
            throw new Error(`tab ${tabId} access was revoked`);
          }
        };
        try {
          await policy.requireTab(tabId, epoch);
          assertAccess();
          await detachingTabs.get(tabId);
          assertAccess();
          if (!attachedTabs.has(tabId)) {
            await chrome.debugger.attach({ tabId }, "1.3");
            // Retirement drains this attach promise before cleanup. Record a
            // successful native attach even if its transport retired meanwhile.
            ownedTabs.add(tabId);
            await policy.requireTab(tabId, epoch);
            assertAccess();
            attachedTabs.add(tabId);
          }
          const targets = await chrome.debugger.getTargets();
          await policy.requireTab(tabId, epoch);
          assertAccess();
          attachedAccessEpochs.set(tabId, epoch);
          const target = targets.find(
            (candidate) => candidate.tabId === tabId && candidate.attached,
          );
          return { targetId: target?.id ?? `tab-${tabId}` };
        } catch (error) {
          // Once retired, the retirement barrier owns cleanup. Never let an old
          // catch detach a replacement or swallow a failed retirement detach.
          if (active && ownedTabs.has(tabId)) {
            await detach(tabId);
          }
          throw error;
        }
      })();
      attachingTabs.set(tabId, pending);
      ownedAttaches.add(pending);
      try {
        return await pending;
      } finally {
        ownedAttaches.delete(pending);
        if (attachingTabs.get(tabId) === pending) {
          attachingTabs.delete(tabId);
        }
      }
    }
    const owner = {
      isCurrent: current,
      assertCurrent,
      attach,
      requireTab: async (tabId, epoch, afterNavigation = false) => {
        assertCurrent();
        await retirement;
        assertCurrent();
        const tab = afterNavigation
          ? await policy.requireTabAfterNavigation(tabId, epoch)
          : await policy.requireTab(tabId, epoch);
        assertCurrent();
        return tab;
      },
      detach: async (tabId) => {
        assertCurrent();
        await retirement;
        assertCurrent();
        await detach(tabId);
      },
      retire: () => {
        if (retired) {
          return retired;
        }
        active = false;
        for (const tabId of ownedTabs) {
          policy.retireTabDocument(tabId);
          attachedTabs.delete(tabId);
          attachedAccessEpochs.delete(tabId);
        }
        const pending = [
          ...ownedAttaches,
          ...[...ownedTabs].map((tabId) => detachingTabs.get(tabId)),
        ];
        // Serialize physical generations, not live commands. In particular,
        // native detach rejects evaluations; waiting for them here can deadlock.
        retired = retirement = retirement.then(async () => {
          await Promise.allSettled(pending);
          await Promise.all([...ownedTabs].map(detach));
          owners.delete(owner);
        });
        return retired;
      },
    };
    owners.add(owner);
    return owner;
  }
  async function detachAll() {
    await Promise.all([...owners].map((owner) => owner.retire()));
  }
  return { detachAll, attachedTabs, attachedAccessEpochs, attachingTabs, detach, createOwner };
}
