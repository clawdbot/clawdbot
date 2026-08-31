import {
  prepareHarnessNativeMcpAppPreview,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import type { CodexAppServerClient } from "./client.js";
import { createCodexNativeMcpAppResultDetailsPreparer } from "./native-mcp-app.js";

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...original,
    prepareHarnessNativeMcpAppPreview: vi.fn(original.prepareHarnessNativeMcpAppPreview),
  };
});

function createAttempt(enabled = true): EmbeddedRunAttemptParams {
  return {
    sessionId: "session-1",
    sessionKey: "agent:main:dashboard:thread-1",
    workspaceDir: "/tmp/workspace",
    config: enabled ? { mcp: { apps: { enabled: true } } } : {},
  } as EmbeddedRunAttemptParams;
}

describe("Codex native MCP Apps", () => {
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
                internal_reasoning: {
                  description: "Model-only internal context",
                  inputSchema: {},
                  _meta: { ui: { visibility: ["model"] } },
                },
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
      connectorId: "sample",
    });
    expect(
      vi.mocked(prepareHarnessNativeMcpAppPreview).mock.lastCall?.[0].allowedAppToolNames,
    ).toEqual(new Set(["show_options", "show_menu"]));
  });

  it.each([
    { label: "a different", responseOriginCallId: "call-other" },
    { label: "no", responseOriginCallId: undefined },
    { label: "a null", responseOriginCallId: null },
  ])(
    "omits the app preview when Codex returns $label MCP origin call",
    async ({ responseOriginCallId }) => {
      const request = vi.fn(async (method: string) => {
        if (method === "mcpServerStatus/list") {
          return {
            data: [
              {
                name: "codex_apps",
                tools: {
                  show_options: {
                    description: "Show options",
                    inputSchema: {},
                    _meta: { connector_id: "sample" },
                  },
                },
              },
            ],
          };
        }
        if (method === "mcpServer/resource/read") {
          return {
            ...(responseOriginCallId !== undefined ? { originCallId: responseOriginCallId } : {}),
            contents: [
              {
                uri: "ui://sample/options.html",
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

      await expect(
        prepare?.({
          id: "call-options",
          type: "mcpToolCall",
          server: "codex_apps",
          tool: "show_options",
          status: "completed",
          appContext: { connectorId: "sample", resourceUri: "ui://sample/options.html" },
          arguments: {},
          result: { content: [{ type: "text", text: "Found options." }] },
        } as never),
      ).resolves.toBeUndefined();
      expect(request).toHaveBeenCalledWith("mcpServer/resource/read", {
        threadId: "thread-1",
        originCallId: "call-options",
        server: "codex_apps",
        uri: "ui://sample/options.html",
        connectorId: "sample",
      });
    },
  );

  it("does not prepare native app views unless MCP Apps are enabled", () => {
    expect(
      createCodexNativeMcpAppResultDetailsPreparer({
        client: {} as CodexAppServerClient,
        threadId: "thread-1",
        attempt: createAttempt(false),
      }),
    ).toBeUndefined();
  });

  it("limits hosted app widgets to app-visible tools owned by their originating connector", async () => {
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === "mcpServerStatus/list") {
        return {
          data: [
            {
              name: "codex_apps",
              tools: {
                calendar_read: {
                  inputSchema: { type: "object" },
                  _meta: { connector_id: "calendar", ui: { visibility: ["app", "model"] } },
                },
                calendar_model_only: {
                  inputSchema: { type: "object" },
                  _meta: { connector_id: "calendar", ui: { visibility: ["model"] } },
                },
                calendar_shared: {
                  inputSchema: { type: "object" },
                  _meta: { connectorId: "calendar" },
                },
                drive_delete: {
                  inputSchema: { type: "object" },
                  _meta: { connector_id: "drive", ui: { visibility: ["app"] } },
                },
                unattributed: {
                  inputSchema: { type: "object" },
                  _meta: { ui: { visibility: ["app"] } },
                },
              },
            },
          ],
        };
      }
      if (method === "mcpServer/resource/read") {
        return {
          originCallId: params.originCallId,
          contents: [
            {
              uri: params.uri,
              mimeType: "text/html;profile=mcp-app",
              text: "<html><body>Calendar</body></html>",
            },
          ],
        };
      }
      throw new Error(`unexpected request: ${method}`);
    });
    const prepare = createCodexNativeMcpAppResultDetailsPreparer({
      client: { request, getInstanceId: () => "client-hosted" } as unknown as CodexAppServerClient,
      threadId: "thread-hosted",
      attempt: createAttempt(),
    });

    const hostedItem = {
      id: "call-calendar",
      type: "mcpToolCall",
      server: "codex_apps",
      tool: "calendar_read",
      status: "completed",
      appContext: { connectorId: "calendar", resourceUri: "ui://calendar/widget.html" },
      arguments: {},
      result: { content: [{ type: "text", text: "Calendar ready." }] },
    };
    await expect(prepare?.(hostedItem as never)).resolves.toBeDefined();

    const previewParams = vi.mocked(prepareHarnessNativeMcpAppPreview).mock.lastCall?.[0];
    expect(previewParams?.allowedAppToolNames).toEqual(
      new Set(["calendar_read", "calendar_shared"]),
    );
    await expect(previewParams?.runtime.getCatalog()).resolves.toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({ toolName: "calendar_model_only", uiVisibility: ["model"] }),
        expect.objectContaining({ toolName: "drive_delete", uiVisibility: ["app"] }),
      ]),
    });
    await expect(previewParams?.runtime.listTools?.("codex_apps")).resolves.toMatchObject({
      tools: expect.arrayContaining([
        expect.objectContaining({
          name: "calendar_model_only",
          _meta: { connector_id: "calendar", ui: { visibility: ["model"] } },
        }),
      ]),
    });

    const previousResourceReadCount = request.mock.calls.filter(
      ([method]) => method === "mcpServer/resource/read",
    ).length;
    for (const tool of ["calendar_model_only", "drive_delete", "unattributed"]) {
      await expect(
        prepare?.({ ...hostedItem, id: `call-denied-${tool}`, tool } as never),
      ).resolves.toBeUndefined();
    }
    expect(
      request.mock.calls.filter(([method]) => method === "mcpServer/resource/read"),
    ).toHaveLength(previousResourceReadCount);
  });

  it("does not grant a hosted widget authority without an originating connector", async () => {
    const request = vi.fn();
    const prepare = createCodexNativeMcpAppResultDetailsPreparer({
      client: { request, getInstanceId: () => "client-unowned" } as unknown as CodexAppServerClient,
      threadId: "thread-unowned",
      attempt: createAttempt(),
    });

    await expect(
      prepare?.({
        id: "call-unowned",
        type: "mcpToolCall",
        server: "codex_apps",
        tool: "calendar_read",
        status: "completed",
        appContext: { resourceUri: "ui://calendar/widget.html" },
        arguments: {},
        result: { content: [{ type: "text", text: "Calendar ready." }] },
      } as never),
    ).resolves.toBeUndefined();
    expect(request).not.toHaveBeenCalled();
  });
});
