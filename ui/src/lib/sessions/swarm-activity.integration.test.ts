import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient, GatewayEventFrame, GatewayHelloOk } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import { createSessionCapability } from "./index.ts";

function sessionsResult(sessions: SessionsListResult["sessions"], ts: number): SessionsListResult {
  return {
    ts,
    path: "(multiple)",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
  };
}

function createGatewayHarness(client: GatewayBrowserClient) {
  const snapshot: {
    client: GatewayBrowserClient | null;
    connected: boolean;
    sessionKey: string;
    assistantAgentId: string | null;
    hello: GatewayHelloOk | null;
  } = {
    client,
    connected: true,
    sessionKey: "agent:main:main",
    assistantAgentId: "main",
    hello: null,
  };
  const eventListeners = new Set<(event: GatewayEventFrame) => void>();
  return {
    gateway: {
      get snapshot() {
        return snapshot;
      },
      subscribe: () => () => undefined,
      subscribeEvents(listener: (event: GatewayEventFrame) => void) {
        eventListeners.add(listener);
        return () => eventListeners.delete(listener);
      },
    },
    emitEvent: (event: GatewayEventFrame) => {
      for (const listener of eventListeners) {
        listener(event);
      }
    },
  };
}

describe("session swarm activity", () => {
  it("keeps chronological phase and log annotations across canonical refreshes", async () => {
    const parentKey = "agent:main:main";
    const groupId = "swarm:agent:main:main:turn-42";
    let rows: SessionsListResult["sessions"] = [
      { key: parentKey, kind: "direct", updatedAt: 1 },
      {
        key: "agent:main:subagent:older",
        kind: "direct",
        parentSessionKey: parentKey,
        swarmGroupId: groupId,
        status: "running",
        updatedAt: 2,
      },
    ];
    let ts = 1;
    const request = vi.fn(async (method: string) => {
      if (method !== "sessions.list") {
        throw new Error(`Unexpected request: ${method}`);
      }
      return sessionsResult(rows, ts++);
    });
    const client = { request } as unknown as GatewayBrowserClient;
    const { gateway, emitEvent } = createGatewayHarness(client);
    const sessions = createSessionCapability(gateway);
    const note = (kind: "phase" | "log", text: string) => ({
      sessionKey: parentKey,
      reason: "swarm-note",
      swarmGroupId: groupId,
      kind,
      text,
      key: parentKey,
      updatedAt: 1,
    });
    const child = (key: string, updatedAt: number) => ({
      sessionKey: key,
      reason: "create",
      key,
      kind: "direct",
      parentSessionKey: parentKey,
      swarmGroupId: groupId,
      status: "running",
      updatedAt,
    });
    const emitChanged = (payload: Record<string, unknown>) =>
      emitEvent({ type: "event", event: "sessions.changed", payload });

    await sessions.refresh({ force: true });
    emitChanged(note("phase", "Plan"));
    await waitForFast(() => expect(request).toHaveBeenCalledTimes(2));
    rows = [
      ...rows,
      {
        key: "agent:main:subagent:planner",
        kind: "direct",
        parentSessionKey: parentKey,
        swarmGroupId: groupId,
        status: "running",
        updatedAt: 3,
      },
    ];
    emitChanged(child("agent:main:subagent:planner", 3));
    await waitForFast(() =>
      expect(sessions.state.result?.sessions.some((row) => row.key.endsWith(":planner"))).toBe(
        true,
      ),
    );

    type SwarmDisplayRow = GatewaySessionRow & { swarmLog?: string; swarmPhase?: string };
    const displayRows = () => sessions.state.result?.sessions as SwarmDisplayRow[] | undefined;
    expect(displayRows()?.find((row) => row.key.endsWith(":older"))?.swarmPhase).toBeUndefined();
    expect(displayRows()?.find((row) => row.key.endsWith(":planner"))?.swarmPhase).toBe("Plan");

    emitChanged(note("log", "Planning is complete."));
    await waitForFast(() =>
      expect(
        displayRows()
          ?.filter((row) => row.swarmGroupId === groupId)
          .map((row) => row.swarmLog),
      ).toEqual(["Planning is complete.", "Planning is complete."]),
    );

    emitChanged(note("phase", "Build"));
    rows = [
      ...rows,
      {
        key: "agent:main:subagent:builder",
        kind: "direct",
        parentSessionKey: parentKey,
        swarmGroupId: groupId,
        status: "running",
        updatedAt: 4,
      },
    ];
    emitChanged(child("agent:main:subagent:builder", 4));
    await waitForFast(() =>
      expect(sessions.state.result?.sessions.some((row) => row.key.endsWith(":builder"))).toBe(
        true,
      ),
    );

    expect(displayRows()?.find((row) => row.key.endsWith(":planner"))?.swarmPhase).toBe("Plan");
    expect(displayRows()?.find((row) => row.key.endsWith(":builder"))?.swarmPhase).toBe("Build");

    // Only creation events assign an implicit phase; a later status update
    // must leave a child that predates all phase notes unphased.
    emitChanged({
      sessionKey: "agent:main:subagent:older",
      reason: "status",
      key: "agent:main:subagent:older",
      kind: "direct",
      parentSessionKey: parentKey,
      swarmGroupId: groupId,
      status: "done",
      updatedAt: 5,
    });
    await waitForFast(() =>
      expect(displayRows()?.find((row) => row.key.endsWith(":older"))?.swarmPhase).toBeUndefined(),
    );
    sessions.dispose();
  });
});
