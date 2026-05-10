import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  const spawnSubagentDirectMock = vi.fn();
  const spawnAcpDirectMock = vi.fn();
  const registerSubagentRunMock = vi.fn();
  return {
    spawnSubagentDirectMock,
    spawnAcpDirectMock,
    registerSubagentRunMock,
  };
});

vi.mock("../subagent-spawn.js", () => ({
  SUBAGENT_SPAWN_CONTEXT_MODES: ["isolated", "fork"],
  SUBAGENT_SPAWN_MODES: ["run", "session"],
  spawnSubagentDirect: (...args: unknown[]) => hoisted.spawnSubagentDirectMock(...args),
}));

vi.mock("../acp-spawn.js", () => ({
  ACP_SPAWN_MODES: ["run", "session"],
  ACP_SPAWN_STREAM_TARGETS: ["parent"],
  isSpawnAcpAcceptedResult: (result: { status?: string }) => result?.status === "accepted",
  spawnAcpDirect: (...args: unknown[]) => hoisted.spawnAcpDirectMock(...args),
}));

vi.mock("../subagent-registry.js", () => ({
  registerSubagentRun: (...args: unknown[]) => hoisted.registerSubagentRunMock(...args),
}));

let createSessionsSpawnTool: typeof import("./sessions-spawn-tool.js").createSessionsSpawnTool;
let acpRuntimeRegistry: typeof import("../../acp/runtime/registry.js");

