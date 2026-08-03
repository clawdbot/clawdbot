import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadCodexEffectiveMcpCatalog } from "./effective-mcp-catalog.js";

const sharedClientMocks = vi.hoisted(() => ({
  retainById: vi.fn(),
}));

vi.mock("./shared-client.js", () => ({
  retainSharedCodexAppServerClientByInstanceId: sharedClientMocks.retainById,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("loadCodexEffectiveMcpCatalog", () => {
  it("reads every page from the exact bound client and thread, then releases the lease", async () => {
    const release = vi.fn();
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            name: "docs!",
            tools: {
              search: {
                description: "Search docs",
                inputSchema: { type: "object", properties: { query: { type: "string" } } },
              },
            },
          },
        ],
        nextCursor: "page-2",
      })
      .mockResolvedValueOnce({
        data: [
          {
            name: "docs?",
            tools: { read: { description: "Read docs", inputSchema: { type: "object" } } },
          },
          { name: "__proto__", tools: {} },
          {
            name: "constructor",
            tools: { inspect: { inputSchema: { type: "object" } } },
          },
          { name: "native-only", tools: { mutate: { inputSchema: { type: "object" } } } },
        ],
        nextCursor: null,
      });
    sharedClientMocks.retainById.mockReturnValueOnce({ client: { request }, release });
    const bindingStore = {
      read: vi.fn().mockResolvedValue({
        threadId: "thread-1",
        clientId: "client-1",
        cwd: "/workspace",
      }),
    };

    const catalog = await loadCodexEffectiveMcpCatalog(
      {
        config: {},
        agentId: "main",
        sessionId: "session-1",
        sessionKey: "agent:main:session-1",
        workspaceDir: "/workspace",
        mcpServerNames: ["docs!", "docs?", "__proto__", "constructor"],
        toolOverrides: { mcpToolsDeny: { "docs!": ["delete", "search"] } },
      },
      { bindingStore: bindingStore as never },
    );

    expect(sharedClientMocks.retainById).toHaveBeenCalledWith("client-1");
    expect(request).toHaveBeenNthCalledWith(1, "mcpServerStatus/list", {
      threadId: "thread-1",
      detail: "toolsAndAuthOnly",
      limit: 100,
    });
    expect(request).toHaveBeenNthCalledWith(2, "mcpServerStatus/list", {
      threadId: "thread-1",
      detail: "toolsAndAuthOnly",
      limit: 100,
      cursor: "page-2",
    });
    expect(catalog?.servers["docs!"]?.safeServerName).toBe("docs-");
    expect(catalog?.servers["docs?"]?.safeServerName).toBe("docs--2");
    expect(Object.hasOwn(catalog?.servers ?? {}, "__proto__")).toBe(true);
    expect(catalog?.servers).not.toHaveProperty("native-only");
    expect(catalog?.tools).toMatchObject([
      { serverName: "constructor", toolName: "inspect" },
      { serverName: "docs?", safeServerName: "docs--2", toolName: "read" },
    ]);
    expect(catalog?.sessionDeniedTools).toMatchObject([
      { serverName: "docs!", toolName: "search", description: "Search docs" },
      { serverName: "docs!", toolName: "delete", deniedBySession: true },
    ]);
    expect(catalog?.servers["docs!"]?.toolCount).toBe(2);
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not start a new Codex process when the binding has no live client", async () => {
    const bindingStore = {
      read: vi.fn().mockResolvedValue({ threadId: "thread-1", cwd: "/workspace" }),
    };

    await expect(
      loadCodexEffectiveMcpCatalog(
        {
          config: {},
          agentId: "main",
          sessionId: "session-1",
          sessionKey: "agent:main:session-1",
          workspaceDir: "/workspace",
          mcpServerNames: [],
        },
        { bindingStore: bindingStore as never },
      ),
    ).resolves.toBeUndefined();
    expect(sharedClientMocks.retainById).not.toHaveBeenCalled();
  });
});
