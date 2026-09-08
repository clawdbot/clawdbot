import { err, ok } from "@openclaw/normalization-core/result";
import {
  prepareHostedGatewayStop,
  type HostedGatewayStop,
  type GatewayProcessOwner,
} from "../../daemon/hosted-stop.js";
import type { GatewayHostLifecycle } from "../../gateway/server-public.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { disarmGatewaySuspendHandoff } from "../../infra/gateway-suspend-coordinator.js";
import { scheduleSafeGatewayRestart } from "../../infra/restart-coordinator.js";

/** The run loop retains this owner; kernels receive only its request capability. */
export function createGatewayHostLifecycle(params: {
  isCurrent: () => boolean;
  isServing: () => boolean;
  acceptStop: () => void;
  processOwner: GatewayProcessOwner;
}) {
  const abort = new AbortController();
  const processOwner = { ...params.processOwner };
  const stopSignalReason = new Error("Gateway host stop signalled");
  let state: "serving" | "preparing" | "accepted" | "finishing" | "retired" = "serving";
  let stop: HostedGatewayStop | undefined;
  let preparationFinished: Promise<void> | undefined;
  let execution: ReturnType<HostedGatewayStop["execute"]> | undefined;
  let retirement: Promise<void> | undefined;
  const externalRestart = {
    isCurrent: () => state === "serving" && params.isCurrent() && params.isServing(),
  };
  const assertCurrent = () => {
    if (state === "retired" || !params.isCurrent()) {
      throw new Error(
        "Gateway host lifecycle is unavailable for this iteration. Reconnect and retry.",
      );
    }
  };
  const retire = () => {
    if (retirement) {
      return retirement;
    }
    state = "retired";
    disarmGatewaySuspendHandoff(externalRestart);
    abort.abort();
    // Fence now; join the child, preparation, and execution before replacement.
    // finishStop owns execution errors; retirement only waits for its unwind.
    retirement = Promise.all([
      stop?.dispose(),
      preparationFinished,
      execution?.catch(() => {}),
    ]).then(() => {});
    stop = undefined;
    return retirement;
  };
  const capability: GatewayHostLifecycle = {
    ...(processOwner.ownsProcessLifecycle ? { externalRestart } : {}),
    async request(action, assertCaller) {
      const assertRequest = () => {
        assertCurrent();
        if (!params.isServing()) {
          throw new Error("Gateway host is not serving this iteration. Reconnect and retry.");
        }
        if (state === "accepted" || state === "finishing") {
          throw new Error("Gateway stop is already scheduled.");
        }
        assertCaller();
      };
      let prepared: HostedGatewayStop | undefined;
      let finishPreparation: (() => void) | undefined;
      try {
        assertRequest();
        if (action === "start") {
          return ok({ outcome: "already-running" });
        }
        if (!processOwner.ownsProcessLifecycle) {
          throw new Error(
            "This Gateway host does not own the process lifecycle. Use its owning host to stop or restart it.",
          );
        }
        if (action === "restart") {
          scheduleSafeGatewayRestart({ reason: "gateway.restart.safe", delayMs: 0 });
          return ok({ outcome: "scheduled" });
        }
        if (state !== "serving") {
          throw new Error(
            "Gateway stop preparation is already in progress. Retry when it finishes.",
          );
        }
        state = "preparing";
        preparationFinished = new Promise((resolve) => {
          finishPreparation = resolve;
        });
        prepared = await prepareHostedGatewayStop(processOwner, assertRequest, abort.signal);
        assertRequest();
        // Transfer exactly this intent before closing admission. Caller/kernel
        // authority ends at close; only this private continuation crosses teardown.
        stop = prepared;
        state = "accepted";
        params.acceptStop();
        return ok({ outcome: "scheduled" });
      } catch (error) {
        await prepared?.dispose();
        if (finishPreparation && state === "preparing") {
          state = "serving";
        }
        return err(formatErrorMessage(error));
      } finally {
        finishPreparation?.();
      }
    },
  };
  return {
    capability,
    retire,
    notifyStopSignal() {
      if (state === "finishing" && params.isCurrent()) {
        // Native stop can wait for our extinction. Cancel the client, not the
        // already-drained stop, and join its close before allowing process exit.
        abort.abort(stopSignalReason);
      }
    },
    async finishStop() {
      if (state !== "accepted" || !params.isCurrent() || !stop) {
        return { outcome: "retired" as const };
      }
      state = "finishing";
      const ownsStop = () => state === "finishing" && params.isCurrent();
      try {
        execution = stop.execute(assertCurrent);
        const result = await execution;
        if (!ownsStop()) {
          return { outcome: "retired" as const };
        }
        return abort.signal.reason === stopSignalReason ? { outcome: "exit" as const } : result;
      } catch (error) {
        if (!ownsStop()) {
          return { outcome: "retired" as const };
        }
        if (abort.signal.reason === stopSignalReason) {
          return { outcome: "exit" as const };
        }
        throw error;
      } finally {
        await retire();
      }
    },
  };
}
