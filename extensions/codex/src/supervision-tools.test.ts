// Codex supervision compatibility tests lock writes to active-turn controls.
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "openclaw/plugin-sdk/agent-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createCodexSupervisionTools,
  LEGACY_CODEX_SUPERVISOR_ENDPOINTS_ENV,
  LEGACY_CODEX_SUPERVISOR_RAW_TRANSCRIPTS_ENV,
  LEGACY_CODEX_SUPERVISOR_WRITE_CONTROLS_ENV,
  type CodexSupervisionToolsOptions,
} from "./supervision-tools.js";

const requestCodexAppServerJsonMock = vi.hoisted(() => vi.fn());

vi.mock("./app-server/request.js", () => ({
  requestCodexAppServerJson: requestCodexAppServerJsonMock,
}));

type RecordedRequest = { method: string; params?: unknown };
type EndpointRequest = NonNullable<CodexSupervisionToolsOptions["request"]>;
type EndpointRequestHandler = (...args: Parameters<EndpointRequest>) => unknown;

function createEndpointRequest(handler: EndpointRequestHandler): EndpointRequest {
  return async <T>(...args: Parameters<EndpointRequest>) => (await handler(...args)) as T;
}

function toolByName(tools: ReturnType<typeof createCodexSupervisionTools>, name: string) {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool) {
    throw new Error(`missing tool: ${name}`);
  }
  return tool;
}

function createRequest(thread: Record<string, unknown>) {
  const calls: RecordedRequest[] = [];
  const request = createEndpointRequest(async (_endpoint, method, params) => {
    calls.push({ method, ...(params === undefined ? {} : { params }) });
    if (method === "thread/read") {
      return { thread };
    }
    if (method === "thread/loaded/list") {
      return { data: [], nextCursor: null };
    }
    return {};
  });
  return { calls, request };
}

function createTools(
  request: EndpointRequest,
  overrides: Partial<CodexSupervisionToolsOptions> = {},
) {
  return createCodexSupervisionTools({
    getPluginConfig: () => ({
      supervision: {
        enabled: true,
        allowRawTranscripts: true,
        allowWriteControls: true,
      },
    }),
    senderIsOwner: true,
    request,
    ...overrides,
  });
}

