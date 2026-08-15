import { ErrorCodes } from "openclaw/plugin-sdk/gateway-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import type { TranscriptSourceProvider } from "openclaw/plugin-sdk/transcripts";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

const MEETING_URL = "https://zoom.us/j/12345678901?pwd=owned";

type GatewayHandler = (options: {
  client?: { internal?: { pluginRuntimeOwnerId?: string } };
  params?: Record<string, unknown>;
  respond(ok: boolean, payload?: unknown, error?: unknown): void;
}) => Promise<void>;

function authorizationHarness(options?: { browserError?: Error }) {
  const methods = new Map<string, GatewayHandler>();
  let tabOpen = false;
  const gatewayRequest = vi.fn(async (_method: string, params: Record<string, unknown>) => {
    if (options?.browserError) {
      throw options.browserError;
    }
    if (params.path === "/tabs") {
      return { tabs: tabOpen ? [{ targetId: "zoom-tab", title: "Zoom", url: MEETING_URL }] : [] };
    }
    if (params.path === "/tabs/open") {
      tabOpen = true;
      return { targetId: "zoom-tab", title: "Zoom", url: MEETING_URL };
    }
    if (params.path === "/tabs/focus") {
      return { ok: true };
    }
    if (params.method === "DELETE" && params.path === "/tabs/zoom-tab") {
      tabOpen = false;
      return { ok: true };
    }
    if (params.path === "/act") {
      const scriptValue = (params.body as { fn?: unknown } | undefined)?.fn;
      const script = typeof scriptValue === "string" ? scriptValue : "";
      return script.includes("leaveAction")
        ? { result: JSON.stringify({ departed: true, urlMatched: true }) }
        : script.includes("expectedSessionId")
          ? {
              result: JSON.stringify({
                droppedLines: 0,
                lines: [],
                sessionMatched: true,
                urlMatched: true,
              }),
            }
          : {
              result: JSON.stringify({
                cameraOff: true,
                inCall: true,
                micMuted: true,
                title: "Zoom",
                url: MEETING_URL,
              }),
            };
    }
    throw new Error(`unexpected browser request ${String(params.path)}`);
  });
  const api = createTestPluginApi({
    id: "zoom-meetings",
    name: "Zoom meetings",
    description: "test",
    version: "0",
    source: "test",
    config: {},
    pluginConfig: { defaultMode: "transcribe", chrome: { waitForInCallMs: 1 } },
    runtime: {
      gateway: { isAvailable: vi.fn(async () => true), request: gatewayRequest },
    } as unknown as OpenClawPluginApi["runtime"],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    registerGatewayMethod: (method: string, handler: unknown) =>
      methods.set(method, handler as GatewayHandler),
  });
  plugin.register(api);

  const invoke = async (
    method: string,
    params: Record<string, unknown>,
    pluginRuntimeOwnerId?: string,
  ) => {
    const handler = methods.get(method);
    if (!handler) {
      throw new Error(`missing handler ${method}`);
    }
    let response: { ok: boolean; payload?: unknown; error?: unknown } | undefined;
    await handler({
      params,
      ...(pluginRuntimeOwnerId ? { client: { internal: { pluginRuntimeOwnerId } } } : {}),
      respond: (ok, payload, error) => {
        response = { ok, payload, error };
      },
    });
    return response;
  };
  const call = async (
    method: string,
    params: Record<string, unknown>,
    pluginRuntimeOwnerId?: string,
  ) => {
    const response = await invoke(method, params, pluginRuntimeOwnerId);
    if (!response?.ok) {
      throw new Error(`gateway call failed: ${JSON.stringify(response)}`);
    }
    return response.payload as Record<string, unknown>;
  };
  return { call, invoke };
}

