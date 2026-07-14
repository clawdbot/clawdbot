import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchMcpAppView: vi.fn(),
  getMcpAppViewLease: vi.fn(),
  getOrCreateSessionMcpRuntime: vi.fn(),
  loadSessionEntry: vi.fn(),
  resolveAgentDir: vi.fn(),
  resolveAgentIdFromSessionKey: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
  visitSessionMessagesAsync: vi.fn(),
}));

vi.mock("../agents/agent-bundle-mcp-runtime.js", () => ({
  getOrCreateSessionMcpRuntime: mocks.getOrCreateSessionMcpRuntime,
}));
vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentDir: mocks.resolveAgentDir,
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
}));
vi.mock("../agents/mcp-ui-resource.js", () => ({
  fetchMcpAppView: mocks.fetchMcpAppView,
  getMcpAppViewLease: mocks.getMcpAppViewLease,
}));
vi.mock("../routing/session-key.js", () => ({
  resolveAgentIdFromSessionKey: mocks.resolveAgentIdFromSessionKey,
}));
vi.mock("./session-transcript-readers.js", () => ({
  visitSessionMessagesAsync: mocks.visitSessionMessagesAsync,
}));
vi.mock("./session-utils.js", () => ({
  loadSessionEntry: mocks.loadSessionEntry,
}));

import { restoreMcpAppView } from "./mcp-app-reconstruction.js";

const runtime = { mcpAppsEnabled: true };
const view = { id: "view-lease" };

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.resolveAgentIdFromSessionKey.mockReturnValue("main");
  mocks.resolveAgentDir.mockReturnValue("/tmp/agent");
  mocks.resolveAgentWorkspaceDir.mockReturnValue("/tmp/workspace");
  mocks.loadSessionEntry.mockReturnValue({
    canonicalKey: "agent:main:main",
    entry: { sessionId: "session-1" },
    storePath: "/tmp/sessions.json",
  });
  mocks.getOrCreateSessionMcpRuntime.mockResolvedValue(runtime);
  mocks.fetchMcpAppView.mockResolvedValue(undefined);
  mocks.getMcpAppViewLease.mockReturnValue(view);
});

async function restoreFromMessages(messages: unknown[], viewId: string) {
  mocks.visitSessionMessagesAsync.mockImplementation(
    async (_scope: unknown, visit: (message: unknown) => void) => {
      for (const message of messages) {
        visit(message);
      }
    },
  );
  return await restoreMcpAppView({ cfg: {}, sessionKey: "agent:main:main", viewId });
}

function descriptor(viewId: string, toolCallId: string) {
  return {
    viewId,
    serverName: "demo",
    toolName: "show",
    uiResourceUri: "ui://demo/app",
    toolCallId,
  };
}

function toolResult(viewId: string, toolCallId: string, extraDescriptor: object = {}) {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "demo__show",
    content: [{ type: "text", text: "ok" }],
    details: {
      mcpServer: "demo",
      mcpTool: "show",
      structuredContent: { city: "Paris" },
      mcpAppPreview: { mcpApp: { ...descriptor(viewId, toolCallId), ...extraDescriptor } },
    },
  };
}

describe("MCP App transcript reconstruction", () => {
  it("restores a descriptor bound to its canonical tool call and result", async () => {
    const restored = await restoreFromMessages(
      [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "call-1",
              name: "demo__show",
              arguments: { city: "Paris" },
            },
          ],
        },
        toolResult("mcp-app-1", "call-1"),
      ],
      "mcp-app-1",
    );

    expect(restored).toEqual({ runtime, view });
    expect(mocks.fetchMcpAppView).toHaveBeenCalledWith({
      runtime,
      serverName: "demo",
      toolName: "show",
      uiResourceUri: "ui://demo/app",
      toolCallId: "call-1",
      toolInput: { city: "Paris" },
      toolResult: {
        content: [{ type: "text", text: "ok" }],
        structuredContent: { city: "Paris" },
      },
      viewId: "mcp-app-1",
      allowedAppToolNames: new Set(),
    });
  });

  it("rejects client-selected descriptors that do not match transcript ownership", async () => {
    await expect(
      restoreFromMessages(
        [
          {
            ...toolResult("mcp-app-ownership", "call-1"),
            toolCallId: "call-other",
          },
        ],
        "mcp-app-ownership",
      ),
    ).resolves.toBeUndefined();
    expect(mocks.fetchMcpAppView).not.toHaveBeenCalled();
  });

  it("binds reused call IDs to the nearest preceding matching tool", async () => {
    await restoreFromMessages(
      [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "shared", name: "other__tool", args: { secret: 1 } }],
        },
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "shared", name: "demo__show", args: { page: 2 } }],
        },
        toolResult("mcp-app-reused", "shared"),
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "shared", name: "demo__show", args: { page: 3 } }],
        },
      ],
      "mcp-app-reused",
    );

    expect(mocks.fetchMcpAppView).toHaveBeenCalledWith(
      expect.objectContaining({ toolInput: { page: 2 } }),
    );
  });

  it("declines reconstruction when app-only result metadata was not persisted", async () => {
    await expect(
      restoreFromMessages(
        [
          {
            role: "assistant",
            content: [{ type: "toolCall", id: "call-1", name: "demo__show", args: {} }],
          },
          toolResult("mcp-app-meta", "call-1", { resultMetaState: "unavailable" }),
        ],
        "mcp-app-meta",
      ),
    ).resolves.toBeUndefined();
  });

  it("rejects a descriptor without its matching tool-call input", async () => {
    await expect(
      restoreFromMessages([toolResult("mcp-app-missing", "call-1")], "mcp-app-missing"),
    ).resolves.toBeUndefined();
  });

  it("streams the full active transcript instead of limiting reconstruction to its tail", async () => {
    const messages = [
      {
        role: "assistant",
        content: [{ type: "toolCall", id: "call-1", name: "demo__show", args: { page: 1 } }],
      },
      toolResult("mcp-app-stream", "call-1"),
      ...Array.from({ length: 2_500 }, (_, index) => ({
        role: "assistant",
        content: [{ type: "text", text: `later-${index}` }],
      })),
    ];

    await restoreFromMessages(messages, "mcp-app-stream");

    expect(mocks.visitSessionMessagesAsync).toHaveBeenCalledTimes(2);
    expect(mocks.fetchMcpAppView).toHaveBeenCalledWith(
      expect.objectContaining({ toolInput: { page: 1 } }),
    );
  });
});
