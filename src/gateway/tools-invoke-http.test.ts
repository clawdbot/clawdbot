import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { runBeforeToolCallHook as runBeforeToolCallHookType } from "../agents/pi-tools.before-tool-call.js";

type RunBeforeToolCallHook = typeof runBeforeToolCallHookType;
type RunBeforeToolCallHookArgs = Parameters<RunBeforeToolCallHook>[0];
type RunBeforeToolCallHookResult = Awaited<ReturnType<RunBeforeToolCallHook>>;

const pluginToolMetaState = vi.hoisted(
  () => new Map<string, { pluginId: string; optional: boolean }>(),
);

const hookMocks = vi.hoisted(() => ({
  resolveToolLoopDetectionConfig: vi.fn(() => ({ warnAt: 3 })),
  runBeforeToolCallHook: vi.fn(
    async (args: RunBeforeToolCallHookArgs): Promise<RunBeforeToolCallHookResult> => ({
      blocked: false,
      params: args.params,
    }),
  ),
}));

let cfg: Record<string, unknown> = {};
let lastCreateOpenClawToolsContext: Record<string, unknown> | undefined;

// Perf: keep this suite pure unit. Mock heavyweight config/session modules.
vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => cfg,
}));

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => cfg,
}));

vi.mock("../config/sessions.js", () => ({
  resolveMainSessionKey: (params?: {
    session?: { scope?: string; mainKey?: string };
    agents?: { list?: Array<{ id?: string; default?: boolean }> };
  }) => {
    if (params?.session?.scope === "global") {
      return "global";
    }
    const agents = params?.agents?.list ?? [];
    const rawDefault = agents.find((agent) => agent?.default)?.id ?? agents[0]?.id ?? "main";
    const agentId = rawDefault.trim().toLowerCase() || "main";
    const mainKeyRaw = (params?.session?.mainKey ?? "main").trim().toLowerCase();
    const mainKey = mainKeyRaw || "main";
    return `agent:${agentId}:${mainKey}`;
  },
}));

vi.mock("./auth.js", () => ({
  authorizeHttpGatewayConnect: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../logger.js", () => ({
  logWarn: () => {},
}));

vi.mock("../plugins/config-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/config-state.js")>();
  return {
    ...actual,
    isTestDefaultMemorySlotDisabled: () => false,
  };
});

vi.mock("../plugins/tools.js", () => ({
  getPluginToolMeta: (tool: { name?: string }) =>
    typeof tool?.name === "string" ? pluginToolMetaState.get(tool.name) : undefined,
}));

