import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { AgentsListResult } from "../api/types.ts";
import { createAgentSelectionCapability } from "./agent-selection.ts";

function createGateway(assistantAgentId = "Main") {
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
    const selection = createAgentSelectionCapability(harness.gateway, createRoster().roster);

    expect(selection.state).toEqual({ selectedId: "main", scopeId: "main" });
    selection.setScope(null);
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

  it("resets selection and scope together for a new gateway client", () => {
    const harness = createGateway();
    const selection = createAgentSelectionCapability(harness.gateway, createRoster().roster);
    selection.setScope(null);

    harness.publish({
      client: { request() {} } as unknown as GatewayBrowserClient,
      assistantAgentId: "Ops",
    });

    expect(selection.state).toEqual({ selectedId: "ops", scopeId: "ops" });
  });
});
