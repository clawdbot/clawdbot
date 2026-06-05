// Sessions access tests cover session-tool visibility policy, sandbox clamps,
// and agent-to-agent allow rules.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  createSessionVisibilityRowChecker,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxSessionToolsVisibility,
  resolveSessionToolsVisibility,
} from "../../plugin-sdk/session-visibility.js";
import { resolveSandboxedSessionToolContext } from "./sessions-access.js";
import { testing as sessionsResolutionTesting } from "./sessions-resolution.js";

describe("resolveSessionToolsVisibility", () => {
  it("defaults to tree when unset or invalid", () => {
    expect(resolveSessionToolsVisibility({} as unknown as OpenClawConfig)).toBe("tree");
    expect(
      resolveSessionToolsVisibility({
        tools: { sessions: { visibility: "invalid" } },
      } as unknown as OpenClawConfig),
    ).toBe("tree");
  });

  it("accepts known visibility values case-insensitively", () => {
    expect(
      resolveSessionToolsVisibility({
        tools: { sessions: { visibility: "ALL" } },
      } as unknown as OpenClawConfig),
    ).toBe("all");
  });
});

describe("resolveEffectiveSessionToolsVisibility", () => {
  it("clamps to tree in sandbox when sandbox visibility is spawned", () => {
    const cfg = {
      tools: { sessions: { visibility: "all" } },
      agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
    } as unknown as OpenClawConfig;
    expect(resolveEffectiveSessionToolsVisibility({ cfg, sandboxed: true })).toBe("tree");
  });

  it("preserves visibility when sandbox clamp is all", () => {
    const cfg = {
      tools: { sessions: { visibility: "all" } },
      agents: { defaults: { sandbox: { sessionToolsVisibility: "all" } } },
    } as unknown as OpenClawConfig;
    expect(resolveEffectiveSessionToolsVisibility({ cfg, sandboxed: true })).toBe("all");
  });
});

describe("sandbox session-tools context", () => {
  it("defaults sandbox visibility clamp to spawned", () => {
    expect(resolveSandboxSessionToolsVisibility({} as unknown as OpenClawConfig)).toBe("spawned");
  });

  it("restricts non-subagent sandboxed sessions to spawned visibility", () => {
    const cfg = {
      tools: { sessions: { visibility: "all" } },
      agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
    } as unknown as OpenClawConfig;
    const context = resolveSandboxedSessionToolContext({
      cfg,
      agentSessionKey: "agent:main:main",
      sandboxed: true,
    });

    expect(context.restrictToSpawned).toBe(true);
    expect(context.requesterInternalKey).toBe("agent:main:main");
    expect(context.effectiveRequesterKey).toBe("agent:main:main");
  });

  it("does not restrict subagent sessions in sandboxed mode", () => {
    const cfg = {
      tools: { sessions: { visibility: "all" } },
      agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
    } as unknown as OpenClawConfig;
    const context = resolveSandboxedSessionToolContext({
      cfg,
      agentSessionKey: "agent:main:subagent:abc",
      sandboxed: true,
    });

    expect(context.restrictToSpawned).toBe(false);
    expect(context.requesterInternalKey).toBe("agent:main:subagent:abc");
  });
});

