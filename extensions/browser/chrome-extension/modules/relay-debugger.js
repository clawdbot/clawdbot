/** Physical debugger attachments and cleanup debt belong to exact native acquisitions. */
export function createRelayDebugger({ policy, requireAutomationAllowed }) {
  const attachments = new Map();
  const owners = new Set();
  let admission = 0;

  function invalidate(record) {
    if (!record.retired) {
      policy.retireTabDocument(record.tabId);
      record.retired = true;
      record.epoch = undefined;
    }
  }

  function forget(record) {
    if (attachments.get(record.tabId) === record) {
      if (record.previous && !record.previous.closed) {
        attachments.set(record.tabId, record.previous);
      } else {
        attachments.delete(record.tabId);
      }
    }
    record.owned?.delete(record);
    record.released?.();
  }

  function cleanup(record) {
    invalidate(record);
    if (record.cleaning) {
      return record.cleaning;
    }
    const cleaning = Promise.resolve().then(async () => {
      // Access closes immediately; dispatched acquisition/detach still drains
      // before a successor can use this tab. No evaluation/body read is awaited.
      await Promise.allSettled([record.pending]);
      await record.previousCleanup;
      if (record.native && !record.closed) {
        const target = record.targetId ? { targetId: record.targetId } : { tabId: record.tabId };
        try {
          await chrome.debugger.detach(target);
        } catch (error) {
          // GetForId + FindClientHost prove absence of this exact host/client.
          // NoTab fails before either lookup and never settles native debt.
          if (
            !record.closed &&
            !(
              record.targetId &&
              (error?.message === `No target with given id ${record.targetId}.` ||
                error?.message ===
                  `Debugger is not attached to the target with id: ${record.targetId}.`)
            )
          ) {
            throw error;
          }
        }
      }
      record.closed = true;
      forget(record);
    });
    record.cleaning = cleaning;
    void cleaning
      .finally(() => {
        if (record.cleaning === cleaning) {
          record.cleaning = undefined;
        }
      })
      .catch(() => {});
    return cleaning;
  }

  function detach(tabId) {
    const record = attachments.get(tabId);
    return record ? cleanup(record) : Promise.resolve();
  }

  function nativeDetached(tabId) {
    let record = attachments.get(tabId);
    // A new acquisition may be waiting on an older native client's cleanup.
    while (record?.previous && !record.previous.closed) {
      record = record.previous;
    }
    if (!record) {
      return;
    }
    invalidate(record);
    record.closed = true;
    void cleanup(record).catch((error) => console.warn("Debugger cleanup failed", error));
  }

  function createOwner(connectionIsCurrent) {
    const owned = new Set();
    let active = true;
    const isCurrent = () => active && connectionIsCurrent();
    const assertCurrent = () => {
      if (!isCurrent()) {
        throw new Error("Relay transport retired");
      }
    };
    function capture(tabId) {
      assertCurrent();
      const record = attachments.get(tabId);
      if (!record?.epoch || record.retired || record.owner !== isCurrent) {
        throw new Error("Debugger is not attached");
      }
      const native = record.native;
      return () => {
        assertCurrent();
        if (record.retired || attachments.get(tabId) !== record || record.native !== native) {
          throw new Error("Debugger attachment retired");
        }
      };
    }
    async function attach(tabId, assertCallerCurrent, creationEpoch) {
      const epoch = creationEpoch ?? policy.capture(tabId);
      const assertAccess = () => {
        assertCurrent();
        assertCallerCurrent();
        if (!policy.epochIsCurrent(tabId, epoch)) {
          throw new Error(`tab ${tabId} access was revoked`);
        }
      };
      assertAccess();
      const previous = attachments.get(tabId);
      if (previous && !previous.retired && previous.owner === isCurrent) {
        const result = previous.pending
          ? await previous.pending
          : { targetId: previous.targetId, assertCurrent: capture(tabId) };
        await policy.requireTab(tabId, epoch);
        assertAccess();
        result.assertCurrent();
        return result;
      }
      const record = {
        tabId,
        owner: isCurrent,
        owned,
        previous,
        retired: false,
        epoch: undefined,
        released: () => {
          if (!active && owned.size === 0) {
            owners.delete(owner);
          }
        },
      };
      admission++;
      attachments.set(tabId, record);
      owned.add(record);
      const assertAcquisition = () => {
        assertAccess();
        if (record.retired || attachments.get(tabId) !== record) {
          throw new Error("Debugger attachment retired");
        }
      };
      const pending = Promise.resolve().then(async () => {
        if (previous) {
          record.previousCleanup = cleanup(previous);
          await record.previousCleanup;
          record.previous = undefined;
        }
        assertAcquisition();
        await requireAutomationAllowed();
        assertAcquisition();
        await policy.requireTab(tabId, epoch);
        assertAcquisition();
        await chrome.debugger.attach({ tabId }, "1.3");
        // Mint only on native success. Identity discovery is cleanup authority
        // even when access/socket closure overtakes the native callback.
        record.native = {};
        if (!record.closed) {
          const result = await chrome.debugger.sendCommand({ tabId }, "Target.getTargetInfo", {});
          const targetId = result?.targetInfo?.targetId;
          if (typeof targetId !== "string" || !targetId) {
            throw new Error("Debugger target identity unavailable");
          }
          record.targetId = targetId;
        }
        await policy.requireTab(tabId, epoch);
        assertAcquisition();
        record.epoch = epoch;
        return { targetId: record.targetId, assertCurrent: capture(tabId) };
      });
      record.pending = pending;
      try {
        return await pending;
      } catch (error) {
        invalidate(record);
        if (record.native) {
          const [cleanupResult] = await Promise.allSettled([cleanup(record)]);
          if (cleanupResult.status === "rejected") {
            throw new Error(
              `Debugger acquisition failed: ${String(error)}; cleanup incomplete: ${String(cleanupResult.reason)}`,
              { cause: error },
            );
          }
        } else {
          forget(record);
        }
        throw error;
      } finally {
        if (record.pending === pending) {
          record.pending = undefined;
        }
      }
    }
    const owner = {
      isCurrent,
      attach,
      capture,
      requireTab: async (tabId, epoch, afterNavigation = false) => {
        assertCurrent();
        const tab = afterNavigation
          ? await policy.requireTabAfterNavigation(tabId, epoch)
          : await policy.requireTab(tabId, epoch);
        assertCurrent();
        return tab;
      },
      detach: (tabId) => {
        assertCurrent();
        return detach(tabId);
      },
      retire: async () => {
        active = false;
        const results = await Promise.allSettled([...owned].map(cleanup));
        if (owned.size === 0) {
          owners.delete(owner);
        }
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason] : [],
        );
        if (errors.length) {
          throw new AggregateError(
            errors,
            `Debugger cleanup incomplete: ${errors.map(String).join("; ")}`,
          );
        }
      },
    };
    owners.add(owner);
    return owner;
  }
  return {
    attachments,
    nativeDetached,
    detach,
    createOwner,
    detachAll: async (inherited = false) => {
      const capturedAdmission = admission;
      const results = await Promise.allSettled([...owners].map((owner) => owner.retire()));
      const errors = results.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (inherited) {
        try {
          const targets = await chrome.debugger.getTargets();
          if (admission !== capturedAdmission) {
            throw new Error("Debugger cleanup superseded by new attachment");
          }
          const cleanups = targets
            .filter((target) => target.attached && typeof target.tabId === "number")
            .map(async (target) => {
              if (attachments.has(target.tabId)) {
                return detach(target.tabId);
              }
              if (typeof target.id !== "string" || !target.id) {
                throw new Error("Inherited debugger identity unavailable");
              }
              const record = {
                tabId: target.tabId,
                targetId: target.id,
                native: {},
                retired: true,
              };
              attachments.set(target.tabId, record);
              return cleanup(record);
            });
          for (const result of await Promise.allSettled(cleanups)) {
            if (result.status === "rejected") {
              errors.push(result.reason);
            }
          }
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) {
        throw new AggregateError(
          errors,
          `Debugger cleanup incomplete: ${errors.map(String).join("; ")}`,
        );
      }
    },
  };
}