describe("sessions_spawn tool", () => {
  beforeAll(async () => {
    ({ createSessionsSpawnTool } = await import("./sessions-spawn-tool.js"));
    acpRuntimeRegistry = await import("../../acp/runtime/registry.js");
  });

  beforeEach(() => {
    acpRuntimeRegistry.__testing.resetAcpRuntimeBackendsForTests();
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

  function requireRecord(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`expected ${label}`);
    }
    return value as Record<string, unknown>;
  }

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
    const tool = createSessionsSpawnTool();
    const schema = tool.parameters as {
      properties?: {
        runtime?: { enum?: string[] };
        resumeSessionId?: { description?: string };
        streamTo?: { description?: string };
      };
    };

    expect(tool.displaySummary).toBe("Spawn sub-agent sessions.");
    expect(tool.description).not.toContain("ACP");
    expect(tool.description).not.toContain('runtime="acp"');
    expect(schema.properties?.runtime?.enum).toEqual(["subagent"]);
    expect(schema.properties?.resumeSessionId).toBeUndefined();
    expect(schema.properties?.streamTo).toBeUndefined();
  });

  it("advertises ACP runtime affordances when an ACP backend is loaded", () => {
    registerAcpBackendForTest();

    const tool = createSessionsSpawnTool();
    const schema = tool.parameters as {
      properties?: {
        runtime?: { enum?: string[] };
        resumeSessionId?: { description?: string };
        streamTo?: { description?: string };
      };
    };

    expect(tool.displaySummary).toBe("Spawn sub-agent or ACP sessions.");
    expect(tool.description).toContain('runtime="acp"');
    expect(schema.properties?.runtime?.enum).toEqual(["subagent", "acp"]);
    const resumeSessionId = requireSchemaProperty(schema.properties, "resumeSessionId");
    const streamTo = requireSchemaProperty(schema.properties, "streamTo");
    expect(resumeSessionId.description).toContain("ACP-only resume target");
    expect(resumeSessionId.description).toContain('ignored for runtime="subagent"');
    expect(resumeSessionId.description).toContain("already recorded for this requester");
    expect(streamTo.description).toContain("ACP-only stream target");
    expect(streamTo.description).toContain('ignored for runtime="subagent"');
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

  it("hides thread-bound spawn fields when current channel disables spawnSessions", () => {
    const tool = createSessionsSpawnTool({
      agentChannel: "discord",
      agentAccountId: "default",
      config: {
        channels: {
          discord: {
            threadBindings: {
              spawnSessions: false,
            },
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
  });

  it("shows thread-bound spawn fields when current channel allows spawnSessions", () => {
    const tool = createSessionsSpawnTool({
      agentChannel: "discord",
      agentAccountId: "default",
      config: {
        channels: {
          discord: {
            threadBindings: {
              spawnSessions: true,
            },
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
      runTimeoutSeconds: 5,
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
    expect(spawnArgs.runTimeoutSeconds).toBe(5);
    expect(spawnArgs.thread).toBe(true);
    expect(spawnArgs.mode).toBe("session");
    expect(spawnArgs.cleanup).toBe("keep");
    const spawnContext = mockCallArg(hoisted.spawnSubagentDirectMock, 0, 1, "spawnSubagentDirect");
    expect(spawnContext.agentSessionKey).toBe("agent:main:main");
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
  });

  it("accepts taskName as a stable subagent handle", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });
    const schema = tool.parameters as {
      properties?: Record<string, { description?: string; type?: string } | undefined>;
    };

    expect(requireSchemaProperty(schema.properties, "taskName").description).toContain(
      "Stable optional alias",
    );

    const result = await tool.execute("call-task-name", {
      task: "review subagent handling",
      taskName: "review_subagents",
    });

    expectDetailFields(result.details, {
      status: "accepted",
      childSessionKey: "agent:main:subagent:1",
    });
    const spawnArgs = mockCallArg(hoisted.spawnSubagentDirectMock, 0, 0, "spawnSubagentDirect");
    expect(spawnArgs.task).toBe("review subagent handling");
    expect(spawnArgs.taskName).toBe("review_subagents");
  });

  it("rejects invalid taskName before spawning", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call-bad-task-name", {
      task: "review subagent handling",
      taskName: "Bad-Name",
    });

    expectDetailFields(result.details, { status: "error" });
    expect(JSON.stringify(result.details)).toContain("Invalid taskName");
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

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

  it("supports legacy timeoutSeconds alias", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    await tool.execute("call-timeout-alias", {
      task: "do thing",
      timeoutSeconds: 2,
    });

    const spawnArgs = mockCallArg(hoisted.spawnSubagentDirectMock, 0, 0, "spawnSubagentDirect");
    expect(spawnArgs.task).toBe("do thing");
    expect(spawnArgs.runTimeoutSeconds).toBe(2);
  });

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
      agentChannel: "quietchat",
      agentAccountId: "default",
      agentTo: "channel:123",
      agentThreadId: "456",
    });

    const result = await tool.execute("call-2", {
      runtime: "acp",
      task: "investigate the failing CI run",
      agentId: "codex",
      cwd: "/workspace",
      runTimeoutSeconds: 45,
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
    expect(spawnArgs.runTimeoutSeconds).toBe(45);
    expect(spawnArgs.thread).toBe(true);
    expect(spawnArgs.mode).toBe("session");
    expect(spawnArgs.streamTo).toBe("parent");
    const spawnContext = mockCallArg(hoisted.spawnAcpDirectMock, 0, 1, "spawnAcpDirect");
    expect(spawnContext.agentSessionKey).toBe("agent:main:main");
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
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
    const spawnContext = mockCallArg(hoisted.spawnAcpDirectMock, 0, 1, "spawnAcpDirect");
    expect(spawnContext.agentSessionKey).toBe("agent:main:subagent:parent");
    const registration = mockCallArg(hoisted.registerSubagentRunMock, 0, 0, "registerSubagentRun");
    expect(registration.runId).toBe("run-acp");
    expect(registration.childSessionKey).toBe("agent:codex:acp:1");
    expect(registration.requesterSessionKey).toBe("agent:main:subagent:parent");
    expect(registration.task).toBe("investigate");
    expect(registration.cleanup).toBe("keep");
    expect(registration.spawnMode).toBe("run");
  });

  it("suppresses completion announces for inline ACP session delivery", async () => {
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

    const registration = mockCallArg(hoisted.registerSubagentRunMock, 0, 0, "registerSubagentRun");
    expect(registration.runId).toBe("run-acp");
    expect(registration.childSessionKey).toBe("agent:codex:acp:1");
    expect(registration.requesterSessionKey).toBe("agent:main:main");
    expect(registration.task).toBe("investigate");
    expect(registration.cleanup).toBe("keep");
    expect(registration.spawnMode).toBe("session");
    expect(registration.expectsCompletionMessage).toBe(false);
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
    expect(hoisted.spawnSubagentDirectMock.mock.calls[0]?.[0]).not.toHaveProperty(
      "resumeSessionId",
    );
    expect(hoisted.spawnSubagentDirectMock.mock.calls[0]?.[0]).not.toHaveProperty("streamTo");
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
  });

  it("rejects attachments for ACP runtime", async () => {
    registerAcpBackendForTest();
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "quietchat",
      agentAccountId: "default",
      agentTo: "channel:123",
      agentThreadId: "456",
    });

    const result = await tool.execute("call-3", {
      runtime: "acp",
      task: "analyze file",
      attachments: [{ name: "a.txt", content: "hello", encoding: "utf8" }],
    });

    expectDetailFields(result.details, { status: "error" });
    const details = result.details as { error?: string };
    expect(details.error).toContain("attachments are currently unsupported for runtime=acp");
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
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
    expect(hoisted.spawnSubagentDirectMock.mock.calls[0]?.[0]).not.toHaveProperty(
      "resumeSessionId",
    );
    expect(hoisted.spawnSubagentDirectMock.mock.calls[0]?.[0]).not.toHaveProperty("streamTo");
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
});
