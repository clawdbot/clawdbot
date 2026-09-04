export const RESOURCE_LEASE_MS = 60_000;
export const RESOURCE_SWEEP_MS = 1_000;
const RESOURCE_LEASE_RENEW_MS = 20_000;

type SkillResourceLeaseRenewalOptions = {
  assertAllocationCurrent: () => void;
  callerSignal?: AbortSignal;
  commitDispatchedAt: number;
  executeRenewal: (signal: AbortSignal) => Promise<unknown>;
  retire: () => Promise<void>;
};

export function createSkillResourceLeaseRenewal(options: SkillResourceLeaseRenewalOptions) {
  let renewalStopped = false;
  let renewalFailure: Error | undefined;
  let leaseDeadline = options.commitDispatchedAt + RESOURCE_LEASE_MS;
  let nextRenewAt = options.commitDispatchedAt + RESOURCE_LEASE_RENEW_MS;
  let renewalRunning = false;
  let renewalAbort: AbortController | undefined;
  let renewalInFlight = Promise.resolve();
  const failRenewal = (error: unknown) => {
    renewalFailure =
      error instanceof Error
        ? error
        : new Error("Skill resource lease authority was lost.", { cause: error });
    renewalStopped = true;
    clearInterval(renewalTimer);
  };
  const runRenewal = () => {
    const dispatchedAt = Date.now();
    const controller = new AbortController();
    renewalAbort = controller;
    const signal = options.callerSignal
      ? AbortSignal.any([options.callerSignal, controller.signal])
      : controller.signal;
    const deadlineError = new DOMException("Skill resource lease renewal expired", "TimeoutError");
    const timeout = setTimeout(
      () => controller.abort(deadlineError),
      Math.max(0, leaseDeadline - Date.now()),
    );
    timeout.unref?.();
    const operation = options.executeRenewal(signal);
    void operation.catch(() => undefined);
    const abortReason = () =>
      signal.reason instanceof Error
        ? signal.reason
        : new DOMException("Skill resource renewal aborted", "AbortError");
    const aborted = new Promise<never>((_resolve, reject) => {
      if (signal.aborted) {
        reject(abortReason());
        return;
      }
      signal.addEventListener("abort", () => reject(abortReason()), { once: true });
    });
    return Promise.race([operation, aborted])
      .then(() => dispatchedAt)
      .finally(() => {
        clearTimeout(timeout);
        if (renewalAbort === controller) {
          renewalAbort = undefined;
        }
      });
  };
  const renewalTimer = setInterval(() => {
    if (renewalStopped || renewalRunning || Date.now() < nextRenewAt) {
      return;
    }
    renewalRunning = true;
    renewalInFlight = runRenewal()
      .then((dispatchedAt) => {
        leaseDeadline = dispatchedAt + RESOURCE_LEASE_MS;
        nextRenewAt = dispatchedAt + RESOURCE_LEASE_RENEW_MS;
      })
      .catch((error: unknown) => {
        try {
          options.assertAllocationCurrent();
        } catch (authorityError) {
          failRenewal(authorityError);
          return;
        }
        if (Date.now() + RESOURCE_SWEEP_MS >= leaseDeadline) {
          failRenewal(
            new Error("Skill resource lease could not be renewed before expiry.", {
              cause: error,
            }),
          );
        } else {
          nextRenewAt = Date.now() + RESOURCE_SWEEP_MS;
        }
      })
      .finally(() => {
        renewalRunning = false;
      });
  }, RESOURCE_SWEEP_MS);
  renewalTimer.unref?.();

  const assertCurrent = () => {
    options.assertAllocationCurrent();
    if (!renewalFailure && !renewalStopped && Date.now() >= leaseDeadline) {
      const error = new Error("Skill resource lease expired before renewal completed.");
      renewalAbort?.abort(error);
      failRenewal(error);
    }
    if (renewalFailure) {
      throw renewalFailure;
    }
  };
  let cleanupInFlight: Promise<void> | undefined;
  const cleanup = () => {
    if (cleanupInFlight) {
      return cleanupInFlight;
    }
    const current = (async () => {
      renewalStopped = true;
      clearInterval(renewalTimer);
      renewalAbort?.abort(new DOMException("Skill resource cleanup started", "AbortError"));
      await renewalInFlight.catch(() => undefined);
      await options.retire();
    })();
    cleanupInFlight = current;
    void current.catch(() => {
      if (cleanupInFlight === current) {
        cleanupInFlight = undefined;
      }
    });
    return current;
  };

  return { assertCurrent, cleanup };
}
