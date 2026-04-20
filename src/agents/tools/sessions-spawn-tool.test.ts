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

describe("sessions_spawn tool", () => {
  beforeAll(async () => {
    ({ createSessionsSpawnTool } = await import("./sessions-spawn-tool.js"));
  });

  beforeEach(() => {
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

  it("uses subagent runtime by default", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
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

    expect(result.details).toMatchObject({
      status: "accepted",
      childSessionKey: "agent:main:subagent:1",
      runId: "run-subagent",
    });
    expect(result.details).not.toHaveProperty("role");
    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "build feature",
        agentId: "main",
        model: "anthropic/claude-sonnet-4-6",
        thinking: "medium",
        runTimeoutSeconds: 5,
        thread: true,
        mode: "session",
        cleanup: "keep",
      }),
      expect.objectContaining({
        agentSessionKey: "agent:main:main",
      }),
    );
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
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

    expect(result.details).toMatchObject({
      ...spawnResult,
      role: "reviewer",
    });
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

    expect(result.details).toMatchObject({
      status: "error",
      error: "spawn failed",
    });
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

    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "do thing",
        runTimeoutSeconds: 2,
      }),
      expect.any(Object),
    );
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

    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        workspaceDir: "/parent/workspace",
      }),
    );
  });

  it("passes lightContext through to subagent spawns", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    await tool.execute("call-light", {
      task: "summarize this",
      lightContext: true,
    });

    expect(hoisted.spawnSubagentDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "summarize this",
        lightContext: true,
      }),
      expect.any(Object),
    );
  });

  it('rejects lightContext when runtime is not "subagent"', async () => {
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
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
      agentAccountId: "default",
      agentTo: "channel:123",
      agentThreadId: "456",
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

    expect(result.details).toMatchObject({
      status: "accepted",
      childSessionKey: "agent:codex:acp:1",
      runId: "run-acp",
    });
    expect(hoisted.spawnAcpDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "investigate the failing CI run",
        agentId: "codex",
        cwd: "/workspace",
        thread: true,
        mode: "session",
        streamTo: "parent",
      }),
      expect.objectContaining({
        agentSessionKey: "agent:main:main",
      }),
    );
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(hoisted.registerSubagentRunMock).not.toHaveBeenCalled();
  });

  it("adds requested role to forwarded ACP failures", async () => {
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

    expect(result.details).toMatchObject({
      status: "forbidden",
      error: "ACP disabled",
      errorCode: "acp_disabled",
      role: "codex",
    });
  });

  it("forwards ACP sandbox options and requester sandbox context", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:subagent:parent",
      sandboxed: true,
    });

    await tool.execute("call-2b", {
      runtime: "acp",
      task: "investigate",
      agentId: "codex",
      sandbox: "require",
    });

    expect(hoisted.spawnAcpDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "investigate",
        sandbox: "require",
      }),
      expect.objectContaining({
        agentSessionKey: "agent:main:subagent:parent",
        sandboxed: true,
      }),
    );
    expect(hoisted.registerSubagentRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-acp",
        childSessionKey: "agent:codex:acp:1",
        requesterSessionKey: "agent:main:subagent:parent",
        task: "investigate",
        cleanup: "keep",
        spawnMode: "run",
      }),
    );
  });

  it("passes resumeSessionId through to ACP spawns", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    await tool.execute("call-2c", {
      runtime: "acp",
      task: "resume prior work",
      agentId: "codex",
      resumeSessionId: "7f4a78e0-f6be-43fe-855c-c1c4fd229bc4",
    });

    expect(hoisted.spawnAcpDirectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "resume prior work",
        agentId: "codex",
        resumeSessionId: "7f4a78e0-f6be-43fe-855c-c1c4fd229bc4",
      }),
      expect.any(Object),
    );
  });

  it("rejects resumeSessionId without runtime=acp", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call-guard", {
      task: "resume prior work",
      resumeSessionId: "7f4a78e0-f6be-43fe-855c-c1c4fd229bc4",
    });

    expect(JSON.stringify(result)).toContain("resumeSessionId is only supported for runtime=acp");
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
  });

  it("rejects attachments for ACP runtime", async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
      agentChannel: "discord",
      agentAccountId: "default",
      agentTo: "channel:123",
      agentThreadId: "456",
    });

    const result = await tool.execute("call-3", {
      runtime: "acp",
      task: "analyze file",
      attachments: [{ name: "a.txt", content: "hello", encoding: "utf8" }],
    });

    expect(result.details).toMatchObject({
      status: "error",
    });
    const details = result.details as { error?: string };
    expect(details.error).toContain("attachments are currently unsupported for runtime=acp");
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
  });

  it('rejects streamTo when runtime is not "acp"', async () => {
    const tool = createSessionsSpawnTool({
      agentSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call-3b", {
      runtime: "subagent",
      task: "analyze file",
      streamTo: "parent",
    });

    expect(result.details).toMatchObject({
      status: "error",
    });
    const details = result.details as { error?: string };
    expect(details.error).toContain("streamTo is only supported for runtime=acp");
    expect(hoisted.spawnAcpDirectMock).not.toHaveBeenCalled();
    expect(hoisted.spawnSubagentDirectMock).not.toHaveBeenCalled();
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
