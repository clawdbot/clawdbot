import { describe, expect, it, vi } from "vitest";
import type { AgentsListResult } from "../../api/types.ts";
import type { ApplicationGatewaySnapshot } from "../../app/gateway.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createAgentCapability } from "./index.ts";

const cachedList: AgentsListResult = {
  defaultId: "main",
  mainKey: "home",
  scope: "per-sender",
  agents: [{ id: "main", name: "Cached name" }],
};

type Snapshot = Pick<ApplicationGatewaySnapshot, "client" | "phase" | "selfUser">;
function gatewayHarness() {
  const request = vi.fn(async () => ({
    ...cachedList,
    agents: [{ id: "main", name: "Live name" }],
  }));
  const client = createTestGatewayClient(request);
  let snapshot: Snapshot = { client: null, phase: "connecting", selfUser: null };
  const listeners = new Set<(snapshot: Snapshot) => void>();
  return {
    request,
    client,
    gateway: {
      connection: { gatewayUrl: "ws://gateway-a.example" },
      connectionRevision: 0,
      get snapshot() {
        return snapshot;
      },
      subscribe(listener: (snapshot: Snapshot) => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    publish(next: Snapshot) {
      snapshot = next;
      for (const listener of listeners) {
        listener(snapshot);
      }
    },
  };
}

describe("agent roster warm boot", () => {
  it("publishes cached defaults before connect and keeps the latest live defaults on disconnect", async () => {
    const harness = gatewayHarness();
    const liveList = {
      ...cachedList,
      defaultId: "research",
      mainKey: "workspace",
      agents: [{ id: "research", name: "Live name" }],
    };
    harness.request.mockResolvedValueOnce(liveList);
    const agents = createAgentCapability(harness.gateway, { cachedList });
    try {
      expect(agents.state.agentsList).toEqual(cachedList);
      expect(agents.state.agentsListCached).toBe(true);
      await agents.ensureList();
      expect(harness.request).not.toHaveBeenCalled();
      harness.publish({ client: harness.client, phase: "connected" });
      await agents.ensureList();
      expect(harness.request).toHaveBeenCalledExactlyOnceWith("agents.list", {});
      expect(agents.state.agentsList).toEqual(liveList);
      expect(agents.state.agentsListCached).toBe(false);
      await agents.ensureList();
      expect(harness.request).toHaveBeenCalledTimes(1);
      harness.publish({ client: null, phase: "reconnecting" });
      expect(agents.state.agentsList).toEqual(liveList);
      expect(agents.state.agentsListCached).toBe(true);
    } finally {
      agents.dispose();
    }
  });

  it.each([
    ["profile-a", "profile-b"],
    ["profile-a", null],
    [null, "profile-b"],
  ])("drops cached profile %s before loading profile %s", async (cachedProfileId, profileId) => {
    const harness = gatewayHarness();
    const agents = createAgentCapability(harness.gateway, { cachedList, cachedProfileId });
    const observed: Array<AgentsListResult | null> = [];
    const stop = harness.gateway.subscribe(() => {
      observed.push(agents.state.agentsList);
      void agents.ensureList();
    });
    try {
      harness.publish({
        client: harness.client,
        phase: "connected",
        selfUser: profileId === null ? null : { id: profileId },
      });
      expect(observed).toEqual([null]);
      expect(agents.state.agentsListCached).toBe(false);
      await agents.ensureList();
      expect(agents.state.agentsList?.agents[0]?.name).toBe("Live name");
      harness.publish({ client: null, phase: "reconnecting" });
      expect(agents.state.agentsList).toBeNull();
      expect(agents.state.agentsListCached).toBe(false);
    } finally {
      stop();
      agents.dispose();
    }
  });

  it.each(["gateway", "credentials"])(
    "discards cached agents on a %s change before hello",
    (change) => {
      const harness = gatewayHarness();
      const agents = createAgentCapability(harness.gateway, { cachedList, cachedProfileId: null });
      const listener = vi.fn();
      const stop = agents.subscribe(listener);
      try {
        expect(agents.state.agentsList).toEqual(cachedList);
        expect(agents.state.agentsListCached).toBe(true);
        if (change === "gateway") {
          harness.gateway.connection.gatewayUrl = "ws://gateway-b.example";
        } else {
          harness.gateway.connectionRevision += 1;
        }
        harness.publish({ client: null, phase: "connecting", selfUser: null });
        expect(agents.state.agentsList).toBeNull();
        expect(agents.state.agentsListCached).toBe(false);
        expect(listener).toHaveBeenLastCalledWith(
          expect.objectContaining({ agentsList: null, agentsListCached: false }),
        );
        harness.publish({ client: null, phase: "offline", selfUser: null });
        expect(agents.state.agentsList).toBeNull();
        harness.publish({ client: harness.client, phase: "connected", selfUser: null });
        expect(agents.state.agentsList).toBeNull();
      } finally {
        stop();
        agents.dispose();
      }
    },
  );

  it("keeps matching cached profile data until the live list arrives", () => {
    const harness = gatewayHarness();
    const agents = createAgentCapability(harness.gateway, {
      cachedList,
      cachedProfileId: "profile-a",
    });
    try {
      harness.publish({
        client: harness.client,
        phase: "connected",
        selfUser: { id: "profile-a" },
      });
      expect(agents.state.agentsList).toEqual(cachedList);
      expect(agents.state.agentsListCached).toBe(true);
      expect(harness.request).not.toHaveBeenCalled();
    } finally {
      agents.dispose();
    }
  });
});
