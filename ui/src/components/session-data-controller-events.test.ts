// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SessionsListResult } from "../api/types.ts";
import { publishSidebarSessionList } from "./session-data-controller-events.ts";

describe("publishSidebarSessionList", () => {
  const createOwner = () => ({
    context: undefined,
    sessionCreatedOrder: new Map<string, number>(),
    sessionResultsByAgent: {},
    sessionsResult: null,
    sessionsAgentId: null,
    sessionsLoading: false,
    sessionMutationError: null,
    expandedAgentId: () => "main",
    requestSessionDataUpdate: () => undefined,
  });

  const publish = (owner: ReturnType<typeof createOwner>, agentId: string | null, keys: string[]) =>
    publishSidebarSessionList(owner, {
      result: {
        sessions: keys.map((key, index) => ({ key, kind: "direct", updatedAt: index })),
        count: keys.length,
      } as SessionsListResult,
      agentId,
      loading: false,
      error: null,
    });

  it("keeps observed creation order only for rows in the current accumulated result", () => {
    const owner = createOwner();

    publish(owner, "main", ["first", "second"]);
    publish(owner, "main", ["second", "third"]);

    expect([...owner.sessionCreatedOrder.keys()]).toEqual(["second", "third"]);
  });

  it("keeps creation order for every retained agent result", () => {
    const owner = createOwner();

    publish(owner, "alpha", ["alpha-first", "alpha-second"]);
    publish(owner, "beta", ["beta-first"]);
    publish(owner, "alpha", ["alpha-first", "alpha-second"]);

    expect([...owner.sessionCreatedOrder.keys()]).toEqual([
      "alpha-first",
      "alpha-second",
      "beta-first",
    ]);
  });

  it("preserves promoted order for an unscoped canonical result", () => {
    const owner = createOwner();
    owner.sessionCreatedOrder.set("first", 1);
    owner.sessionCreatedOrder.set("second", 0);

    publish(owner, null, ["first", "second"]);

    expect([...owner.sessionCreatedOrder]).toEqual([
      ["first", 1],
      ["second", 0],
    ]);
  });
});