describe("createAgentToAgentPolicy", () => {
  it("denies cross-agent access when disabled", () => {
    const policy = createAgentToAgentPolicy({} as unknown as OpenClawConfig);
    expect(policy.enabled).toBe(false);
    expect(policy.isAllowed("main", "main")).toBe(true);
    expect(policy.isAllowed("main", "ops")).toBe(false);
  });

  it("honors allow patterns when enabled", () => {
    const policy = createAgentToAgentPolicy({
      tools: {
        agentToAgent: {
          enabled: true,
          allow: ["ops-*", "main"],
        },
      },
    } as unknown as OpenClawConfig);

    expect(policy.isAllowed("ops-a", "ops-b")).toBe(true);
    expect(policy.isAllowed("main", "ops-a")).toBe(true);
    expect(policy.isAllowed("guest", "ops-a")).toBe(false);
  });

  it("matches wildcard patterns case-insensitively", () => {
    const policy = createAgentToAgentPolicy({
      tools: {
        agentToAgent: {
          enabled: true,
          allow: ["Ops-*"],
        },
      },
    } as unknown as OpenClawConfig);

    expect(policy.matchesAllow("ops-worker")).toBe(true);
    expect(policy.matchesAllow("OPS-WORKER")).toBe(true);
    expect(policy.matchesAllow("guest")).toBe(false);
  });

  it("keeps exact allow patterns case-sensitive", () => {
    const policy = createAgentToAgentPolicy({
      tools: {
        agentToAgent: {
          enabled: true,
          allow: ["Ops"],
        },
      },
    } as unknown as OpenClawConfig);

    expect(policy.matchesAllow("Ops")).toBe(true);
    expect(policy.matchesAllow("ops")).toBe(false);
  });

  it("keeps blank configured allow patterns fail-closed", () => {
    const policy = createAgentToAgentPolicy({
      tools: {
        agentToAgent: {
          enabled: true,
          allow: [" "],
        },
      },
    } as unknown as OpenClawConfig);

    expect(policy.matchesAllow("ops")).toBe(false);
    expect(policy.isAllowed("main", "ops")).toBe(false);
  });

  it("handles interior wildcards", () => {
    const policy = createAgentToAgentPolicy({
      tools: {
        agentToAgent: {
          enabled: true,
          allow: ["team-*-prod"],
        },
      },
    } as unknown as OpenClawConfig);

    expect(policy.matchesAllow("team-ops-prod")).toBe(true);
    expect(policy.matchesAllow("team-dev-prod")).toBe(true);
    expect(policy.matchesAllow("team-ops-staging")).toBe(false);
    expect(policy.matchesAllow("team-prod")).toBe(false);
  });

  it("handles multiple wildcards without polynomial backtracking", () => {
    // Allow patterns use segment matching rather than a greedy regex so
    // adversarial agent ids cannot cause slow policy checks.
    const policy = createAgentToAgentPolicy({
      tools: {
        agentToAgent: {
          enabled: true,
          allow: ["*a*b*c*d*e*"],
        },
      },
    } as unknown as OpenClawConfig);

    // Positive match
    expect(policy.matchesAllow("xaxbxcxdxe")).toBe(true);

    // Negative match with adversarial input that would cause O(n^k)
    // backtracking with the old `^.*a.*b.*c.*d.*e.*$` regex.
    const adversarial = "a".repeat(200) + "b".repeat(200) + "c".repeat(200) + "d".repeat(200);
    const start = performance.now();
    expect(policy.matchesAllow(adversarial)).toBe(false);
    const elapsed = performance.now() - start;
    // The old regex could take seconds; the segment matcher finishes sub-ms.
    expect(elapsed).toBeLessThan(50);
  });

  it("rejects when suffix overlaps prefix", () => {
    const policy = createAgentToAgentPolicy({
      tools: {
        agentToAgent: {
          enabled: true,
          allow: ["abc*xyz"],
        },
      },
    } as unknown as OpenClawConfig);

    expect(policy.matchesAllow("abcxyz")).toBe(true);
    expect(policy.matchesAllow("abc-middle-xyz")).toBe(true);
    expect(policy.matchesAllow("ab")).toBe(false);
  });

  it("treats regex syntax as literal text in wildcard patterns", () => {
    const policy = createAgentToAgentPolicy({
      tools: {
        agentToAgent: {
          enabled: true,
          allow: ["ops.[prod]*"],
        },
      },
    } as unknown as OpenClawConfig);

    expect(policy.matchesAllow("OPS.[PROD]-worker")).toBe(true);
    expect(policy.matchesAllow("opsXprod-worker")).toBe(false);
  });
});