// Perf: the real tool factory instantiates many tools per request; for these HTTP
// routing/policy tests we only need a small set of tool names.
vi.mock("../agents/openclaw-tools.js", () => {
  const toolInputError = (message: string) => {
    const err = new Error(message);
    err.name = "ToolInputError";
    return err;
  };
  const toolAuthorizationError = (message: string) => {
    const err = new Error(message) as Error & { status?: number };
    err.name = "ToolAuthorizationError";
    err.status = 403;
    return err;
  };

  const tools = [
    {
      name: "session_status",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true }),
    },
    {
      name: "agents_list",
      parameters: { type: "object", properties: { action: { type: "string" } } },
      execute: async () => ({ ok: true, result: [] }),
    },
    {
      name: "sessions_spawn",
      parameters: { type: "object", properties: {} },
      execute: async () => ({
        ok: true,
        route: {
          agentTo: lastCreateOpenClawToolsContext?.agentTo,
          agentThreadId: lastCreateOpenClawToolsContext?.agentThreadId,
        },
      }),
    },
    {
      name: "sessions_send",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true }),
    },
    {
      name: "gateway",
      parameters: { type: "object", properties: {} },
      execute: async () => {
        throw toolInputError("invalid args");
      },
    },
    {
      name: "exec",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true, result: "exec" }),
    },
    {
      name: "apply_patch",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true, result: "apply_patch" }),
    },
    {
      name: "nodes",
      ownerOnly: true,
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true, result: "nodes" }),
    },
    {
      name: "browser",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true, result: "browser" }),
    },
    {
      name: "plugin_doctor",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true, permissionFlow: true }),
    },
    {
      name: "owner_only_test",
      ownerOnly: true,
      parameters: { type: "object", properties: {} },
      execute: async () => ({ ok: true, result: "owner-only" }),
    },
    {
      name: "tools_invoke_test",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string" },
        },
        required: ["mode"],
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, args: unknown) => {
        const mode = (args as { mode?: unknown })?.mode;
        if (mode === "input") {
          throw toolInputError("mode invalid");
        }
        if (mode === "auth") {
          throw toolAuthorizationError("mode forbidden");
        }
        if (mode === "crash") {
          throw new Error("boom");
        }
        return { ok: true };
      },
    },
    {
      name: "diffs_compat_test",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string" },
          fileFormat: { type: "string" },
        },
        additionalProperties: false,
      },
      execute: async (_toolCallId: string, args: unknown) => {
        const input = (args ?? {}) as Record<string, unknown>;
        return {
          ok: true,
          observedFormat: input.format,
          observedFileFormat: input.fileFormat,
        };
      },
    },
  ];

  return {
    createOpenClawTools: (ctx: Record<string, unknown>) => {
      lastCreateOpenClawToolsContext = ctx;
      return ctx.disablePluginTools ? tools.filter((tool) => tool.name !== "browser") : tools;
    },
  };
});

vi.mock("../agents/pi-tools.js", () => ({
  resolveToolLoopDetectionConfig: hookMocks.resolveToolLoopDetectionConfig,
}));

vi.mock("../agents/pi-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: hookMocks.runBeforeToolCallHook,
}));

const { authorizeHttpGatewayConnect } = await import("./auth.js");
const { handleToolsInvokeHttpRequest } = await import("./tools-invoke-http.js");
const { toolsInvokeHandlers } = await import("./server-methods/tools-invoke.js");

let pluginHttpHandlers: Array<(req: IncomingMessage, res: ServerResponse) => Promise<boolean>> = [];

let sharedPort = 0;
let sharedServer: ReturnType<typeof createServer> | undefined;

beforeAll(async () => {
  sharedServer = createServer((req, res) => {
    void (async () => {
      const handled = await handleToolsInvokeHttpRequest(req, res, {
        auth: { mode: "none", allowTailscale: false },
      });
      if (handled) {
        return;
      }
      for (const handler of pluginHttpHandlers) {
        if (await handler(req, res)) {
          return;
        }
      }
      res.statusCode = 404;
      res.end("not found");
    })().catch((err) => {
      res.statusCode = 500;
      res.end(String(err));
    });
  });

  await new Promise<void>((resolve, reject) => {
    sharedServer?.once("error", reject);
    sharedServer?.listen(0, "127.0.0.1", () => {
      const address = sharedServer?.address() as AddressInfo | null;
      sharedPort = address?.port ?? 0;
      resolve();
    });
  });
});

