import path from "node:path";
// sessions_spawn tool tests cover model-visible schema gating, ACP/subagent
// dispatch, and result details for spawned child sessions.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionIdentityAdmissionToken } from "../../audit/execution-identity-admission.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { GatewayClientRequestError } from "../../gateway/client.js";
import { withTestDir } from "../../test-helpers/temp-dir.js";
import { createOperationalRunInstanceRef } from "../admitted-run-context.js";
import { readParentExecutionIdentity } from "../subagents/spawn/execution-identity-spawn-context.js";
import {
  SWARM_CODE_MODE_IDEMPOTENCY_KEY,
  SWARM_CODE_MODE_REQUEST_FINGERPRINT,
} from "../subagents/swarm/swarm-code-mode.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";

const hoisted = vi.hoisted(() => {
  const spawnSubagentDirectMock = vi.fn();
  const spawnAcpDirectMock = vi.fn();
  const registerSubagentRunMock = vi.fn();
  const inProcessCreationMock = vi.fn();
  const getSubagentDeliveryBacklogPressureMock = vi.fn(() => ({
    suspended: 0,
    blocked: false,
  }));
  const runSubagentProgressMock = vi.fn(async () => {});
  return {
    spawnSubagentDirectMock,
    spawnAcpDirectMock,
    registerSubagentRunMock,
    inProcessCreationMock,
    getSubagentDeliveryBacklogPressureMock,
    runSubagentProgressMock,
  };
});

vi.mock("../subagents/spawn/subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_CONTEXT_MODES: ["isolated", "fork"],
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  spawnSubagentDirect: (...args: unknown[]) => hoisted.spawnSubagentDirectMock(...args),
}));

vi.mock("../subagents/spawn/acp-spawn.js", () => ({
  spawnAcpDirect: (...args: unknown[]) => hoisted.spawnAcpDirectMock(...args),
}));

vi.mock("../subagents/registry/subagent-registry.js", () => ({
  registerSubagentRun: (...args: unknown[]) => hoisted.registerSubagentRunMock(...args),
  getSubagentDeliveryBacklogPressure: () => hoisted.getSubagentDeliveryBacklogPressureMock(),
}));

vi.mock("./in-process-gateway.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./in-process-gateway.js")>();
  return {
    ...actual,
    callInProcessGatewayToolWithCreation: (...args: unknown[]) =>
      hoisted.inProcessCreationMock(...args),
  };
});

vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({
    hasHooks: (hookName: string) => hookName === "subagent_progress",
    runSubagentProgress: hoisted.runSubagentProgressMock,
  }),
}));

let createSessionsSpawnTool: typeof import("./sessions-spawn-tool.js").createSessionsSpawnTool;
let acpRuntimeRegistry: typeof import("../../acp/runtime/registry.js");

