/** Behavior tests for live node-host MCP catalog and connection recovery. */

import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenClawStreamableHTTPClientTransport } from "../agents/mcp-http-transport.js";
import { startNodeHostMcpManager } from "./mcp.js";

function tool(name: string, inputSchema: Tool["inputSchema"] = { type: "object" }): Tool {
  return { name, inputSchema };
}

function createClient(params: {
  tools?: () => Tool[];
  connect?: () => Promise<void>;
  list?: (input?: { cursor?: string }) => Promise<{ tools: Tool[]; nextCursor?: string }>;
  call?: () => Promise<CallToolResult>;
}) {
  const call =
    params.call ??
    (async (): Promise<CallToolResult> => ({ content: [{ type: "text", text: "ok" }] }));
  return {
    onclose: undefined as (() => void) | undefined,
    connect: vi.fn(params.connect ?? (async () => {})),
    request: vi.fn(async (request: { method: "tools/list"; params?: { cursor?: string } }) =>
      params.list ? await params.list(request.params) : { tools: params.tools?.() ?? [] },
    ),
    callTool: vi.fn(call),
    close: vi.fn(async () => {}),
  };
}

const stdioTransport = {
  transport: {} as never,
  transportType: "stdio" as const,
  connectionTimeoutMs: 100,
  requestTimeoutMs: 100,
};

