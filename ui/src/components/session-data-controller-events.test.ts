// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SessionsListResult } from "../api/types.ts";
import { publishSidebarSessionList } from "./session-data-controller-events.ts";

describe("publishSidebarSessionList", () => {
  it("keeps observed creation order only for rows in the current accumulated result", () => {
    const owner = {
      context: undefined,
      sessionCreatedOrder: new Map<string, number>(),
      sessionResultsByAgent: {},
      sessionsResult: null,
      sessionsAgentId: null,
      sessionsLoading: false,
      sessionMutationError: null,
      expandedAgentId: () => "main",
      requestSessionDataUpdate: () => undefined,
    };
    const publish = (keys: string[]) =>
      publishSidebarSessionList(owner, {
        result: {
          sessions: keys.map((key, index) => ({ key, kind: "direct", updatedAt: index })),
          count: keys.length,
        } as SessionsListResult,
        agentId: "main",
        loading: false,
        error: null,
      });

    publish(["first", "second"]);
    publish(["second", "third"]);

    expect([...owner.sessionCreatedOrder.keys()]).toEqual(["second", "third"]);
  });
});