describe("sessions_spawn tool", () => {
  beforeAll(async () => {
    ({ createSessionsSpawnTool } = await import("./sessions-spawn-tool.js"));
    acpRuntimeRegistry = await import("../../acp/runtime/registry.js");
  });

  beforeEach(() => {
    acpRuntimeRegistry.testing.resetAcpRuntimeBackendsForTests();
    hoisted.spawnSubagentDirectMock.mockReset().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:main:subagent:1",
      runId: "run-subagent",
    });
    hoisted.spawnAcpDirectMock.mockReset().mockResolvedValue({
      status: "accepted",
      childSessionKey: "agent:codex:acp:1",
      runId: "run-acp",
    });
    hoisted.registerSubagentRunMock.mockReset();
    hoisted.inProcessCreationMock.mockReset();
    hoisted.getSubagentDeliveryBacklogPressureMock
      .mockReset()
      .mockReturnValue({ suspended: 0, blocked: false });
    hoisted.runSubagentProgressMock.mockClear();
  });

  function registerAcpBackendForTest() {
    acpRuntimeRegistry.registerAcpRuntimeBackend({
      id: "acpx",
      runtime: {
        ensureSession: vi.fn(async () => ({
          sessionKey: "agent:codex:acp:1",
          backend: "acpx",
          runtimeSessionName: "codex",
        })),
        async *runTurn() {},
        cancel: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      },
    });
  }

  function requireSchemaProperty(
    properties:
      | Record<string, { description?: string; enum?: string[]; type?: string } | undefined>
      | undefined,
    name: string,
  ) {
    const property = properties?.[name];
    if (!property) {
      throw new Error(`expected ${name} schema property`);
    }
    return property;
  }

  const requireRecord = createRequireRecord("record", "expected-label");

  function expectDetailFields(details: unknown, expected: Record<string, unknown>) {
    const record = requireRecord(details, "result details");
    for (const [key, value] of Object.entries(expected)) {
      expect(record[key]).toBe(value);
    }
  }

  function mockCallArg(mock: unknown, callIndex: number, argIndex: number, label: string) {
    const calls = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls;
    if (!Array.isArray(calls)) {
      throw new Error(`expected ${label} mock calls`);
    }
    const call = calls[callIndex];
    if (!call) {
      throw new Error(`expected ${label} call ${callIndex + 1}`);
    }
    return requireRecord(call[argIndex], `${label} call ${callIndex + 1} arg ${argIndex + 1}`);
  }

  it("hides ACP runtime affordances when no ACP backend is loaded", () => {
    // The tool schema is generated from live runtime availability; stale ACP
    // fields should not be advertised when no backend can handle them.
    const tool = createSessionsSpawnTool();
    const schema = tool.parameters as {
      properties?: {
        runtime?: { enum?: string[] };
        resumeSessionId?: { description?: string };
        streamTo?: { description?: string };
      };
    };

    expect(tool.displaySummary).toBe("Spawn subagent session.");
    expect(tool.description).not.toContain("ACP");
    expect(tool.description).not.toContain('runtime="acp"');
    expect(schema.properties?.runtime?.enum).toEqual(["subagent"]);
    expect(schema.properties?.resumeSessionId).toBeUndefined();
    expect(schema.properties?.streamTo).toBeUndefined();
  });

  it("advertises ACP runtime affordances when an ACP backend is loaded", () => {
    registerAcpBackendForTest();

    const tool = createSessionsSpawnTool({
      agentChannel: "discord",
      agentAccountId: "default",
      config: {
        session: {
          threadBindings: {
            spawnSessions: true,
          },
        },
      },
    });
    const schema = tool.parameters as {
      properties?: {
        runtime?: { enum?: string[] };
        resumeSessionId?: { description?: string };
        streamTo?: { description?: string };
      };
    };

    expect(tool.displaySummary).toBe(
      "Spawn hidden subagent (ephemeral) or visible work session (durable).",
    );
    expect(tool.description).toContain('runtime="acp"');
    expect(tool.description).toContain('unless ACP `streamTo="parent"`');
    expect(schema.properties?.runtime?.enum).toEqual(["subagent", "acp"]);
    const resumeSessionId = requireSchemaProperty(schema.properties, "resumeSessionId");
    const streamTo = requireSchemaProperty(schema.properties, "streamTo");
    expect(resumeSessionId.description).toContain("ACP resume id");
    expect(resumeSessionId.description).toContain("ignored by subagent");
    expect(resumeSessionId.description).toContain("already recorded for requester");
    expect(streamTo.description).toContain("ACP only");
    expect(streamTo.description).toContain("Ignored by subagent");
  });

  it("hides ACP runtime affordances when the ACP backend is unhealthy", () => {
    acpRuntimeRegistry.registerAcpRuntimeBackend({
      id: "acpx",
      healthy: () => false,
      runtime: {
        ensureSession: vi.fn(async () => ({
          sessionKey: "agent:codex:acp:1",
          backend: "acpx",
          runtimeSessionName: "codex",
        })),
        async *runTurn() {},
        cancel: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
      },
    });

    const tool = createSessionsSpawnTool();
    const schema = tool.parameters as { properties?: { runtime?: { enum?: string[] } } };

    expect(tool.description).not.toContain("ACP");
    expect(schema.properties?.runtime?.enum).toEqual(["subagent"]);
  });

  it("rejects stale ACP runtime calls when no ACP backend is loaded", async () => {
    const tool = createSessionsSpawnTool();

    const result = await tool.execute("call-acp-unavailable", {
      runtime: "acp",
      task: "investigate",
      agentId: "codex",
    });

    expectDetailFields(result.details, { status: "error", role: "codex" });
    expect(JSON.stringify(result.details)).toContain("no ACP runtime backend is loaded");
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it.each([
    { runtime: "subagent" as const, spawn: hoisted.spawnSubagentDirectMock },
    { runtime: "acp" as const, spawn: hoisted.spawnAcpDirectMock },
  ])(
    "forwards the exact private parent token to the $runtime spawn owner",
    async ({ runtime, spawn }) => {
      if (runtime === "acp") {
        registerAcpBackendForTest();
      }
      const parentToken = createExecutionIdentityAdmissionToken("parent-run", {
        contextId: "parent-context",
        executionId: "parent-execution",
        now: 100,
      });
      const tool = createSessionsSpawnTool({ agentSessionKey: "agent:main:main" });

      const result = await withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: "agent:main:main",
          operationalRunInstance: createOperationalRunInstanceRef("parent-run"),
          executionIdentityToken: parentToken,
        },
        async () =>
          await tool.execute(`spawn-${runtime}`, {
            task: "inspect child lineage",
            runtime,
            ...(runtime === "acp" ? { agentId: "codex" } : {}),
          }),
      );

      const context = mockCallArg(spawn, 0, 1, `${runtime} spawn`);
      expect(readParentExecutionIdentity(context)).toBe(parentToken);
      expect(JSON.stringify(tool.parameters)).not.toContain("parentExecutionIdentityToken");
      expect(JSON.stringify(result.details)).not.toContain("parent-context");
      expect(JSON.stringify(result.details)).not.toContain("parent-execution");
    },
  );

  it.each([
    { label: "native", args: { task: "investigate", runtime: "subagent" } },
    { label: "ACP", args: { task: "investigate", runtime: "acp" }, acp: true },
    { label: "visible", args: { task: "investigate", visible: true } },
  ])("blocks $label starts when retained delivery pressure reaches capacity", async (testCase) => {
    if (testCase.acp) {
      registerAcpBackendForTest();
    }
    hoisted.getSubagentDeliveryBacklogPressureMock.mockReturnValue({
      suspended: 50,
      blocked: true,
    });
    const callGateway = vi.fn();
    const tool = createSessionsSpawnTool({ callGateway });

    const result = await tool.execute(`blocked-${testCase.label}`, testCase.args);

    expectDetailFields(result.details, { status: "forbidden" });
    expect(JSON.stringify(result.details)).toContain("50 completed tasks have blocked delivery");
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("hides ACP runtime affordances when ACP policy is disabled", () => {
    registerAcpBackendForTest();

    const tool = createSessionsSpawnTool({
      config: {
        acp: { enabled: false },
      },
    });
    const schema = tool.parameters as { properties?: { runtime?: { enum?: string[] } } };

    expect(tool.description).not.toContain("ACP");
    expect(schema.properties?.runtime?.enum).toEqual(["subagent"]);
  });

  it("advertises ACP runtime affordances when only automatic ACP dispatch is disabled", () => {
    registerAcpBackendForTest();

    const tool = createSessionsSpawnTool({
      config: {
        acp: {
          enabled: true,
          dispatch: { enabled: false },
        },
      },
    });
    const schema = tool.parameters as { properties?: { runtime?: { enum?: string[] } } };

    expect(tool.description).toContain('runtime="acp"');
    expect(schema.properties?.runtime?.enum).toEqual(["subagent", "acp"]);
  });

  it("exposes the canonical per-run timeout without advertising a wait-timeout alias", () => {
    const tool = createSessionsSpawnTool();
    const schema = tool.parameters as {
      properties?: {
        runTimeoutSeconds?: { type?: string; minimum?: number; description?: string };
        timeoutSeconds?: unknown;
      };
    };

    expect(schema.properties?.runTimeoutSeconds).toMatchObject({ type: "integer", minimum: 0 });
    expect(schema.properties?.runTimeoutSeconds?.description).toContain("configured subagent");
    expect(schema.properties?.timeoutSeconds).toBeUndefined();
  });

  it("hides and rejects swarm parameters while tools.swarm is disabled", async () => {
    const tool = createSessionsSpawnTool({ agentSessionKey: "agent:main:main" });
    const schema = tool.parameters as { properties?: Record<string, unknown> };

    expect(schema.properties?.collect).toBeUndefined();
    expect(schema.properties?.outputSchema).toBeUndefined();
    expect(schema.properties?.fastMode).toBeUndefined();
    expect(schema.properties?.groupId).toBeUndefined();
    await expect(tool.execute("disabled", { task: "collect", collect: true })).rejects.toThrow(
      "tools.swarm.enabled=true",
    );
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("requires collector children to delegate only through collect mode", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:worker:subagent:collector",
      swarmCollector: true,
      config: { tools: { swarm: true } },
    });

    await expect(tool.execute("normal-child", { task: "ask for approval" })).rejects.toThrow(
      "requires collect=true",
    );
    await tool.execute("collector-child", { task: "collect safely", collect: true });

    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledOnce();
    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({ collect: true }),
      expect.any(Object),
    );
  });

  it("forwards collector parameters and requesting run identity when enabled", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      requesterRunId: "parent-run",
      config: { tools: { swarm: true } },
    });
    const schema = tool.parameters as { properties?: Record<string, unknown> };
    expect(schema.properties?.collect).toBeDefined();
    expect(schema.properties?.outputSchema).toBeDefined();
    expect(schema.properties?.fastMode).toBeDefined();
    expect(schema.properties?.groupId).toBeDefined();

    await tool.execute("collector", {
      task: "collect",
      collect: true,
      outputSchema: { type: "object", required: ["answer"] },
      fastMode: "auto",
      groupId: "swarm:custom",
    });

    const spawnArgs = mockCallArg(hoisted.spawnSubagentDirectMock, 0, 0, "spawnSubagentDirect");
    expect(spawnArgs).toMatchObject({
      collect: true,
      outputSchema: { type: "object", required: ["answer"] },
      fastMode: "auto",
      groupId: "swarm:custom",
      expectsCompletionMessage: false,
    });
    const spawnContext = mockCallArg(hoisted.spawnSubagentDirectMock, 0, 1, "spawnSubagentDirect");
    expect(spawnContext.requesterRunId).toBe("parent-run");
  });

  it("forwards host-only Code Mode idempotency metadata", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      requesterRunId: "parent-run",
      config: { tools: { swarm: true } },
    });
    const input: Record<PropertyKey, unknown> = { task: "collect", collect: true };
    Object.defineProperty(input, SWARM_CODE_MODE_IDEMPOTENCY_KEY, {
      value: "cm-restart:bridge:1",
    });
    Object.defineProperty(input, SWARM_CODE_MODE_REQUEST_FINGERPRINT, {
      value: "sha256:request",
    });

    await tool.execute("collector", input);

    const spawnArgs = hoisted.spawnSubagentDirectMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(spawnArgs.swarmLaunchReplayKey).toBe("cm-restart:bridge:1");
    expect(spawnArgs.swarmLaunchRequestFingerprint).toBe("sha256:request");
  });

  it("requires collect=true for outputSchema", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: { tools: { swarm: true } },
    });
    await expect(
      tool.execute("schema-without-collect", {
        task: "collect",
        outputSchema: { type: "object" },
      }),
    ).rejects.toThrow("requires collect=true");
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("requires collect=true for groupId", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: { tools: { swarm: true } },
    });
    await expect(
      tool.execute("group-without-collect", {
        task: "ordinary child",
        groupId: "swarm:custom",
      }),
    ).rejects.toThrow("requires collect=true");
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("advertises visible sessions with terse UI guidance", () => {
    const tool = createSessionsSpawnTool();
    const schema = tool.parameters as {
      properties?: Record<
        string,
        { anyOf?: unknown; description?: string; enum?: string[] } | undefined
      >;
    };

    expect(schema.properties?.visible?.description).toBe(
      "Durable visible session: coding/multi-step/keepable results; works without UI; subagent only; omit mode/thread/thinking/lightContext/attachments/attachAs.",
    );
    expect(schema.properties?.cwd?.description).toContain(
      "outside configured agent workspaces require operator.admin",
    );
    expect(tool.description).toContain("`visible=true`: durable visible session");
    expect(tool.description).toContain("Default for coding, multi-step work");
    expect(tool.description).toContain('no `mode="run"`');
    expect(tool.description).toContain("inherits the caller tool-policy ceiling");
    expect(tool.description).toContain("session URL on the first line");
    expect(tool.description).toContain("`Owner: <label>` on the second line");
    expect(tool.description).toContain("`tools.sessions.visibility`");
    expect(schema.properties?.runtime?.description).toContain("visible=true");
    expect(schema.properties?.mode?.description).toContain("Omit with visible=true");
    expect(schema.properties?.lightContext?.description).toContain("unavailable with visible=true");
    expect(schema.properties?.attachments?.description).toContain("unavailable with visible=true");
    expect(schema.properties?.attachAs?.description).toContain("unavailable with visible=true");
    expect(schema.properties?.category?.description).toContain("leave it ungrouped");
    expect(schema.properties?.mode?.enum).toEqual(["run"]);
    expect(schema.properties?.mode?.anyOf).toBeUndefined();
    expect(schema.properties?.worktree).toBeDefined();
  });

  it("creates visible worktree sessions and registers completion announce", async () => {
    await withTestDir({ prefix: "openclaw-visible-spawn-" }, async (dir) => {
      const callGateway = vi.fn(async () => ({
        key: "agent:main:dashboard:child",
        runStarted: true,
        runId: "run-visible",
      }));
      const registerRun = vi.fn();
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
        agentChannel: "slack",
        agentTo: "channel:C-stale",
        agentThreadId: "stale-thread",
        currentMessagingTarget: "channel:C-current",
        currentChannelId: "C-native",
        currentThreadTs: "current-thread",
        config: {
          session: { store: path.join(dir, "sessions.json") },
          agents: {
            defaults: {
              subagents: { model: "openai/gpt-5.4", runTimeoutSeconds: 120 },
            },
            list: [{ id: "main" }],
          },
        },
        callGateway: callGateway as never,
        registerRun,
        countActiveRuns: () => 0,
      });

      const result = await tool.execute("visible", {
        task: "inspect issue",
        label: "Issue review",
        category: "P1 issues from beta feedback",
        model: "anthropic/claude-sonnet-4-6",
        cwd: dir,
        context: "fork",
        visible: true,
        worktree: true,
        worktreeName: "issue-review",
        worktreeBaseRef: "main",
        cleanup: "delete",
      });

      expect(result.details).toMatchObject({
        status: "accepted",
        childSessionKey: "agent:main:dashboard:child",
        runId: "run-visible",
        cleanup: "keep",
      });
      expect(callGateway).toHaveBeenCalledWith("sessions.create", {
        agentId: "main",
        label: "Issue review",
        category: "P1 issues from beta feedback",
        model: "anthropic/claude-sonnet-4-6",
        task: "inspect issue",
        parentSessionKey: "agent:main:main",
        spawnDepth: 1,
        fork: true,
        cwd: dir,
        worktree: true,
        worktreeName: "issue-review",
        worktreeBaseRef: "main",
      });
      expect(registerRun).toHaveBeenCalledWith(
        expect.objectContaining({
          runId: "run-visible",
          childSessionKey: "agent:main:dashboard:child",
          requesterSessionKey: "agent:main:main",
          requesterOrigin: {
            channel: "slack",
            to: "channel:C-current",
            threadId: "current-thread",
          },
          cleanup: "keep",
          runTimeoutSeconds: 120,
          expectsCompletionMessage: true,
          spawnMode: "run",
        }),
      );
      expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    });
  });

  it.each([{ category: undefined }, { category: "" }])(
    "keeps a visible session ungrouped when category is $category",
    async ({ category }) => {
      const callGateway = vi.fn(async () => ({
        key: "agent:main:dashboard:child",
        runStarted: true,
        runId: "run-visible",
      }));
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
        config: { agents: { list: [{ id: "main" }] } },
        callGateway: callGateway as never,
        registerRun: vi.fn(),
        countActiveRuns: () => 0,
      });

      await tool.execute("visible-ungrouped", {
        task: "inspect issue",
        visible: true,
        ...(category !== undefined ? { category } : {}),
      });

      expect(callGateway).toHaveBeenCalledWith(
        "sessions.create",
        expect.not.objectContaining({ category: expect.anything() }),
      );
    },
  );

  it("explains an out-of-workspace visible cwd denial without suggesting a CLI fallback", async () => {
    await withTestDir({ prefix: "openclaw-visible-spawn-external-cwd-" }, async (workspace) => {
      const outside = path.dirname(workspace);
      const callGateway = vi.fn(async () => {
        throw new GatewayClientRequestError({
          code: "FORBIDDEN",
          message: "permission denied",
          details: {
            code: "MISSING_SCOPE",
            missingScope: "operator.admin",
            requiredScopes: ["operator.admin"],
          },
        });
      });
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
        config: { agents: { list: [{ id: "main", workspace }] } },
        callGateway: callGateway as never,
        countActiveRuns: () => 0,
      });

      const result = await tool.execute("visible-external-cwd", {
        task: "inspect issue",
        cwd: outside,
        visible: true,
        worktree: true,
      });

      expect(result.details).toMatchObject({
        status: "forbidden",
        error: `Visible session cwd "${outside}" is outside configured agent workspaces and requires operator.admin. Omit cwd to use the target agent workspace, or ask the operator to start the session from a registered project. Do not substitute the synchronous \`openclaw agent\` CLI for a persistent visible session.`,
      });
      expect(callGateway).toHaveBeenCalledOnce();
    });
  });

  it("preserves matching error text without structured missing-scope details", async () => {
    const callGateway = vi.fn(async () => {
      throw new Error("missing scope: operator.admin");
    });
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: { agents: { list: [{ id: "main" }] } },
      callGateway: callGateway as never,
      countActiveRuns: () => 0,
    });

    await expect(
      tool.execute("visible-message-only-denial", {
        task: "inspect issue",
        cwd: "/srv/external/repo",
        visible: true,
      }),
    ).rejects.toThrow("missing scope: operator.admin");
  });

  it("preserves inconsistent structured missing-scope details", async () => {
    const callGateway = vi.fn(async () => {
      throw new GatewayClientRequestError({
        code: "FORBIDDEN",
        message: "permission denied",
        details: {
          code: "MISSING_SCOPE",
          missingScope: "operator.admin",
          requiredScopes: ["operator.write"],
        },
      });
    });
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: { agents: { list: [{ id: "main" }] } },
      callGateway: callGateway as never,
      countActiveRuns: () => 0,
    });

    await expect(
      tool.execute("visible-inconsistent-scope-denial", {
        task: "inspect issue",
        cwd: "/srv/external/repo",
        visible: true,
      }),
    ).rejects.toThrow("permission denied");
  });

  it("preserves unrelated visible-session admin denials with an allowed cwd", async () => {
    await withTestDir({ prefix: "openclaw-visible-spawn-allowed-cwd-" }, async (workspace) => {
      const callGateway = vi.fn(async () => {
        throw new GatewayClientRequestError({
          code: "FORBIDDEN",
          message: "permission denied",
          details: {
            code: "MISSING_SCOPE",
            missingScope: "operator.admin",
            requiredScopes: ["operator.admin"],
          },
        });
      });
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
        config: { agents: { list: [{ id: "main", workspace }] } },
        callGateway: callGateway as never,
        countActiveRuns: () => 0,
      });

      await expect(
        tool.execute("visible-admin-denial", {
          task: "inspect issue",
          cwd: workspace,
          visible: true,
        }),
      ).rejects.toThrow("permission denied");
    });
  });

  it("rejects a visible spawn before creation when the exact parent incarnation changed", async () => {
    await withTestDir({ prefix: "openclaw-visible-spawn-parent-race-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const parentSessionKey = "agent:main:main";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: parentSessionKey, storePath },
        { sessionId: "replacement-parent", updatedAt: 2 },
      );
      const callGateway = vi.fn();
      const tool = createSessionsSpawnTool({
        agentSessionKey: parentSessionKey,
        expectedParentSessionId: "original-parent",
        config: {
          session: { store: storePath },
          agents: { list: [{ id: "main" }] },
        },
        callGateway,
        countActiveRuns: () => 0,
      });

      await expect(
        tool.execute("visible-stale-parent", { task: "inspect", visible: true }),
      ).rejects.toThrow(`Session "${parentSessionKey}" changed after access was granted.`);
      expect(callGateway).not.toHaveBeenCalled();
    });
  });

  it("requires visible sessions for worktree options", async () => {
    const tool = createSessionsSpawnTool({ agentSessionKey: "agent:main:main" });

    await expect(
      tool.execute("hidden-worktree", { task: "inspect", worktree: true }),
    ).rejects.toThrow("Parameters require visible=true: worktree");
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it.each(["Projects", ""])("rejects category %j without visible mode", async (category) => {
    const tool = createSessionsSpawnTool({ agentSessionKey: "agent:main:main" });

    await expect(tool.execute("hidden-category", { task: "inspect", category })).rejects.toThrow(
      "Parameters require visible=true: category",
    );
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("applies a per-run timeout to visible dashboard sessions", async () => {
    const callGateway = vi.fn(async () => ({
      key: "agent:main:dashboard:timed-child",
      runStarted: true,
      runId: "run-visible-timed",
    }));
    const registerRun = vi.fn();
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: {
        agents: {
          defaults: { subagents: { runTimeoutSeconds: 120 } },
          list: [{ id: "main" }],
        },
      },
      callGateway: callGateway as never,
      registerRun,
      countActiveRuns: () => 0,
    });

    const result = await tool.execute("visible-timeout", {
      task: "inspect issue",
      visible: true,
      runTimeoutSeconds: 7,
    });

    expect(result.details).toMatchObject({ status: "accepted", runId: "run-visible-timed" });
    expect(registerRun).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-visible-timed", runTimeoutSeconds: 7 }),
    );
  });

  it("uses the target agent model for cross-agent visible sessions", async () => {
    const callGateway = vi.fn(async () => ({
      key: "agent:reviewer:dashboard:child",
      runStarted: true,
      runId: "run-reviewer",
    }));
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: {
        agents: {
          defaults: { subagents: { allowAgents: ["reviewer"] } },
          list: [
            { id: "main" },
            { id: "reviewer", subagents: { model: "anthropic/claude-sonnet-4-6" } },
          ],
        },
      },
      callGateway: callGateway as never,
      registerRun: vi.fn(),
      countActiveRuns: () => 0,
    });

    await tool.execute("visible-reviewer", {
      task: "review patch",
      agentId: "reviewer",
      visible: true,
    });

    expect(callGateway).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({
        agentId: "reviewer",
        model: "anthropic/claude-sonnet-4-6",
        parentSessionKey: "agent:main:main",
        spawnDepth: 1,
      }),
    );
    expect(mockCallArg(callGateway, 0, 1, "sessions.create")).not.toHaveProperty("fork");
  });

  it("rejects cross-agent visible transcript forks", async () => {
    const callGateway = vi.fn();
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: {
        agents: {
          defaults: { subagents: { allowAgents: ["reviewer"] } },
          list: [{ id: "main" }, { id: "reviewer" }],
        },
      },
      callGateway,
      countActiveRuns: () => 0,
    });

    const result = await tool.execute("visible-cross-agent-fork", {
      task: "review patch",
      agentId: "reviewer",
      context: "fork",
      visible: true,
    });

    expect(result.details).toMatchObject({
      status: "error",
      error:
        'context="fork" currently requires the same target agent as the requester; use context="isolated" for cross-agent spawns.',
    });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("rejects cwd escape for sandboxed visible sessions", async () => {
    await withTestDir({ prefix: "openclaw-visible-sandbox-cwd-" }, async (dir) => {
      const callGateway = vi.fn();
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
        config: {
          agents: {
            defaults: { sandbox: { mode: "all" } },
            list: [{ id: "main", workspace: path.join(dir, "workspace") }],
          },
        },
        callGateway,
        countActiveRuns: () => 0,
      });

      const result = await tool.execute("visible-sandbox-cwd", {
        task: "inspect",
        cwd: path.join(dir, "outside"),
        visible: true,
      });

      expect(result.details).toMatchObject({
        status: "forbidden",
        error:
          "cwd override is not supported outside the target agent workspace for sandboxed visible session runs",
      });
      expect(callGateway).not.toHaveBeenCalled();
    });
  });

  it("allows cwd within a sandboxed visible session workspace", async () => {
    await withTestDir({ prefix: "openclaw-visible-sandbox-cwd-" }, async (dir) => {
      const workspace = path.join(dir, "workspace");
      const cwd = path.join(workspace, "packages", "app");
      const callGateway = vi.fn(async () => ({
        key: "agent:main:dashboard:child",
        runStarted: true,
        runId: "run-visible",
      }));
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
        config: {
          agents: {
            defaults: { sandbox: { mode: "all" } },
            list: [{ id: "main", workspace }],
          },
        },
        callGateway: callGateway as never,
        registerRun: vi.fn(),
        countActiveRuns: () => 0,
      });

      const result = await tool.execute("visible-sandbox-cwd", {
        task: "inspect",
        cwd,
        visible: true,
      });

      expect(result.details).toMatchObject({ status: "accepted" });
      expect(result.details).toMatchObject({ owner: { type: "agent", id: "main" } });
      expect(result.details).not.toHaveProperty("sessionUrl");
      expect(callGateway).toHaveBeenCalledWith("sessions.create", expect.objectContaining({ cwd }));
    });
  });

  it.each([
    [
      "thinking",
      { thinking: "high" },
      "Parameters unavailable with visible=true: thinking: thinking overrides are not wired to the sessions.create path",
    ],
    [
      "thread",
      { thread: true },
      "Parameters unavailable with visible=true: thread: visible sessions route to the dashboard, not a channel thread",
    ],
    [
      "mode",
      { mode: "session" },
      "Parameters unavailable with visible=true: mode: visible sessions are persistent dashboard sessions",
    ],
    [
      "lightContext",
      { lightContext: true },
      "Parameters unavailable with visible=true: lightContext: bootstrap staging is not wired to the sessions.create path",
    ],
    [
      "attachments",
      { attachments: [{ name: "note.txt", content: "hello" }] },
      "Parameters unavailable with visible=true: attachments: attachment staging is not wired to the sessions.create path",
    ],
    [
      "attachAs",
      { attachAs: { mountPath: "inputs" } },
      "Parameters unavailable with visible=true: attachAs: attachment staging is not wired to the sessions.create path",
    ],
  ] as const)("rejects visible %s overrides with a reason", async (_name, override, message) => {
    const tool = createSessionsSpawnTool({ agentSessionKey: "agent:main:main" });

    await expect(
      tool.execute("visible-unsupported", { task: "inspect", visible: true, ...override }),
    ).rejects.toThrow(message);
  });

  it("reports every unsupported visible parameter in one error", async () => {
    const tool = createSessionsSpawnTool({ agentSessionKey: "agent:main:main" });

    await expect(
      tool.execute("visible-unsupported-many", {
        task: "inspect",
        runtime: "acp",
        thinking: "high",
        thread: true,
        mode: "run",
        lightContext: true,
        attachments: [{ name: "note.txt", content: "hello" }],
        attachAs: { mountPath: "inputs" },
        visible: true,
      }),
    ).rejects.toThrow(
      'Parameters unavailable with visible=true: runtime: supports runtime="subagent" only; thinking: thinking overrides are not wired to the sessions.create path; thread: visible sessions route to the dashboard, not a channel thread; mode: visible sessions are persistent dashboard sessions; lightContext: bootstrap staging is not wired to the sessions.create path; attachments: attachment staging is not wired to the sessions.create path; attachAs: attachment staging is not wired to the sessions.create path',
    );
  });

  it("creates visible sessions while carrying inherited tool restrictions forward", async () => {
    hoisted.inProcessCreationMock.mockResolvedValue({
      key: "agent:main:dashboard:restricted-child",
      runStarted: true,
      runId: "run-visible-restricted",
    });
    const registerRun = vi.fn();
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: {
        agents: { list: [{ id: "main", identity: { name: "Roboclaw" } }] },
        gateway: { publicOrigin: "https://openclaw.example", controlUi: { basePath: "/control" } },
      },
      inheritedToolAllowlist: ["read", "sessions_spawn"],
      inheritedToolDenylist: ["exec"],
      registerRun,
      countActiveRuns: () => 0,
    });

    const result = await tool.execute("visible-restricted", {
      task: "inspect",
      label: "Track upstream fix",
      visible: true,
    });

    expect(result.details).toMatchObject({
      status: "accepted",
      childSessionKey: "agent:main:dashboard:restricted-child",
      runId: "run-visible-restricted",
      sessionUrl: "https://openclaw.example/control/chat/main/dashboard/restricted-child",
      owner: { type: "agent", id: "main", label: "Roboclaw" },
    });
    expect(hoisted.inProcessCreationMock).toHaveBeenCalledWith(
      "sessions.create",
      expect.objectContaining({
        agentId: "main",
        label: "Track upstream fix",
        parentSessionKey: "agent:main:main",
        spawnDepth: 1,
      }),
      {
        via: "spawn",
        actor: { type: "agent", id: "main" },
        requesterSessionKey: "agent:main:main",
        completionOwnerSessionKey: "agent:main:main",
        inheritedToolPolicy: {
          version: 1,
          allow: ["read", "sessions_spawn"],
          deny: ["exec"],
        },
      },
    );
    expect(registerRun).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionKey: "agent:main:dashboard:restricted-child",
        runId: "run-visible-restricted",
      }),
    );
  });

  it("blocks unsandboxed visible targets for a sandboxed caller runtime", async () => {
    const callGateway = vi.fn();
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      sandboxed: true,
      config: { agents: { list: [{ id: "main" }] } },
      callGateway,
      countActiveRuns: () => 0,
    });

    const result = await tool.execute("visible-sandboxed", { task: "inspect", visible: true });

    expect(result.details).toMatchObject({
      status: "forbidden",
      error: "Sandboxed sessions cannot spawn unsandboxed sessions.",
    });
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("reserves visible child capacity before session creation", async () => {
    let resolveCreate!: (value: { key: string; runStarted: true; runId: string }) => void;
    const pendingCreate = new Promise<{
      key: string;
      runStarted: true;
      runId: string;
    }>((resolve) => {
      resolveCreate = resolve;
    });
    const callGateway = vi.fn(async () => await pendingCreate);
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: {
        agents: {
          defaults: { subagents: { maxChildrenPerAgent: 1 } },
          list: [{ id: "main" }],
        },
      },
      callGateway: callGateway as never,
      registerRun: vi.fn(),
      countActiveRuns: () => 0,
    });

    const first = tool.execute("visible-first", { task: "first", visible: true });
    await vi.waitFor(() => expect(callGateway).toHaveBeenCalledTimes(1));
    const second = await tool.execute("visible-second", { task: "second", visible: true });

    expect(second.details).toMatchObject({
      status: "forbidden",
      error: expect.stringContaining("max active children"),
    });
    expect(callGateway).toHaveBeenCalledTimes(1);

    resolveCreate({
      key: "agent:main:dashboard:first",
      runStarted: true,
      runId: "run-first",
    });
    await expect(first).resolves.toEqual(
      expect.objectContaining({ details: expect.objectContaining({ status: "accepted" }) }),
    );
  });

  it("deletes a visible session whose initial run did not start", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({
        key: "agent:main:dashboard:not-started",
        runStarted: false,
        runError: "model unavailable",
      })
      .mockResolvedValueOnce({ deleted: true });
    const registerRun = vi.fn();
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: { agents: { list: [{ id: "main" }] } },
      callGateway,
      registerRun,
      countActiveRuns: () => 0,
    });

    const result = await tool.execute("visible-not-started", {
      task: "inspect",
      visible: true,
    });

    expect(result.details).toMatchObject({
      status: "error",
      error: "model unavailable",
      childSessionKey: "agent:main:dashboard:not-started",
    });
    expect(callGateway).toHaveBeenNthCalledWith(2, "sessions.delete", {
      key: "agent:main:dashboard:not-started",
      deleteTranscript: true,
      emitLifecycleHooks: false,
    });
    expect(registerRun).not.toHaveBeenCalled();
  });

  it("aborts a partially started visible run before deleting its session", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({
        key: "agent:main:dashboard:partial",
        runStarted: true,
        runError: "missing run id",
      })
      .mockResolvedValueOnce({ ok: true, abortedRunId: "run-partial" })
      .mockResolvedValueOnce({ deleted: true });
    const registerRun = vi.fn();
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: { agents: { list: [{ id: "main" }] } },
      callGateway,
      registerRun,
      countActiveRuns: () => 0,
    });

    const result = await tool.execute("visible-partial", { task: "inspect", visible: true });

    // A started-but-untrackable run (no run id) is always aborted and deleted,
    // never left as a visible orphan the parent cannot cancel.
    expect(result.details).toMatchObject({ status: "error" });
    expect((result.details as { childSessionKey?: string }).childSessionKey).toBeUndefined();
    expect(callGateway).toHaveBeenNthCalledWith(2, "sessions.abort", {
      key: "agent:main:dashboard:partial",
      agentId: "main",
    });
    expect(callGateway).toHaveBeenNthCalledWith(3, "sessions.delete", {
      key: "agent:main:dashboard:partial",
      deleteTranscript: true,
      emitLifecycleHooks: false,
    });
    expect(registerRun).not.toHaveBeenCalled();
  });

  it("deletes a started run with no run id even when abort reports nothing stopped", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({
        key: "agent:main:dashboard:untracked",
        runStarted: true,
        runError: "missing run id",
      })
      .mockResolvedValueOnce({ ok: true, abortedRunId: null })
      .mockResolvedValueOnce({ deleted: true });
    const registerRun = vi.fn();
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: { agents: { list: [{ id: "main" }] } },
      callGateway,
      registerRun,
      countActiveRuns: () => 0,
    });

    const result = await tool.execute("visible-untracked", { task: "inspect", visible: true });

    expect(result.details).toMatchObject({ status: "error" });
    expect(callGateway).toHaveBeenNthCalledWith(3, "sessions.delete", {
      key: "agent:main:dashboard:untracked",
      deleteTranscript: true,
      emitLifecycleHooks: false,
    });
    expect(registerRun).not.toHaveBeenCalled();
  });

  it("rolls back a visible session when announce registration fails", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({
        key: "agent:main:dashboard:orphan",
        runStarted: true,
        runId: "run-orphan",
      })
      .mockResolvedValueOnce({ ok: true, abortedRunId: "run-orphan" })
      .mockResolvedValueOnce({ deleted: true });
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: { agents: { list: [{ id: "main" }] } },
      callGateway,
      registerRun: () => {
        throw new Error("registry unavailable");
      },
      countActiveRuns: () => 0,
    });

    const result = await tool.execute("visible-orphan", { task: "inspect", visible: true });

    expect(result.details).toMatchObject({ status: "error", runId: "run-orphan" });
    expect(callGateway).toHaveBeenNthCalledWith(2, "sessions.abort", {
      key: "agent:main:dashboard:orphan",
      runId: "run-orphan",
      agentId: "main",
    });
    expect(callGateway).toHaveBeenNthCalledWith(3, "sessions.delete", {
      key: "agent:main:dashboard:orphan",
      deleteTranscript: true,
      emitLifecycleHooks: false,
    });
  });

  it("keeps a visible session when rollback cannot abort its run", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({
        key: "agent:main:dashboard:live",
        runStarted: true,
        runId: "run-live",
      })
      .mockRejectedValueOnce(new Error("abort unavailable"));
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: { agents: { list: [{ id: "main" }] } },
      callGateway,
      registerRun: () => {
        throw new Error("registry unavailable");
      },
      countActiveRuns: () => 0,
    });

    const result = await tool.execute("visible-live", { task: "inspect", visible: true });

    expect(result.details).toMatchObject({
      status: "error",
      childSessionKey: "agent:main:dashboard:live",
      runId: "run-live",
    });
    expect(callGateway).toHaveBeenCalledTimes(2);
  });

  it("keeps a visible session when rollback does not confirm its run", async () => {
    const callGateway = vi
      .fn()
      .mockResolvedValueOnce({
        key: "agent:main:dashboard:finished",
        runStarted: true,
        runId: "run-finished",
      })
      .mockResolvedValueOnce({ ok: true, abortedRunId: null, status: "no-active-run" });
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: { agents: { list: [{ id: "main" }] } },
      callGateway,
      registerRun: () => {
        throw new Error("registry unavailable");
      },
      countActiveRuns: () => 0,
    });

    const result = await tool.execute("visible-finished", { task: "inspect", visible: true });

    expect(result.details).toMatchObject({
      status: "error",
      error: expect.stringContaining("Run abort unconfirmed. Session kept."),
      childSessionKey: "agent:main:dashboard:finished",
      runId: "run-finished",
    });
    expect(callGateway).toHaveBeenCalledTimes(2);
  });

  it("applies spawn depth limits to visible dashboard descendants", async () => {
    await withTestDir({ prefix: "openclaw-visible-depth-" }, async (dir) => {
      const storePath = path.join(dir, "sessions.json");
      const childKey = "agent:main:dashboard:child";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: "agent:main:main", storePath },
        { sessionId: "root", updatedAt: 1 },
      );
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: childKey, storePath },
        // Canonical spawn-child shape: sessions.create persists explicit
        // spawnDepth; parentSessionKey alone is UI threading and adds no depth.
        { sessionId: "child", updatedAt: 1, spawnDepth: 1, parentSessionKey: "agent:main:main" },
      );
      const callGateway = vi.fn();
      const tool = createSessionsSpawnTool({
        agentSessionKey: childKey,
        config: {
          session: { store: storePath },
          agents: {
            list: [{ id: "main" }],
            defaults: { subagents: { maxSpawnDepth: 1 } },
          },
        },
        callGateway,
        countActiveRuns: () => 0,
      });

      const result = await tool.execute("visible-depth", { task: "inspect", visible: true });

      expect(result.details).toMatchObject({ status: "forbidden" });
      expect(callGateway).not.toHaveBeenCalled();

      callGateway.mockResolvedValue({
        key: "agent:main:dashboard:grandchild",
        runStarted: true,
        runId: "run-grandchild",
      });
      const nestedTool = createSessionsSpawnTool({
        agentSessionKey: childKey,
        config: {
          session: { store: storePath },
          agents: {
            list: [{ id: "main" }],
            defaults: { subagents: { maxSpawnDepth: 2 } },
          },
        },
        callGateway,
        countActiveRuns: () => 0,
        registerRun: vi.fn(),
      });

      const nestedResult = await nestedTool.execute("visible-nested", {
        task: "inspect from the grandchild",
        visible: true,
      });

      expect(nestedResult.details).toMatchObject({
        status: "accepted",
        childSessionKey: "agent:main:dashboard:grandchild",
        runId: "run-grandchild",
      });
      expect(callGateway).toHaveBeenCalledWith(
        "sessions.create",
        expect.objectContaining({
          parentSessionKey: childKey,
          spawnDepth: 2,
          task: "inspect from the grandchild",
        }),
      );
    });
  });

  it("hides thread-bound spawn fields when current channel disables spawnSessions", () => {
    const tool = createSessionsSpawnTool({
      agentChannel: "discord",
      agentAccountId: "default",
      config: {
        session: {
          threadBindings: {
            spawnSessions: false,
          },
        },
      },
    });
    const schema = tool.parameters as {
      properties?: Record<
        string,
        { description?: string; enum?: string[]; type?: string } | undefined
      >;
    };

    expect(schema.properties?.thread).toBeUndefined();
    expect(schema.properties?.mode?.enum).toEqual(["run"]);
    expect(tool.description).not.toContain("thread-bound");
    expect(tool.description).not.toContain("session-mode output stays in thread");
  });

  it("shows thread-bound spawn fields when current channel allows spawnSessions", () => {
    const tool = createSessionsSpawnTool({
      agentChannel: "discord",
      agentAccountId: "default",
      config: {
        session: {
          threadBindings: {
            spawnSessions: true,
          },
        },
      },
    });
    const schema = tool.parameters as {
      properties?: Record<
        string,
        { description?: string; enum?: string[]; type?: string } | undefined
      >;
    };

    const thread = requireSchemaProperty(schema.properties, "thread");
    expect(thread.type).toBe("boolean");
    expect(schema.properties?.mode?.enum).toEqual(["run", "session"]);
    expect(tool.description).toContain("thread-bound");
  });

  it("uses subagent runtime by default", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "quietchat",
      agentAccountId: "default",
      agentTo: "channel:123",
      agentThreadId: "456",
    });

    const result = await tool.execute("call-1", {
      task: "build feature",
      agentId: "main",
      model: "anthropic/claude-sonnet-4-6",
      thinking: "medium",
      cwd: "/workspace/requester",
      thread: true,
      mode: "session",
      cleanup: "keep",
    });

    expectDetailFields(result.details, {
      status: "accepted",
      childSessionKey: "agent:main:subagent:1",
      runId: "run-subagent",
    });
    expect(result.details).not.toHaveProperty("role");
    const spawnArgs = mockCallArg(hoisted.spawnSubagentDirectMock, 0, 0, "spawnSubagentDirect");
    expect(spawnArgs.task).toBe("build feature");
    expect(spawnArgs.agentId).toBe("main");
    expect(spawnArgs.model).toBe("anthropic/claude-sonnet-4-6");
    expect(spawnArgs.thinking).toBe("medium");
    expect(spawnArgs.cwd).toBe("/workspace/requester");
    expect(spawnArgs).not.toHaveProperty("runTimeoutSeconds");
    expect(spawnArgs.thread).toBe(true);
    expect(spawnArgs.mode).toBe("session");
    expect(spawnArgs.cleanup).toBe("keep");
    const spawnContext = mockCallArg(hoisted.spawnSubagentDirectMock, 0, 1, "spawnSubagentDirect");
    expect(spawnContext.agentSessionKey).toBe("agent:main:main");
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
  });

  it("passes inherited tool denies to subagent spawns", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      inheritedToolDenylist: ["exec", "read"],
    });

    await tool.execute("call-inherited-deny", {
      task: "build feature",
    });

    const spawnContext = mockCallArg(hoisted.spawnSubagentDirectMock, 0, 1, "spawnSubagentDirect");
    expect(spawnContext.inheritedToolDenylist).toEqual(["exec", "read"]);
  });

  it("passes inherited tool allow lists to subagent spawns", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      inheritedToolAllowlist: ["sessions_spawn", "read"],
    });

    await tool.execute("call-inherited-allow", {
      task: "build feature",
    });

    const spawnContext = mockCallArg(hoisted.spawnSubagentDirectMock, 0, 1, "spawnSubagentDirect");
    expect(spawnContext.inheritedToolAllowlist).toEqual(["sessions_spawn", "read"]);
  });

  it("accepts taskName as a stable subagent handle", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });
    const schema = tool.parameters as {
      properties?: Record<string, { description?: string; type?: string } | undefined>;
    };

    expect(requireSchemaProperty(schema.properties, "taskName").description).toContain(
      "Stable later-target alias",
    );
    expect(requireSchemaProperty(schema.properties, "taskName").description).toContain(
      "starts lowercase letter",
    );

    const result = await tool.execute("call-task-name", {
      task: "review subagent handling",
      taskName: "review-subagents",
    });

    expectDetailFields(result.details, {
      status: "accepted",
      childSessionKey: "agent:main:subagent:1",
    });
    const spawnArgs = mockCallArg(hoisted.spawnSubagentDirectMock, 0, 0, "spawnSubagentDirect");
    expect(spawnArgs.task).toBe("review subagent handling");
    expect(spawnArgs.taskName).toBe("review-subagents");
  });

  it("accepts underscore taskName aliases", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call-underscore-task-name", {
      task: "review subagent handling",
      taskName: "review_subagents",
    });

    expectDetailFields(result.details, {
      status: "accepted",
      childSessionKey: "agent:main:subagent:1",
    });
    const spawnArgs = mockCallArg(hoisted.spawnSubagentDirectMock, 0, 0, "spawnSubagentDirect");
    expect(spawnArgs.taskName).toBe("review_subagents");
  });

  it.each(["Bad-Name", "code review", "-bad"])(
    "rejects invalid taskName %s before spawning",
    async (taskName) => {
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
      });

      const result = await tool.execute("call-bad-task-name", {
        task: "review subagent handling",
        taskName,
      });

      expectDetailFields(result.details, { status: "error" });
      expect(JSON.stringify(result.details)).toContain("Invalid taskName");
      expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    },
  );

  it.each(["last", "all"])("rejects reserved taskName %s before spawning", async (taskName) => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute(`call-reserved-task-name-${taskName}`, {
      task: "review subagent handling",
      taskName,
    });

    expectDetailFields(result.details, { status: "error" });
    expect(JSON.stringify(result.details)).toContain("Reserved subagent targets");
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it.each([
    { status: "error" as const, error: "spawn failed" },
    { status: "forbidden" as const, error: "not allowed" },
  ])("adds requested role to forwarded subagent $status results", async (spawnResult) => {
    hoisted.spawnSubagentDirectMock.mockResolvedValueOnce(spawnResult);
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call-role-error", {
      task: "build feature",
      agentId: "reviewer",
    });

    expectDetailFields(result.details, { ...spawnResult, role: "reviewer" });
  });

  it("does not add role to forwarded failures when agentId is absent", async () => {
    hoisted.spawnSubagentDirectMock.mockResolvedValueOnce({
      status: "error",
      error: "spawn failed",
    });
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call-no-role-error", {
      task: "build feature",
    });

    expectDetailFields(result.details, { status: "error", error: "spawn failed" });
    expect(result.details).not.toHaveProperty("role");
  });

  it.each(["runTimeoutSeconds", "run_timeout_seconds"] as const)(
    "forwards native per-run timeout argument %s",
    async (timeoutParam) => {
      const tool = createSessionsSpawnTool({ agentSessionKey: "agent:main:main" });

      await tool.execute("call-run-timeout", {
        task: "do thing",
        [timeoutParam]: 2,
      });

      expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
        expect.objectContaining({ task: "do thing", runTimeoutSeconds: 2 }),
        expect.any(Object),
      );
    },
  );

  it("forwards a zero native timeout so a child can explicitly disable the default", async () => {
    const tool = createSessionsSpawnTool({ agentSessionKey: "agent:main:main" });

    await tool.execute("call-no-timeout", { task: "do thing", runTimeoutSeconds: 0 });

    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({ task: "do thing", runTimeoutSeconds: 0 }),
      expect.any(Object),
    );
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, "not-a-number"])(
    "rejects invalid native timeout %s before spawning",
    async (runTimeoutSeconds) => {
      const tool = createSessionsSpawnTool({ agentSessionKey: "agent:main:main" });

      await expect(
        tool.execute("call-invalid-timeout", { task: "do thing", runTimeoutSeconds }),
      ).rejects.toThrow("runTimeoutSeconds must be a non-negative integer");

      expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
      expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
    },
  );

  it.each(["timeoutSeconds", "timeout_seconds"] as const)(
    "rejects ambiguous wait-timeout argument %s",
    async (timeoutParam) => {
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
      });

      await expect(
        tool.execute("call-stale-timeout-override", {
          task: "do thing",
          [timeoutParam]: 2,
        }),
      ).rejects.toThrow(
        `sessions_spawn does not support "${timeoutParam}". Use "runTimeoutSeconds" for a per-run timeout.`,
      );

      expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    },
  );

  it("passes inherited workspaceDir from tool context, not from tool args", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      workspaceDir: "/parent/workspace",
    });

    await tool.execute("call-ws", {
      task: "inspect AGENTS",
      workspaceDir: "/tmp/attempted-override",
    });

    const spawnContext = mockCallArg(hoisted.spawnSubagentDirectMock, 0, 1, "spawnSubagentDirect");
    expect(spawnContext.workspaceDir).toBe("/parent/workspace");
  });

  it("passes lightContext through to subagent spawns", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    await tool.execute("call-light", {
      task: "summarize this",
      lightContext: true,
    });

    const spawnArgs = mockCallArg(hoisted.spawnSubagentDirectMock, 0, 0, "spawnSubagentDirect");
    expect(spawnArgs.task).toBe("summarize this");
    expect(spawnArgs.lightContext).toBe(true);
  });

  it('rejects lightContext when runtime is not "subagent"', async () => {
    registerAcpBackendForTest();
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    await expect(
      tool.execute("call-light-acp", {
        runtime: "acp",
        task: "summarize this",
        lightContext: true,
      }),
    ).rejects.toThrow("lightContext is only supported for runtime='subagent'.");

    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
  });

  it("routes to ACP runtime when runtime=acp", async () => {
    registerAcpBackendForTest();
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      requesterAgentIdOverride: "main",
      agentChannel: "quietchat",
      agentAccountId: "default",
      agentTo: "channel:123",
      agentThreadId: "456",
      currentMessagingTarget: "channel:source",
      currentChannelId: "source-native",
      currentMessageId: "message-789",
    });

    const result = await tool.execute("call-2", {
      runtime: "acp",
      task: "investigate the failing CI run",
      agentId: "codex",
      cwd: "/workspace",
      thread: true,
      mode: "session",
      streamTo: "parent",
    });

    expectDetailFields(result.details, {
      status: "accepted",
      childSessionKey: "agent:codex:acp:1",
      runId: "run-acp",
    });
    const spawnArgs = mockCallArg(hoisted.spawnAcpDirectMock, 0, 0, "spawnAcpDirect");
    expect(spawnArgs.task).toBe("investigate the failing CI run");
    expect(spawnArgs.agentId).toBe("codex");
    expect(spawnArgs.cwd).toBe("/workspace");
    expect(spawnArgs).not.toHaveProperty("runTimeoutSeconds");
    expect(spawnArgs.thread).toBe(true);
    expect(spawnArgs.mode).toBe("session");
    expect(spawnArgs.cleanup).toBe("keep");
    expect(spawnArgs.expectsCompletionMessage).toBe(true);
    expect(spawnArgs.streamTo).toBe("parent");
    const spawnContext = mockCallArg(hoisted.spawnAcpDirectMock, 0, 1, "spawnAcpDirect");
    expect(spawnContext.agentSessionKey).toBe("agent:main:main");
    expect(spawnContext.requesterAgentIdOverride).toBe("main");
    expect(spawnContext.currentMessagingTarget).toBe("channel:source");
    expect(spawnContext.currentChannelId).toBe("source-native");
    expect(spawnContext.currentMessageId).toBe("message-789");
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    // Registration and progress hooks now belong to the shared backend pipeline.
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
    expect(hoisted.runSubagentProgressMock).not.toHaveBeenCalled();
  });

  it("passes inherited tool denies to ACP spawns", async () => {
    registerAcpBackendForTest();
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      inheritedToolDenylist: ["custom_control_tool"],
    });

    await tool.execute("call-acp-inherited-deny", {
      runtime: "acp",
      task: "investigate",
      agentId: "codex",
    });

    const spawnContext = mockCallArg(hoisted.spawnAcpDirectMock, 0, 1, "spawnAcpDirect");
    expect(spawnContext.inheritedToolDenylist).toEqual(["custom_control_tool"]);
  });

  it("rejects ACP spawns when inherited denies include command tools", async () => {
    registerAcpBackendForTest();
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      inheritedToolDenylist: ["exec"],
    });

    const result = await tool.execute("call-acp-inherited-command-deny", {
      runtime: "acp",
      task: "investigate",
      agentId: "codex",
    });

    expectDetailFields(result.details, { status: "forbidden", role: "codex" });
    expect(JSON.stringify(result.details)).toContain("requester denies exec");
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
  });

  it("rejects ACP spawns when inherited deny groups or patterns include command tools", async () => {
    registerAcpBackendForTest();
    const cases = [
      { inheritedToolDenylist: ["group:fs"], expected: "requester denies apply_patch" },
      { inheritedToolDenylist: ["group:runtime"], expected: "requester denies exec" },
      { inheritedToolDenylist: ["exec*"], expected: "requester denies exec" },
      { inheritedToolDenylist: ["*"], expected: "requester denies apply_patch" },
    ];

    for (const testCase of cases) {
      const tool = createSessionsSpawnTool({
        agentSessionKey: "agent:main:main",
        inheritedToolDenylist: testCase.inheritedToolDenylist,
      });

      const result = await tool.execute("call-acp-inherited-command-group-deny", {
        runtime: "acp",
        task: "investigate",
        agentId: "codex",
      });

      expectDetailFields(result.details, { status: "forbidden", role: "codex" });
      expect(JSON.stringify(result.details)).toContain(testCase.expected);
    }
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
  });

  it("rejects ACP spawns when inherited allows omit command tools", async () => {
    registerAcpBackendForTest();
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      inheritedToolAllowlist: ["sessions_spawn", "custom_plugin_tool"],
    });

    const result = await tool.execute("call-acp-inherited-command-allow", {
      runtime: "acp",
      task: "investigate",
      agentId: "codex",
    });

    expectDetailFields(result.details, { status: "forbidden", role: "codex" });
    expect(JSON.stringify(result.details)).toContain("requester does not allow apply_patch");
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
  });

  it("accepts ACP spawns when inherited allows include OpenClaw command tools", async () => {
    registerAcpBackendForTest();
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      inheritedToolAllowlist: [
        "apply_patch",
        "edit",
        "exec",
        "process",
        "read",
        "sessions_spawn",
        "write",
      ],
    });

    const result = await tool.execute("call-acp-inherited-command-allow-compatible", {
      runtime: "acp",
      task: "investigate",
      agentId: "codex",
    });

    expectDetailFields(result.details, {
      status: "accepted",
      childSessionKey: "agent:codex:acp:1",
    });
    const spawnContext = mockCallArg(hoisted.spawnAcpDirectMock, 0, 1, "spawnAcpDirect");
    expect(spawnContext.inheritedToolAllowlist).toEqual([
      "apply_patch",
      "edit",
      "exec",
      "process",
      "read",
      "sessions_spawn",
      "write",
    ]);
  });

  it("forwards model override to ACP runtime spawns", async () => {
    registerAcpBackendForTest();
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    await tool.execute("call-2-model", {
      runtime: "acp",
      task: "investigate the failing CI run",
      agentId: "codex",
      model: "github-copilot/claude-sonnet-4.6",
    });

    const spawnArgs = mockCallArg(hoisted.spawnAcpDirectMock, 0, 0, "spawnAcpDirect");
    expect(spawnArgs.task).toBe("investigate the failing CI run");
    expect(spawnArgs.agentId).toBe("codex");
    expect(spawnArgs.model).toBe("github-copilot/claude-sonnet-4.6");
  });

  it("forwards a per-run timeout to ACP runtime spawns", async () => {
    registerAcpBackendForTest();
    const tool = createSessionsSpawnTool({ agentSessionKey: "agent:main:main" });

    await tool.execute("call-acp-timeout", {
      runtime: "acp",
      task: "investigate the failing CI run",
      agentId: "codex",
      runTimeoutSeconds: 45,
    });

    expect(hoisted.spawnAcpDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "investigate the failing CI run",
        agentId: "codex",
        runTimeoutSeconds: 45,
      }),
      expect.any(Object),
    );
  });

  it("adds requested role to forwarded ACP failures", async () => {
    registerAcpBackendForTest();
    hoisted.spawnAcpDirectMock.mockResolvedValueOnce({
      status: "forbidden",
      error: "ACP disabled",
      errorCode: "acp_disabled",
    });
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call-acp-role-error", {
      runtime: "acp",
      task: "investigate",
      agentId: "codex",
    });

    expectDetailFields(result.details, {
      status: "forbidden",
      error: "ACP disabled",
      errorCode: "acp_disabled",
      role: "codex",
    });
  });

  it("forwards ACP sandbox options", async () => {
    registerAcpBackendForTest();
    hoisted.spawnAcpDirectMock.mockResolvedValueOnce({
      status: "accepted",
      childSessionKey: "agent:codex:acp:1",
      runId: "run-acp",
      mode: "run",
      runTimeoutSeconds: 120,
    });
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:subagent:parent",
    });

    await tool.execute("call-2b", {
      runtime: "acp",
      task: "investigate",
      agentId: "codex",
      sandbox: "require",
    });

    const spawnArgs = mockCallArg(hoisted.spawnAcpDirectMock, 0, 0, "spawnAcpDirect");
    expect(spawnArgs.task).toBe("investigate");
    expect(spawnArgs.sandbox).toBe("require");
    expect(spawnArgs.cleanup).toBe("keep");
    const spawnContext = mockCallArg(hoisted.spawnAcpDirectMock, 0, 1, "spawnAcpDirect");
    expect(spawnContext.agentSessionKey).toBe("agent:main:subagent:parent");
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  });

  it("forwards completion policy for inline ACP session delivery", async () => {
    registerAcpBackendForTest();
    hoisted.spawnAcpDirectMock.mockResolvedValueOnce({
      status: "accepted",
      childSessionKey: "agent:codex:acp:1",
      runId: "run-acp",
      mode: "session",
      inlineDelivery: true,
    });
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
      agentAccountId: "default",
      agentTo: "channel:parent-channel",
      agentThreadId: "child-thread",
    });

    await tool.execute("call-inline-acp", {
      runtime: "acp",
      task: "investigate",
      agentId: "codex",
      thread: true,
      mode: "session",
    });

    const spawnArgs = mockCallArg(hoisted.spawnAcpDirectMock, 0, 0, "spawnAcpDirect");
    expect(spawnArgs.mode).toBe("session");
    expect(spawnArgs.cleanup).toBe("keep");
    expect(spawnArgs.expectsCompletionMessage).toBe(true);
    // Inline-delivery suppression is decided after the ACP adapter binds its thread.
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  });

  it("rejects ACP runtime calls from sandboxed requester sessions", async () => {
    registerAcpBackendForTest();
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:subagent:parent",
      sandboxed: true,
    });

    const result = await tool.execute("call-sandboxed-acp", {
      runtime: "acp",
      task: "investigate",
      agentId: "codex",
    });

    expectDetailFields(result.details, { status: "error", role: "codex" });
    expect(JSON.stringify(result.details)).toContain("sandboxed sessions");
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
  });

  it("passes resumeSessionId through to ACP spawns", async () => {
    registerAcpBackendForTest();
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    await tool.execute("call-2c", {
      runtime: "acp",
      task: "resume prior work",
      agentId: "codex",
      resumeSessionId: "7f4a78e0-f6be-43fe-855c-c1c4fd229bc4",
    });

    const spawnArgs = mockCallArg(hoisted.spawnAcpDirectMock, 0, 0, "spawnAcpDirect");
    expect(spawnArgs.task).toBe("resume prior work");
    expect(spawnArgs.agentId).toBe("codex");
    expect(spawnArgs.resumeSessionId).toBe("7f4a78e0-f6be-43fe-855c-c1c4fd229bc4");
  });

  it("ignores ACP-only fields for subagent spawns", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call-guard", {
      runtime: "subagent",
      task: "resume prior work",
      resumeSessionId: "7f4a78e0-f6be-43fe-855c-c1c4fd229bc4",
      streamTo: "parent",
    });

    expectDetailFields(result.details, {
      status: "accepted",
      childSessionKey: "agent:main:subagent:1",
      runId: "run-subagent",
    });
    const spawnArgs = mockCallArg(hoisted.spawnSubagentDirectMock, 0, 0, "spawnSubagentDirect");
    expect(spawnArgs.task).toBe("resume prior work");
    const spawnContext = mockCallArg(hoisted.spawnSubagentDirectMock, 0, 1, "spawnSubagentDirect");
    expect(spawnContext.agentSessionKey).toBe("agent:main:main");
    expect(spawnArgs).not.toHaveProperty("resumeSessionId");
    expect(spawnArgs).not.toHaveProperty("streamTo");
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
  });

  it("rejects ACP attachments when sessions_spawn attachments are disabled", async () => {
    registerAcpBackendForTest();
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: {} as never,
    });

    const imageBase64 = Buffer.from("png-bytes").toString("base64");
    const result = await tool.execute("call-3", {
      runtime: "acp",
      task: "describe the image",
      attachments: [
        { name: "photo.png", content: imageBase64, encoding: "base64", mimeType: "image/png" },
      ],
    });

    expectDetailFields(result.details, { status: "forbidden" });
    expect(JSON.stringify(result.details)).toContain("attachments are disabled");
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("forwards validated image attachments for ACP runtime", async () => {
    registerAcpBackendForTest();
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "quietchat",
      agentAccountId: "default",
      agentTo: "channel:123",
      agentThreadId: "456",
      config: {
        tools: {
          sessions_spawn: {
            attachments: {
              enabled: true,
              maxFiles: 1,
              maxFileBytes: 32,
              maxTotalBytes: 32,
            },
          },
        },
      } as never,
    });

    const imageBase64 = Buffer.from("png-bytes").toString("base64");
    const result = await tool.execute("call-3", {
      runtime: "acp",
      task: "describe the image",
      attachments: [
        { name: "photo.png", content: imageBase64, encoding: "base64", mimeType: "image/png" },
      ],
    });

    expect(result.details).toMatchObject({
      status: "accepted",
    });
    expect(hoisted.spawnAcpDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "describe the image",
        attachments: [{ mediaType: "image/png", data: imageBase64 }],
      }),
      expect.objectContaining({
        agentSessionKey: "agent:main:main",
      }),
    );
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it("rejects non-image ACP attachments", async () => {
    registerAcpBackendForTest();
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: {
        tools: { sessions_spawn: { attachments: { enabled: true } } },
      } as never,
    });

    const result = await tool.execute("call-acp-non-image", {
      runtime: "acp",
      task: "read text",
      attachments: [
        { name: "note.txt", content: "hello", encoding: "utf8", mimeType: "text/plain" },
      ],
    });

    expectDetailFields(result.details, { status: "error" });
    expect(JSON.stringify(result.details)).toContain("attachments_unsupported_for_acp");
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
  });

  it("enforces ACP attachment size limits", async () => {
    registerAcpBackendForTest();
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      config: {
        tools: {
          sessions_spawn: {
            attachments: {
              enabled: true,
              maxFiles: 1,
              maxFileBytes: 4,
              maxTotalBytes: 4,
            },
          },
        },
      } as never,
    });

    const result = await tool.execute("call-acp-too-large", {
      runtime: "acp",
      task: "describe the image",
      attachments: [
        { name: "photo.png", content: "too large", encoding: "utf8", mimeType: "image/png" },
      ],
    });

    expectDetailFields(result.details, { status: "error" });
    expect(JSON.stringify(result.details)).toContain("attachments_file_bytes_exceeded");
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
  });

  it('ignores streamTo when runtime is omitted and defaults to "subagent"', async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call-3b", {
      task: "analyze file",
      resumeSessionId: "7f4a78e0-f6be-43fe-855c-c1c4fd229bc4",
      streamTo: "parent",
    });

    expectDetailFields(result.details, {
      status: "accepted",
      childSessionKey: "agent:main:subagent:1",
      runId: "run-subagent",
    });
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
    const spawnArgs = mockCallArg(hoisted.spawnSubagentDirectMock, 0, 0, "spawnSubagentDirect");
    expect(spawnArgs.task).toBe("analyze file");
    expect(spawnArgs).not.toHaveProperty("resumeSessionId");
    expect(spawnArgs).not.toHaveProperty("streamTo");
  });

  it('treats model="default" as no explicit model override', async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    await tool.execute("call-model-default", {
      task: "analyze file",
      model: "default",
    });

    const spawnArgs = mockCallArg(hoisted.spawnSubagentDirectMock, 0, 0, "spawnSubagentDirect");
    expect(spawnArgs.task).toBe("analyze file");
    expect(spawnArgs.model).toBeUndefined();
  });

  it("keeps attachment content schema unconstrained for llama.cpp grammar safety", () => {
    const tool = createSessionsSpawnTool();
    const schema = tool.parameters as {
      properties?: {
        attachments?: {
          items?: {
            properties?: {
              content?: {
                type?: string;
                maxLength?: number;
              };
            };
          };
        };
      };
    };

    const contentSchema = schema.properties?.attachments?.items?.properties?.content;
    expect(contentSchema?.type).toBe("string");
    expect(contentSchema?.maxLength).toBeUndefined();
  });

  it("registers requesterSessionKey from the provided agentSessionKey, not the sandbox peer key", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "telegram",
      agentAccountId: "bot-1",
      agentTo: "telegram:direct:123",
    });

    await tool.execute("call-requester-key", {
      task: "background research",
    });

    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledTimes(1);
    const spawnContext = mockCallArg(hoisted.spawnSubagentDirectMock, 0, 1, "spawnSubagentDirect");
    expect(spawnContext.agentSessionKey).toBe("agent:main:main");
  });

  it("does not use the Telegram peer key as requesterSessionKey when agentSessionKey is the run session", async () => {
    const telegramPeerKey = "agent:main:telegram:default:direct:456";
    const runSessionKey = "agent:main:main";

    const toolWithPeerKey = createSessionsSpawnTool({
      agentSessionKey: telegramPeerKey,
      agentChannel: "telegram",
      agentAccountId: "default",
      agentTo: "telegram:direct:456",
    });

    await toolWithPeerKey.execute("call-peer-key", { task: "task A" });

    const toolWithRunKey = createSessionsSpawnTool({
      agentSessionKey: runSessionKey,
      agentChannel: "telegram",
      agentAccountId: "default",
      agentTo: "telegram:direct:456",
    });

    await toolWithRunKey.execute("call-run-key", { task: "task B" });

    const peerContext = mockCallArg(hoisted.spawnSubagentDirectMock, 0, 1, "spawnSubagentDirect");
    const runContext = mockCallArg(hoisted.spawnSubagentDirectMock, 1, 1, "spawnSubagentDirect");
    expect(peerContext.agentSessionKey).toBe(telegramPeerKey);
    expect(runContext.agentSessionKey).toBe(runSessionKey);
  });

  it("passes completionOwnerKey through to spawnSubagentDirect separately from agentSessionKey", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:telegram:default:direct:456",
      completionOwnerKey: "agent:main:main",
      agentChannel: "telegram",
      agentAccountId: "default",
      agentTo: "telegram:direct:456",
    });

    await tool.execute("call-completion-owner", { task: "background work" });

    const spawnContext = mockCallArg(hoisted.spawnSubagentDirectMock, 0, 1, "spawnSubagentDirect");
    expect(spawnContext.agentSessionKey).toBe("agent:main:telegram:default:direct:456");
    expect(spawnContext.completionOwnerKey).toBe("agent:main:main");
  });

  it("forwards completionOwnerKey to the ACP registration pipeline", async () => {
    registerAcpBackendForTest();
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:telegram:default:direct:456",
      completionOwnerKey: "agent:main:main",
      agentChannel: "telegram",
      agentAccountId: "default",
      agentTo: "telegram:direct:456",
    });

    await tool.execute("call-acp-completion-owner", {
      runtime: "acp",
      task: "investigate",
      agentId: "codex",
    });

    const spawnContext = mockCallArg(hoisted.spawnAcpDirectMock, 0, 1, "spawnAcpDirect");
    expect(spawnContext.agentSessionKey).toBe("agent:main:telegram:default:direct:456");
    expect(spawnContext.completionOwnerKey).toBe("agent:main:main");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
