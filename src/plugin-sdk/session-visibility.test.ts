import { describe, expect, it } from "vitest";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityChecker,
  createSessionVisibilityRowChecker,
} from "./session-visibility.js";

describe("scoped session access providers", () => {
  it("does not assign an unscoped default-agent row to a non-default requester", () => {
    const checker = createSessionVisibilityChecker({
      action: "history",
      defaultAgentId: "main",
      requesterAgentId: "work",
      requesterSessionKey: "agent:work:main",
      visibility: "agent",
      a2aPolicy: createAgentToAgentPolicy({}),
      spawnedKeys: null,
    });

    expect(checker.check("main")).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Session history visibility is restricted. Set tools.sessions.visibility=all and tools.agentToAgent.enabled=true to allow cross-agent access; use tools.agentToAgent.allow to restrict permitted agent pairs.",
    });
  });

  it("fails closed for an unscoped row without configured ownership", () => {
    const checker = createSessionVisibilityChecker({
      action: "history",
      requesterAgentId: "work",
      requesterSessionKey: "agent:work:main",
      visibility: "all",
      a2aPolicy: createAgentToAgentPolicy({}),
      spawnedKeys: null,
    });

    expect(checker.check("main")).toEqual({
      allowed: false,
      status: "forbidden",
      error: "Session history denied because target agent ownership is unavailable.",
    });
  });

  it("keeps exact and current self aliases available without a configured default", () => {
    const checker = createSessionVisibilityChecker({
      action: "history",
      requesterAgentId: "work",
      requesterSessionKey: "main",
      visibility: "self",
      a2aPolicy: createAgentToAgentPolicy({}),
      spawnedKeys: null,
    });

    expect(checker.check("main")).toEqual({ allowed: true });
    expect(checker.check("current")).toEqual({ allowed: true });
  });

  it("keeps explicit row ownership authoritative when a bare key matches the requester", () => {
    const checker = createSessionVisibilityRowChecker({
      action: "history",
      defaultAgentId: "main",
      requesterAgentId: "work",
      requesterSessionKey: "main",
      visibility: "agent",
      a2aPolicy: createAgentToAgentPolicy({}),
    });

    expect(checker.check({ key: "main", agentId: "main" })).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Session history visibility is restricted. Set tools.sessions.visibility=all and tools.agentToAgent.enabled=true to allow cross-agent access; use tools.agentToAgent.allow to restrict permitted agent pairs.",
    });
  });

  it("resolves a bare requester alias through the configured default before row metadata exists", () => {
    const checker = createSessionVisibilityRowChecker({
      action: "send",
      defaultAgentId: "main",
      requesterAgentId: "work",
      requesterSessionKey: "main",
      visibility: "agent",
      a2aPolicy: createAgentToAgentPolicy({}),
    });

    expect(checker.check({ key: "main" })).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Session send visibility is restricted. Set tools.sessions.visibility=all and tools.agentToAgent.enabled=true to allow cross-agent access; use tools.agentToAgent.allow to restrict permitted agent pairs.",
    });
  });

  it("keeps the current alias requester-owned when a configured default exists", () => {
    const checker = createSessionVisibilityRowChecker({
      action: "history",
      defaultAgentId: "main",
      requesterAgentId: "work",
      requesterSessionKey: "agent:work:main",
      visibility: "self",
      a2aPolicy: createAgentToAgentPolicy({}),
    });

    expect(checker.check({ key: "current" })).toEqual({ allowed: true });
  });

  it("grants only the exact requester, target, and action supplied by a provider", () => {
    const makeChecker = (action: "history" | "send") =>
      createSessionVisibilityChecker({
        action,
        requesterAgentId: "main",
        requesterSessionKey: "agent:main:clickclack:channel:discussion",
        visibility: "tree",
        a2aPolicy: createAgentToAgentPolicy({}),
        spawnedKeys: new Set(),
      });
    const history = makeChecker("history");
    const send = makeChecker("send");
    const target = "agent:main:main";

    expect(history.check(target).allowed).toBe(false);
    const unregister = createSessionVisibilityChecker.registerScopedAccessProvider((request) =>
      request.action === "history" &&
      request.requesterSessionKey === "agent:main:clickclack:channel:discussion" &&
      request.targetSessionKey === target
        ? { expectedSessionId: "main-incarnation" }
        : undefined,
    );
    try {
      expect(history.check(target)).toEqual({
        allowed: true,
        expectedSessionId: "main-incarnation",
      });
      expect(send.check(target).allowed).toBe(false);
      expect(history.check("agent:main:other").allowed).toBe(false);
    } finally {
      unregister();
    }
    expect(history.check(target).allowed).toBe(false);
  });

  it("fails closed when a provider throws", () => {
    const unregister = createSessionVisibilityChecker.registerScopedAccessProvider(() => {
      throw new Error("provider failure");
    });
    try {
      const checker = createSessionVisibilityChecker({
        action: "status",
        requesterAgentId: "main",
        requesterSessionKey: "agent:main:requester",
        visibility: "self",
        a2aPolicy: createAgentToAgentPolicy({}),
        spawnedKeys: null,
      });
      expect(checker.check("agent:main:target").allowed).toBe(false);
    } finally {
      unregister();
    }
  });
});
