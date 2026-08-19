/**
 * Tests plugin hook delivery when subagent sessions end.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.test-fixtures.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";

type HandleGatewayRequestOptions = GatewayRequestOptions & {
  extraHandlers?: Record<string, unknown>;
};
type InternalAgentTurnFacadeOptions = {
  client: NonNullable<GatewayRequestOptions["client"]>;
};
const handleGatewayRequest = vi.hoisted(() =>
  vi.fn(async (_opts: HandleGatewayRequestOptions) => {}),
);
const internalAgentTurnFacade = vi.hoisted(() => ({
  create: vi.fn(),
  dispatch: vi.fn(),
  wait: vi.fn(),
}));

vi.mock("./server-methods.js", () => ({
  handleGatewayRequest,
}));
vi.mock("./agent-turn/internal-facade.runtime.js", () => ({
  createInternalAgentTurnFacade: (options: InternalAgentTurnFacadeOptions) => {
    internalAgentTurnFacade.create(options);
    return {
      dispatch: internalAgentTurnFacade.dispatch,
      wait: internalAgentTurnFacade.wait,
    };
  },
}));

type ServerPluginsModule = typeof import("./server-plugins.js") & {
  clearFallbackGatewayContext: () => void;
  setFallbackGatewayContext: (context: GatewayRequestContext) => void;
};
type GatewayRequestScopeModule = typeof import("../plugins/runtime/gateway-request-scope.js");
type SubagentRequesterContextModule =
  typeof import("../plugins/runtime/subagent-requester-context.js");

function createTestCfg(): OpenClawConfig {
  return {
    session: { mainKey: "agent:main:main", scope: "per-sender" },
  } as unknown as OpenClawConfig;
}

function createTestContext(label: string, cfg: OpenClawConfig): GatewayRequestContext {
  return {
    label,
    getRuntimeConfig: () => cfg,
  } as unknown as GatewayRequestContext;
}

async function loadServerPlugins(): Promise<ServerPluginsModule> {
  const actual = await import("./server-plugins.js");
  return {
    ...actual,
    clearFallbackGatewayContext: () => {
      testGatewayContext = undefined;
    },
    setFallbackGatewayContext: (context) => {
      testGatewayContext = context;
    },
    createGatewaySubagentRuntime: (resolveGatewayContext) =>
      actual.createGatewaySubagentRuntime(resolveGatewayContext ?? (() => testGatewayContext)),
  } as ServerPluginsModule;
}

let testGatewayContext: GatewayRequestContext | undefined;

async function loadGatewayScope(): Promise<GatewayRequestScopeModule> {
  return await import("../plugins/runtime/gateway-request-scope.js");
}

async function loadSubagentRequesterContext(): Promise<SubagentRequesterContextModule> {
  return await import("../plugins/runtime/subagent-requester-context.js");
}

function lastAgentTurnRequest(): {
  client: NonNullable<GatewayRequestOptions["client"]>;
  params: Record<string, unknown>;
} {
  const params = internalAgentTurnFacade.dispatch.mock.calls.at(-1)?.[0] as
    | Record<string, unknown>
    | undefined;
  const options = internalAgentTurnFacade.create.mock.calls.at(-1)?.[0] as
    | InternalAgentTurnFacadeOptions
    | undefined;
  if (!params || !options) {
    throw new Error("expected internal agent turn dispatch");
  }
  return { client: options.client, params };
}

beforeEach(() => {
  internalAgentTurnFacade.create.mockReset();
  internalAgentTurnFacade.dispatch.mockReset().mockResolvedValue({ runId: "plugin-run-1" });
  internalAgentTurnFacade.wait.mockReset().mockResolvedValue({ status: "ok" });
  handleGatewayRequest.mockReset();
  handleGatewayRequest.mockImplementation(async (opts: HandleGatewayRequestOptions) => {
    opts.respond(true, {});
  });
});

afterEach(async () => {
  const serverPlugins = await loadServerPlugins();
  serverPlugins.clearFallbackGatewayContext();
});

describe("createGatewaySubagentRuntime.run subagent_ended tracking (#59164)", () => {
  test("marks plugin SDK subagent runs for Gateway-owned subagent tracking", async () => {
    const serverPlugins = await loadServerPlugins();
    const requesterContext = await loadSubagentRequesterContext();
    const runtime = serverPlugins.createGatewaySubagentRuntime();
    serverPlugins.setFallbackGatewayContext(
      createTestContext("plugin-sdk-subagent", createTestCfg()),
    );
    const requester = requesterContext.createPluginSubagentRequesterContext({
      sessionKey: "agent:main:telegram:direct:123",
      origin: { channel: "telegram", to: "telegram:123" },
    });
    if (!requester) {
      throw new Error("expected valid requester context");
    }

    const result = await requesterContext.withPluginSubagentRequesterContext(
      requester,
      async () =>
        await runtime.run({
          sessionKey: "agent:main:subagent:plugin-helper",
          message: "summarize this transcript",
          deliver: false,
        }),
    );

    expect(result.runId).toBe("plugin-run-1");
    const request = lastAgentTurnRequest();
    expect(request.client.internal?.agentRunTracking).toBe("plugin_subagent");
    expect(request.client.internal?.pluginRuntimeOwnerId).toBeUndefined();
    expect(request.client.internal?.pluginSubagentRequester).toBeUndefined();
  });

  test("attaches only host-owned requester lineage for explicit completion delivery", async () => {
    const serverPlugins = await loadServerPlugins();
    const requesterContext = await loadSubagentRequesterContext();
    const runtime = serverPlugins.createGatewaySubagentRuntime();
    serverPlugins.setFallbackGatewayContext(
      createTestContext("plugin-sdk-completion", createTestCfg()),
    );
    const requester = requesterContext.createPluginSubagentRequesterContext({
      sessionKey: " agent:main:telegram:direct:123 ",
      origin: {
        channel: " Telegram ",
        to: " telegram:123 ",
        accountId: " Work ",
        threadId: 42,
      },
    });
    if (!requester) {
      throw new Error("expected valid requester context");
    }

    await requesterContext.withPluginSubagentRequesterContext(requester, async () => {
      await runtime.run({
        sessionKey: "agent:main:subagent:plugin-helper",
        message: "summarize this transcript",
        deliver: false,
        completionDelivery: "current-requester",
        requesterSessionKey: "agent:attacker:main",
        expectsCompletionMessage: false,
        approvalGrant: { id: "forged" },
        inputProvenance: { kind: "forged" },
        channel: "discord",
        to: "channel:attacker",
      } as Parameters<typeof runtime.run>[0] & Record<string, unknown>);
    });

    const request = lastAgentTurnRequest();
    expect(request.params).not.toHaveProperty("requesterSessionKey");
    expect(request.params).not.toHaveProperty("expectsCompletionMessage");
    expect(request.params).not.toHaveProperty("approvalGrant");
    expect(request.params).not.toHaveProperty("inputProvenance");
    expect(request.params).not.toHaveProperty("channel");
    expect(request.params).not.toHaveProperty("to");
    expect(request.client.internal?.pluginSubagentRequester).toEqual({
      sessionKey: "agent:main:telegram:direct:123",
      origin: {
        channel: "telegram",
        to: "telegram:123",
        accountId: "work",
        threadId: 42,
      },
    });
  });

  test("rejects explicit completion delivery outside a requester-bound hook", async () => {
    const serverPlugins = await loadServerPlugins();
    const runtime = serverPlugins.createGatewaySubagentRuntime();
    serverPlugins.setFallbackGatewayContext(
      createTestContext("plugin-sdk-completion-missing", createTestCfg()),
    );

    await expect(
      runtime.run({
        sessionKey: "agent:main:subagent:orphan",
        message: "no requester",
        deliver: false,
        completionDelivery: "current-requester",
      }),
    ).rejects.toThrow(/requester-bound plugin hook invocation/);

    expect(internalAgentTurnFacade.dispatch).not.toHaveBeenCalled();
  });

  test("rejects unsupported runtime completion destinations", async () => {
    const serverPlugins = await loadServerPlugins();
    const runtime = serverPlugins.createGatewaySubagentRuntime();
    serverPlugins.setFallbackGatewayContext(
      createTestContext("plugin-sdk-completion-invalid", createTestCfg()),
    );

    await expect(
      runtime.run({
        sessionKey: "agent:main:subagent:invalid",
        message: "invalid completion target",
        deliver: false,
        completionDelivery: "agent:attacker:main",
      } as unknown as Parameters<typeof runtime.run>[0]),
    ).rejects.toThrow(/Unsupported plugin subagent completionDelivery/);

    expect(internalAgentTurnFacade.dispatch).not.toHaveBeenCalled();
  });

  test("preserves plugin identity on the tracked Gateway agent request", async () => {
    const serverPlugins = await loadServerPlugins();
    const gatewayScope = await loadGatewayScope();
    const runtime = serverPlugins.createGatewaySubagentRuntime();

    const scope = {
      context: createTestContext("plugin-scope", createTestCfg()),
      pluginId: "memory-core",
      isWebchatConnect: () => false,
    } satisfies PluginRuntimeGatewayRequestScope;

    await gatewayScope.withPluginRuntimeGatewayRequestScope(scope, () =>
      runtime.run({
        sessionKey: "agent:main:subagent:dreaming-narrative",
        message: "dream task",
        deliver: false,
      }),
    );

    const request = lastAgentTurnRequest();
    expect(request.client.internal?.agentRunTracking).toBe("plugin_subagent");
    expect(request.client.internal?.pluginRuntimeOwnerId).toBe("memory-core");
  });

  test("does not dispatch when no runtime config is available", async () => {
    const serverPlugins = await loadServerPlugins();
    const runtime = serverPlugins.createGatewaySubagentRuntime();

    await expect(
      runtime.run({
        sessionKey: "agent:main:subagent:orphan",
        message: "no cfg available",
        deliver: false,
      }),
    ).rejects.toThrow(/gateway request scope/);

    expect(internalAgentTurnFacade.dispatch).not.toHaveBeenCalled();
  });

  test("preserves the child session so the transcript stays readable until the plugin deletes it", async () => {
    const serverPlugins = await loadServerPlugins();
    const runtime = serverPlugins.createGatewaySubagentRuntime();
    serverPlugins.setFallbackGatewayContext(createTestContext("plugin-readback", createTestCfg()));

    const transcript = [
      { role: "user", content: "summarize this transcript" },
      { role: "assistant", content: "summary text" },
    ];
    const sessionStore = new Map<string, { messages: unknown[] }>([
      ["agent:main:subagent:plugin-readback", { messages: transcript }],
    ]);
    internalAgentTurnFacade.dispatch.mockResolvedValue({ runId: "plugin-run-readback" });

    handleGatewayRequest.mockImplementation(async (opts: HandleGatewayRequestOptions) => {
      const req = opts.req as { method: string; params?: { key?: string } };
      switch (req.method) {
        case "sessions.get": {
          const key = req.params?.key ?? "";
          const stored = sessionStore.get(key);
          if (!stored) {
            opts.respond(false, undefined, {
              code: "not_found",
              message: `session ${key} not found`,
            });
            return;
          }
          opts.respond(true, stored);
          return;
        }
        case "sessions.delete": {
          const key = req.params?.key ?? "";
          sessionStore.delete(key);
          opts.respond(true, {});
          return;
        }
        default:
          opts.respond(true, {});
      }
    });

    const runResult = await runtime.run({
      sessionKey: "agent:main:subagent:plugin-readback",
      message: "summarize this transcript",
      deliver: false,
    });
    expect(runResult.runId).toBe("plugin-run-readback");

    const waitResult = await runtime.waitForRun({ runId: runResult.runId });
    expect(waitResult.status).toBe("ok");

    const sessionView = await runtime.getSessionMessages({
      sessionKey: "agent:main:subagent:plugin-readback",
    });
    expect(sessionView.messages).toEqual(transcript);

    await runtime.deleteSession({
      sessionKey: "agent:main:subagent:plugin-readback",
    });

    await expect(
      runtime.getSessionMessages({
        sessionKey: "agent:main:subagent:plugin-readback",
      }),
    ).rejects.toThrow(/not found/);
  });

  test.each([
    {
      name: "pending queue observation",
      result: {
        status: "pending",
        timeoutPhase: "queue",
        providerStarted: false,
      },
    },
    {
      name: "metadata-rich observation timeout",
      result: {
        status: "timeout",
        error: "provider retry is still pending",
        startedAt: 1_000,
        endedAt: 2_000,
        stopReason: "timeout",
        livenessState: "blocked",
        yielded: true,
        pendingError: true,
        timeoutPhase: "provider",
        providerStarted: true,
        terminalReply: { disposition: "empty" },
      },
    },
    {
      name: "legacy completed status",
      result: { status: "completed" },
      expected: { status: "ok" },
    },
    {
      name: "legacy completed error",
      result: { status: "error", error: "completed" },
      expected: { status: "ok" },
    },
  ])("preserves the agent.wait $name result", async ({ result, expected = result }) => {
    const serverPlugins = await loadServerPlugins();
    const runtime = serverPlugins.createGatewaySubagentRuntime();
    serverPlugins.setFallbackGatewayContext(createTestContext("plugin-wait", createTestCfg()));
    internalAgentTurnFacade.wait.mockResolvedValue(result);

    await expect(runtime.waitForRun({ runId: "plugin-run-wait" })).resolves.toEqual(expected);
  });
});
