import { createDeferredCore } from "../../shared/deferred.js";
import type { RespondFn } from "../server-methods/response-types.js";

export type GatewayPolicyClient = {
  invalidated?: boolean;
  invalidatedReason?: string;
  socket: { close: (code: number, reason: string) => void };
};

const policyMethods = new Set([
  "config.set",
  "config.patch",
  "config.apply",
  "secrets.reload",
  "secrets.store.set",
  "secrets.store.delete",
  "device.pair.remove",
  "device.token.rotate",
  "device.token.revoke",
]);
type PolicyResponse = {
  readonly pending: boolean;
  readonly settled: Promise<void>;
  hold: () => void;
  finish: () => void;
};
type PolicyClientState = { pending: number; close?: () => void };
const responses = new WeakMap<RespondFn, PolicyResponse>();
const clients = new WeakMap<GatewayPolicyClient, PolicyClientState>();

/** The dispatcher owns response completion, including throws and handlers that return silently. */
export function registerGatewayPolicyResponse(
  method: string,
  client: GatewayPolicyClient,
  respond: RespondFn,
): PolicyResponse | undefined {
  if (!policyMethods.has(method)) {
    return undefined;
  }
  const settled = createDeferredCore();
  let state: PolicyClientState | undefined;
  const response: PolicyResponse = {
    settled: settled.promise,
    get pending() {
      return state !== undefined;
    },
    hold() {
      if (state) {
        return;
      }
      if (client.invalidated) {
        throw new Error("client authorization is no longer active");
      }
      state = clients.get(client) ?? { pending: 0 };
      state.pending++;
      clients.set(client, state);
    },
    finish() {
      // Settle on send, throw, and silent return so abandoned handlers cannot strand restart.
      settled.resolve();
      responses.delete(respond);
      if (!state) {
        return;
      }
      const completed = state;
      state = undefined;
      if (--completed.pending === 0) {
        clients.delete(client);
        completed.close?.();
      }
    },
  };
  responses.set(respond, response);
  return response;
}

/** Claim only at the mutation owner, after request validation and before publication can revoke it. */
export function holdGatewayPolicyResponse(
  respond: RespondFn | undefined,
): Pick<PolicyResponse, "settled"> | undefined {
  const response = respond ? responses.get(respond) : undefined;
  response?.hold();
  return response;
}

/** Fence authority immediately; only already accepted policy writers may send their final result. */
export function invalidateGatewayPolicyClient(
  client: GatewayPolicyClient,
  policy: { reason: string; code: number; message: string; close?: () => void },
): void {
  client.invalidated = true;
  client.invalidatedReason ??= policy.reason;
  const close = () => {
    try {
      if (policy.close) {
        policy.close();
      } else {
        client.socket.close(policy.code, policy.message);
      }
    } catch {
      // The connection may have closed independently while its write completed.
    }
  };
  const state = clients.get(client);
  if (state) {
    state.close ??= close;
  } else {
    close();
  }
}
