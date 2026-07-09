import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentIdentityResult } from "../../api/types.ts";
import { createAgentIdentityCapability } from "./identity.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

it("rejects stale identities after reconnecting the same client", async () => {
  const oldRequest = deferred<AgentIdentityResult>();
  const currentRequest = deferred<AgentIdentityResult>();
  const request = vi
    .fn()
    .mockImplementationOnce(() => oldRequest.promise)
    .mockImplementationOnce(() => currentRequest.promise);
  const client = { request } as unknown as GatewayBrowserClient;
  let snapshot = { client, connected: true };
  const listeners = new Set<(next: typeof snapshot) => void>();
  const capability = createAgentIdentityCapability({
    get snapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  const publish = (connected: boolean) => {
    snapshot = { client, connected };
    for (const listener of listeners) {
      listener(snapshot);
    }
  };

  const stale = capability.ensure(["main"]);
  publish(false);
  publish(true);
  const current = capability.ensure(["main"]);

  oldRequest.resolve({ agentId: "main", name: "Stale" } as AgentIdentityResult);
  await stale;
  expect(capability.entries()).toEqual([]);

  currentRequest.resolve({ agentId: "main", name: "Current" } as AgentIdentityResult);
  await current;
  expect(capability.get("main")?.name).toBe("Current");
});
