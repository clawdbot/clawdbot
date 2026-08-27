import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { AgentsListResult } from "../api/types.ts";
import { createAgentSelectionCapability, selectApplicationSession } from "./agent-selection.ts";

function createGateway(assistantAgentId: string | null = "Main") {
  let snapshot = { client: null as GatewayBrowserClient | null, assistantAgentId };
  const listeners = new Set<(next: typeof snapshot) => void>();
  return {
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (next: typeof snapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    publish(next: typeof snapshot) {
      snapshot = next;
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

function createRoster() {
  let state = { agentsList: null as AgentsListResult | null };
  const listeners = new Set<() => void>();
  return {
    roster: {
      get state() {
        return state;
      },
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    publish(agentsList: AgentsListResult) {
      state = { agentsList };
      for (const listener of listeners) {
        listener();
      }
    },
  };
}

describe("agent selection", () => {
  it("keeps page scope separate from the concrete chat agent", () => {
    const harness = createGateway();
    const roster = createRoster();
    const selection = createAgentSelectionCapability(harness.gateway, roster.roster);

    expect(selection.state).toEqual({ selectedId: "main", scopeId: "main" });
    selection.setScope(null);
    expect(selection.state).toEqual({ selectedId: "main", scopeId: null });

    roster.publish({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "main", kind: "agent" },
        { id: "writer", kind: "agent" },
      ],
    });
    expect(selection.state).toEqual({ selectedId: "main", scopeId: null });

    selection.set("Writer");
    expect(selection.state).toEqual({ selectedId: "writer", scopeId: "writer" });
  });

  it("clears system page scopes when the typed roster becomes known", () => {
    const gateway = createGateway("OpenClaw");
    const roster = createRoster();
    const selection = createAgentSelectionCapability(gateway.gateway, roster.roster);

    expect(selection.state).toEqual({ selectedId: "openclaw", scopeId: "openclaw" });
    roster.publish({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "main", kind: "agent" },
        { id: "openclaw", kind: "system" },
      ],
    });
    expect(selection.state).toEqual({ selectedId: "openclaw", scopeId: null });

    selection.setScope("historical");
    expect(selection.state.scopeId).toBe("historical");
    selection.setScope("main");
    expect(selection.state.scopeId).toBe("main");
    selection.setScope("openclaw");
    expect(selection.state.scopeId).toBeNull();
  });

  it("adopts the Gateway default when the cold-start selection is unresolved", () => {
    const harness = createGateway("");
    const selection = createAgentSelectionCapability(harness.gateway, createRoster().roster);

    harness.publish({
      client: { request() {} } as unknown as GatewayBrowserClient,
      assistantAgentId: "Ops",
    });

    expect(selection.state).toEqual({ selectedId: "ops", scopeId: "ops" });
  });

  it("adopts the hello default published by the same gateway client", () => {
    const gateway = createGateway(null);
    const selection = createAgentSelectionCapability(gateway.gateway, createRoster().roster);
    const client = { request() {} } as unknown as GatewayBrowserClient;

    gateway.publish({ client, assistantAgentId: null });
    expect(selection.state).toEqual({ selectedId: null, scopeId: null });

    gateway.publish({ client, assistantAgentId: "Roboclaw" });
    expect(selection.state).toEqual({ selectedId: "roboclaw", scopeId: "roboclaw" });
  });

  it("does not replace an explicit pre-hello selection", () => {
    const gateway = createGateway(null);
    const selection = createAgentSelectionCapability(gateway.gateway, createRoster().roster);
    const client = { request() {} } as unknown as GatewayBrowserClient;

    gateway.publish({ client, assistantAgentId: null });
    selection.set("Research");
    gateway.publish({ client, assistantAgentId: "Roboclaw" });

    expect(selection.state).toEqual({ selectedId: "research", scopeId: "research" });
  });

  it("keeps an explicit session owner across a Gateway reconnect", () => {
    const harness = createGateway();
    const selection = createAgentSelectionCapability(harness.gateway, createRoster().roster);
    harness.publish({
      client: { request() {} } as unknown as GatewayBrowserClient,
      assistantAgentId: "Main",
    });
    selection.set("Research");

    harness.publish({
      client: { request() {} } as unknown as GatewayBrowserClient,
      assistantAgentId: "Main",
    });

    expect(selection.state).toEqual({ selectedId: "research", scopeId: "research" });
  });

  it("adopts a changed default after the reconnect null phase", () => {
    const harness = createGateway("Main");
    const roster = createRoster();
    const selection = createAgentSelectionCapability(harness.gateway, roster.roster);
    roster.publish({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main", kind: "agent" }],
    });
    const client = { request() {} } as unknown as GatewayBrowserClient;

    harness.publish({ client, assistantAgentId: null });
    expect(selection.state).toEqual({ selectedId: "main", scopeId: "main" });
    harness.publish({ client, assistantAgentId: "Ops" });
    expect(selection.state).toEqual({ selectedId: "main", scopeId: "main" });
    roster.publish({
      defaultId: "ops",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "main", kind: "agent" },
        { id: "ops", kind: "agent" },
      ],
    });

    expect(selection.state).toEqual({ selectedId: "ops", scopeId: "ops" });
  });

  it("keeps following hello after the roster repairs an invalid startup default", () => {
    const harness = createGateway("Stale");
    const roster = createRoster();
    roster.publish({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main", kind: "agent" }],
    });
    const selection = createAgentSelectionCapability(harness.gateway, roster.roster);
    const client = { request() {} } as unknown as GatewayBrowserClient;

    expect(selection.state).toEqual({ selectedId: "main", scopeId: "main" });
    harness.publish({ client, assistantAgentId: "Ops" });
    roster.publish({
      defaultId: "ops",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "main", kind: "agent" },
        { id: "ops", kind: "agent" },
      ],
    });

    expect(selection.state).toEqual({ selectedId: "ops", scopeId: "ops" });
  });

  it("preserves an explicit owner through reconnect and a changed default", () => {
    const harness = createGateway("Main");
    const selection = createAgentSelectionCapability(harness.gateway, createRoster().roster);
    selection.set("Research");
    const client = { request() {} } as unknown as GatewayBrowserClient;

    harness.publish({ client, assistantAgentId: null });
    harness.publish({ client, assistantAgentId: "Ops" });

    expect(selection.state).toEqual({ selectedId: "research", scopeId: "research" });
  });

  it("establishes explicit ownership before notifying selection subscribers", () => {
    const harness = createGateway("Main");
    const selection = createAgentSelectionCapability(harness.gateway, createRoster().roster);
    const client = { request() {} } as unknown as GatewayBrowserClient;
    selection.subscribe((state) => {
      if (state.selectedId === "research") {
        harness.publish({ client, assistantAgentId: "Ops" });
      }
    });

    selection.set("Research");

    expect(selection.state).toEqual({ selectedId: "research", scopeId: "research" });
  });

  it("follows hello again after the roster removes an explicit owner", () => {
    const harness = createGateway("Main");
    const roster = createRoster();
    roster.publish({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "main", kind: "agent" },
        { id: "research", kind: "agent" },
      ],
    });
    const selection = createAgentSelectionCapability(harness.gateway, roster.roster);
    selection.set("Research");

    roster.publish({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "main", kind: "agent" }],
    });
    expect(selection.state).toEqual({ selectedId: "main", scopeId: "main" });

    const client = { request() {} } as unknown as GatewayBrowserClient;
    harness.publish({ client, assistantAgentId: null });
    harness.publish({ client, assistantAgentId: "Ops" });
    roster.publish({
      defaultId: "ops",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "main", kind: "agent" },
        { id: "ops", kind: "agent" },
      ],
    });

    expect(selection.state).toEqual({ selectedId: "ops", scopeId: "ops" });
  });

  it("preserves a reentrant explicit owner during roster fallback", () => {
    const harness = createGateway("Main");
    const roster = createRoster();
    roster.publish({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "main", kind: "agent" },
        { id: "ops", kind: "agent" },
        { id: "research", kind: "agent" },
      ],
    });
    const selection = createAgentSelectionCapability(harness.gateway, roster.roster);
    selection.set("Research");
    selection.subscribe((state) => {
      if (state.selectedId === "main") {
        selection.set("Ops");
      }
    });

    roster.publish({
      defaultId: "main",
      mainKey: "main",
      scope: "per-sender",
      agents: [
        { id: "main", kind: "agent" },
        { id: "ops", kind: "agent" },
      ],
    });
    const client = { request() {} } as unknown as GatewayBrowserClient;
    harness.publish({ client, assistantAgentId: null });
    harness.publish({ client, assistantAgentId: "Main" });

    expect(selection.state).toEqual({ selectedId: "ops", scopeId: "ops" });
  });

  it("self-heals an unknown cold-load selection to the roster default", () => {
    const gateway = createGateway("Main");
    const roster = createRoster();
    const selection = createAgentSelectionCapability(gateway.gateway, roster.roster);

    roster.publish({
      defaultId: "Roboclaw",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "roboclaw", kind: "agent" }],
    });

    expect(selection.state).toEqual({ selectedId: "roboclaw", scopeId: "roboclaw" });

    selection.set("main");
    expect(selection.state).toEqual({ selectedId: "roboclaw", scopeId: "roboclaw" });
  });

  it("waits for the roster when the gateway has no assistant agent id", () => {
    const gateway = createGateway(null);
    const roster = createRoster();
    const selection = createAgentSelectionCapability(gateway.gateway, roster.roster);

    expect(selection.state).toEqual({ selectedId: null, scopeId: null });
    roster.publish({
      defaultId: "Roboclaw",
      mainKey: "main",
      scope: "per-sender",
      agents: [{ id: "roboclaw", kind: "agent" }],
    });

    expect(selection.state).toEqual({ selectedId: "roboclaw", scopeId: "roboclaw" });
  });
});

