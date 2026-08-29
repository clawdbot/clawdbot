import type { PluginServicesHandle } from "../plugins/services.js";
import { createDeferredCore } from "../shared/deferred.js";

export type GatewayPluginRuntimeClaim = Readonly<{
  isCurrent: () => boolean;
  waitForUnblocked: () => Promise<boolean>;
  publish: (publication: () => void) => boolean;
}>;

type GatewayPluginRuntimeReservation = Readonly<{
  claim: GatewayPluginRuntimeClaim;
  commit: () => void;
  reject: () => void;
}>;

/** One Gateway owner fences every plugin publication across startup and hot replacement. */
export function createGatewayPluginRuntimeGeneration(params: {
  getServices: () => PluginServicesHandle | null;
  setServices: (services: PluginServicesHandle | null) => void;
}) {
  let current: GatewayPluginRuntimeClaim;
  let pending:
    | {
        claim: GatewayPluginRuntimeClaim;
        settled: ReturnType<typeof createDeferredCore<void>>;
      }
    | undefined;

  const createClaim = (): GatewayPluginRuntimeClaim => {
    const claim: GatewayPluginRuntimeClaim = Object.freeze({
      isCurrent: () => current === claim && pending === undefined,
      waitForUnblocked: async () => {
        for (;;) {
          const reservation = pending;
          if (current !== claim || !reservation) {
            return claim.isCurrent();
          }
          await reservation.settled.promise;
        }
      },
      publish: (publication: () => void) => {
        if (!claim.isCurrent()) {
          return false;
        }
        publication();
        return true;
      },
    });
    return claim;
  };
  current = createClaim();

  return {
    currentClaim: () => current,
    currentServices: () => params.getServices(),
    publishServices: (claim: GatewayPluginRuntimeClaim, services: PluginServicesHandle | null) =>
      claim.publish(() => params.setServices(services)),
    reserve: (): GatewayPluginRuntimeReservation => {
      if (pending) {
        throw new Error("a Gateway plugin runtime replacement is already pending");
      }
      const reservation = { claim: createClaim(), settled: createDeferredCore() };
      pending = reservation;
      const settle = (accepted: boolean) => {
        if (pending !== reservation) {
          return;
        }
        if (accepted) {
          current = reservation.claim;
        }
        pending = undefined;
        reservation.settled.resolve();
      };
      return Object.freeze({
        claim: reservation.claim,
        commit: () => settle(true),
        reject: () => settle(false),
      });
    },
  };
}
