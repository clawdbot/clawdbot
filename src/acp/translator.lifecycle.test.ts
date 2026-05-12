import type {
  CloseSessionRequest,
  InitializeRequest,
  ListSessionsRequest,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
} from "@agentclientprotocol/sdk";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import type { GatewaySessionRow } from "../gateway/session-utils.js";
import { createInMemorySessionStore } from "./session.js";
import { AcpGatewayAgent } from "./translator.js";
import { createAcpConnection, createAcpGateway } from "./translator.test-helpers.js";

vi.mock("./commands.js", () => ({
  getAvailableCommands: () => [],
}));

function createInitializeRequest(): InitializeRequest {
  return {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
  } as InitializeRequest;
}

function createListSessionsRequest(params: {
  cwd?: string;
  cursor?: string | null;
  limit?: number;
}): ListSessionsRequest {
  const request: ListSessionsRequest = {
    _meta: {},
  };
  if (params.cwd) {
    request.cwd = params.cwd;
  }
  if (params.cursor !== undefined) {
    request.cursor = params.cursor;
  }
  if (params.limit !== undefined) {
    request._meta = { limit: params.limit };
  }
  return request;
}

function createResumeSessionRequest(
  sessionId: string,
  cwd = "/tmp/openclaw",
): ResumeSessionRequest {
  return {
    sessionId,
    cwd,
    mcpServers: [],
    _meta: {},
  } as ResumeSessionRequest;
}

function createCloseSessionRequest(sessionId: string): CloseSessionRequest {
  return {
    sessionId,
    _meta: {},
  } as CloseSessionRequest;
}

function createPromptRequest(sessionId: string): PromptRequest {
  return {
    sessionId,
    prompt: [{ type: "text", text: "hello" }],
    _meta: {},
  } as PromptRequest;
}

function createGatewaySessions(rows: GatewaySessionRow[]) {
  return {
    ts: Date.now(),
    path: "/tmp/sessions.json",
    count: rows.length,
    totalCount: rows.length,
    limitApplied: rows.length,
    hasMore: false,
    defaults: {
      modelProvider: null,
      model: null,
      contextTokens: null,
    },
    sessions: rows,
  };
}

function createSessionRow(params: {
  key: string;
  cwd?: string;
  title?: string;
  updatedAt?: number;
}): GatewaySessionRow {
  return {
    key: params.key,
    kind: "direct",
    spawnedWorkspaceDir: params.cwd,
    derivedTitle: params.title,
    updatedAt: params.updatedAt ?? 1_710_000_000_000,
    thinkingLevel: "adaptive",
    modelProvider: "openai",
    model: "gpt-5.4",
  };
}

async function startPendingPrompt(params: {
  agent: AcpGatewayAgent;
  sentRunIds: string[];
  sessionId: string;
}): Promise<{ promptPromise: Promise<PromptResponse>; runId: string }> {
  const before = params.sentRunIds.length;
  const promptPromise = params.agent.prompt(createPromptRequest(params.sessionId));
  await vi.waitFor(() => {
    expect(params.sentRunIds.length).toBe(before + 1);
  });
  return {
    promptPromise,
    runId: params.sentRunIds[before],
  };
}

