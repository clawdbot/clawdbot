import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentIdentityResult } from "../../api/types.ts";
import type { ApplicationGatewayPhase } from "../../app/gateway.ts";
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
  let snapshot: { client: GatewayBrowserClient | null; phase: ApplicationGatewayPhase } = {
    client,
    phase: "connected",
  };
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
    snapshot = { client, phase: connected ? "connected" : "reconnecting" };
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

it("rejects an in-flight identity after that agent is invalidated", async () => {
  const staleRequest = deferred<AgentIdentityResult>();
  const currentRequest = deferred<AgentIdentityResult>();
  const request = vi
    .fn()
    .mockImplementationOnce(() => staleRequest.promise)
    .mockImplementationOnce(() => currentRequest.promise);
  const client = { request } as unknown as GatewayBrowserClient;
  const capability = createAgentIdentityCapability({
    snapshot: { client, phase: "connected" as const },
    subscribe: () => () => undefined,
  });

  const stale = capability.ensure(["main"]);
  capability.invalidate(["main"]);
  const current = capability.ensure(["main"]);

  staleRequest.resolve({ agentId: "main", name: "Stale" } as AgentIdentityResult);
  await stale;
  expect(capability.entries()).toEqual([]);

  currentRequest.resolve({ agentId: "main", name: "Current" } as AgentIdentityResult);
  await current;
  expect(capability.get("main")?.name).toBe("Current");
});

it("publishes each fetched snapshot once under overlapping roster and stream updates", async () => {
  const pending = deferred<AgentIdentityResult>();
  const ids = Array.from({ length: 24 }, (_, index) => `agent-${index}`);
  const request = vi.fn((_method: string, { agentId }: { agentId: string }) =>
    pending.promise.then(() => ({ agentId, name: agentId })),
  );
  const capability = createAgentIdentityCapability({
    snapshot: { client: { request } as unknown as GatewayBrowserClient, phase: "connected" },
    subscribe: () => () => undefined,
  });
  const publish = vi.fn();
  capability.subscribe(publish);
  const updates = Array.from({ length: 40 }, () => capability.ensure(ids));
  pending.resolve({ agentId: ids[0], name: ids[0] } as AgentIdentityResult);
  await Promise.all(updates);
  expect(request).toHaveBeenCalledTimes(ids.length);
  expect(capability.entries()).toHaveLength(ids.length);
  expect(publish).toHaveBeenCalledTimes(1);
  await capability.ensure(ids);
  expect(publish).toHaveBeenCalledTimes(1);
});