describe("application session selection", () => {
  it("selects the encoded agent before changing the Gateway session", () => {
    const calls: string[] = [];

    selectApplicationSession({
      selection: { set: (agentId) => calls.push(`agent:${agentId}`) },
      gateway: { setSessionKey: (sessionKey) => calls.push(`session:${sessionKey}`) },
      sessionKey: "agent:Research:work",
    });

    expect(calls).toEqual(["agent:research", "session:agent:Research:work"]);
  });

  it("uses explicit ownership for a canonical global session", () => {
    const calls: string[] = [];

    selectApplicationSession({
      selection: { set: (agentId) => calls.push(`agent:${agentId}`) },
      gateway: { setSessionKey: (sessionKey) => calls.push(`session:${sessionKey}`) },
      sessionKey: "global",
      agentId: "Research",
    });

    expect(calls).toEqual(["agent:research", "session:global"]);
  });

  it("preserves the encoded owner of an explicit global-session alias", () => {
    const calls: string[] = [];

    selectApplicationSession({
      selection: { set: (agentId) => calls.push(`agent:${agentId}`) },
      gateway: { setSessionKey: (sessionKey) => calls.push(`session:${sessionKey}`) },
      sessionKey: "agent:Research:main",
    });

    expect(calls).toEqual(["agent:research", "session:agent:Research:main"]);
  });
});