describe("acp translator stable lifecycle handlers", () => {
  it("advertises only session capabilities backed by bridge handlers", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      sessionStore,
    });

    const result = await agent.initialize(createInitializeRequest());
    const capabilities = result.agentCapabilities;
    if (!capabilities) {
      throw new Error("initialize response did not include agent capabilities");
    }

    expect(capabilities.loadSession).toBe(true);
    expect(typeof agent.loadSession).toBe("function");
    expect(capabilities.sessionCapabilities?.list).toStrictEqual({});
    expect(typeof agent.listSessions).toBe("function");
    expect(capabilities.sessionCapabilities?.resume).toStrictEqual({});
    expect(typeof agent.resumeSession).toBe("function");
    expect(capabilities.sessionCapabilities?.close).toStrictEqual({});
    expect(typeof agent.closeSession).toBe("function");
    expect(capabilities.sessionCapabilities?.fork).toBeUndefined();
    expect("unstable_listSessions" in agent).toBe(false);

    sessionStore.clearAllSessionsForTest();
  });

  it("captures ACP client capabilities during initialize", async () => {
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway());

    expect(agent.supportsClientReadTextFile()).toBe(false);
    expect(agent.supportsClientWriteTextFile()).toBe(false);
    expect(agent.supportsClientTerminal()).toBe(false);

    await agent.initialize({
      ...createInitializeRequest(),
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: false },
        terminal: true,
      },
      clientInfo: { name: "test-client", version: "1.2.3" },
    } as InitializeRequest);

    expect(agent.supportsClientReadTextFile()).toBe(true);
    expect(agent.supportsClientWriteTextFile()).toBe(false);
    expect(agent.supportsClientTerminal()).toBe(true);
    expect(agent.getClientInfo()).toEqual({ name: "test-client", version: "1.2.3" });
  });

  it("lists Gateway sessions through the stable handler with opaque cursors and cwd filtering", async () => {
    const allRows = [
      createSessionRow({ key: "agent:main:a1", cwd: "/work/a", title: "A1" }),
      createSessionRow({ key: "agent:main:a2", cwd: "/work/a", title: "A2" }),
      createSessionRow({ key: "agent:main:a3", cwd: "/work/a", title: "A3" }),
      createSessionRow({ key: "agent:main:b1", cwd: "/work/b", title: "B1" }),
      createSessionRow({ key: "agent:main:a4", cwd: "/work/a", title: "A4" }),
    ];
    const request = vi.fn(async (method: string, params?: { limit?: number }) => {
      if (method === "sessions.list") {
        const limit = params?.limit ?? allRows.length;
        return {
          ...createGatewaySessions(allRows.slice(0, limit)),
          totalCount: allRows.length,
          hasMore: limit < allRows.length,
        };
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const sessionStore = createInMemorySessionStore();
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(request), {
      sessionStore,
    });

    const first = await agent.listSessions(createListSessionsRequest({ cwd: "/work/a", limit: 2 }));
    const second = await agent.listSessions(
      createListSessionsRequest({ cwd: "/work/a", limit: 2, cursor: first.nextCursor }),
    );

    expect(first.sessions.map((session) => session.sessionId)).toEqual([
      "agent:main:a1",
      "agent:main:a2",
    ]);
    expect(first.sessions.map((session) => session.cwd)).toEqual(["/work/a", "/work/a"]);
    expect(first.nextCursor).toBeTypeOf("string");
    expect(first.nextCursor).not.toBe("");
    expect(second.sessions.map((session) => session.sessionId)).toEqual([
      "agent:main:a3",
      "agent:main:a4",
    ]);
    expect(second.sessions.map((session) => session.cwd)).toEqual(["/work/a", "/work/a"]);
    expect(second.nextCursor).toBeNull();
    expect(request).toHaveBeenNthCalledWith(1, "sessions.list", {
      limit: 3,
      includeDerivedTitles: true,
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.list", {
      limit: 5,
      includeDerivedTitles: true,
    });

    sessionStore.clearAllSessionsForTest();
  });

  it("does not include sessions without workspace metadata in cwd-filtered lists", async () => {
    const allRows = [
      createSessionRow({ key: "agent:main:unknown", title: "Unknown workspace" }),
      createSessionRow({ key: "agent:main:a1", cwd: "/work/a", title: "A1" }),
      createSessionRow({ key: "agent:main:b1", cwd: "/work/b", title: "B1" }),
    ];
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return createGatewaySessions(allRows);
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const sessionStore = createInMemorySessionStore();
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(request), {
      sessionStore,
    });

    const result = await agent.listSessions(createListSessionsRequest({ cwd: "/work/a" }));

    expect(result.sessions.map((session) => session.sessionId)).toEqual(["agent:main:a1"]);
    expect(result.sessions.map((session) => session.cwd)).toEqual(["/work/a"]);

    sessionStore.clearAllSessionsForTest();
  });

  it("rejects session/list cursors when the cwd filter changes", async () => {
    const allRows = [
      createSessionRow({ key: "agent:main:a1", cwd: "/work/a", title: "A1" }),
      createSessionRow({ key: "agent:main:a2", cwd: "/work/a", title: "A2" }),
      createSessionRow({ key: "agent:main:b1", cwd: "/work/b", title: "B1" }),
    ];
    const request = vi.fn(async (method: string, params?: { limit?: number }) => {
      if (method === "sessions.list") {
        const limit = params?.limit ?? allRows.length;
        return {
          ...createGatewaySessions(allRows.slice(0, limit)),
          totalCount: allRows.length,
          hasMore: limit < allRows.length,
        };
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const sessionStore = createInMemorySessionStore();
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(request), {
      sessionStore,
    });

    const unfiltered = await agent.listSessions(createListSessionsRequest({ limit: 1 }));
    expect(unfiltered.nextCursor).toBeTypeOf("string");
    expect(unfiltered.nextCursor).not.toBe("");
    await expect(
      agent.listSessions(
        createListSessionsRequest({ cwd: "/work/a", cursor: unfiltered.nextCursor }),
      ),
    ).rejects.toThrow(/cursor does not match the cwd filter/i);

    const filtered = await agent.listSessions(
      createListSessionsRequest({ cwd: "/work/a", limit: 1 }),
    );
    expect(filtered.nextCursor).toBeTypeOf("string");
    expect(filtered.nextCursor).not.toBe("");
    await expect(
      agent.listSessions(createListSessionsRequest({ cursor: filtered.nextCursor })),
    ).rejects.toThrow(/cursor does not match the cwd filter/i);

    sessionStore.clearAllSessionsForTest();
  });

  it("rejects relative cwd filters for session/list", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      sessionStore,
    });

    await expect(
      agent.listSessions(createListSessionsRequest({ cwd: "relative/path" })),
    ).rejects.toThrow(/requires an absolute cwd/i);

    sessionStore.clearAllSessionsForTest();
  });

  it("resumes an existing Gateway session without replaying transcript history", async () => {
    const connection = createAcpConnection();
    const sessionUpdate = connection.__sessionUpdateMock;
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return createGatewaySessions([
          createSessionRow({
            key: "agent:main:work",
            cwd: "/tmp/openclaw",
            title: "Work session",
          }),
        ]);
      }
      if (method === "sessions.get") {
        throw new Error("resume must not load transcript history");
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const sessionStore = createInMemorySessionStore();
    const agent = new AcpGatewayAgent(connection, createAcpGateway(request), {
      sessionStore,
    });

    const result = await agent.resumeSession(createResumeSessionRequest("agent:main:work"));

    expect(result.modes?.currentModeId).toBe("adaptive");
    if (!result.configOptions) {
      throw new Error("expected resume session config options");
    }
    const thoughtLevelOption = result.configOptions.find((option) => option.id === "thought_level");
    expect(thoughtLevelOption?.currentValue).toBe("adaptive");
    expect(sessionStore.getSession("agent:main:work")?.sessionKey).toBe("agent:main:work");
    const requestCalls = (request as unknown as { mock: { calls: Array<[string]> } }).mock.calls;
    expect(requestCalls.map((call) => call[0])).not.toContain("sessions.get");
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "agent:main:work",
      update: {
        sessionUpdate: "session_info_update",
        title: "Work session",
        updatedAt: "2024-03-09T16:00:00.000Z",
        _meta: {
          sessionKey: "agent:main:work",
          kind: "direct",
          spawnedWorkspaceDir: "/tmp/openclaw",
        },
      },
    });

    sessionStore.clearAllSessionsForTest();
  });

  it("rejects resume for a missing Gateway session without creating bridge state", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "sessions.list") {
        return createGatewaySessions([]);
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const sessionStore = createInMemorySessionStore();
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(request), {
      sessionStore,
    });

    await expect(
      agent.resumeSession(createResumeSessionRequest("missing-session")),
    ).rejects.toThrow(/Session missing-session not found/i);

    expect(sessionStore.hasSession("missing-session")).toBe(false);
    sessionStore.clearAllSessionsForTest();
  });

  it("closes sessions by aborting active work, resolving pending prompts, and deleting bridge state", async () => {
    const sentRunIds: string[] = [];
    const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "chat.send") {
        const runId = params?.idempotencyKey;
        if (typeof runId === "string") {
          sentRunIds.push(runId);
        }
        return new Promise<never>(() => {});
      }
      return { ok: true };
    }) as GatewayClient["request"];
    const sessionStore = createInMemorySessionStore();
    sessionStore.createSession({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      cwd: "/tmp/openclaw",
    });
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(request), {
      sessionStore,
    });
    const pending = await startPendingPrompt({ agent, sentRunIds, sessionId: "session-1" });

    await expect(agent.closeSession(createCloseSessionRequest("session-1"))).resolves.toStrictEqual(
      {},
    );

    expect(request).toHaveBeenCalledWith("chat.abort", {
      sessionKey: "agent:main:work",
      runId: pending.runId,
    });
    await expect(pending.promptPromise).resolves.toEqual({ stopReason: "cancelled" });
    expect(sessionStore.hasSession("session-1")).toBe(false);
  });

  it("rejects close for missing sessions", async () => {
    const sessionStore = createInMemorySessionStore();
    const agent = new AcpGatewayAgent(createAcpConnection(), createAcpGateway(), {
      sessionStore,
    });

    await expect(agent.closeSession(createCloseSessionRequest("missing-session"))).rejects.toThrow(
      /Session missing-session not found/i,
    );

    sessionStore.clearAllSessionsForTest();
  });
});
