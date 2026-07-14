import { describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import { createAgentSelectionCapability } from "./agent-selection.ts";

function createGateway() {
  let snapshot = { client: null as GatewayBrowserClient | null, assistantAgentId: "Main" };
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

describe("agent selection", () => {
  it("keeps page scope separate from the concrete chat agent", () => {
    const harness = createGateway();
    const selection = createAgentSelectionCapability(harness.gateway);

    expect(selection.state).toEqual({ selectedId: "main", scopeId: "main" });
    selection.setScope(null);
    expect(selection.state).toEqual({ selectedId: "main", scopeId: null });

    selection.set("Writer");
    expect(selection.state).toEqual({ selectedId: "writer", scopeId: "writer" });
  });

  it("resets selection and scope together for a new gateway client", () => {
    const harness = createGateway();
    const selection = createAgentSelectionCapability(harness.gateway);
    selection.setScope(null);

    harness.publish({
      client: { request() {} } as unknown as GatewayBrowserClient,
      assistantAgentId: "Ops",
    });

    expect(selection.state).toEqual({ selectedId: "ops", scopeId: "ops" });
  });
});
