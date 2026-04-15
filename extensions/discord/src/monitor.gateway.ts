import type { DiscordGatewayHandle } from "./monitor/gateway-handle.js";
import {
  DiscordGatewayEvent,
  DiscordGatewayLifecycleError,
  DiscordGatewaySupervisor,
} from "./monitor/gateway-supervisor.js";

export { getDiscordGatewayEmitter } from "./monitor/gateway-supervisor.js";

export type WaitForDiscordGatewayStopParams = {
  gateway?: DiscordGatewayHandle;
  abortSignal?: AbortSignal;
  gatewaySupervisor?: Pick<DiscordGatewaySupervisor, "attachLifecycle" | "detachLifecycle">;
  onGatewayEvent?: (event: DiscordGatewayEvent) => "continue" | "stop";
  registerForceStop?: (forceStop: (err: unknown) => void) => void;
};

export async function waitForDiscordGatewayStop(
  params: WaitForDiscordGatewayStopParams,
): Promise<void> {
  const { gateway, abortSignal } = params;
  return await new Promise<void>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      abortSignal?.removeEventListener("abort", onAbort);
      params.gatewaySupervisor?.detachLifecycle();
    };
    const finishResolve = () => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        gateway?.disconnect?.();
      } finally {
        // remove listeners after disconnect so late "error" events emitted
        // during disconnect are still handled instead of becoming uncaught
        cleanup();
        resolve();
      }
    };
    const finishReject = (err: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        gateway?.disconnect?.();
      } finally {
        cleanup();
        reject(err);
      }
    };
    const onAbort = () => {
      finishResolve();
    };
    const onGatewayEvent = (event: DiscordGatewayEvent) => {
      const shouldStop = (params.onGatewayEvent?.(event) ?? "stop") === "stop";
      if (shouldStop) {
        finishReject(new DiscordGatewayLifecycleError(event));
      }
    };
    const onForceStop = (err: unknown) => {
      finishReject(err);
    };
    if (abortSignal?.aborted) {
      onAbort();
      return;
    }

    abortSignal?.addEventListener("abort", onAbort, { once: true });
    params.gatewaySupervisor?.attachLifecycle(onGatewayEvent);
    params.registerForceStop?.(onForceStop);
  });
}