function httpTransport(sessionId?: string) {
  const transport = new OpenClawStreamableHTTPClientTransport(
    new URL("http://127.0.0.1:1/mcp"),
    sessionId ? { sessionId } : undefined,
  );
  transport.close = vi.fn(async () => {});
  transport.terminateSession = vi.fn(async () => {});
  return {
    transport,
    transportType: "streamable-http" as const,
    connectionTimeoutMs: 100,
    requestTimeoutMs: 100,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("node host MCP live lifecycle", () => {
  it("serializes a startup notification refresh after the initial tool list", async () => {
    let notifyToolsChanged: (() => void) | undefined;
    let activeLists = 0;
    let maxActiveLists = 0;
    const pending: Array<(value: { tools: Tool[] }) => void> = [];
    const client = createClient({
      list: async () => {
        activeLists += 1;
        maxActiveLists = Math.max(maxActiveLists, activeLists);
        try {
          return await new Promise<{ tools: Tool[] }>((resolve) => {
            pending.push(resolve);
          });
        } finally {
          activeLists -= 1;
        }
      },
    });
    const starting = startNodeHostMcpManager(
      { docs: { command: "docs" } },
      {
        createClient: (_serverName, options) => {
          notifyToolsChanged = options.onToolsChanged;
          return client;
        },
        resolveTransport: () => stdioTransport,
        warn: vi.fn(),
      },
    );

    await vi.waitFor(() => expect(pending).toHaveLength(1));
    notifyToolsChanged?.();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(client.request).toHaveBeenCalledOnce();
    expect(maxActiveLists).toBe(1);

    pending[0]?.({ tools: [tool("stale")] });
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[1]?.({ tools: [tool("fresh")] });

    const manager = await starting;
    expect(maxActiveLists).toBe(1);
    expect(manager.descriptors.map((descriptor) => descriptor.mcp?.tool)).toEqual(["fresh"]);
    await manager.close();
  });

  it("owns paginated output metadata and hides required-task tools", async () => {
    const outputSchema = {
      type: "object" as const,
      properties: { count: { type: "number" as const } },
      required: ["count"],
      additionalProperties: false,
    };
    const client = createClient({
      list: async (input) =>
        input?.cursor === "page-2"
          ? { tools: [tool("ordinary")] }
          : {
              tools: [
                { ...tool("structured"), outputSchema },
                {
                  ...tool("task_only"),
                  execution: { taskSupport: "required" as const },
                },
              ],
              nextCursor: "page-2",
            },
      call: async () => ({
        content: [{ type: "text", text: "invalid" }],
        structuredContent: { count: "not-a-number" },
      }),
    });
    const manager = await startNodeHostMcpManager(
      { docs: { command: "docs" } },
      { createClient: () => client, resolveTransport: () => stdioTransport, warn: vi.fn() },
    );

    expect(
      manager.descriptors
        .map((descriptor) => descriptor.mcp?.tool)
        .toSorted((left, right) => (left ?? "").localeCompare(right ?? "")),
    ).toEqual(["ordinary", "structured"]);
    await expect(manager.callMcpTool({ server: "docs", tool: "structured" })).rejects.toMatchObject(
      { code: "MCP_TOOL_ERROR" },
    );
    await manager.close();
  });

  it("redacts Streamable HTTP response bodies from node diagnostics", async () => {
    const client = createClient({
      tools: () => [tool("fail")],
      call: async () => {
        throw new StreamableHTTPError(500, "Error POSTing to endpoint: bearer=body-secret");
      },
    });
    const manager = await startNodeHostMcpManager(
      { docs: { command: "docs" } },
      { createClient: () => client, resolveTransport: () => stdioTransport, warn: vi.fn() },
    );

    const error = await manager
      .callMcpTool({ server: "docs", tool: "fail" })
      .catch((caught: unknown) => caught);
    expect(String(error)).not.toContain("body-secret");
    expect(String(error)).toContain("[redacted response body]");
    await manager.close();
  });

  it("refreshes additions, removals, and schemas without replacing descriptor authority", async () => {
    let listed = [tool("before")];
    let notifyToolsChanged: (() => void) | undefined;
    const client = createClient({ tools: () => listed });
    const onDescriptorsChanged = vi.fn();
    const manager = await startNodeHostMcpManager(
      { docs: { command: "docs" } },
      {
        createClient: (_serverName, options) => {
          notifyToolsChanged = options.onToolsChanged;
          return client;
        },
        resolveTransport: () => stdioTransport,
        onDescriptorsChanged,
        warn: vi.fn(),
      },
    );
    const descriptorAuthority = manager.descriptors;

    listed = [
      tool("after", {
        type: "object",
        properties: { revision: { type: "number" } },
        required: ["revision"],
      }),
    ];
    notifyToolsChanged?.();

    await vi.waitFor(() =>
      expect(manager.descriptors.map((descriptor) => descriptor.mcp?.tool)).toEqual(["after"]),
    );
    expect(manager.descriptors).toBe(descriptorAuthority);
    expect(manager.descriptors[0]?.parameters).toEqual(listed[0]?.inputSchema);
    expect(onDescriptorsChanged).toHaveBeenCalledOnce();

    notifyToolsChanged?.();
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(3));
    expect(onDescriptorsChanged).toHaveBeenCalledOnce();
    await manager.close();
  });

  it("coalesces notification storms and never overlaps refreshes", async () => {
    let notifyToolsChanged: (() => void) | undefined;
    let activeLists = 0;
    let maxActiveLists = 0;
    let listCount = 0;
    const pending: Array<(value: { tools: Tool[] }) => void> = [];
    const client = createClient({
      list: async () => {
        listCount += 1;
        if (listCount === 1) {
          return { tools: [tool("initial")] };
        }
        activeLists += 1;
        maxActiveLists = Math.max(maxActiveLists, activeLists);
        try {
          return await new Promise<{ tools: Tool[] }>((resolve) => {
            pending.push(resolve);
          });
        } finally {
          activeLists -= 1;
        }
      },
    });
    const manager = await startNodeHostMcpManager(
      { docs: { command: "docs" } },
      {
        createClient: (_serverName, options) => {
          notifyToolsChanged = options.onToolsChanged;
          return client;
        },
        resolveTransport: () => stdioTransport,
        warn: vi.fn(),
      },
    );

    notifyToolsChanged?.();
    await vi.waitFor(() => expect(activeLists).toBe(1));
    for (let index = 0; index < 20; index += 1) {
      notifyToolsChanged?.();
    }
    expect(client.request).toHaveBeenCalledTimes(2);
    pending.shift()?.({ tools: [tool("middle")] });
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(3));
    expect(maxActiveLists).toBe(1);
    pending.shift()?.({ tools: [tool("final")] });
    await vi.waitFor(() =>
      expect(manager.descriptors.map((descriptor) => descriptor.mcp?.tool)).toEqual(["final"]),
    );
    expect(maxActiveLists).toBe(1);
    await manager.close();
  });

  it("fences a stale refresh and reconnects after transport close", async () => {
    let notifyToolsChanged: (() => void) | undefined;
    let resolveStale: ((value: { tools: Tool[] }) => void) | undefined;
    let firstList = true;
    const stale = createClient({
      list: async () => {
        if (firstList) {
          firstList = false;
          return { tools: [tool("stale-initial")] };
        }
        return await new Promise<{ tools: Tool[] }>((resolve) => {
          resolveStale = resolve;
        });
      },
    });
    const fresh = createClient({ tools: () => [tool("fresh")] });
    let generation = 0;
    const manager = await startNodeHostMcpManager(
      { docs: { command: "docs" } },
      {
        createClient: (_serverName, options) => {
          generation += 1;
          if (generation === 1) {
            notifyToolsChanged = options.onToolsChanged;
            return stale;
          }
          return fresh;
        },
        resolveTransport: () => stdioTransport,
        warn: vi.fn(),
      },
    );

    notifyToolsChanged?.();
    await vi.waitFor(() => expect(stale.request).toHaveBeenCalledTimes(2));
    stale.onclose?.();
    expect(manager.descriptors).toEqual([]);
    await vi.waitFor(() =>
      expect(manager.descriptors.map((descriptor) => descriptor.mcp?.tool)).toEqual(["fresh"]),
    );
    resolveStale?.({ tools: [tool("stale-completion")] });
    await Promise.resolve();
    expect(manager.descriptors.map((descriptor) => descriptor.mcp?.tool)).toEqual(["fresh"]);

    stale.onclose?.();
    expect(manager.descriptors.map((descriptor) => descriptor.mcp?.tool)).toEqual(["fresh"]);
    await manager.close();
  });

  it("withdraws a failed refresh while preserving a healthy sibling", async () => {
    let notifyToolsChanged: (() => void) | undefined;
    const failed = createClient({
      list: vi
        .fn<() => Promise<{ tools: Tool[] }>>()
        .mockResolvedValueOnce({ tools: [tool("unsafe-stale")] })
        .mockRejectedValueOnce(new Error("refresh failed https://mcp.invalid/?token=secret-value")),
    });
    const reconnectFailure = createClient({
      connect: async () => {
        throw new Error("still unavailable");
      },
    });
    const healthy = createClient({ tools: () => [tool("healthy")] });
    let failedGeneration = 0;
    const warn = vi.fn();
    const manager = await startNodeHostMcpManager(
      { failed: { command: "failed" }, healthy: { command: "healthy" } },
      {
        createClient: (serverName, options) => {
          if (serverName === "healthy") {
            return healthy;
          }
          failedGeneration += 1;
          if (failedGeneration === 1) {
            notifyToolsChanged = options.onToolsChanged;
            return failed;
          }
          return reconnectFailure;
        },
        resolveTransport: () => stdioTransport,
        warn,
      },
    );

    notifyToolsChanged?.();
    await vi.waitFor(() =>
      expect(manager.descriptors.map((descriptor) => descriptor.mcp?.server)).toEqual(["healthy"]),
    );
    await expect(manager.callMcpTool({ server: "healthy", tool: "healthy" })).resolves.toEqual({
      content: [{ type: "text", text: "ok" }],
    });
    expect(warn.mock.calls.flat().join("\n")).not.toContain("secret-value");
    await manager.close();
  });

  it("recovers only an exact stateful Streamable HTTP 404 and never replays the call", async () => {
    let releaseReplacement: (() => void) | undefined;
    const replacementReady = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    const expiredStateful = createClient({
      tools: () => [tool("run")],
      call: async () => {
        throw new StreamableHTTPError(404, "Session not found");
      },
    });
    const clients = {
      stateful: [
        expiredStateful,
        createClient({
          tools: () => [tool("run")],
          connect: async () => await replacementReady,
        }),
      ],
      stateless: [
        createClient({
          tools: () => [tool("run")],
          call: async () => {
            throw new StreamableHTTPError(404, "Not found");
          },
        }),
      ],
      application: [
        createClient({
          tools: () => [tool("run")],
          call: async () => ({ isError: true, content: [{ type: "text", text: "rejected" }] }),
        }),
      ],
    } as const;
    const generations = new Map<string, number>();
    const manager = await startNodeHostMcpManager(
      {
        stateful: { url: "http://stateful.invalid/mcp" },
        stateless: { url: "http://stateless.invalid/mcp" },
        application: { url: "http://application.invalid/mcp" },
      },
      {
        createClient: (serverName) => {
          const generation = generations.get(serverName) ?? 0;
          generations.set(serverName, generation + 1);
          const client = clients[serverName as keyof typeof clients][generation];
          if (!client) {
            throw new Error(`unexpected ${serverName} MCP client generation ${generation}`);
          }
          return client;
        },
        resolveTransport: (serverName) =>
          httpTransport(serverName === "stateful" ? "session-1" : undefined),
        warn: vi.fn(),
      },
    );

    await expect(manager.callMcpTool({ server: "stateful", tool: "run" })).rejects.toMatchObject({
      code: "MCP_TOOL_ERROR",
    });
    expect(expiredStateful.callTool).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(generations.get("stateful")).toBe(2));
    expect(manager.descriptors.map((descriptor) => descriptor.mcp?.server)).not.toContain(
      "stateful",
    );

    releaseReplacement?.();
    await vi.waitFor(() =>
      expect(manager.descriptors.map((descriptor) => descriptor.mcp?.server)).toContain("stateful"),
    );
    await expect(manager.callMcpTool({ server: "stateful", tool: "run" })).resolves.toEqual({
      content: [{ type: "text", text: "ok" }],
    });
    expect(expiredStateful.callTool).toHaveBeenCalledOnce();

    await expect(manager.callMcpTool({ server: "stateless", tool: "run" })).rejects.toMatchObject({
      code: "MCP_TOOL_ERROR",
    });
    expect(generations.get("stateless")).toBe(1);
    expect(manager.descriptors.map((descriptor) => descriptor.mcp?.server)).toContain("stateless");

    await expect(
      manager.callMcpTool({ server: "application", tool: "run" }),
    ).resolves.toMatchObject({ isError: true });
    expect(generations.get("application")).toBe(1);
    await manager.close();
  });

  it("does not retry unsupported restart-scoped transport config", async () => {
    vi.useFakeTimers();
    const mockCreateClient = vi.fn(() => createClient({}));
    const warn = vi.fn();
    const manager = await startNodeHostMcpManager(
      { invalid: { transport: "stdio" } },
      { createClient: mockCreateClient, resolveTransport: () => null, warn },
    );

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledOnce();
    await manager.close();
  });

  it("caps reconnect backoff and cancels its timer on close", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const manager = await startNodeHostMcpManager(
      { offline: { command: "offline" } },
      {
        createClient: () =>
          createClient({
            connect: async () => {
              attempts += 1;
              throw new Error("offline");
            },
          }),
        resolveTransport: () => stdioTransport,
        warn: vi.fn(),
      },
    );
    expect(attempts).toBe(1);

    for (const [index, delayMs] of [
      250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000,
    ].entries()) {
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(attempts).toBe(index + 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(index + 2);
    }

    await manager.close();
    const attemptsAtClose = attempts;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(attempts).toBe(attemptsAtClose);
  });

  it("keeps global ordering and descriptor caps after refresh", async () => {
    let listed = [tool("initial")];
    let notifyToolsChanged: (() => void) | undefined;
    const crowded = createClient({ tools: () => listed });
    const sibling = createClient({ tools: () => [tool("sibling")] });
    const manager = await startNodeHostMcpManager(
      { crowded: { command: "crowded" }, sibling: { command: "sibling" } },
      {
        createClient: (serverName, options) => {
          if (serverName === "crowded") {
            notifyToolsChanged = options.onToolsChanged;
            return crowded;
          }
          return sibling;
        },
        resolveTransport: () => stdioTransport,
        warn: vi.fn(),
      },
    );

    listed = Array.from({ length: 130 }, (_, index) =>
      tool(`tool-${String(index).padStart(3, "0")}`),
    ).toReversed();
    notifyToolsChanged?.();
    await vi.waitFor(() => expect(manager.descriptors).toHaveLength(128));
    expect(manager.descriptors[0]?.mcp).toEqual({ server: "crowded", tool: "tool-000" });
    expect(manager.descriptors.at(-1)?.mcp).toEqual({ server: "crowded", tool: "tool-127" });
    expect(manager.descriptors.some((descriptor) => descriptor.mcp?.server === "sibling")).toBe(
      false,
    );
    await manager.close();
  });

  it("bounds initial server connection fan-out at six", async () => {
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const servers = Object.fromEntries(
      Array.from({ length: 7 }, (_, index) => [`server-${index}`, { command: "server" }]),
    );
    const starting = startNodeHostMcpManager(servers, {
      createClient: () =>
        createClient({
          connect: async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise<void>((resolve) => {
              releases.push(resolve);
            });
            active -= 1;
          },
        }),
      resolveTransport: () => stdioTransport,
      warn: vi.fn(),
    });

    await vi.waitFor(() => expect(releases).toHaveLength(6));
    expect(maxActive).toBe(6);
    releases.shift()?.();
    await vi.waitFor(() => expect(releases).toHaveLength(6));
    for (const release of releases.splice(0)) {
      release();
    }
    const manager = await starting;
    expect(maxActive).toBe(6);
    await manager.close();
  });
});
