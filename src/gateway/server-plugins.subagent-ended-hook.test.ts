import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { GatewayRequestContext, GatewayRequestOptions } from "./server-methods/types.js";

type HandleGatewayRequestOptions = GatewayRequestOptions & {
  extraHandlers?: Record<string, unknown>;
};
const handleGatewayRequest = vi.hoisted(() =>
  vi.fn(async (_opts: HandleGatewayRequestOptions) => {}),
);

vi.mock("./server-methods.js", () => ({
  handleGatewayRequest,
}));

type ServerPluginsModule = typeof import("./server-plugins.js");
type GatewayRequestScopeModule = typeof import("../plugins/runtime/gateway-request-scope.js");

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
  return await import("./server-plugins.js");
}

async function loadGatewayScope(): Promise<GatewayRequestScopeModule> {
  return await import("../plugins/runtime/gateway-request-scope.js");
}

function lastGatewayRequest(): HandleGatewayRequestOptions {
  const call = handleGatewayRequest.mock.calls.at(-1)?.[0];
  if (!call) {
    throw new Error("expected handleGatewayRequest call");
  }
  return call;
}

beforeEach(() => {
  handleGatewayRequest.mockReset();
  handleGatewayRequest.mockImplementation(async (opts: HandleGatewayRequestOptions) => {
    switch (opts.req.method) {
      case "agent":
        opts.respond(true, { runId: "plugin-run-1" });
        return;
      case "agent.wait":
        opts.respond(true, { status: "ok" });
        return;
      default:
        opts.respond(true, {});
    }
  });
});

afterEach(async () => {
  const serverPlugins = await loadServerPlugins();
  serverPlugins.clearFallbackGatewayContext();
});

describe("createGatewaySubagentRuntime.run subagent_ended tracking (#59164)", () => {
  test("marks plugin SDK subagent runs for Gateway-owned subagent tracking", async () => {
    const serverPlugins = await loadServerPlugins();
    const runtime = serverPlugins.createGatewaySubagentRuntime();
    serverPlugins.setFallbackGatewayContext(
      createTestContext("plugin-sdk-subagent", createTestCfg()),
    );

    const result = await runtime.run({
      sessionKey: "agent:main:subagent:plugin-helper",
      message: "summarize this transcript",
      deliver: false,
    });

    expect(result.runId).toBe("plugin-run-1");
    const request = lastGatewayRequest();
    expect(request.req.method).toBe("agent");
    expect(request.client?.internal?.agentRunTracking).toBe("plugin_subagent");
    expect(request.client?.internal?.pluginRuntimeOwnerId).toBeUndefined();
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

    const request = lastGatewayRequest();
    expect(request.req.method).toBe("agent");
    expect(request.client?.internal?.agentRunTracking).toBe("plugin_subagent");
    expect(request.client?.internal?.pluginRuntimeOwnerId).toBe("memory-core");
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

    expect(handleGatewayRequest).not.toHaveBeenCalled();
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

    handleGatewayRequest.mockImplementation(async (opts: HandleGatewayRequestOptions) => {
      const req = opts.req as { method: string; params?: { key?: string } };
      switch (req.method) {
        case "agent":
          opts.respond(true, { runId: "plugin-run-readback" });
          return;
        case "agent.wait":
          opts.respond(true, { status: "ok" });
          return;
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
});
