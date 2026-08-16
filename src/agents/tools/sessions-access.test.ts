// Sessions access tests cover session-tool visibility policy, sandbox clamps,
// and agent-to-agent allow rules.
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import { GatewayCredentialsRequiredError } from "../../gateway/call.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityChecker,
  createSessionVisibilityGuard,
  createSessionVisibilityRowChecker,
  resolveEffectiveSessionToolsVisibility,
  resolveSandboxSessionToolsVisibility,
  resolveSessionToolsVisibility,
} from "../../plugin-sdk/session-visibility.js";
import {
  listAmbientGroupWatchTargets,
  registerMainSessionGroupWatch,
  registerSessionStateWatch,
} from "../../sessions/session-state-events.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveSandboxedSessionToolContext, resolveSessionToolAccess } from "./sessions-access.js";

const loggerMocks = vi.hoisted(() => ({ logWarn: vi.fn() }));
vi.mock("../../logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../logger.js")>()),
  logWarn: loggerMocks.logWarn,
}));

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
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("allows watched group reads under tree while denying unwatched peers", () => {
    const stateDir = tempDirs.make("openclaw-session-visibility-");
    closeOpenClawStateDatabaseForTest();
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    try {
      const requesterSessionKey = "agent:main:main";
      const watchedSessionKey = "agent:main:telegram:group:watched";
      expect(
        registerMainSessionGroupWatch({
          sessionKey: watchedSessionKey,
          agentId: "main",
          entry: { sessionId: "watched", updatedAt: Date.now(), chatType: "group" },
          dmScope: "main",
        }),
      ).toBe(true);
      const crossAgentSessionKey = "agent:ops:telegram:group:watched";
      registerSessionStateWatch({
        watcherSessionKey: requesterSessionKey,
        targetSessionKey: crossAgentSessionKey,
      });
      const explicitDirectSessionKey = "agent:main:coordinator";
      registerSessionStateWatch({
        watcherSessionKey: requesterSessionKey,
        targetSessionKey: explicitDirectSessionKey,
      });
      expect(listAmbientGroupWatchTargets(requesterSessionKey)).toEqual(
        new Set([watchedSessionKey]),
      );
      const guard = createSessionVisibilityRowChecker({
        action: "history",
        requesterSessionKey,
        visibility: "tree",
        a2aPolicy: createAgentToAgentPolicy({} as OpenClawConfig),
      });

      expect(guard.check({ key: watchedSessionKey })).toEqual({ allowed: true });
      expect(guard.check({ key: "agent:main:telegram:group:unwatched" })).toEqual({
        allowed: false,
        status: "forbidden",
        error:
          "Session history visibility is restricted to the current session tree and any watched same-agent group sessions (tools.sessions.visibility=tree).",
      });
      expect(guard.check({ key: explicitDirectSessionKey })).toEqual({
        allowed: false,
        status: "forbidden",
        error:
          "Session history visibility is restricted to the current session tree and any watched same-agent group sessions (tools.sessions.visibility=tree).",
      });
      expect(guard.check({ key: crossAgentSessionKey })).toEqual({
        allowed: false,
        status: "forbidden",
        error:
          "Session history visibility is restricted. Set tools.sessions.visibility=all and tools.agentToAgent.enabled=true to allow cross-agent access; use tools.agentToAgent.allow to restrict permitted agent pairs.",
      });
      const sendGuard = createSessionVisibilityRowChecker({
        action: "send",
        requesterSessionKey,
        visibility: "tree",
        a2aPolicy: createAgentToAgentPolicy({} as OpenClawConfig),
      });
      expect(sendGuard.check({ key: watchedSessionKey })).toEqual({
        allowed: false,
        status: "forbidden",
        error:
          "Session send visibility is restricted to the current session tree (tools.sessions.visibility=tree).",
      });
    } finally {
      closeOpenClawStateDatabaseForTest();
      vi.unstubAllEnvs();
    }
  });

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
        "Session list visibility is restricted. Set tools.sessions.visibility=all and tools.agentToAgent.enabled=true to allow cross-agent access; use tools.agentToAgent.allow to restrict permitted agent pairs.",
    });
  });

  it("does not do spawned lookup for list visibility without row metadata", async () => {
    const callGateway = vi.fn(async () => ({
      sessions: [{ key: "agent:codex:acp:child-1" }],
    }));

    const guard = await createSessionVisibilityGuard({
      action: "list",
      requesterSessionKey: "agent:main:main",
      visibility: "tree",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
      callGateway: callGateway as never,
    });

    expect(guard.check("agent:codex:acp:child-1").allowed).toBe(false);
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("allows cross-agent spawned child sessions with tree visibility", async () => {
    const callGateway = vi.fn(
      async (request: { method?: string; params?: { spawnedBy?: string } }) => {
        if (request.method === "sessions.list") {
          expect(request.params?.spawnedBy).toBe("agent:main:main");
          return {
            sessions: [{ key: "agent:codex:acp:child-1" }],
          };
        }
        return {};
      },
    );

    const guard = await createSessionVisibilityGuard({
      action: "history",
      requesterSessionKey: "agent:main:main",
      visibility: "tree",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
      callGateway: callGateway as never,
    });

    expect(guard.check("agent:codex:acp:child-1")).toEqual({ allowed: true });
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
        "Session history visibility is restricted. Set tools.sessions.visibility=all and tools.agentToAgent.enabled=true to allow cross-agent access; use tools.agentToAgent.allow to restrict permitted agent pairs.",
    });
  });

  it("allows cross-agent spawned child sessions before agent-to-agent checks with all visibility", async () => {
    const callGateway = vi.fn(
      async (request: { method?: string; params?: { spawnedBy?: string } }) => {
        if (request.method === "sessions.list") {
          expect(request.params?.spawnedBy).toBe("agent:main:main");
          return {
            sessions: [{ key: "agent:codex:acp:child-1" }],
          };
        }
        return {};
      },
    );

    const guard = await createSessionVisibilityGuard({
      action: "send",
      requesterSessionKey: "agent:main:main",
      visibility: "all",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
      callGateway: callGateway as never,
    });

    expect(guard.check("agent:codex:acp:child-1")).toEqual({ allowed: true });
  });

  it("allows cross-agent spawned child status before agent-to-agent checks with all visibility", async () => {
    const callGateway = vi.fn(
      async (request: { method?: string; params?: { spawnedBy?: string } }) => {
        if (request.method === "sessions.list") {
          expect(request.params?.spawnedBy).toBe("agent:main:main");
          return {
            sessions: [{ key: "agent:codex:acp:child-1" }],
          };
        }
        return {};
      },
    );

    const guard = await createSessionVisibilityGuard({
      action: "status",
      requesterSessionKey: "agent:main:main",
      visibility: "all",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
      callGateway: callGateway as never,
    });

    expect(guard.check("agent:codex:acp:child-1")).toEqual({ allowed: true });
  });

  it("does not block exact same-agent spawned targets that fall past the spawned list cap", async () => {
    const gateway = vi.fn(async (request: { method?: string; params?: { key?: string } }) => {
      if (request.method === "sessions.resolve") {
        return { key: request.params?.key };
      }
      return {};
    });

    const access = await resolveSessionToolAccess({
      action: "history",
      requesterAgentId: "main",
      requesterSessionKey: "agent:main:main",
      targetAgentId: "main",
      targetSessionKey: "agent:main:subagent:worker-999",
      requesterOwned: false,
      visibility: "tree",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
      callGateway: gateway as never,
    });

    expect(access).toEqual({ allowed: true });
    expect(gateway).toHaveBeenCalledTimes(1);
    expect(gateway).toHaveBeenCalledWith(expect.objectContaining({ method: "sessions.resolve" }));
  });

  it("falls back to spawned-session listing when the exact resolver is unavailable", async () => {
    const gateway = vi.fn(async (request: { method?: string }) => {
      if (request.method === "sessions.resolve") {
        throw new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: "unknown method: sessions.resolve",
        });
      }
      return { sessions: [{ key: "agent:main:subagent:worker" }] };
    });

    const access = await resolveSessionToolAccess({
      action: "history",
      requesterAgentId: "main",
      requesterSessionKey: "agent:main:main",
      targetAgentId: "main",
      targetSessionKey: "agent:main:subagent:worker",
      requesterOwned: false,
      visibility: "tree",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
      callGateway: gateway as never,
    });

    expect(access).toEqual({ allowed: true });
    expect(gateway.mock.calls.map(([request]) => request.method)).toEqual([
      "sessions.resolve",
      "sessions.list",
    ]);
  });

  it("preserves an ordinary cross-agent denial when exact ownership lookup fails", async () => {
    const gateway = vi.fn(async () => {
      throw new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "transport timeout",
        retryable: true,
      });
    });

    const access = await resolveSessionToolAccess({
      action: "send",
      requesterAgentId: "main",
      requesterSessionKey: "agent:main:main",
      targetAgentId: "ops",
      targetSessionKey: "agent:ops:main",
      requesterOwned: false,
      visibility: "all",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
      callGateway: gateway as never,
    });

    expect(access).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
    });
    expect(gateway).not.toHaveBeenCalled();
  });

  it("does not apply a bare-key scoped grant to another agent's session", async () => {
    const targets: string[] = [];
    const unregister = createSessionVisibilityChecker.registerScopedAccessProvider((request) => {
      targets.push(request.targetSessionKey);
      return request.targetSessionKey === "shared" ? { expectedSessionId: "agent-a" } : undefined;
    });
    try {
      const gateway = vi.fn();
      const access = await resolveSessionToolAccess({
        action: "history",
        requesterAgentId: "main",
        requesterSessionKey: "agent:main:main",
        authorizationTargetSessionKey: "agent:ops:shared",
        targetAgentId: "ops",
        targetSessionKey: "shared",
        requesterOwned: false,
        visibility: "self",
        a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
        callGateway: gateway as never,
      });

      expect(access.allowed).toBe(false);
      expect(targets).toEqual(["agent:ops:shared"]);
      expect(gateway).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("keeps incognito targets hidden from scoped grants", async () => {
    const targetSessionKey = "agent:main:dashboard:incognito-private";
    const unregister = createSessionVisibilityChecker.registerScopedAccessProvider(() => ({
      expectedSessionId: "incognito-incarnation",
    }));
    try {
      const gateway = vi.fn();
      const access = await resolveSessionToolAccess({
        action: "history",
        requesterAgentId: "main",
        requesterSessionKey: "agent:main:main",
        targetAgentId: "main",
        targetSessionKey,
        requesterOwned: true,
        visibility: "all",
        a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
        callGateway: gateway as never,
      });

      expect(access).toEqual({
        allowed: false,
        status: "forbidden",
        error: `Session not visible from session tools: ${targetSessionKey}`,
      });
      expect(gateway).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("retains lookup-failure guidance for a cross-agent ACP child candidate", async () => {
    const gateway = vi.fn(async () => {
      throw new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "transport timeout",
        retryable: true,
      });
    });

    const access = await resolveSessionToolAccess({
      action: "history",
      requesterAgentId: "main",
      requesterSessionKey: "agent:main:main",
      targetAgentId: "codex",
      targetSessionKey: "agent:codex:acp:child-1",
      requesterOwned: false,
      visibility: "tree",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
      callGateway: gateway as never,
    });

    expect(access).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Session history denied because spawned-session ownership lookup failed (transient); retry once, then ask the operator to inspect OpenClaw logs.",
    });
    expect(gateway).toHaveBeenCalledTimes(1);
  });

  it("blocks cross-agent send when agent-to-agent is disabled", async () => {
    const guard = await createSessionVisibilityGuard({
      action: "send",
      requesterSessionKey: "agent:main:main",
      visibility: "all",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
      callGateway: vi.fn(async () => ({ sessions: [] })) as never,
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

  it("preserves cross-agent policy denials after a successful empty ownership lookup", async () => {
    const guard = await createSessionVisibilityGuard({
      action: "history",
      requesterSessionKey: "agent:main:main",
      visibility: "tree",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
      callGateway: vi.fn(async () => ({ sessions: [] })) as never,
    });

    expect(guard.check("agent:other:main")).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Session history visibility is restricted. Set tools.sessions.visibility=all and tools.agentToAgent.enabled=true to allow cross-agent access; use tools.agentToAgent.allow to restrict permitted agent pairs.",
    });
  });

  it.each([
    {
      name: "cross-agent ACP child under tree visibility",
      target: "agent:codex:acp:child-1",
      visibility: "tree" as const,
      error:
        "Session history denied because spawned-session ownership lookup failed (transient); retry once, then ask the operator to inspect OpenClaw logs.",
    },
    {
      name: "cross-agent ACP child under all visibility",
      target: "agent:codex:acp:child-1",
      visibility: "all" as const,
      error:
        "Session history denied because spawned-session ownership lookup failed (transient); retry once, then ask the operator to inspect OpenClaw logs.",
    },
    {
      name: "malformed agent key",
      target: "agent:",
      visibility: "tree" as const,
      error: "Session history denied because target agent ownership is unavailable.",
    },
    {
      name: "unscoped alias without a default agent",
      target: "main",
      visibility: "tree" as const,
      error: "Session history denied because target agent ownership is unavailable.",
    },
  ])("handles $name when the ownership lookup fails", async ({ target, visibility, error }) => {
    const guard = await createSessionVisibilityGuard({
      action: "history",
      requesterSessionKey: "agent:main:main",
      visibility,
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
      callGateway: vi.fn(async () => {
        throw new GatewayClientRequestError({
          code: "UNAVAILABLE",
          message: "transport timeout",
          retryable: true,
        });
      }) as never,
    });

    expect(guard.check(target)).toEqual({
      allowed: false,
      status: "forbidden",
      error,
    });
  });

  it("reports a transient tree-visibility lookup failure distinctly", async () => {
    loggerMocks.logWarn.mockClear();
    const guard = await createSessionVisibilityGuard({
      action: "history",
      requesterSessionKey: "agent:main:main",
      visibility: "tree",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
      callGateway: vi.fn(async () => {
        throw new GatewayClientRequestError({
          code: "UNAVAILABLE",
          message: "transport timeout Authorization: Bearer sk-evidence-secret-9f3a2c",
          retryable: true,
        });
      }) as never,
    });

    const result = guard.check("agent:main:subagent:child-1");
    expect(result.allowed).toBe(false);
    expect(result).toMatchObject({ status: "forbidden" });
    if (!result.allowed) {
      expect(result.error).toMatch(/ownership lookup failed/i);
      expect(result.error).toMatch(/transient\); retry/i);
    }
    const warnText = loggerMocks.logWarn.mock.calls.map((call) => String(call[0])).join("\n");
    expect(warnText).toMatch(/requester=sha256:[a-f0-9]{12}/u);
    expect(warnText).not.toContain("agent:main:main");
    expect(warnText).not.toContain("sk-evidence-secret-9f3a2c");
  });

  it("classifies a permanent credential lookup failure as non-retryable under tree visibility", async () => {
    const guard = await createSessionVisibilityGuard({
      action: "history",
      requesterSessionKey: "agent:main:main",
      visibility: "tree",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
      callGateway: vi.fn(async () => {
        throw new GatewayCredentialsRequiredError({
          method: "sessions.list",
          configPath: "/tmp/openclaw.json",
        });
      }) as never,
    });

    const result = guard.check("agent:main:subagent:child-1");
    expect(result).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Session history denied because spawned-session ownership lookup failed; ask the operator to check gateway configuration and credentials.",
    });
    expect(result.allowed ? "" : result.error).not.toMatch(/retry/i);
  });

  it("keeps unknown lookup failures generic under tree visibility", async () => {
    const guard = await createSessionVisibilityGuard({
      action: "history",
      requesterSessionKey: "agent:main:main",
      visibility: "tree",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
      callGateway: vi.fn(async () => {
        throw new Error("failed to decode session row");
      }) as never,
    });

    const result = guard.check("agent:main:subagent:child-1");
    expect(result).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Session history denied because spawned-session ownership lookup failed; ask the operator to inspect OpenClaw logs.",
    });
    expect(result.allowed ? "" : result.error).not.toMatch(/credentials|retry/i);
  });

  it("classifies a malformed sessions.list response as an unknown lookup failure", async () => {
    const guard = await createSessionVisibilityGuard({
      action: "history",
      requesterSessionKey: "agent:main:main",
      visibility: "tree",
      a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
      callGateway: vi.fn(async () => ({})) as never,
    });

    expect(guard.check("agent:main:subagent:child-1")).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Session history denied because spawned-session ownership lookup failed; ask the operator to inspect OpenClaw logs.",
    });
  });

  it("keeps watched same-agent group reads allowed when the spawned lookup throws", async () => {
    loggerMocks.logWarn.mockClear();
    const stateDir = tempDirs.make("openclaw-session-visibility-");
    closeOpenClawStateDatabaseForTest();
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    try {
      const requesterSessionKey = "agent:main:main";
      const watchedSessionKey = "agent:main:telegram:group:watched";
      expect(
        registerMainSessionGroupWatch({
          sessionKey: watchedSessionKey,
          agentId: "main",
          entry: { sessionId: "watched", updatedAt: Date.now(), chatType: "group" },
          dmScope: "main",
        }),
      ).toBe(true);
      expect(listAmbientGroupWatchTargets(requesterSessionKey)).toEqual(
        new Set([watchedSessionKey]),
      );

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const guard = await createSessionVisibilityGuard({
          action: "history",
          requesterSessionKey,
          visibility: "tree",
          a2aPolicy: createAgentToAgentPolicy({} as unknown as OpenClawConfig),
          callGateway: vi.fn(async () => {
            throw new GatewayClientRequestError({
              code: "UNAVAILABLE",
              message: "transport timeout",
              retryable: true,
            });
          }) as never,
        });

        // Durable watched-group allowance does not depend on spawned ownership lookup.
        expect(loggerMocks.logWarn).not.toHaveBeenCalled();
        expect(guard.check(watchedSessionKey)).toEqual({ allowed: true });
        expect(loggerMocks.logWarn).not.toHaveBeenCalled();
        // A non-watched, non-spawned same-agent target still fails closed, but
        // the denial is distinguishable from a genuine policy denial.
        expect(guard.check("agent:main:telegram:group:unwatched")).toEqual({
          allowed: false,
          status: "forbidden",
          error:
            "Session history denied because spawned-session ownership lookup failed (transient); retry once, then ask the operator to inspect OpenClaw logs.",
        });
      } finally {
        warnSpy.mockRestore();
      }
    } finally {
      closeOpenClawStateDatabaseForTest();
      vi.unstubAllEnvs();
    }
  });
});