afterAll(async () => {
  const server = sharedServer;
  if (!server) {
    return;
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  sharedServer = undefined;
});

beforeEach(() => {
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  delete process.env.OPENCLAW_GATEWAY_PASSWORD;
  pluginHttpHandlers = [];
  cfg = {};
  lastCreateOpenClawToolsContext = undefined;
  pluginToolMetaState.clear();
  pluginToolMetaState.set("plugin_doctor", { pluginId: "test-plugin", optional: true });
  hookMocks.resolveToolLoopDetectionConfig.mockClear();
  hookMocks.resolveToolLoopDetectionConfig.mockImplementation(() => ({ warnAt: 3 }));
  hookMocks.runBeforeToolCallHook.mockClear();
  hookMocks.runBeforeToolCallHook.mockImplementation(
    async (args: RunBeforeToolCallHookArgs): Promise<RunBeforeToolCallHookResult> => ({
      blocked: false,
      params: args.params,
    }),
  );
  vi.mocked(authorizeHttpGatewayConnect).mockResolvedValue({ ok: true });
});

const gatewayAuthHeaders = () => ({ "x-openclaw-scopes": "operator.write" });
const gatewayAdminHeaders = () => ({ "x-openclaw-scopes": "operator.admin" });

const allowAgentsListForMain = () => {
  cfg = {
    ...cfg,
    agents: {
      list: [
        {
          id: "main",
          default: true,
          tools: {
            allow: ["agents_list"],
          },
        },
      ],
    },
  };
};

const postToolsInvoke = async (params: {
  port: number;
  headers?: Record<string, string>;
  body: Record<string, unknown>;
}) =>
  await fetch(`http://127.0.0.1:${params.port}/tools/invoke`, {
    method: "POST",
    headers: { "content-type": "application/json", ...params.headers },
    body: JSON.stringify(params.body),
  });

const withOptionalSessionKey = (body: Record<string, unknown>, sessionKey?: string) => ({
  ...body,
  ...(sessionKey ? { sessionKey } : {}),
});

const invokeAgentsList = async (params: {
  port: number;
  headers?: Record<string, string>;
  sessionKey?: string;
}) => {
  const body = withOptionalSessionKey(
    { tool: "agents_list", action: "json", args: {} },
    params.sessionKey,
  );
  return await postToolsInvoke({ port: params.port, headers: params.headers, body });
};

const invokeTool = async (params: {
  port: number;
  tool: string;
  args?: Record<string, unknown>;
  action?: string;
  headers?: Record<string, string>;
  sessionKey?: string;
}) => {
  const body: Record<string, unknown> = withOptionalSessionKey(
    {
      tool: params.tool,
      args: params.args ?? {},
    },
    params.sessionKey,
  );
  if (params.action) {
    body.action = params.action;
  }
  return await postToolsInvoke({ port: params.port, headers: params.headers, body });
};

const invokeAgentsListAuthed = async (params: { sessionKey?: string } = {}) =>
  invokeAgentsList({
    port: sharedPort,
    headers: gatewayAuthHeaders(),
    sessionKey: params.sessionKey,
  });

const invokeAgentsListBearer = async () =>
  await postToolsInvoke({
    port: sharedPort,
    headers: {
      authorization: "Bearer secret",
      "content-type": "application/json",
    },
    body: {
      tool: "agents_list",
      action: "json",
      args: {},
      sessionKey: "main",
    },
  });

const invokeToolAuthed = async (params: {
  tool: string;
  args?: Record<string, unknown>;
  action?: string;
  sessionKey?: string;
}) =>
  invokeTool({
    port: sharedPort,
    headers: gatewayAuthHeaders(),
    ...params,
  });

const expectOkInvokeResponse = async (res: Response) => {
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  return body as { ok: boolean; result?: Record<string, unknown> };
};

const firstHookCallArg = () => {
  const call = hookMocks.runBeforeToolCallHook.mock.calls.at(0);
  if (!call) {
    throw new Error("Expected before-tool-call hook");
  }
  return call[0];
};

const invokeToolsRpc = async (params: Record<string, unknown>, scopes = ["operator.write"]) => {
  const respond = vi.fn();
  await toolsInvokeHandlers["tools.invoke"]({
    params,
    respond,
    context: { getRuntimeConfig: () => cfg } as never,
    client: { connect: { role: "operator", scopes } } as never,
    req: { type: "req", id: "req-rpc-1", method: "tools.invoke" },
    isWebchatConnect: () => false,
  });
  return respond.mock.calls.at(0) as
    | [boolean, { ok?: boolean; toolName?: string; output?: unknown; error?: unknown }?, unknown?]
    | undefined;
};

const setMainAllowedTools = (params: {
  allow: string[];
  gatewayAllow?: string[];
  gatewayDeny?: string[];
}) => {
  cfg = {
    ...cfg,
    agents: {
      list: [{ id: "main", default: true, tools: { allow: params.allow } }],
    },
    ...(params.gatewayAllow || params.gatewayDeny
      ? {
          gateway: {
            tools: {
              ...(params.gatewayAllow ? { allow: params.gatewayAllow } : {}),
              ...(params.gatewayDeny ? { deny: params.gatewayDeny } : {}),
            },
          },
        }
      : {}),
  };
};

describe("POST /tools/invoke", () => {
  it("invokes a tool and returns {ok:true,result}", async () => {
    allowAgentsListForMain();
    const res = await invokeAgentsListAuthed({ sessionKey: "main" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body).toHaveProperty("result");
    expect(lastCreateOpenClawToolsContext?.allowMediaInvokeCommands).toBe(true);
    expect(lastCreateOpenClawToolsContext?.disablePluginTools).toBe(true);
    const hookArg = firstHookCallArg();
    expect(hookArg.toolName).toBe("agents_list");
    const hookCtx = hookArg.ctx;
    if (!hookCtx) {
      throw new Error("Expected before-tool-call hook context");
    }
    expect(hookCtx.agentId).toBe("main");
    expect(hookCtx.config).toBe(cfg);
    expect(hookCtx.sessionKey).toBe("agent:main:main");
    expect(hookCtx.loopDetection).toEqual({ warnAt: 3 });
  });

  it("opts direct gateway tool invocation into gateway subagent binding", async () => {
    allowAgentsListForMain();
    const res = await invokeAgentsListAuthed({ sessionKey: "main" });

    expect(res.status).toBe(200);
    expect(lastCreateOpenClawToolsContext?.allowGatewaySubagentBinding).toBe(true);
  });

  it("keeps plugin tools enabled for non-core tool invokes", async () => {
    setMainAllowedTools({ allow: ["tools_invoke_test"] });

    const res = await invokeToolAuthed({
      tool: "tools_invoke_test",
      args: { mode: "ok" },
      sessionKey: "main",
    });

    expect(res.status).toBe(200);
    expect(lastCreateOpenClawToolsContext?.disablePluginTools).toBe(false);
  });

  it("allows the requested plugin tool through Gateway profile filtering", async () => {
    cfg = {
      ...cfg,
      agents: { list: [{ id: "main", default: true }] },
      tools: { profile: "minimal" },
    };

    const res = await invokeToolAuthed({
      tool: "plugin_doctor",
      sessionKey: "main",
    });

    const body = await expectOkInvokeResponse(res);
    expect(body.result?.ok).toBe(true);
    expect(body.result?.permissionFlow).toBe(true);
    expect(lastCreateOpenClawToolsContext?.pluginToolAllowlist).toContain("plugin_doctor");
  });

  it("uses tools.alsoAllow for optional plugin discovery without loading every plugin tool", async () => {
    cfg = {
      ...cfg,
      agents: { list: [{ id: "main", default: true }] },
      tools: { alsoAllow: ["plugin_doctor"] },
    };

    const res = await invokeToolAuthed({
      tool: "plugin_doctor",
      sessionKey: "main",
    });

    const body = await expectOkInvokeResponse(res);
    expect(body.result?.ok).toBe(true);
    expect(body.result?.permissionFlow).toBe(true);
    expect(lastCreateOpenClawToolsContext?.pluginToolAllowlist).toContain("plugin_doctor");
    expect(lastCreateOpenClawToolsContext?.pluginToolAllowlist).not.toContain("*");
  });

  it("blocks tool execution when before_tool_call rejects the invoke", async () => {
    setMainAllowedTools({ allow: ["tools_invoke_test"] });
    hookMocks.runBeforeToolCallHook.mockResolvedValueOnce({
      blocked: true,
      reason: "blocked by test hook",
    });

    const res = await invokeToolAuthed({
      tool: "tools_invoke_test",
      args: { mode: "ok" },
      sessionKey: "main",
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error?.type).toBe("tool_call_blocked");
    expect(body.error?.message).toBe("blocked by test hook");
  });

  it("accepts shared-secret bearer auth on the HTTP tools surface", async () => {
    allowAgentsListForMain();
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValueOnce({
      ok: true,
      method: "token",
    });

    const res = await invokeAgentsListBearer();

    const body = await expectOkInvokeResponse(res);
    expect(body.result).toEqual({ ok: true, result: [] });
  });

  it("threads senderIsOwner into tool creation before owner-only filtering", async () => {
    setMainAllowedTools({ allow: ["session_status", "owner_only_test"] });

    const writeRes = await invokeTool({
      port: sharedPort,
      headers: gatewayAuthHeaders(),
      tool: "session_status",
      sessionKey: "main",
    });
    expect(writeRes.status).toBe(200);
    expect(lastCreateOpenClawToolsContext?.senderIsOwner).toBe(false);

    const adminRes = await invokeTool({
      port: sharedPort,
      headers: gatewayAdminHeaders(),
      tool: "session_status",
      sessionKey: "main",
    });
    expect(adminRes.status).toBe(200);
    expect(lastCreateOpenClawToolsContext?.senderIsOwner).toBe(true);
  });

  it("uses before_tool_call adjusted params for HTTP tool execution", async () => {
    setMainAllowedTools({ allow: ["tools_invoke_test"] });
    hookMocks.runBeforeToolCallHook.mockImplementationOnce(async () => ({
      blocked: false,
      params: { mode: "rewritten" },
    }));

    const res = await invokeToolAuthed({
      tool: "tools_invoke_test",
      args: { mode: "input" },
      sessionKey: "main",
    });

    const body = await expectOkInvokeResponse(res);
    expect(body.result?.ok).toBe(true);
  });

  it("supports tools.alsoAllow in profile and implicit modes", async () => {
    cfg = {
      ...cfg,
      agents: { list: [{ id: "main", default: true }] },
      tools: { profile: "minimal", alsoAllow: ["agents_list"] },
    };

    const resProfile = await invokeAgentsListAuthed({ sessionKey: "main" });

    expect(resProfile.status).toBe(200);
    const profileBody = await resProfile.json();
    expect(profileBody.ok).toBe(true);

    cfg = {
      ...cfg,
      tools: { alsoAllow: ["agents_list"] },
    };

    const resImplicit = await invokeAgentsListAuthed({ sessionKey: "main" });
    expect(resImplicit.status).toBe(200);
    const implicitBody = await resImplicit.json();
    expect(implicitBody.ok).toBe(true);
  });

  it("routes tools invoke before plugin HTTP handlers", async () => {
    const pluginHandler = vi.fn(async (_req: IncomingMessage, res: ServerResponse) => {
      res.statusCode = 418;
      res.end("plugin");
      return true;
    });
    allowAgentsListForMain();
    pluginHttpHandlers = [async (req, res) => pluginHandler(req, res)];

    const res = await invokeAgentsListAuthed({ sessionKey: "main" });

    expect(res.status).toBe(200);
    expect(pluginHandler).not.toHaveBeenCalled();
  });

  it("returns 404 when denylisted or blocked by tools.profile", async () => {
    cfg = {
      ...cfg,
      agents: {
        list: [
          {
            id: "main",
            default: true,
            tools: {
              deny: ["agents_list"],
            },
          },
        ],
      },
    };
    const denyRes = await invokeAgentsListAuthed({ sessionKey: "main" });
    expect(denyRes.status).toBe(404);

    allowAgentsListForMain();
    cfg = {
      ...cfg,
      tools: { profile: "minimal" },
    };

    const profileRes = await invokeAgentsListAuthed({ sessionKey: "main" });
    expect(profileRes.status).toBe(404);
  });

  it("denies sessions_spawn via HTTP even when agent policy allows", async () => {
    cfg = {
      ...cfg,
      agents: {
        list: [
          {
            id: "main",
            default: true,
            tools: { allow: ["sessions_spawn"] },
          },
        ],
      },
    };

    const res = await invokeToolAuthed({
      tool: "sessions_spawn",
      args: { task: "test" },
      sessionKey: "main",
    });

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error.type).toBe("not_found");
  });

  it("propagates message target/thread headers into tools context for sessions_spawn", async () => {
    cfg = {
      ...cfg,
      agents: {
        list: [{ id: "main", default: true, tools: { allow: ["sessions_spawn"] } }],
      },
      gateway: { tools: { allow: ["sessions_spawn"] } },
    };

    const res = await invokeTool({
      port: sharedPort,
      headers: {
        ...gatewayAuthHeaders(),
        "x-openclaw-message-to": "channel:24514",
        "x-openclaw-thread-id": "thread-24514",
      },
      tool: "sessions_spawn",
      sessionKey: "main",
    });

    const body = await expectOkInvokeResponse(res);
    expect(body.result?.route).toEqual({
      agentTo: "channel:24514",
      agentThreadId: "thread-24514",
    });
  });

  it("denies sessions_send via HTTP gateway", async () => {
    setMainAllowedTools({ allow: ["sessions_send"] });

    const res = await invokeToolAuthed({
      tool: "sessions_send",
      sessionKey: "main",
    });

    expect(res.status).toBe(404);
  });

  it("denies gateway tool via HTTP", async () => {
    setMainAllowedTools({ allow: ["gateway"] });

    const res = await invokeToolAuthed({
      tool: "gateway",
      sessionKey: "main",
    });

    expect(res.status).toBe(404);
  });

  it("allows gateway tool via HTTP when explicitly enabled in gateway.tools.allow", async () => {
    setMainAllowedTools({ allow: ["gateway"], gatewayAllow: ["gateway"] });

    const res = await invokeTool({
      port: sharedPort,
      headers: gatewayAdminHeaders(),
      tool: "gateway",
      sessionKey: "main",
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error?.type).toBe("tool_error");
  });

  it("treats gateway.tools.deny as higher priority than gateway.tools.allow", async () => {
    setMainAllowedTools({
      allow: ["gateway"],
      gatewayAllow: ["gateway"],
      gatewayDeny: ["gateway"],
    });

    const res = await invokeToolAuthed({
      tool: "gateway",
      sessionKey: "main",
    });

    expect(res.status).toBe(404);
  });

  it("uses the configured main session key when sessionKey is missing or main", async () => {
    cfg = {
      ...cfg,
      agents: {
        list: [
          {
            id: "main",
            tools: {
              deny: ["agents_list"],
            },
          },
          {
            id: "ops",
            default: true,
            tools: {
              allow: ["agents_list"],
            },
          },
        ],
      },
      session: { mainKey: "primary" },
    };

    const resDefault = await invokeAgentsListAuthed();
    expect(resDefault.status).toBe(200);

    const resMain = await invokeAgentsListAuthed({ sessionKey: "main" });
    expect(resMain.status).toBe(200);
  });

  it("maps tool input/auth errors to 400/403 and unexpected execution errors to 500", async () => {
    cfg = {
      ...cfg,
      agents: {
        list: [{ id: "main", default: true, tools: { allow: ["tools_invoke_test"] } }],
      },
    };

    const inputRes = await invokeToolAuthed({
      tool: "tools_invoke_test",
      args: { mode: "input" },
      sessionKey: "main",
    });
    expect(inputRes.status).toBe(400);
    const inputBody = await inputRes.json();
    expect(inputBody.ok).toBe(false);
    expect(inputBody.error?.type).toBe("tool_error");
    expect(inputBody.error?.message).toBe("mode invalid");

    const authRes = await invokeToolAuthed({
      tool: "tools_invoke_test",
      args: { mode: "auth" },
      sessionKey: "main",
    });
    expect(authRes.status).toBe(403);
    const authBody = await authRes.json();
    expect(authBody.ok).toBe(false);
    expect(authBody.error?.type).toBe("tool_error");
    expect(authBody.error?.message).toBe("mode forbidden");

    const crashRes = await invokeToolAuthed({
      tool: "tools_invoke_test",
      args: { mode: "crash" },
      sessionKey: "main",
    });
    expect(crashRes.status).toBe(500);
    const crashBody = await crashRes.json();
    expect(crashBody.ok).toBe(false);
    expect(crashBody.error?.type).toBe("tool_error");
    expect(crashBody.error?.message).toBe("tool execution failed");
  });

  it("passes deprecated format alias through invoke payloads even when schema omits it", async () => {
    setMainAllowedTools({ allow: ["diffs_compat_test"] });

    const res = await invokeToolAuthed({
      tool: "diffs_compat_test",
      args: { mode: "file", format: "pdf" },
      sessionKey: "main",
    });

    const body = await expectOkInvokeResponse(res);
    expect(body.result?.observedFormat).toBe("pdf");
    expect(body.result?.observedFileFormat).toBeUndefined();
  });

  it("requires operator.write scope for HTTP tool invocation", async () => {
    allowAgentsListForMain();
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValueOnce({
      ok: true,
      method: "trusted-proxy",
    });

    const res = await invokeTool({
      port: sharedPort,
      headers: {
        "x-openclaw-scopes": "",
      },
      tool: "agents_list",
      sessionKey: "main",
    });

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error?.type).toBe("forbidden");
    expect(body.error?.message).toBe("missing scope: operator.write");
  });

  it("treats shared-secret bearer auth as full operator access on /tools/invoke", async () => {
    allowAgentsListForMain();
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValueOnce({
      ok: true,
      method: "token",
    });

    const res = await invokeAgentsListBearer();

    const body = await expectOkInvokeResponse(res);
    expect(body.result).toEqual({ ok: true, result: [] });
  });

  it("applies owner-only tool policy on the HTTP path", async () => {
    setMainAllowedTools({ allow: ["owner_only_test"] });

    const deniedRes = await invokeToolAuthed({
      tool: "owner_only_test",
      sessionKey: "main",
    });
    expect(deniedRes.status).toBe(404);

    const allowedRes = await invokeTool({
      port: sharedPort,
      headers: gatewayAdminHeaders(),
      tool: "owner_only_test",
      sessionKey: "main",
    });
    const allowedBody = await expectOkInvokeResponse(allowedRes);
    expect(allowedBody.result).toEqual({ ok: true, result: "owner-only" });
  });

  it("treats shared-secret bearer auth as owner on /tools/invoke", async () => {
    setMainAllowedTools({ allow: ["owner_only_test"] });
    vi.mocked(authorizeHttpGatewayConnect).mockResolvedValueOnce({
      ok: true,
      method: "token",
    });

    const res = await invokeTool({
      port: sharedPort,
      headers: {
        authorization: "Bearer secret",
        "x-openclaw-scopes": "operator.approvals",
      },
      tool: "owner_only_test",
      sessionKey: "main",
    });

    const body = await expectOkInvokeResponse(res);
    expect(body.result).toEqual({ ok: true, result: "owner-only" });
  });

  it("extends the HTTP deny list to high-risk execution and file tools", async () => {
    setMainAllowedTools({ allow: ["exec", "apply_patch", "nodes"] });

    const execRes = await invokeToolAuthed({
      tool: "exec",
      sessionKey: "main",
    });
    const patchRes = await invokeToolAuthed({
      tool: "apply_patch",
      sessionKey: "main",
    });
    const nodesRes = await invokeToolAuthed({
      tool: "nodes",
      sessionKey: "main",
    });
    const nodesAdminRes = await invokeTool({
      port: sharedPort,
      headers: gatewayAdminHeaders(),
      tool: "nodes",
      sessionKey: "main",
    });

    expect(execRes.status).toBe(404);
    expect(patchRes.status).toBe(404);
    expect(nodesRes.status).toBe(404);
    expect(nodesAdminRes.status).toBe(404);
  });

  it("falls back to plugin-backed tools when a cataloged core tool has no core implementation", async () => {
    setMainAllowedTools({ allow: ["browser"] });

    const res = await invokeToolAuthed({
      tool: "browser",
      sessionKey: "main",
    });

    const body = await expectOkInvokeResponse(res);
    expect(body.result).toEqual({ ok: true, result: "browser" });
    expect(lastCreateOpenClawToolsContext?.disablePluginTools).toBe(false);
  });
});

describe("tools.invoke Gateway RPC", () => {
  it("invokes a tool through the SDK-facing RPC envelope", async () => {
    allowAgentsListForMain();

    const call = await invokeToolsRpc({
      name: "agents_list",
      args: {},
      sessionKey: "main",
      idempotencyKey: "rpc-tool-test",
    });

    expect(call?.[0]).toBe(true);
    expect(call?.[1]?.ok).toBe(true);
    expect(call?.[1]?.toolName).toBe("agents_list");
    expect(call?.[1]?.output).toEqual({ ok: true, result: [] });
    expect((call?.[1] as { source?: unknown } | undefined)?.source).toBe("core");
    expect(lastCreateOpenClawToolsContext?.allowGatewaySubagentBinding).toBe(true);
    const hookArg = firstHookCallArg();
    expect(hookArg.approvalMode).toBe("report");
    expect(hookArg.toolName).toBe("agents_list");
    expect(hookArg.toolCallId).toBe("rpc-rpc-tool-test");
    const hookCtx = hookArg.ctx;
    if (!hookCtx) {
      throw new Error("Expected before-tool-call hook context");
    }
    expect(hookCtx.agentId).toBe("main");
    expect(hookCtx.config).toBe(cfg);
    expect(hookCtx.sessionKey).toBe("agent:main:main");
  });

  it("returns typed approval-needed refusal when the policy hook blocks", async () => {
    setMainAllowedTools({ allow: ["tools_invoke_test"] });
    hookMocks.runBeforeToolCallHook.mockResolvedValueOnce({
      blocked: true,
      deniedReason: "plugin-approval",
      reason: "Plugin approval required",
      params: { mode: "ok" },
    });

    const call = await invokeToolsRpc({
      name: "tools_invoke_test",
      args: { mode: "ok" },
      sessionKey: "main",
      confirm: false,
    });

    expect(call?.[0]).toBe(true);
    expect(call?.[1]?.ok).toBe(false);
    expect(call?.[1]?.toolName).toBe("tools_invoke_test");
    expect((call?.[1] as { requiresApproval?: unknown } | undefined)?.requiresApproval).toBe(true);
    const error = call?.[1]?.error as { code?: string; message?: string } | undefined;
    expect(error?.code).toBe("requires_approval");
    expect(error?.message).toBe("Plugin approval required");
  });

  it("rejects mismatched session and agent scope", async () => {
    cfg = {
      agents: {
        list: [
          { id: "main", default: true, tools: { allow: ["agents_list"] } },
          { id: "other", tools: { allow: ["agents_list"] } },
        ],
      },
    };

    const call = await invokeToolsRpc({
      name: "agents_list",
      sessionKey: "agent:main:main",
      agentId: "other",
    });

    expect(call?.[0]).toBe(true);
    expect(call?.[1]?.ok).toBe(false);
    expect(call?.[1]?.toolName).toBe("agents_list");
    const error = call?.[1]?.error as { code?: string; message?: string } | undefined;
    expect(error?.code).toBe("validation_error");
    expect(error?.message).toBe('agent id "other" does not match session agent "main"');
  });

  it("rejects malformed params at the RPC boundary", async () => {
    const call = await invokeToolsRpc({ name: "" });

    expect(call?.[0]).toBe(false);
    const error = call?.[2] as { code?: string; message?: string } | undefined;
    expect(error?.code).toBe("INVALID_REQUEST");
    expect(error?.message).toContain("invalid tools.invoke params");
  });
});