describe("createSessionVisibilityGuard", () => {
  it("allows cross-agent spawned child rows in list results with tree visibility", () => {
    const guard = createSessionVisibilityRowChecker({
      action: "list",
      requesterSessionKey: "agent:main:main",
      visibility: "tree",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
    });

    expect(
      guard.check({
        key: "agent:codex:acp:child-1",
        spawnedBy: "agent:main:main",
      }),
    ).toEqual({ allowed: true });
  });

  it("allows cross-agent spawned child rows in all-visibility list results when a2a is disabled", () => {
    const guard = createSessionVisibilityRowChecker({
      action: "list",
      requesterSessionKey: "agent:main:main",
      visibility: "all",
      a2aPolicy: createAgentToAgentPolicy({
        tools: { agentToAgent: { enabled: false } },
      } as unknown as OpenClawConfig),
    });

    expect(
      guard.check({
        key: "agent:codex:acp:child-1",
        spawnedBy: "agent:main:main",
      }),
    ).toEqual({ allowed: true });
  });

  it("keeps agent visibility same-agent-only for cross-agent owned child rows", () => {
    const guard = createSessionVisibilityRowChecker({
      action: "list",
      requesterSessionKey: "agent:main:main",
      visibility: "agent",
      a2aPolicy: createAgentToAgentPolicy({
        tools: { agentToAgent: { enabled: true, allow: ["main", "codex"] } },
      } as unknown as OpenClawConfig),
    });

    expect(
      guard.check({
        key: "agent:codex:acp:child-1",
        spawnedBy: "agent:main:main",
      }),
    ).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Session list visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access.",
    });
  });

  it("does not do spawned lookup for list visibility without row metadata", async () => {
    const callGateway = vi.fn(async () => ({
      sessions: [{ key: "agent:codex:acp:child-1" }],
    }));
    sessionsResolutionTesting.setDepsForTest({
      callGateway: callGateway as never,
    });

    const guard = await createSessionVisibilityGuard({
      action: "list",
      requesterSessionKey: "agent:main:main",
      visibility: "tree",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
    });

    expect(guard.check("agent:codex:acp:child-1").allowed).toBe(false);
    expect(callGateway).not.toHaveBeenCalled();

    sessionsResolutionTesting.setDepsForTest();
  });

  it("allows cross-agent spawned child sessions with tree visibility", async () => {
    sessionsResolutionTesting.setDepsForTest({
      callGateway: vi.fn(async (request: { method?: string; params?: { spawnedBy?: string } }) => {
        if (request.method === "sessions.list") {
          expect(request.params?.spawnedBy).toBe("agent:main:main");
          return {
            sessions: [{ key: "agent:codex:acp:child-1" }],
          };
        }
        return {};
      }) as never,
    });

    const guard = await createSessionVisibilityGuard({
      action: "history",
      requesterSessionKey: "agent:main:main",
      visibility: "tree",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
    });

    expect(guard.check("agent:codex:acp:child-1")).toEqual({ allowed: true });

    sessionsResolutionTesting.setDepsForTest();
  });

  it("keeps self visibility restricted even for spawned child sessions", async () => {
    const guard = await createSessionVisibilityGuard({
      action: "history",
      requesterSessionKey: "agent:main:main",
      visibility: "self",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
    });

    expect(guard.check("agent:codex:acp:child-1")).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Session history visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access.",
    });
  });

  it("allows cross-agent spawned child sessions before agent-to-agent checks with all visibility", async () => {
    sessionsResolutionTesting.setDepsForTest({
      callGateway: vi.fn(async (request: { method?: string; params?: { spawnedBy?: string } }) => {
        if (request.method === "sessions.list") {
          expect(request.params?.spawnedBy).toBe("agent:main:main");
          return {
            sessions: [{ key: "agent:codex:acp:child-1" }],
          };
        }
        return {};
      }) as never,
    });

    const guard = await createSessionVisibilityGuard({
      action: "send",
      requesterSessionKey: "agent:main:main",
      visibility: "all",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
    });

    expect(guard.check("agent:codex:acp:child-1")).toEqual({ allowed: true });

    sessionsResolutionTesting.setDepsForTest();
  });

  it("allows cross-agent spawned child status before agent-to-agent checks with all visibility", async () => {
    sessionsResolutionTesting.setDepsForTest({
      callGateway: vi.fn(async (request: { method?: string; params?: { spawnedBy?: string } }) => {
        if (request.method === "sessions.list") {
          expect(request.params?.spawnedBy).toBe("agent:main:main");
          return {
            sessions: [{ key: "agent:codex:acp:child-1" }],
          };
        }
        return {};
      }) as never,
    });

    const guard = await createSessionVisibilityGuard({
      action: "status",
      requesterSessionKey: "agent:main:main",
      visibility: "all",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
    });

    expect(guard.check("agent:codex:acp:child-1")).toEqual({ allowed: true });

    sessionsResolutionTesting.setDepsForTest();
  });

  it("does not block exact same-agent spawned targets that fall past the spawned list cap", async () => {
    sessionsResolutionTesting.setDepsForTest({
      callGateway: vi.fn(async (request: { method?: string; params?: { key?: string } }) => {
        if (request.method === "sessions.resolve") {
          return { key: request.params?.key };
        }
        if (request.method === "sessions.list") {
          return {
            sessions: [
              ...Array.from({ length: 500 }, (_, index) => ({
                key: `agent:main:subagent:worker-${index}`,
              })),
              { key: "agent:main:subagent:worker-999" },
            ],
          };
        }
        return {};
      }) as never,
    });

    const guard = await createSessionVisibilityGuard({
      action: "history",
      requesterSessionKey: "agent:main:main",
      visibility: "tree",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
    });

    expect(guard.check("agent:main:subagent:worker-999")).toEqual({ allowed: true });

    sessionsResolutionTesting.setDepsForTest();
  });

  it("blocks cross-agent send when agent-to-agent is disabled", async () => {
    const guard = await createSessionVisibilityGuard({
      action: "send",
      requesterSessionKey: "agent:main:main",
      visibility: "all",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
    });

    expect(guard.check("agent:ops:main")).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
    });
  });

  it("enforces self visibility for same-agent sessions", async () => {
    const guard = await createSessionVisibilityGuard({
      action: "history",
      requesterSessionKey: "agent:main:main",
      visibility: "self",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
    });

    expect(guard.check("agent:main:main")).toEqual({ allowed: true });
    expect(guard.check("agent:main:forum:group:1")).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Session history visibility is restricted to the current session (tools.sessions.visibility=self).",
    });
  });
});
