// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { SessionsListResult } from "../api/types.ts";
import { publishSidebarSessionList } from "./session-data-controller-events.ts";

describe("publishSidebarSessionList", () => {
  const createOwner = () => ({
    context: undefined,
    sessionResultsByAgent: {} as Record<string, SessionsListResult>,
    sessionsResult: null as SessionsListResult | null,
    sessionsAgentId: null as string | null,
    sessionsLoading: false,
    sessionMutationError: null,
    expandedAgentId: () => "main",
    sessionListQuery: (agentId: string) => ({ agentId }),
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

  it("replaces the current agent's accumulated session result", () => {
    const owner = createOwner();

    publish(owner, "main", ["first", "second"]);
    publish(owner, "main", ["second", "third"]);

    expect(owner.sessionsAgentId).toBe("main");
    expect(owner.sessionsResult?.sessions.map((row) => row.key)).toEqual(["second", "third"]);
    expect(owner.sessionResultsByAgent.main).toBe(owner.sessionsResult);
  });

  it("keeps the latest scoped session result for every cached agent", () => {
    const owner = createOwner();

    publish(owner, "alpha", ["alpha-first", "alpha-second"]);
    publish(owner, "beta", ["beta-first"]);
    publish(owner, "alpha", ["alpha-second"]);

    expect(owner.sessionsAgentId).toBe("alpha");
    expect(owner.sessionResultsByAgent.alpha?.sessions.map((row) => row.key)).toEqual([
      "alpha-second",
    ]);
    expect(owner.sessionResultsByAgent.beta?.sessions.map((row) => row.key)).toEqual([
      "beta-first",
    ]);
  });

  it("keeps cached agent results while an uncached agent has no result", () => {
    const owner = createOwner();

    publish(owner, "alpha", ["alpha-first", "alpha-second"]);
    publishSidebarSessionList(owner, {
      result: null,
      agentId: "beta",
      loading: true,
      error: null,
    });

    expect(owner.sessionsAgentId).toBe("beta");
    expect(owner.sessionsResult).toBeNull();
    expect(owner.sessionResultsByAgent.alpha?.sessions.map((row) => row.key)).toEqual([
      "alpha-first",
      "alpha-second",
    ]);
    expect(owner.sessionResultsByAgent.beta).toBeUndefined();
  });
});
