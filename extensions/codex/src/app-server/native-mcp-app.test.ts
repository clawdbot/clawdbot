import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";

const sharedClientMocks = vi.hoisted(() => ({
  fenceSharedCodexAppServerClientToolCalls: vi.fn(),
  isSharedCodexAppServerClientToolCallFenced: vi.fn(),
  retainLiveSharedCodexAppServerClient: vi.fn(),
  retireSharedCodexAppServerClientIfCurrent: vi.fn(),
}));

vi.mock("./shared-client.js", () => sharedClientMocks);

import { createCodexNativeMcpAppResultDetailsPreparer } from "./native-mcp-app.js";
import { testing } from "./native-mcp-app.test-support.js";

const { createNativeMcpRuntime } = testing;

function createAttempt(enabled = true): EmbeddedRunAttemptParams {
  return {
    sessionId: "session-1",
    sessionKey: "agent:main:dashboard:thread-1",
    workspaceDir: "/tmp/workspace",
    config: enabled ? { mcp: { apps: { enabled: true } } } : {},
  } as EmbeddedRunAttemptParams;
}

describe("Codex native MCP Apps", () => {
  beforeEach(() => {
    const fencedClients = new WeakSet<object>();
    sharedClientMocks.fenceSharedCodexAppServerClientToolCalls.mockReset();
    sharedClientMocks.fenceSharedCodexAppServerClientToolCalls.mockImplementation(
      (client: object) => {
        fencedClients.add(client);
      },
    );
    sharedClientMocks.isSharedCodexAppServerClientToolCallFenced.mockReset();
    sharedClientMocks.isSharedCodexAppServerClientToolCallFenced.mockImplementation(
      (client: object) => fencedClients.has(client),
    );
    sharedClientMocks.retainLiveSharedCodexAppServerClient.mockReset();
    sharedClientMocks.retireSharedCodexAppServerClientIfCurrent.mockReset();
  });

  it("uses the active Codex thread for inventory and app resources", async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "mcpServerStatus/list") {
        return {
          data: [
            {
              name: "sample",
              tools: {
                show_options: { description: "Show nearby options", inputSchema: {} },
                show_menu: { description: "Show a restaurant menu", inputSchema: {} },
              },
            },
          ],
        };
      }
      if (method === "mcpServer/resource/read") {
        return {
          contents: [
            {
              uri: params.uri,
              mimeType: "text/html;profile=mcp-app",
              text: "<html><body>Sample</body></html>",
            },
          ],
        };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const prepare = createCodexNativeMcpAppResultDetailsPreparer({
      client: { request, getInstanceId: () => "client-1" } as unknown as CodexAppServerClient,
      threadId: "thread-1",
      attempt: createAttempt(),
    });

    const details = await prepare?.({
      id: "call-options",
      type: "mcpToolCall",
      server: "sample",
      tool: "show_options",
      status: "completed",
      appContext: { connectorId: "sample", resourceUri: "ui://sample/options.html" },
      arguments: { limit: 4 },
      result: {
        content: [{ type: "text", text: "Found four restaurants." }],
        structuredContent: { stores: [{ id: "store-1" }] },
        _meta: null,
      },
    } as never);
    expect(details).toMatchObject({
      mcpAppPreview: {
        kind: "canvas",
        view: { id: expect.stringMatching(/^mcp-app-/u), title: "show_options UI" },
        mcpApp: {
          serverName: "sample",
          toolName: "show_options",
          uiResourceUri: "ui://sample/options.html",
          toolCallId: "call-options",
          originSessionKey: "agent:main:dashboard:thread-1",
        },
      },
    });
    expect(request).toHaveBeenCalledWith("mcpServerStatus/list", {
      threadId: "thread-1",
      detail: "full",
    });
    expect(request).toHaveBeenCalledWith("mcpServer/resource/read", {
      threadId: "thread-1",
      server: "sample",
      uri: "ui://sample/options.html",
    });
  });

  it("does not prepare native app views unless MCP Apps are enabled", () => {
    expect(
      createCodexNativeMcpAppResultDetailsPreparer({
        client: {} as CodexAppServerClient,
        threadId: "thread-1",
        attempt: createAttempt(false),
      }),
    ).toBeUndefined();
  });

  it("forwards each MCP operation signal to the native app-server request", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "mcpServerStatus/list") {
        return {
          data: [
            {
              name: "sample",
              tools: { show_options: { inputSchema: {} } },
              resources: [],
              resourceTemplates: [],
            },
          ],
        };
      }
      if (method === "mcpServer/tool/call") {
        return { content: [] };
      }
      if (method === "mcpServer/resource/read") {
        return { contents: [] };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const runtime = createNativeMcpRuntime({
      client: { request, getInstanceId: () => "client-1" } as unknown as CodexAppServerClient,
      threadId: "thread-1",
      attempt: createAttempt(),
    });
    const controller = new AbortController();

    await runtime.getCatalog({ signal: controller.signal });
    await runtime.callTool("sample", "show_options", {}, { signal: controller.signal });
    await runtime.readResource?.("sample", "ui://sample/options.html", {
      signal: controller.signal,
    });

    expect(request).toHaveBeenNthCalledWith(
      1,
      "mcpServerStatus/list",
      { threadId: "thread-1", detail: "full" },
      { signal: controller.signal },
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      "mcpServer/tool/call",
      {
        threadId: "thread-1",
        server: "sample",
        tool: "show_options",
        arguments: {},
      },
      { signal: controller.signal },
    );
    expect(request).toHaveBeenNthCalledWith(
      3,
      "mcpServer/resource/read",
      {
        threadId: "thread-1",
        server: "sample",
        uri: "ui://sample/options.html",
      },
      { signal: controller.signal },
    );
  });

  it.each([
    {
      label: "post-write cancellation",
      code: "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED",
    },
    {
      label: "post-write transport failure",
      code: "CODEX_APP_SERVER_REQUEST_TRANSPORT_INDETERMINATE",
    },
  ] as const)("fences later tool calls after a $label", async ({ code }) => {
    const failure = Object.assign(new Error("mcpServer/tool/call became indeterminate"), {
      code,
      mayHaveWritten: true as const,
    });
    const request = vi.fn(async () => {
      throw failure;
    });
    const client = {
      request,
      getInstanceId: () => "client-1",
    } as unknown as CodexAppServerClient;
    const runtime = createNativeMcpRuntime({
      client,
      threadId: "thread-1",
      attempt: createAttempt(),
    });
    const siblingRuntime = createNativeMcpRuntime({
      client,
      threadId: "thread-2",
      attempt: createAttempt(),
    });

    await expect(runtime.callTool("sample", "charge", {})).rejects.toBe(failure);
    expect(sharedClientMocks.retireSharedCodexAppServerClientIfCurrent).toHaveBeenCalledWith(
      client,
    );
    await expect(runtime.callTool("sample", "charge", {})).rejects.toThrow(
      "Codex native MCP tool calls are unavailable after an indeterminate cancellation",
    );
    await expect(siblingRuntime.callTool("sample", "charge", {})).rejects.toThrow(
      "Codex native MCP tool calls are unavailable after an indeterminate cancellation",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("does not fence tool calls when cancellation happens before the request write", async () => {
    const cancellation = Object.assign(new Error("mcpServer/tool/call aborted"), {
      code: "CODEX_APP_SERVER_LOCAL_REQUEST_CANCELLED" as const,
      mayHaveWritten: false as const,
    });
    const request = vi
      .fn()
      .mockRejectedValueOnce(cancellation)
      .mockResolvedValueOnce({ content: [] });
    const runtime = createNativeMcpRuntime({
      client: { request, getInstanceId: () => "client-1" } as unknown as CodexAppServerClient,
      threadId: "thread-1",
      attempt: createAttempt(),
    });

    await expect(runtime.callTool("sample", "charge", {})).rejects.toBe(cancellation);
    await expect(runtime.callTool("sample", "charge", {})).resolves.toEqual({ content: [] });
    expect(sharedClientMocks.retireSharedCodexAppServerClientIfCurrent).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
  });
});
