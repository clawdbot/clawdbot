// Sessions access tests cover session-tool visibility policy, sandbox clamps,
// and agent-to-agent allow rules.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { pageExecutionDecisionFactsForContext } from "../../audit/execution-decision-facts.js";
import { configureExecutionDecisionWorkSink } from "../../audit/execution-decision-work.js";
import {
  createExecutionIdentityAdmissionToken,
  enqueueExecutionIdentityContextAtAdmission,
} from "../../audit/execution-identity-admission.js";
import { startAgentLocalAuditWriter } from "../../commands/agent-local-audit.js";
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
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import {
  formatSessionToolAccessDenial,
  resolveSandboxedSessionToolContext,
  resolveSessionToolAccess,
} from "./sessions-access.js";

const loggerMocks = vi.hoisted(() => ({ logWarn: vi.fn() }));
const gatewayMocks = vi.hoisted(() => ({ callGateway: vi.fn() }));
vi.mock("../../logger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../logger.js")>()),
  logWarn: loggerMocks.logWarn,
}));
vi.mock("../../gateway/call.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../gateway/call.js")>()),
  callGateway: gatewayMocks.callGateway,
}));

beforeEach(() => {
  gatewayMocks.callGateway.mockReset();
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const AUDIT_REF_RE = /^hmac-sha256:v1:[a-f0-9]{32}:[a-f0-9]{64}$/u;

function makeConfig(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return overrides;
}

describe("resolveSessionToolsVisibility", () => {
  it("defaults to all when unset or invalid", () => {
    expect(resolveSessionToolsVisibility(makeConfig())).toBe("all");
    expect(
      resolveSessionToolsVisibility({
        tools: { sessions: { visibility: "invalid" } },
      } as unknown as OpenClawConfig),
    ).toBe("all");
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
  it.each([undefined, "all"] as const)(
    "clamps %s visibility to tree in sandbox when sandbox visibility is spawned",
    (visibility) => {
      const cfg = makeConfig({
        tools: { sessions: { visibility } },
        agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
      });
      expect(resolveEffectiveSessionToolsVisibility({ cfg, sandboxed: true })).toBe("tree");
    },
  );

  it("preserves visibility when sandbox clamp is all", () => {
    const cfg = makeConfig({
      tools: { sessions: { visibility: "all" } },
      agents: { defaults: { sandbox: { sessionToolsVisibility: "all" } } },
    });
    expect(resolveEffectiveSessionToolsVisibility({ cfg, sandboxed: true })).toBe("all");
  });
});

describe("sandbox session-tools context", () => {
  it("defaults sandbox visibility clamp to spawned", () => {
    expect(resolveSandboxSessionToolsVisibility(makeConfig())).toBe("spawned");
  });

  it("restricts non-subagent sandboxed sessions to spawned visibility", () => {
    const cfg = makeConfig({
      tools: { sessions: { visibility: "all" } },
      agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
    });
    const context = resolveSandboxedSessionToolContext({
      cfg,
      agentSessionKey: "agent:main:main",
      sandboxed: true,
    });

    expect(context.restrictToSpawned).toBe(true);
    expect(context.mainSessionKey).toBeUndefined();
    expect(context.requesterInternalKey).toBe("agent:main:main");
    expect(context.effectiveRequesterKey).toBe("agent:main:main");
  });

  it("does not restrict subagent sessions in sandboxed mode", () => {
    const cfg = makeConfig({
      tools: { sessions: { visibility: "all" } },
      agents: { defaults: { sandbox: { sessionToolsVisibility: "spawned" } } },
    });
    const context = resolveSandboxedSessionToolContext({
      cfg,
      agentSessionKey: "agent:main:subagent:abc",
      sandboxed: true,
    });

    expect(context.restrictToSpawned).toBe(false);
    expect(context.requesterInternalKey).toBe("agent:main:subagent:abc");
  });

  it("resolves a configured canonical main key for unsandboxed callers", () => {
    const context = resolveSandboxedSessionToolContext({
      cfg: { session: { mainKey: "work" } },
      agentSessionKey: "agent:main:work",
    });

    expect(context.mainSessionKey).toBe("agent:main:work");
  });

  it("resolves the canonical global main key from its explicit store owner", () => {
    const context = resolveSandboxedSessionToolContext({
      cfg: {
        session: { scope: "global" },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "ops" } },
          entries: { ops: {}, research: {} },
        },
      },
      agentSessionKey: "global",
      requesterAgentId: "ops",
    });

    expect(context.mainSessionKey).toBe("global");
  });
});

describe("createAgentToAgentPolicy", () => {
  it("allows cross-agent access by default", () => {
    const policy = createAgentToAgentPolicy(makeConfig());
    expect(policy.enabled).toBe(true);
    expect(policy.isAllowed("main", "ops")).toBe(true);
  });

  it("denies cross-agent access when explicitly disabled", () => {
    const policy = createAgentToAgentPolicy(
      makeConfig({ tools: { agentToAgent: { enabled: false } } }),
    );
    expect(policy.enabled).toBe(false);
    expect(policy.isAllowed("main", "main")).toBe(true);
    expect(policy.isAllowed("main", "ops")).toBe(false);
  });

  it("honors allow patterns when enabled", () => {
    const policy = createAgentToAgentPolicy(
      makeConfig({
        tools: {
          agentToAgent: {
            enabled: true,
            allow: ["ops-*", "main"],
          },
        },
      }),
    );

    expect(policy.isAllowed("ops-a", "ops-b")).toBe(true);
    expect(policy.isAllowed("main", "ops-a")).toBe(true);
    expect(policy.isAllowed("guest", "ops-a")).toBe(false);
  });

  it("matches wildcard patterns case-insensitively", () => {
    const policy = createAgentToAgentPolicy(
      makeConfig({
        tools: {
          agentToAgent: {
            enabled: true,
            allow: ["Ops-*"],
          },
        },
      }),
    );

    expect(policy.matchesAllow("ops-worker")).toBe(true);
    expect(policy.matchesAllow("OPS-WORKER")).toBe(true);
    expect(policy.matchesAllow("guest")).toBe(false);
  });

  it("keeps exact allow patterns case-sensitive", () => {
    const policy = createAgentToAgentPolicy(
      makeConfig({
        tools: {
          agentToAgent: {
            enabled: true,
            allow: ["Ops"],
          },
        },
      }),
    );

    expect(policy.matchesAllow("Ops")).toBe(true);
    expect(policy.matchesAllow("ops")).toBe(false);
  });

  it("keeps blank configured allow patterns fail-closed", () => {
    const policy = createAgentToAgentPolicy(
      makeConfig({
        tools: {
          agentToAgent: {
            enabled: true,
            allow: [" "],
          },
        },
      }),
    );

    expect(policy.matchesAllow("ops")).toBe(false);
    expect(policy.isAllowed("main", "ops")).toBe(false);
  });

  it("handles interior wildcards", () => {
    const policy = createAgentToAgentPolicy(
      makeConfig({
        tools: {
          agentToAgent: {
            enabled: true,
            allow: ["team-*-prod"],
          },
        },
      }),
    );

    expect(policy.matchesAllow("team-ops-prod")).toBe(true);
    expect(policy.matchesAllow("team-dev-prod")).toBe(true);
    expect(policy.matchesAllow("team-ops-staging")).toBe(false);
    expect(policy.matchesAllow("team-prod")).toBe(false);
  });

  it("handles multiple wildcards without polynomial backtracking", () => {
    // Allow patterns use segment matching rather than a greedy regex so
    // adversarial agent ids cannot cause slow policy checks.
    const policy = createAgentToAgentPolicy(
      makeConfig({
        tools: {
          agentToAgent: {
            enabled: true,
            allow: ["*a*b*c*d*e*"],
          },
        },
      }),
    );

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
    const policy = createAgentToAgentPolicy(
      makeConfig({
        tools: {
          agentToAgent: {
            enabled: true,
            allow: ["abc*xyz"],
          },
        },
      }),
    );

    expect(policy.matchesAllow("abcxyz")).toBe(true);
    expect(policy.matchesAllow("abc-middle-xyz")).toBe(true);
    expect(policy.matchesAllow("ab")).toBe(false);
  });

  it("treats regex syntax as literal text in wildcard patterns", () => {
    const policy = createAgentToAgentPolicy(
      makeConfig({
        tools: {
          agentToAgent: {
            enabled: true,
            allow: ["ops.[prod]*"],
          },
        },
      }),
    );

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
      a2aPolicy: createAgentToAgentPolicy(makeConfig()),
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
      a2aPolicy: createAgentToAgentPolicy(
        makeConfig({
          tools: { agentToAgent: { enabled: false } },
        }),
      ),
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
      a2aPolicy: createAgentToAgentPolicy(
        makeConfig({
          tools: { agentToAgent: { enabled: true, allow: ["main", "codex"] } },
        }),
      ),
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
        "Session list visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access; use tools.agentToAgent to restrict permitted agent pairs.",
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
      a2aPolicy: createAgentToAgentPolicy(makeConfig()),
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
      a2aPolicy: createAgentToAgentPolicy(makeConfig()),
      callGateway: callGateway as never,
    });

    expect(guard.check("agent:codex:acp:child-1")).toEqual({ allowed: true });
  });

  it("keeps self visibility restricted even for spawned child sessions", async () => {
    const guard = await createSessionVisibilityGuard({
      action: "history",
      requesterSessionKey: "agent:main:main",
      visibility: "self",
      a2aPolicy: createAgentToAgentPolicy(makeConfig()),
    });

    expect(guard.check("agent:codex:acp:child-1")).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Session history visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access; use tools.agentToAgent to restrict permitted agent pairs.",
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
      a2aPolicy: createAgentToAgentPolicy(
        makeConfig({ tools: { agentToAgent: { enabled: false } } }),
      ),
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
      a2aPolicy: createAgentToAgentPolicy(
        makeConfig({ tools: { agentToAgent: { enabled: false } } }),
      ),
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
      a2aPolicy: createAgentToAgentPolicy(makeConfig()),
      callGateway: gateway as never,
    });

    expect(access).toEqual({ allowed: true });
    expect(gateway.mock.calls.map(([request]) => request.method)).toEqual([
      "sessions.describe",
      "sessions.resolve",
    ]);
  });

  it.each([
    { action: "send" as const },
    { action: "status" as const },
    { action: "history" as const, displayAction: "search" as const },
  ])("does not grant durable-row ownership to $action tools", async ({ action, displayAction }) => {
    const requesterSessionKey = "agent:main:subagent:parent";
    const targetSessionKey = "agent:main:subagent:old-child";
    const gateway = vi.fn(async (request: { method?: string }) => {
      if (request.method === "sessions.describe") {
        return {
          session: {
            key: targetSessionKey,
            sessionId: "old-child-session",
            parentSessionKey: requesterSessionKey,
          },
        };
      }
      return {};
    });

    const access = await resolveSessionToolAccess({
      action,
      displayAction,
      requesterAgentId: "main",
      requesterSessionKey,
      targetAgentId: "main",
      targetSessionKey,
      requesterOwned: false,
      visibility: "tree",
      a2aPolicy: createAgentToAgentPolicy(makeConfig()),
      callGateway: gateway as never,
    });

    expect(access).toMatchObject({ allowed: false, reasonCode: "tree_visibility_restricted" });
    expect(gateway.mock.calls.map(([request]) => request.method)).toEqual(["sessions.resolve"]);
  });

  it("returns a private typed denial without presentation text", async () => {
    const access = await resolveSessionToolAccess({
      action: "send",
      requesterAgentId: "main",
      requesterSessionKey: "agent:main:main",
      targetAgentId: "ops",
      targetSessionKey: "agent:ops:main",
      requesterOwned: false,
      visibility: "all",
      a2aPolicy: createAgentToAgentPolicy(
        makeConfig({ tools: { agentToAgent: { enabled: false } } }),
      ),
    });

    expect(access).toMatchObject({
      allowed: false,
      status: "forbidden",
      reasonCode: expect.any(String),
      policyRefs: expect.arrayContaining(["tools.agentToAgent.enabled"]),
    });
    expect(access).not.toHaveProperty("error");
  });

  it("persists unknown ownership evidence with an opaque target through the local writer", async () => {
    const now = Date.now();
    const stateDir = tempDirs.make("openclaw-session-access-audit-");
    const database = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const stopWriter = startAgentLocalAuditWriter({ stateDir });
    if (!stopWriter) {
      throw new Error("expected an isolated direct-local audit writer");
    }
    const token = createExecutionIdentityAdmissionToken("session-access-run", {
      contextId: "session-access-context",
      executionId: "session-access-execution",
      now,
    });
    expect(
      enqueueExecutionIdentityContextAtAdmission(
        {
          runId: token.runId,
          agentId: "main",
          ingress: { kind: "local-cli", boundary: "agent-command.local" },
          runtime: { kind: "embedded" },
        },
        { enabled: true, token, runtimeInstanceId: "session-access-runtime" },
      ),
    ).toMatchObject({ accepted: true });

    const targetSessionKey = "agent:main:dashboard:owner-unknown";
    gatewayMocks.callGateway.mockRejectedValue(
      new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "transport timeout",
        retryable: true,
      }),
    );
    try {
      await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          executionIdentityToken: token,
          receiptAuthority: () => true,
        },
        async () => {
          const access = await resolveSessionToolAccess({
            action: "send",
            requesterAgentId: "main",
            requesterSessionKey: "agent:main:main",
            targetAgentId: "main",
            targetSessionKey,
            requesterOwned: false,
            visibility: "tree",
            a2aPolicy: createAgentToAgentPolicy(makeConfig()),
          });
          expect(access).toMatchObject({
            allowed: false,
            reasonCode: "session_ownership_lookup_failed_transient",
            contextFieldsUsed: ["requesterSessionKey", "targetSessionKey"],
            missingEvidence: ["session.owner"],
          });
        },
      );
    } finally {
      await stopWriter();
    }

    const page = pageExecutionDecisionFactsForContext({
      context: token,
      limit: 10,
      now: now + 1,
      database,
    });
    expect(page.receipts).toHaveLength(1);
    expect(page.receipts[0]).toMatchObject({
      contextId: token.contextId,
      executionId: token.executionId,
      runId: token.runId,
      action: {
        family: "session",
        operation: "send",
        targetRef: expect.stringMatching(AUDIT_REF_RE),
      },
      decision: { outcome: "denied", reasonCode: "session_ownership_lookup_failed_transient" },
      enforcement: {
        coverageState: "unknown",
        policyRefs: ["tools.sessions.visibility"],
        contextFieldsUsed: ["requesterSessionKey", "targetSessionKey"],
      },
      missingEvidence: ["session.owner"],
    });
    expect(JSON.stringify(page.receipts)).not.toContain(targetSessionKey);
  });

  it("revalidates the exact receipt authority after awaited ownership lookup", async () => {
    const decisionWork: unknown[] = [];
    const clear = configureExecutionDecisionWorkSink((work) => {
      decisionWork.push(work);
      return true;
    });
    const token = createExecutionIdentityAdmissionToken("session-access-closed-run", {
      contextId: "session-access-closed-context",
      executionId: "session-access-closed-execution",
    });
    let authorityActive = true;
    gatewayMocks.callGateway.mockImplementation(async () => {
      authorityActive = false;
      return { sessions: [] };
    });
    try {
      const access = await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          executionIdentityToken: token,
          receiptAuthority: () => authorityActive,
        },
        async () =>
          await resolveSessionToolAccess({
            action: "history",
            requesterAgentId: "main",
            requesterSessionKey: "agent:main:main",
            targetAgentId: "main",
            targetSessionKey: "agent:main:dashboard:unowned",
            requesterOwned: false,
            visibility: "tree",
            a2aPolicy: createAgentToAgentPolicy(makeConfig()),
          }),
      );

      expect(access).toMatchObject({ allowed: false, reasonCode: "tree_visibility_restricted" });
      expect(decisionWork).toEqual([]);
    } finally {
      clear();
    }
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
      a2aPolicy: createAgentToAgentPolicy(makeConfig()),
      callGateway: gateway as never,
    });

    expect(access).toEqual({ allowed: true });
    expect(gateway.mock.calls.map(([request]) => request.method)).toEqual([
      "sessions.describe",
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
      a2aPolicy: createAgentToAgentPolicy(
        makeConfig({ tools: { agentToAgent: { enabled: false } } }),
      ),
      callGateway: gateway as never,
    });

    expect(access).toEqual({
      allowed: false,
      status: "forbidden",
      reasonCode: "agent_to_agent_disabled",
      policyRefs: ["tools.agentToAgent.enabled"],
      contextFieldsUsed: ["requesterAgentId", "targetAgentId"],
      missingEvidence: [],
    });
    if (!access.allowed) {
      expect(formatSessionToolAccessDenial(access, { action: "send" })).toBe(
        "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.",
      );
    }
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
        a2aPolicy: createAgentToAgentPolicy(makeConfig()),
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
        a2aPolicy: createAgentToAgentPolicy(makeConfig()),
        callGateway: gateway as never,
      });

      expect(access).toEqual({
        allowed: false,
        status: "forbidden",
        reasonCode: "incognito_session",
        policyRefs: ["sessions.incognito"],
        contextFieldsUsed: ["targetSessionKey"],
        missingEvidence: [],
      });
      if (!access.allowed) {
        expect(
          formatSessionToolAccessDenial(access, {
            action: "history",
            targetSessionKey,
          }),
        ).toBe(`Session not visible from session tools: ${targetSessionKey}`);
      }
      expect(gateway).not.toHaveBeenCalled();
    } finally {
      unregister();
    }
  });

  it("retains lookup-failure guidance for a cross-agent ACP child candidate", async () => {
    const gateway = vi.fn(async (_request: { method?: string }) => {
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
      a2aPolicy: createAgentToAgentPolicy(makeConfig()),
      callGateway: gateway as never,
    });

    expect(access).toEqual({
      allowed: false,
      status: "forbidden",
      reasonCode: "session_ownership_lookup_failed_transient",
      policyRefs: ["tools.sessions.visibility"],
      contextFieldsUsed: ["requesterSessionKey", "targetSessionKey"],
      missingEvidence: ["session.owner"],
    });
    if (!access.allowed) {
      expect(formatSessionToolAccessDenial(access, { action: "history" })).toBe(
        "Session history denied because spawned-session ownership lookup failed (transient); retry once, then ask the operator to inspect OpenClaw logs.",
      );
    }
    expect(gateway.mock.calls.map(([request]) => request.method)).toEqual([
      "sessions.describe",
      "sessions.resolve",
    ]);
  });

  it("blocks cross-agent send when agent-to-agent is disabled", async () => {
    const guard = await createSessionVisibilityGuard({
      action: "send",
      requesterSessionKey: "agent:main:main",
      visibility: "all",
      a2aPolicy: createAgentToAgentPolicy(
        makeConfig({ tools: { agentToAgent: { enabled: false } } }),
      ),
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
      mainSessionKey: "agent:main:main",
      visibility: "self",
      a2aPolicy: createAgentToAgentPolicy(makeConfig()),
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
      mainSessionKey: "agent:main:main",
      visibility: "tree",
      a2aPolicy: createAgentToAgentPolicy(makeConfig()),
      callGateway: vi.fn(async () => ({ sessions: [] })) as never,
    });

    expect(guard.check("agent:other:main")).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Session history visibility is restricted. Set tools.sessions.visibility=all to allow cross-agent access; use tools.agentToAgent to restrict permitted agent pairs.",
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
      a2aPolicy: createAgentToAgentPolicy(
        makeConfig({ tools: { agentToAgent: { enabled: false } } }),
      ),
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
      a2aPolicy: createAgentToAgentPolicy(makeConfig()),
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
      a2aPolicy: createAgentToAgentPolicy(makeConfig()),
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
      a2aPolicy: createAgentToAgentPolicy(makeConfig()),
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
      a2aPolicy: createAgentToAgentPolicy(makeConfig()),
      callGateway: vi.fn(async () => ({})) as never,
    });

    expect(guard.check("agent:main:subagent:child-1")).toEqual({
      allowed: false,
      status: "forbidden",
      error:
        "Session history denied because spawned-session ownership lookup failed; ask the operator to inspect OpenClaw logs.",
    });
  });
});
