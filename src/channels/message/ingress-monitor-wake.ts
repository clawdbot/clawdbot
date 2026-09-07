import type { ChannelIngressDrain } from "./ingress-drain.js";

export function createIngressDrainWakeScheduler(options: {
  isRunning: () => boolean;
  requestDrain: () => void;
  reportError: (error: unknown) => void;
}) {
  let idleWake: Promise<void> | undefined;
  let idleWakeRequested = false;
  let stallSettlementWake: Promise<void> | undefined;

  const observeStallSettlement = (drain: ChannelIngressDrain): void => {
    if (stallSettlementWake || !drain.waitForStallSettlements) {
      return;
    }
    const wake = drain.waitForStallSettlements();
    stallSettlementWake = wake;
    void wake.then(
      () => {
        if (stallSettlementWake !== wake) {
          return;
        }
        stallSettlementWake = undefined;
        if (options.isRunning()) {
          if (drain.hasPendingStallSettlements?.()) {
            observeStallSettlement(drain);
          }
          options.requestDrain();
        }
      },
      (error: unknown) => {
        if (stallSettlementWake === wake) {
          stallSettlementWake = undefined;
        }
        options.reportError(error);
      },
    );
  };

  const schedule = (drain: ChannelIngressDrain): void => {
    if (idleWake) {
      idleWakeRequested = true;
      return;
    }
    idleWakeRequested = false;
    const wake = drain.waitForIdle();
    idleWake = wake;
    void wake.then(
      () => {
        if (idleWake !== wake) {
          return;
        }
        const shouldRearm = idleWakeRequested && options.isRunning();
        const shouldObserveStall =
          (drain.hasPendingStallSettlements?.() ?? false) && options.isRunning();
        idleWake = undefined;
        idleWakeRequested = false;
        if (shouldRearm) {
          schedule(drain);
        }
        if (shouldObserveStall) {
          observeStallSettlement(drain);
        }
        options.requestDrain();
      },
      (error: unknown) => {
        if (idleWake === wake) {
          idleWake = undefined;
          idleWakeRequested = false;
        }
        options.reportError(error);
      },
    );
  };

  return { schedule };
}
