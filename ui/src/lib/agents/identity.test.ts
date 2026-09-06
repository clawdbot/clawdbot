import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { AgentIdentityResult } from "../../api/types.ts";
import type { ApplicationGatewayPhase } from "../../app/gateway.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createAgentIdentityCapability } from "./identity.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

it("rejects stale identities after reconnecting the same client", async () => {
  const oldRequest = createDeferred<AgentIdentityResult>();
  const currentRequest = createDeferred<AgentIdentityResult>();
  const request = vi
    .fn()
    .mockImplementationOnce(() => oldRequest.promise)
    .mockImplementationOnce(() => currentRequest.promise);
  const client = createTestGatewayClient(request);
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

  oldRequest.resolve({ agentId: "main", name: "Stale", avatar: "" });
  await stale;
  expect(capability.entries()).toEqual([]);

  currentRequest.resolve({ agentId: "main", name: "Current", avatar: "" });
  await current;
  expect(capability.get("main")?.name).toBe("Current");
});

it("rejects an in-flight identity after that agent is invalidated", async () => {
  const staleRequest = createDeferred<AgentIdentityResult>();
  const currentRequest = createDeferred<AgentIdentityResult>();
  const request = vi
    .fn()
    .mockImplementationOnce(() => staleRequest.promise)
    .mockImplementationOnce(() => currentRequest.promise);
  const client = createTestGatewayClient(request);
  const capability = createAgentIdentityCapability({
    snapshot: { client, phase: "connected" },
    subscribe: () => () => undefined,
  });

  const stale = capability.ensure(["main"]);
  capability.invalidate(["main"]);
  const current = capability.ensure(["main"]);

  staleRequest.resolve({ agentId: "main", name: "Stale", avatar: "" });
  await stale;
  expect(capability.entries()).toEqual([]);

  currentRequest.resolve({ agentId: "main", name: "Current", avatar: "" });
  await current;
  expect(capability.get("main")?.name).toBe("Current");
});

it("publishes each fetched snapshot once under overlapping roster and stream updates", async () => {
  const pending = createDeferred();
  const ids = Array.from({ length: 24 }, (_, index) => `agent-${index}`);
  const request = vi.fn((_method: string, params: unknown) => {
    const { agentId } = params as { agentId: string };
    return pending.promise.then(() => ({ agentId, name: agentId, avatar: "" }));
  });
  const capability = createAgentIdentityCapability({
    snapshot: { client: createTestGatewayClient(request), phase: "connected" },
    subscribe: () => () => undefined,
  });
  const publish = vi.fn();
  capability.subscribe(publish);
  const updates = Array.from({ length: 40 }, () => capability.ensure(ids));
  pending.resolve();
  await Promise.all(updates);
  expect(request).toHaveBeenCalledTimes(ids.length);
  expect(capability.entries()).toHaveLength(ids.length);
  expect(publish).toHaveBeenCalledTimes(1);
  await capability.ensure(ids);
  expect(publish).toHaveBeenCalledTimes(1);
});

it("shares identity requests between the sidebar and the selected chat", async () => {
  const { fetchAssistantIdentity } = await import("../../app/assistant-identity.ts");
  const result = { agentId: "main", name: "Main", avatar: "/avatar/main?v=1" };
  const request = vi.fn().mockResolvedValue(result);
  const client = createTestGatewayClient(request);
  const capability = createAgentIdentityCapability({
    snapshot: { client, phase: "connected" },
    subscribe: () => () => undefined,
  });

  const [, assistant] = await Promise.all([
    capability.ensure(["main"]),
    fetchAssistantIdentity(client, "main"),
  ]);
  expect(capability.get("main")?.avatar).toBe(result.avatar);
  expect(assistant?.avatar).toBe(result.avatar);
  expect(request).toHaveBeenCalledOnce();
});

it.each(["sidebar", "chat"])(
  "revalidates a replaced avatar without events when %s refreshes first",
  async (first) => {
    const { fetchAssistantIdentity } = await import("../../app/assistant-identity.ts");
    const clock = vi.spyOn(Date, "now").mockReturnValue(0);
    const oldIdentity = { agentId: "main", name: "Main", avatar: "/avatar/main?v=old" };
    const replacement = { ...oldIdentity, avatar: "/avatar/main?v=replaced" };
    const refresh = createDeferred<AgentIdentityResult>();
    const request = vi.fn().mockResolvedValueOnce(oldIdentity).mockReturnValueOnce(refresh.promise);
    const client = createTestGatewayClient(request);
    const capability = createAgentIdentityCapability({
      snapshot: { client, phase: "connected" },
      subscribe: () => () => undefined,
    });
    const publish = vi.fn();
    capability.subscribe(publish);
    await capability.ensure(["main"]);
    clock.mockReturnValue(59_999);
    await Promise.all([capability.ensure(["main"]), fetchAssistantIdentity(client, "main")]);
    expect(request).toHaveBeenCalledOnce();

    clock.mockReturnValue(60_000);
    const firstRefresh =
      first === "sidebar" ? capability.ensure(["main"]) : fetchAssistantIdentity(client, "main");
    // A slow refresh stays shared even past another freshness window.
    clock.mockReturnValue(120_001);
    const waitingChat = fetchAssistantIdentity(client, "main");
    expect(request).toHaveBeenCalledTimes(2);
    expect(capability.get("main")?.avatar).toBe(oldIdentity.avatar);
    refresh.resolve(replacement);
    await firstRefresh;
    expect((await waitingChat)?.avatar).toBe(replacement.avatar);
    // A chat-first completion must update the sidebar's older projection too.
    await capability.ensure(["main"]);
    expect(capability.get("main")?.avatar).toBe(replacement.avatar);
    expect(request).toHaveBeenCalledTimes(2);
    expect(publish).toHaveBeenCalledTimes(2);
    clock.mockReturnValue(180_000);
    await Promise.all([capability.ensure(["main"]), fetchAssistantIdentity(client, "main")]);
    expect(request).toHaveBeenCalledTimes(2);
  },
);