describe("Zoom meetings plugin surface", () => {
  it("registers the bounded gateway, tool, CLI, and node surfaces", () => {
    const methods = new Map<string, unknown>();
    const tools: Array<Record<string, unknown>> = [];
    const cli: unknown[] = [];
    const nodeCommands: unknown[] = [];
    const policies: unknown[] = [];
    const transcriptProviders: TranscriptSourceProvider[] = [];
    const api = createTestPluginApi({
      id: "zoom-meetings",
      name: "Zoom meetings",
      description: "test",
      version: "0",
      source: "test",
      config: {},
      pluginConfig: {},
      runtime: {
        gateway: { isAvailable: vi.fn(async () => false), request: vi.fn() },
      } as unknown as OpenClawPluginApi["runtime"],
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerGatewayMethod: (method: string, handler: unknown) => methods.set(method, handler),
      registerTool: (tool: unknown) => {
        tools.push(
          (typeof tool === "function"
            ? (tool as (context: Record<string, unknown>) => Record<string, unknown>)({})
            : tool) as Record<string, unknown>,
        );
      },
      registerCli: (_registrar: unknown, options: unknown) => cli.push(options),
      registerNodeHostCommand: (command: unknown) => nodeCommands.push(command),
      registerNodeInvokePolicy: (policy: unknown) => policies.push(policy),
      registerTranscriptSourceProvider: (provider) => transcriptProviders.push(provider),
    });

    plugin.register(api);

    expect([...methods.keys()].toSorted()).toEqual(
      [
        "zoommeetings.join",
        "zoommeetings.leave",
        "zoommeetings.setup",
        "zoommeetings.speak",
        "zoommeetings.status",
        "zoommeetings.testListen",
        "zoommeetings.testSpeech",
        "zoommeetings.transcript",
      ].toSorted(),
    );
    expect(tools.map((tool) => tool.name)).toEqual(["zoom_meetings"]);
    expect(cli).toEqual([expect.objectContaining({ commands: ["zoommeetings"] })]);
    expect(nodeCommands).toEqual([
      expect.objectContaining({ command: "zoommeetings.chrome", cap: "zoom-meetings" }),
    ]);
    expect(policies).toHaveLength(1);
    expect(transcriptProviders).toEqual([
      expect.objectContaining({
        id: "zoom",
        aliases: ["zoom-meetings"],
        sourceKinds: ["live-caption"],
      }),
    ]);
  });

  it("does not expose the dangerous node surface when disabled", () => {
    const nodeCommands: unknown[] = [];
    const policies: unknown[] = [];
    const api = createTestPluginApi({
      id: "zoom-meetings",
      name: "Zoom meetings",
      description: "test",
      version: "0",
      source: "test",
      config: {},
      pluginConfig: { enabled: false },
      runtime: {
        gateway: { isAvailable: vi.fn(async () => false), request: vi.fn() },
      } as unknown as OpenClawPluginApi["runtime"],
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerNodeHostCommand: (command: unknown) => nodeCommands.push(command),
      registerNodeInvokePolicy: (policy: unknown) => policies.push(policy),
    });

    plugin.register(api);

    expect(nodeCommands).toEqual([]);
    expect(policies).toEqual([]);
  });

  it("routes main-agent tool calls through the ownership-attested runtime", async () => {
    const gatewayRequest = vi.fn(async () => ({ found: true, sessions: [] }));
    let tool:
      | { execute: (id: string, params: unknown) => Promise<{ details: Record<string, unknown> }> }
      | undefined;
    const api = createTestPluginApi({
      id: "zoom-meetings",
      name: "Zoom meetings",
      description: "test",
      version: "0",
      source: "test",
      config: {},
      pluginConfig: {},
      runtime: {
        gateway: { isAvailable: vi.fn(async () => true), request: gatewayRequest },
      } as unknown as OpenClawPluginApi["runtime"],
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      registerTool: (registered: unknown) => {
        tool = (
          typeof registered === "function"
            ? (registered as (context: Record<string, unknown>) => typeof tool)({
                agentId: "main",
                sessionKey: "agent:main:main",
              })
            : registered
        ) as typeof tool;
      },
    });
    plugin.register(api);

    await tool?.execute("id", { action: "status" });

    expect(gatewayRequest).toHaveBeenCalledWith(
      "zoommeetings.status",
      {
        action: "status",
        agentId: "main",
        requesterSessionKey: "agent:main:main",
      },
      expect.objectContaining({ scopes: ["operator.admin"] }),
    );
  });

  it("scopes trusted tool session operations to the invoking agent", async () => {
    const { call } = authorizationHarness();
    const joined = await call(
      "zoommeetings.join",
      { agentId: "support", mode: "transcribe", url: MEETING_URL },
      "zoom-meetings",
    );
    const sessionId = (joined.session as { id: string }).id;

    expect(await call("zoommeetings.status", { agentId: "other" }, "zoom-meetings")).toMatchObject({
      found: true,
      sessions: [],
    });
    for (const method of ["status", "leave", "transcript", "speak"] as const) {
      expect(
        await call(
          `zoommeetings.${method}`,
          { agentId: "other", message: "hello", sessionId },
          "zoom-meetings",
        ),
      ).toMatchObject({ found: false });
    }

    expect(await call("zoommeetings.status", { agentId: "spoofed", sessionId })).toMatchObject({
      found: true,
      session: { agentId: "support", id: sessionId },
    });
    expect(
      await call("zoommeetings.leave", { agentId: "support", sessionId }, "zoom-meetings"),
    ).toMatchObject({ found: true, session: { id: sessionId, state: "ended" } });
  });

  it.each([
    ["mode", "observe-only", "mode must be agent, bidi, or transcribe"],
    ["transport", "desktop", "transport must be chrome or chrome-node"],
  ])("rejects an explicit invalid %s", async (field, value, message) => {
    const { invoke } = authorizationHarness();
    const response = await invoke("zoommeetings.join", {
      [field]: value,
      url: MEETING_URL,
    });

    expect(response).toMatchObject({
      error: { code: ErrorCodes.INVALID_REQUEST },
      ok: false,
      payload: { error: message },
    });
  });

  it("rejects timeoutMs on normal join instead of silently ignoring it", async () => {
    const { invoke } = authorizationHarness();
    const response = await invoke("zoommeetings.join", {
      mode: "transcribe",
      timeoutMs: 1,
      url: MEETING_URL,
    });

    expect(response).toMatchObject({
      ok: false,
      payload: { error: "timeoutMs is supported only by testSpeech or testListen" },
    });
  });

  it.each([
    ["zoommeetings.testSpeech", "transcribe", "test_speech requires mode: agent or bidi"],
    ["zoommeetings.testListen", "agent", "test_listen requires mode: transcribe"],
  ])(
    "classifies invalid probe mode for %s as an invalid request",
    async (method, mode, message) => {
      const { invoke } = authorizationHarness();
      const response = await invoke(method, { mode, timeoutMs: 1, url: MEETING_URL });

      expect(response).toMatchObject({
        error: { code: ErrorCodes.INVALID_REQUEST },
        ok: false,
        payload: { error: message },
      });
    },
  );

  it("classifies browser failures as unavailable, not invalid requests", async () => {
    const { invoke } = authorizationHarness({ browserError: new Error("browser unavailable") });
    const response = await invoke("zoommeetings.join", {
      mode: "transcribe",
      url: MEETING_URL,
    });

    expect(response).toMatchObject({
      error: { code: ErrorCodes.UNAVAILABLE },
      ok: false,
      payload: { error: "browser unavailable" },
    });
  });
});
