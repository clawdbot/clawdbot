import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";

export type GatewayConnectionSnapshot = Pick<ApplicationGatewaySnapshot, "client" | "phase">;

export type GatewayConnectionScope = {
  readonly client: GatewayBrowserClient;
  readonly epoch: number;
};

type GatewayConnectionLifecycle = {
  readonly epoch: number;
  capture: () => GatewayConnectionScope | null;
  isCurrent: (scope: GatewayConnectionScope) => boolean;
  invalidate: () => void;
  transition: (snapshot: GatewayConnectionSnapshot) => boolean;
  dispose: () => void;
};

export function createGatewayConnectionLifecycle(
  snapshot: GatewayConnectionSnapshot,
): GatewayConnectionLifecycle {
  let client = snapshot.client;
  let connected = snapshot.phase === "connected";
  let epoch = 0;
  let disposed = false;

  return {
    get epoch() {
      return epoch;
    },
    capture() {
      return !disposed && connected && client ? { client, epoch } : null;
    },
    isCurrent(scope) {
      return !disposed && connected && client === scope.client && epoch === scope.epoch;
    },
    invalidate() {
      if (!disposed) {
        epoch += 1;
      }
    },
    transition(next) {
      if (disposed) {
        return false;
      }
      const nextConnected = next.phase === "connected";
      const changed = client !== next.client || connected !== nextConnected;
      if (changed) {
        epoch += 1;
      }
      client = next.client;
      connected = nextConnected;
      return changed;
    },
    dispose() {
      if (!disposed) {
        disposed = true;
        epoch += 1;
      }
    },
  };
}