describe("Codex supervision compatibility tools", () => {
  beforeEach(() => {
    requestCodexAppServerJsonMock.mockReset();
  });

  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    vi.unstubAllEnvs();
  });

  it("keeps the legacy local endpoint alias on shared user-home stdio", async () => {
    const transports: Array<string | undefined> = [];
    const request = createEndpointRequest(async (endpoint) => {
      transports.push(endpoint.configured?.transport);
      return {};
    });
    const tools = createCodexSupervisionTools({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      senderIsOwner: true,
      env: { [LEGACY_CODEX_SUPERVISOR_ENDPOINTS_ENV]: "local" },
      request,
    });

    await toolByName(tools, "codex_endpoint_probe").execute("probe", {});

    expect(transports).toEqual(["stdio-proxy"]);
  });

  it("defaults the local compatibility endpoint to shared user-home stdio", async () => {
    requestCodexAppServerJsonMock.mockResolvedValue({ data: [], nextCursor: null });
    const tools = createCodexSupervisionTools({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      senderIsOwner: true,
      env: {},
    });

    await toolByName(tools, "codex_endpoint_probe").execute("probe", {});

    expect(requestCodexAppServerJsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        startOptions: expect.objectContaining({ transport: "stdio", homeScope: "user" }),
      }),
    );
  });

  it("preserves the shipped stdio endpoint working directory", async () => {
    requestCodexAppServerJsonMock.mockResolvedValue({ data: [], nextCursor: null });
    const tools = createCodexSupervisionTools({
      getPluginConfig: () => ({
        supervision: {
          enabled: true,
          endpoints: [
            {
              id: "legacy-cwd",
              transport: "stdio-proxy",
              command: "codex",
              cwd: "/srv/codex-project",
            },
          ],
        },
      }),
      senderIsOwner: true,
      env: {},
    });

    await toolByName(tools, "codex_endpoint_probe").execute("probe", {});

    expect(requestCodexAppServerJsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "thread/loaded/list",
        startOptions: expect.objectContaining({
          transport: "stdio",
          cwd: "/srv/codex-project",
        }),
      }),
    );
  });

  it("rejects unauthenticated remote compatibility endpoints before connecting", async () => {
    const tools = createCodexSupervisionTools({
      getPluginConfig: () => ({
        supervision: {
          enabled: true,
          allowRawTranscripts: true,
          endpoints: [
            { id: "remote", transport: "websocket", url: "wss://codex.example.com/app-server" },
          ],
        },
      }),
      senderIsOwner: true,
      env: {},
    });

    await expect(
      toolByName(tools, "codex_session_read").execute("read", {
        endpoint_id: "remote",
        thread_id: "thread-1",
      }),
    ).rejects.toThrow("remote Codex app-server WebSocket URLs require");
  });

  it("retains the five shipped tool names and policy gates", async () => {
    const { request } = createRequest({ id: "thread-1", status: { type: "idle" } });
    const tools = createCodexSupervisionTools({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      senderIsOwner: true,
      request,
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "codex_endpoint_probe",
      "codex_sessions_list",
      "codex_session_read",
      "codex_session_send",
      "codex_session_interrupt",
    ]);
    await expect(
      toolByName(tools, "codex_session_read").execute("read", { thread_id: "thread-1" }),
    ).rejects.toThrow("Codex session reads are disabled");
    await expect(
      toolByName(tools, "codex_session_send").execute("send", {
        thread_id: "thread-1",
        text: "continue",
      }),
    ).rejects.toThrow("Codex write controls are disabled");
  });

  it("denies non-owner execution before reading endpoint or session data", async () => {
    const request = vi.fn();
    const tools = createCodexSupervisionTools({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      senderIsOwner: false,
      request,
    });

    await expect(toolByName(tools, "codex_sessions_list").execute("list", {})).rejects.toThrow(
      "require an owner-authorized sender",
    );
    expect(request).not.toHaveBeenCalled();
  });

  it("omits stored transcript metadata and endpoint errors when raw reads are disabled", async () => {
    const privatePreview = "private stored transcript preview";
    const privateName = "private stored thread name";
    const privateError = "private endpoint failure detail";
    const request = createEndpointRequest(async (endpoint, method) => {
      if (endpoint.id === "broken") {
        throw new Error(privateError);
      }
      if (method === "thread/loaded/list") {
        return { data: [], nextCursor: null };
      }
      if (method === "thread/list") {
        return {
          data: [
            {
              id: "stored-thread",
              name: privateName,
              preview: privatePreview,
              status: { type: "idle" },
            },
          ],
          nextCursor: null,
        };
      }
      throw new Error(`unexpected method: ${method}`);
    });
    const tools = createCodexSupervisionTools({
      getPluginConfig: () => ({
        supervision: {
          enabled: true,
          endpoints: [
            { id: "healthy", transport: "stdio-proxy" },
            { id: "broken", transport: "stdio-proxy" },
          ],
        },
      }),
      senderIsOwner: true,
      request,
    });

    const result = await toolByName(tools, "codex_sessions_list").execute("list", {
      include_stored: true,
      max_stored_sessions: 1,
    });

    expect(result).toMatchObject({
      details: {
        sessions: [
          {
            endpointId: "healthy",
            threadId: "stored-thread",
            status: "idle",
          },
        ],
        errors: [{ endpointId: "broken", ok: false }],
      },
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(privatePreview);
    expect(serialized).not.toContain(privateName);
    expect(serialized).not.toContain(privateError);
  });

  it("stops loaded-session pagination when Codex cycles through prior cursors", async () => {
    let pageCalls = 0;
    const request = createEndpointRequest(async (_endpoint, method) => {
      if (method !== "thread/loaded/list") {
        throw new Error(`unexpected method: ${method}`);
      }
      pageCalls += 1;
      if (pageCalls > 3) {
        throw new Error("unexpected fourth loaded-session page");
      }
      const nextCursor = ["loaded-page-a", "loaded-page-b", "loaded-page-a"][pageCalls - 1];
      return { data: [], nextCursor };
    });
    const tools = createTools(request);

    await expect(
      toolByName(tools, "codex_sessions_list").execute("list", {}),
    ).resolves.toMatchObject({
      details: {
        sessions: [],
        errors: [
          {
            endpointId: "local",
            ok: false,
            detail: "Codex thread/loaded/list returned repeated cursor loaded-page-a",
          },
        ],
      },
    });
    expect(pageCalls).toBe(3);
  });

  it("stops stored-session pagination when duplicate-only pages repeat a cursor", async () => {
    let storedPageCalls = 0;
    const request = createEndpointRequest(async (_endpoint, method) => {
      if (method === "thread/loaded/list") {
        return { data: [], nextCursor: null };
      }
      if (method !== "thread/list") {
        throw new Error(`unexpected method: ${method}`);
      }
      storedPageCalls += 1;
      if (storedPageCalls > 2) {
        throw new Error("unexpected third stored-session page");
      }
      return {
        data: [{ id: "stored-thread", status: { type: "idle" } }],
        nextCursor: "stored-page-2",
      };
    });
    const tools = createTools(request);

    await expect(
      toolByName(tools, "codex_sessions_list").execute("list", {
        include_stored: true,
        max_stored_sessions: 2,
      }),
    ).resolves.toMatchObject({
      details: {
        sessions: [],
        errors: [
          {
            endpointId: "local",
            ok: false,
            detail: "Codex thread/list returned repeated cursor stored-page-2",
          },
        ],
      },
    });
    expect(storedPageCalls).toBe(2);
  });

  it("fails closed at the loaded-session page cap when a cursor remains", async () => {
    let loadedPageCalls = 0;
    const request = createEndpointRequest(async (_endpoint, method) => {
      if (method === "thread/read") {
        return {
          thread: { id: "loaded-thread", status: { type: "idle" } },
        };
      }
      if (method !== "thread/loaded/list") {
        throw new Error(`unexpected method: ${method}`);
      }
      loadedPageCalls += 1;
      return {
        data: loadedPageCalls === 1 ? ["loaded-thread"] : [],
        nextCursor: `loaded-page-${loadedPageCalls + 1}`,
      };
    });
    const tools = createTools(request);

    await expect(
      toolByName(tools, "codex_sessions_list").execute("list", {}),
    ).resolves.toMatchObject({
      details: {
        sessions: [],
        errors: [
          {
            endpointId: "local",
            ok: false,
            detail: "Codex thread/loaded/list exceeded 100 pages with a continuation cursor",
          },
        ],
      },
    });
    expect(loadedPageCalls).toBe(100);
  });

  it("rejects an over-returned loaded page before reading any thread", async () => {
    const methods: string[] = [];
    const request = createEndpointRequest(async (_endpoint, method) => {
      methods.push(method);
      return {
        data: Array.from({ length: 101 }, (_, index) => `thread-${index}`),
        nextCursor: null,
      };
    });
    const tools = createTools(request);

    await expect(
      toolByName(tools, "codex_sessions_list").execute("list", {}),
    ).resolves.toMatchObject({
      details: {
        sessions: [],
        errors: [
          {
            endpointId: "local",
            ok: false,
            detail: "Codex thread/loaded/list returned more than 100 entries",
          },
        ],
      },
    });
    expect(methods).toEqual(["thread/loaded/list"]);
  });

  it.each([
    {
      name: "non-string thread id",
      response: { data: [42], nextCursor: null },
      detail: "Codex thread/loaded/list returned an invalid thread id at data[0]",
    },
    {
      name: "non-string cursor",
      response: { data: [], nextCursor: 42 },
      detail: "Codex thread/loaded/list returned an invalid nextCursor",
    },
    {
      name: "oversized cursor",
      response: { data: [], nextCursor: "x".repeat(4097) },
      detail: "Codex thread/loaded/list returned an invalid nextCursor",
    },
  ])("rejects a loaded page with $name", async ({ response, detail }) => {
    const request = createEndpointRequest(async () => response);
    const tools = createTools(request);

    await expect(
      toolByName(tools, "codex_sessions_list").execute("list", {}),
    ).resolves.toMatchObject({
      details: {
        sessions: [],
        errors: [{ endpointId: "local", ok: false, detail }],
      },
    });
  });

  it("continues past a duplicate-only stored page when its cursor advances", async () => {
    let storedPageCalls = 0;
    const request = createEndpointRequest(async (_endpoint, method) => {
      if (method === "thread/loaded/list") {
        return { data: [], nextCursor: null };
      }
      if (method !== "thread/list") {
        throw new Error(`unexpected method: ${method}`);
      }
      storedPageCalls += 1;
      if (storedPageCalls === 3) {
        return {
          data: [{ id: "stored-thread-2", status: { type: "idle" } }],
          nextCursor: null,
        };
      }
      return {
        data: [{ id: "stored-thread-1", status: { type: "idle" } }],
        nextCursor: `stored-page-${storedPageCalls + 1}`,
      };
    });
    const tools = createTools(request);

    await expect(
      toolByName(tools, "codex_sessions_list").execute("list", {
        include_stored: true,
        max_stored_sessions: 2,
      }),
    ).resolves.toMatchObject({
      details: {
        sessions: [
          { endpointId: "local", threadId: "stored-thread-1" },
          { endpointId: "local", threadId: "stored-thread-2" },
        ],
        errors: [],
      },
    });
    expect(storedPageCalls).toBe(3);
  });

  it("rejects a stored page that over-returns max_stored_sessions", async () => {
    const request = createEndpointRequest(async (_endpoint, method) => {
      if (method === "thread/loaded/list") {
        return { data: [], nextCursor: null };
      }
      if (method !== "thread/list") {
        throw new Error(`unexpected method: ${method}`);
      }
      return {
        data: [
          { id: "stored-thread-1", status: { type: "idle" } },
          { id: "stored-thread-2", status: { type: "idle" } },
          { id: "stored-thread-3", status: { type: "idle" } },
        ],
        nextCursor: null,
      };
    });
    const tools = createTools(request);

    await expect(
      toolByName(tools, "codex_sessions_list").execute("list", {
        include_stored: true,
        max_stored_sessions: 1,
      }),
    ).resolves.toMatchObject({
      details: {
        sessions: [],
        errors: [
          {
            endpointId: "local",
            ok: false,
            detail: "Codex thread/list returned more than 1 entries",
          },
        ],
      },
    });
  });

  it.each([
    {
      name: "missing thread id",
      response: { data: [{}], nextCursor: null },
      detail: "Codex thread/list returned an invalid thread id at data[0]",
    },
    {
      name: "blank cursor",
      response: { data: [], nextCursor: " " },
      detail: "Codex thread/list returned an invalid nextCursor",
    },
  ])("rejects a stored page with $name", async ({ response, detail }) => {
    const request = createEndpointRequest(async (_endpoint, method) => {
      if (method === "thread/loaded/list") {
        return { data: [], nextCursor: null };
      }
      return response;
    });
    const tools = createTools(request);

    await expect(
      toolByName(tools, "codex_sessions_list").execute("list", {
        include_stored: true,
      }),
    ).resolves.toMatchObject({
      details: {
        sessions: [],
        errors: [{ endpointId: "local", ok: false, detail }],
      },
    });
  });

  it("fails closed at the stored-session page cap when a cursor remains", async () => {
    let storedPageCalls = 0;
    const request = createEndpointRequest(async (_endpoint, method) => {
      if (method === "thread/loaded/list") {
        return { data: [], nextCursor: null };
      }
      if (method !== "thread/list") {
        throw new Error(`unexpected method: ${method}`);
      }
      storedPageCalls += 1;
      return {
        data: [{ id: "stored-thread", status: { type: "idle" } }],
        nextCursor: `stored-page-${storedPageCalls + 1}`,
      };
    });
    const tools = createTools(request);

    await expect(
      toolByName(tools, "codex_sessions_list").execute("list", {
        include_stored: true,
        max_stored_sessions: 2,
      }),
    ).resolves.toMatchObject({
      details: {
        sessions: [],
        errors: [
          {
            endpointId: "local",
            ok: false,
            detail: "Codex thread/list exceeded 100 pages with a continuation cursor",
          },
        ],
      },
    });
    expect(storedPageCalls).toBe(100);
  });

  it("rechecks live supervision config before every paginated request", async () => {
    let pluginConfig: unknown = { supervision: { enabled: true } };
    let requestCalls = 0;
    const request = createEndpointRequest(async (_endpoint, method) => {
      if (method !== "thread/loaded/list") {
        throw new Error(`unexpected method: ${method}`);
      }
      requestCalls += 1;
      pluginConfig = { supervision: { enabled: false } };
      return { data: [], nextCursor: "next-page" };
    });
    const tools = createCodexSupervisionTools({
      getPluginConfig: () => pluginConfig,
      senderIsOwner: true,
      request,
    });

    await expect(toolByName(tools, "codex_sessions_list").execute("list", {})).rejects.toThrow(
      "Codex supervision is disabled",
    );
    expect(requestCalls).toBe(1);
  });

  it("revokes a removed endpoint before the next paginated request", async () => {
    let pluginConfig: unknown = {
      supervision: {
        enabled: true,
        endpoints: [{ id: "remote", transport: "stdio-proxy", command: "codex" }],
      },
    };
    let requestCalls = 0;
    const request = createEndpointRequest(async (_endpoint, method) => {
      if (method !== "thread/loaded/list") {
        throw new Error(`unexpected method: ${method}`);
      }
      requestCalls += 1;
      pluginConfig = { supervision: { enabled: true, endpoints: [] } };
      return { data: [], nextCursor: "next-page" };
    });
    const tools = createCodexSupervisionTools({
      getPluginConfig: () => pluginConfig,
      senderIsOwner: true,
      request,
    });

    await expect(toolByName(tools, "codex_sessions_list").execute("list", {})).rejects.toThrow(
      "endpoint remote was removed or changed",
    );
    expect(requestCalls).toBe(1);
  });

  it("rechecks raw-transcript policy before a fallback transcript request", async () => {
    let pluginConfig: unknown = {
      supervision: { enabled: true, allowRawTranscripts: true },
    };
    let requestCalls = 0;
    const request = createEndpointRequest(async (_endpoint, method) => {
      if (method !== "thread/read") {
        throw new Error(`unexpected method: ${method}`);
      }
      requestCalls += 1;
      pluginConfig = { supervision: { enabled: true, allowRawTranscripts: false } };
      throw new Error("turns not materialized yet");
    });
    const tools = createCodexSupervisionTools({
      getPluginConfig: () => pluginConfig,
      senderIsOwner: true,
      request,
    });

    await expect(
      toolByName(tools, "codex_session_read").execute("read", {
        endpoint_id: "local",
        thread_id: "thread-1",
        include_turns: true,
      }),
    ).rejects.toThrow("Codex session reads are disabled");
    expect(requestCalls).toBe(1);
  });

  it("does not return a transcript when its endpoint changes in flight", async () => {
    let pluginConfig: unknown = {
      supervision: {
        enabled: true,
        allowRawTranscripts: true,
        endpoints: [{ id: "primary", transport: "stdio-proxy", command: "codex-a" }],
      },
    };
    const request = createEndpointRequest(async (_endpoint, method) => {
      if (method !== "thread/read") {
        throw new Error(`unexpected method: ${method}`);
      }
      pluginConfig = {
        supervision: {
          enabled: true,
          allowRawTranscripts: true,
          endpoints: [{ id: "primary", transport: "stdio-proxy", command: "codex-b" }],
        },
      };
      return {
        thread: {
          id: "thread-1",
          status: { type: "idle" },
          turns: [{ id: "private-turn" }],
        },
      };
    });
    const tools = createCodexSupervisionTools({
      getPluginConfig: () => pluginConfig,
      senderIsOwner: true,
      request,
    });

    await expect(
      toolByName(tools, "codex_session_read").execute("read", {
        endpoint_id: "primary",
        thread_id: "thread-1",
        include_turns: true,
      }),
    ).rejects.toThrow("endpoint primary was removed or changed");
  });

  it("does not return a transcript when the effective agent directory changes in flight", async () => {
    const pluginConfig = {
      appServer: {
        transport: "websocket" as const,
        homeScope: "agent" as const,
        url: "ws://127.0.0.1:4500",
      },
      supervision: { enabled: true, allowRawTranscripts: true },
    };
    let runtimeConfig = {
      agents: {
        list: [{ id: "main", default: true, agentDir: "/tmp/codex-supervision-agent-a" }],
      },
    };
    const request = createEndpointRequest(async (_endpoint, method) => {
      if (method !== "thread/read") {
        throw new Error(`unexpected method: ${method}`);
      }
      runtimeConfig = {
        agents: {
          list: [{ id: "main", default: true, agentDir: "/tmp/codex-supervision-agent-b" }],
        },
      };
      return {
        thread: { id: "thread-1", status: { type: "idle" } },
      };
    });
    const tools = createCodexSupervisionTools({
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => runtimeConfig,
      senderIsOwner: true,
      request,
    });

    await expect(
      toolByName(tools, "codex_session_read").execute("read", {
        endpoint_id: "local",
        thread_id: "thread-1",
      }),
    ).rejects.toThrow("endpoint local was removed or changed");
  });

  it("does not return a transcript when the effective auth profile changes in flight", async () => {
    const agentDir = "/tmp/codex-supervision-auth-agent";
    replaceRuntimeAuthProfileStoreSnapshots([
      {
        agentDir,
        store: {
          version: 1,
          profiles: {
            "openai:first": {
              type: "oauth",
              provider: "openai",
              access: "first-access",
              refresh: "first-refresh",
              expires: Date.now() + 60_000,
            },
            "openai:second": {
              type: "oauth",
              provider: "openai",
              access: "second-access",
              refresh: "second-refresh",
              expires: Date.now() + 60_000,
            },
          },
        },
      },
    ]);
    const pluginConfig = {
      appServer: {
        transport: "websocket" as const,
        homeScope: "agent" as const,
        url: "ws://127.0.0.1:4500",
      },
      supervision: { enabled: true, allowRawTranscripts: true },
    };
    let runtimeConfig = {
      agents: { list: [{ id: "main", default: true, agentDir }] },
      auth: { order: { openai: ["openai:first", "openai:second"] } },
    };
    const request = createEndpointRequest(async (_endpoint, method) => {
      if (method !== "thread/read") {
        throw new Error(`unexpected method: ${method}`);
      }
      runtimeConfig = {
        agents: { list: [{ id: "main", default: true, agentDir }] },
        auth: { order: { openai: ["openai:second", "openai:first"] } },
      };
      return {
        thread: { id: "thread-1", status: { type: "idle" } },
      };
    });
    const tools = createCodexSupervisionTools({
      getPluginConfig: () => pluginConfig,
      getRuntimeConfig: () => runtimeConfig,
      senderIsOwner: true,
      request,
    });

    await expect(
      toolByName(tools, "codex_session_read").execute("read", {
        endpoint_id: "local",
        thread_id: "thread-1",
      }),
    ).rejects.toThrow("endpoint local was removed or changed");
  });

  it("does not return a transcript when fallback API-key auth changes in flight", async () => {
    vi.stubEnv("OPENAI_API_KEY", "first-fallback-key");
    const pluginConfig = {
      supervision: { enabled: true, allowRawTranscripts: true },
    };
    const request = createEndpointRequest(async (_endpoint, method) => {
      if (method !== "thread/read") {
        throw new Error(`unexpected method: ${method}`);
      }
      vi.stubEnv("OPENAI_API_KEY", "second-fallback-key");
      return {
        thread: { id: "thread-1", status: { type: "idle" } },
      };
    });
    const tools = createCodexSupervisionTools({
      getPluginConfig: () => pluginConfig,
      senderIsOwner: true,
      request,
    });

    await expect(
      toolByName(tools, "codex_session_read").execute("read", {
        endpoint_id: "local",
        thread_id: "thread-1",
      }),
    ).rejects.toThrow("endpoint local was removed or changed");
  });

  it("rechecks write policy before mutating an active turn", async () => {
    let pluginConfig: unknown = {
      supervision: { enabled: true, allowWriteControls: true },
    };
    const methods: string[] = [];
    const request = createEndpointRequest(async (_endpoint, method) => {
      methods.push(method);
      if (method !== "thread/read") {
        throw new Error(`unexpected method: ${method}`);
      }
      pluginConfig = { supervision: { enabled: true, allowWriteControls: false } };
      return {
        thread: {
          id: "thread-1",
          status: { type: "active" },
          turns: [{ id: "turn-1", status: "inProgress" }],
        },
      };
    });
    const tools = createCodexSupervisionTools({
      getPluginConfig: () => pluginConfig,
      senderIsOwner: true,
      request,
    });

    await expect(
      toolByName(tools, "codex_session_send").execute("send", {
        endpoint_id: "local",
        thread_id: "thread-1",
        text: "continue",
      }),
    ).rejects.toThrow("Codex write controls are disabled");
    expect(methods).toEqual(["thread/read"]);
  });

  it("rejects an endpoint repoint before mutating an active turn", async () => {
    let pluginConfig: unknown = {
      supervision: {
        enabled: true,
        allowWriteControls: true,
        endpoints: [{ id: "primary", transport: "stdio-proxy", command: "codex-a" }],
      },
    };
    const methods: string[] = [];
    const request = createEndpointRequest(async (_endpoint, method) => {
      methods.push(method);
      if (method !== "thread/read") {
        throw new Error(`unexpected method: ${method}`);
      }
      pluginConfig = {
        supervision: {
          enabled: true,
          allowWriteControls: true,
          endpoints: [{ id: "primary", transport: "stdio-proxy", command: "codex-b" }],
        },
      };
      return {
        thread: {
          id: "thread-1",
          status: { type: "active" },
          turns: [{ id: "turn-1", status: "inProgress" }],
        },
      };
    });
    const tools = createCodexSupervisionTools({
      getPluginConfig: () => pluginConfig,
      senderIsOwner: true,
      request,
    });

    await expect(
      toolByName(tools, "codex_session_send").execute("send", {
        endpoint_id: "primary",
        thread_id: "thread-1",
        text: "continue",
      }),
    ).rejects.toThrow("endpoint primary was removed or changed");
    expect(methods).toEqual(["thread/read"]);
  });

  it("rejects explicit starts and idle auto sends without a mutating request", async () => {
    const { calls, request } = createRequest({
      id: "thread-1",
      status: { type: "idle" },
      turns: [],
    });
    const tools = createTools(request);
    const send = toolByName(tools, "codex_session_send");

    await expect(
      send.execute("start", {
        endpoint_id: "local",
        thread_id: "thread-1",
        text: "continue",
        mode: "start",
      }),
    ).rejects.toThrow("Continue it from Codex Sessions");
    expect(calls).toEqual([]);

    await expect(
      send.execute("auto", {
        endpoint_id: "local",
        thread_id: "thread-1",
        text: "continue",
      }),
    ).rejects.toThrow("Continue it from Codex Sessions");
    expect(calls.map((call) => call.method)).toEqual(["thread/read"]);
  });

  it("steers and interrupts only after a passive active-turn read", async () => {
    const { calls, request } = createRequest({
      id: "thread-1",
      status: { type: "active" },
      turns: [{ id: "turn-1", status: "inProgress" }],
    });
    const tools = createTools(request);

    await toolByName(tools, "codex_session_send").execute("steer", {
      endpoint_id: "local",
      thread_id: "thread-1",
      text: "focus on the failing test",
      mode: "steer",
    });
    await toolByName(tools, "codex_session_interrupt").execute("interrupt", {
      endpoint_id: "local",
      thread_id: "thread-1",
    });

    expect(calls).toEqual([
      {
        method: "thread/read",
        params: { threadId: "thread-1", includeTurns: true },
      },
      {
        method: "turn/steer",
        params: {
          threadId: "thread-1",
          expectedTurnId: "turn-1",
          input: [
            {
              type: "text",
              text: "focus on the failing test",
              text_elements: [],
            },
          ],
        },
      },
      {
        method: "thread/read",
        params: { threadId: "thread-1", includeTurns: true },
      },
      {
        method: "turn/interrupt",
        params: { threadId: "thread-1", turnId: "turn-1" },
      },
    ]);
    expect(calls.some((call) => call.method === "turn/start")).toBe(false);
    expect(calls.some((call) => call.method === "thread/resume")).toBe(false);
  });

  it("retains standalone MCP env aliases only behind the trusted adapter opt-in", async () => {
    const { request } = createRequest({
      id: "thread-1",
      status: { type: "active" },
      turns: [{ id: "turn-1", status: "inProgress" }],
    });
    const tools = createCodexSupervisionTools({
      getPluginConfig: () => ({ supervision: { enabled: true } }),
      senderIsOwner: true,
      env: {
        [LEGACY_CODEX_SUPERVISOR_RAW_TRANSCRIPTS_ENV]: "1",
        [LEGACY_CODEX_SUPERVISOR_WRITE_CONTROLS_ENV]: "1",
      },
      request,
      useLegacyMcpPolicyEnv: true,
    });

    await expect(
      toolByName(tools, "codex_session_read").execute("read", {
        endpoint_id: "local",
        thread_id: "thread-1",
      }),
    ).resolves.toMatchObject({ details: { summary: "codex session: thread-1" } });
    await expect(
      toolByName(tools, "codex_session_send").execute("send", {
        endpoint_id: "local",
        thread_id: "thread-1",
        text: "continue",
      }),
    ).resolves.toMatchObject({ details: { summary: "codex steer: turn-1" } });
  });
});
