/** Tests connected node-hosted plugin tool materialization. */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NodePluginToolDescriptor } from "../../packages/gateway-protocol/src/index.js";
import {
  listConnectedNodePluginTools,
  removeConnectedNodePluginTools,
  replaceConnectedNodePluginTools,
} from "../gateway/node-plugin-tool-snapshot.js";
import {
  NODE_PLUGIN_TOOL_CALL_GATEWAY_TIMEOUT_MS,
  NODE_PLUGIN_TOOL_CALL_TIMEOUT_MS,
} from "../infra/node-commands.js";
import { getPluginToolMeta, setPluginToolMeta } from "../plugins/tools.js";
import { applyCodeModeCatalog, createCodeModeTools } from "./code-mode.js";
import { testing } from "./code-mode.test-support.js";
import { createNodePluginTools } from "./node-plugin-tools.js";
import { isToolResultError } from "./tool-result-error.js";
import { compactToolSearchCatalogEntry, createToolSearchCatalogRef } from "./tool-search.js";
import { jsonResult, type AnyAgentTool } from "./tools/common.js";
import { callGatewayTool } from "./tools/gateway.js";

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

function replaceNodePluginTools(
  params: Omit<Parameters<typeof replaceConnectedNodePluginTools>[0], "tools"> & {
    tools: NodePluginToolDescriptor[];
    registered?: boolean;
  },
): void {
  const { registered = false, tools, ...node } = params;
  replaceConnectedNodePluginTools({
    ...node,
    tools: tools.map((descriptor) => ({ descriptor, registered })),
  });
}

function createCodeModeHarness(tools: AnyAgentTool[]) {
  const catalogRef = createToolSearchCatalogRef();
  const config = { tools: { codeMode: { enabled: true, timeoutMs: 120_000 } } } as never;
  const ctx = {
    config,
    runtimeConfig: config,
    sessionId: "session-node-mcp-code-mode",
    sessionKey: "agent:main:node-mcp-code-mode",
    runId: "run-node-mcp-code-mode",
    catalogRef,
  };
  const codeModeTools = createCodeModeTools(ctx);
  const compacted = applyCodeModeCatalog({
    tools: [...codeModeTools, ...tools],
    config,
    sessionId: ctx.sessionId,
    sessionKey: ctx.sessionKey,
    runId: ctx.runId,
    catalogRef,
  });
  return { catalogRef, codeModeTools, compacted };
}

async function runCodeMode(codeModeTools: AnyAgentTool[], code: string) {
  let details = (
    await expectDefined(codeModeTools[0], "codeModeTools[0] test invariant").execute(
      "code-node-mcp",
      { code },
    )
  ).details as Record<string, unknown>;
  for (let index = 0; index < 8 && details.status === "waiting"; index += 1) {
    details = (
      await expectDefined(codeModeTools[1], "codeModeTools[1] test invariant").execute(
        `wait-node-mcp-${index}`,
        { runId: details.runId },
      )
    ).details as Record<string, unknown>;
  }
  return details;
}

function gatewayMcpTool(serverName: string): AnyAgentTool {
  const tool: AnyAgentTool = {
    name: `${serverName}__status`,
    label: "status",
    description: `Read ${serverName} status`,
    parameters: { type: "object", properties: {} },
    execute: vi.fn(async () => jsonResult({ source: "gateway" })),
  };
  setPluginToolMeta(tool, {
    pluginId: "bundle-mcp",
    optional: false,
    mcp: {
      serverName,
      safeServerName: serverName,
      toolName: "status",
      operation: "tool",
    },
  });
  return tool;
}

afterEach(() => {
  for (const nodeId of new Set(listConnectedNodePluginTools().map((tool) => tool.nodeId))) {
    removeConnectedNodePluginTools(nodeId);
  }
  vi.mocked(callGatewayTool).mockReset();
  testing.activeRuns.clear();
  testing.resumingRunIds.clear();
});

describe("createNodePluginTools", () => {
  it("materializes connected node plugin tools and invokes their node command", async () => {
    replaceNodePluginTools({
      nodeId: "node-1",
      displayName: "Studio Node",
      tools: [
        {
          pluginId: "remote-demo",
          name: "remote_echo",
          description: "Echo through a remote node",
          parameters: {
            type: "object",
            properties: { text: { type: "string" } },
          },
          command: "remote.echo",
          mcp: {
            server: "remote-demo",
            tool: "echo",
          },
        },
      ],
    });
    vi.mocked(callGatewayTool).mockResolvedValueOnce({
      payload: {
        content: [{ type: "text", text: "pong" }],
        details: { ok: true },
      },
    });

    const tools = createNodePluginTools({
      existingToolNames: new Set(["read"]),
      agentSessionKey: "agent:main:canvas",
    });
    const result = await expectDefined(tools[0], "tools[0] test invariant").execute("call-1", {
      text: "ping",
    });

    expect(tools.map((tool) => tool.name)).toEqual(["remote_echo"]);
    expect(expectDefined(tools[0], "tools[0] test invariant").description).toContain("Studio Node");
    expect(getPluginToolMeta(expectDefined(tools[0], "tools[0] test invariant"))).toMatchObject({
      pluginId: "remote-demo",
      mcp: {
        serverName: "remote-demo",
        toolName: "echo",
        operation: "tool",
      },
    });
    expect(callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      { timeoutMs: 35_000 },
      {
        nodeId: "node-1",
        command: "remote.echo",
        params: { text: "ping" },
        timeoutMs: 30_000,
        idempotencyKey: "call-1",
        sessionKey: "agent:main:canvas",
      },
      { scopes: ["operator.write"] },
    );
    expect(result.content).toEqual([{ type: "text", text: "pong" }]);
  });

  it("gives plain node tool calls a gateway deadline the caller wait outlasts", async () => {
    replaceNodePluginTools({
      nodeId: "node-1",
      displayName: "Studio Node",
      tools: [
        {
          pluginId: "remote-demo",
          name: "remote_echo",
          description: "Echo through a remote node",
          parameters: { type: "object", properties: { text: { type: "string" } } },
          command: "remote.echo",
        },
      ],
    });
    vi.mocked(callGatewayTool).mockResolvedValueOnce({ payload: { ok: true } });

    const tool = expectDefined(
      createNodePluginTools({})[0],
      "createNodePluginTools({})[0] test invariant",
    );
    await tool.execute("call-1", { text: "ping" });

    const call = expectDefined(
      vi.mocked(callGatewayTool).mock.calls[0],
      "callGatewayTool call test invariant",
    );
    const callerWaitMs = (call[1] as { timeoutMs?: number }).timeoutMs;
    const invokeDeadlineMs = (call[2] as { timeoutMs?: number }).timeoutMs;

    // The Gateway only arms an invocation deadline when the payload carries a
    // positive top-level timeout; without one the node registry falls back to its
    // own 30s pending timer, which starts too late to beat the caller's wait.
    expect(invokeDeadlineMs).toBe(NODE_PLUGIN_TOOL_CALL_TIMEOUT_MS);
    // The caller must outlast that deadline so the deadline answer wins the race
    // instead of the caller abandoning a still-running node command.
    expect(callerWaitMs).toBe(NODE_PLUGIN_TOOL_CALL_GATEWAY_TIMEOUT_MS);
    expect(callerWaitMs as number).toBeGreaterThan(invokeDeadlineMs as number);
  });

  it("forwards the caller abort signal to node gateway invocations", async () => {
    replaceNodePluginTools({
      nodeId: "node-1",
      tools: [
        {
          pluginId: "remote-demo",
          name: "remote_echo",
          description: "Echo through a remote node",
          command: "remote.echo",
        },
      ],
    });
    vi.mocked(callGatewayTool).mockResolvedValueOnce({ payload: { ok: true } });
    const controller = new AbortController();
    const tool = expectDefined(
      createNodePluginTools({})[0],
      "createNodePluginTools({})[0] test invariant",
    );

    await tool.execute("call-cancellable", { text: "ping" }, controller.signal);

    expect(callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      { timeoutMs: 35_000 },
      {
        nodeId: "node-1",
        command: "remote.echo",
        params: { text: "ping" },
        timeoutMs: 30_000,
        idempotencyKey: "call-cancellable",
      },
      { scopes: ["operator.write"], signal: controller.signal },
    );
  });

  it("propagates caller cancellation through node gateway invocations", async () => {
    replaceNodePluginTools({
      nodeId: "node-1",
      tools: [
        {
          pluginId: "remote-demo",
          name: "remote_echo",
          description: "Echo through a remote node",
          command: "remote.echo",
        },
      ],
    });
    vi.mocked(callGatewayTool).mockImplementationOnce(async (_method, _opts, _params, extra) => {
      extra?.signal?.throwIfAborted();
      return { payload: { ok: true } };
    });
    const controller = new AbortController();
    const abortError = new DOMException("node call cancelled", "AbortError");
    controller.abort(abortError);
    const tool = expectDefined(
      createNodePluginTools({})[0],
      "createNodePluginTools({})[0] test invariant",
    );

    await expect(tool.execute("call-aborted", { text: "ping" }, controller.signal)).rejects.toBe(
      abortError,
    );
    expect(callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      { timeoutMs: 35_000 },
      {
        nodeId: "node-1",
        command: "remote.echo",
        params: { text: "ping" },
        timeoutMs: 30_000,
        idempotencyKey: "call-aborted",
      },
      { scopes: ["operator.write"], signal: controller.signal },
    );
  });

  it("wraps node-host MCP arguments and maps MCP content", async () => {
    replaceNodePluginTools({
      nodeId: "node-1",
      tools: [
        {
          pluginId: "node-mcp",
          name: "docs_search",
          description: "Search node-local docs",
          command: "mcp.tools.call.v1",
          mcp: { server: "docs", tool: "search" },
        },
      ],
    });
    vi.mocked(callGatewayTool).mockResolvedValueOnce({
      payload: {
        content: [
          { type: "image", data: "aW1hZ2UtMQ==", mimeType: "image/png" },
          { type: "text", text: "first" },
          { type: "text", text: "second" },
          { type: "image", data: "aW1hZ2UtMg==", mimeType: "image/png" },
          { type: "image", data: 42, mimeType: "image/png" },
        ],
        structuredContent: { hits: 2 },
        isError: true,
      },
    });

    const tool = expectDefined(
      createNodePluginTools({})[0],
      "createNodePluginTools({})[0] test invariant",
    );
    const result = await tool.execute("call-mcp", { query: "needle" });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      { timeoutMs: 125_000 },
      {
        nodeId: "node-1",
        command: "mcp.tools.call.v1",
        params: { server: "docs", tool: "search", arguments: { query: "needle" } },
        timeoutMs: 120_000,
        idempotencyKey: "call-mcp",
      },
      { scopes: ["operator.write"] },
    );
    expect(tool.executionMode).toBe("sequential");
    expect(getPluginToolMeta(tool)?.mcp?.node).toEqual({ id: "node-1" });
    expect(result.content).toEqual([
      { type: "text", text: 'structuredContent:\n{\n  "hits": 2\n}' },
      { type: "image", data: "aW1hZ2UtMQ==", mimeType: "image/png" },
      { type: "text", text: "first" },
      { type: "text", text: "second" },
      { type: "image", data: "aW1hZ2UtMg==", mimeType: "image/png" },
      { type: "text", text: '{"type":"image","data":42,"mimeType":"image/png"}' },
    ]);
    expect(result.details).toEqual({
      content: [
        { type: "image", data: "aW1hZ2UtMQ==", mimeType: "image/png" },
        { type: "text", text: "first" },
        { type: "text", text: "second" },
        { type: "image", data: "aW1hZ2UtMg==", mimeType: "image/png" },
        { type: "image", data: 42, mimeType: "image/png" },
      ],
      structuredContent: { hits: 2 },
      isError: true,
      status: "error",
    });
    expect(isToolResultError(result)).toBe(true);
  });

  it("projects node MCP schemas and calls through the exact namespace catalog entry", async () => {
    replaceNodePluginTools({
      nodeId: "node-1",
      displayName: "Studio Node",
      tools: [
        {
          pluginId: "node-mcp",
          name: "docs_search",
          description: "Search node-local docs",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search phrase" },
            },
            required: ["query"],
          },
          command: "mcp.tools.call.v1",
          mcp: { server: "docs", tool: "search" },
        },
      ],
    });
    vi.mocked(callGatewayTool).mockResolvedValueOnce({
      payload: {
        content: [{ type: "text", text: "found" }],
        structuredContent: { hits: 1 },
      },
    });

    const nodeTools = createNodePluginTools({ agentSessionKey: "agent:main:node-mcp-code-mode" });
    const { catalogRef, codeModeTools, compacted } = createCodeModeHarness(nodeTools);
    const nodeEntry = catalogRef.current?.entries.find(
      (entry) => entry.name === "docs_search" && entry.source === "mcp",
    );

    expect(nodeEntry?.id).toBe("mcp:docs:docs_search");
    expect(nodeEntry && compactToolSearchCatalogEntry(nodeEntry).mcp).toEqual({
      serverName: "docs",
      safeServerName: "docs",
      toolName: "search",
      operation: "tool",
    });
    expect(compacted.tools[0]?.description).toContain("docs (node: Studio Node)");
    const details = await runCodeMode(
      codeModeTools,
      `
        const api = await API.read("mcp/docs.d.ts");
        const called = await MCP.docs.search({ query: "needle" });
        const direct = await tools.search("docs_search");
        return {
          api: api.content,
          called: called.details,
          allHasNodeMcp: ALL_TOOLS.some((entry) => entry.id === "mcp:docs:docs_search"),
          direct,
        };
      `,
    );

    expect(details.status, JSON.stringify(details)).toBe("completed");
    expect(details.value).toEqual({
      api: expect.stringContaining("query: string;"),
      called: {
        content: [{ type: "text", text: "found" }],
        structuredContent: { hits: 1 },
      },
      allHasNodeMcp: false,
      direct: [],
    });
    expect((details.value as { api: string }).api).toContain("@param query Search phrase");
    expect(callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      { timeoutMs: 125_000 },
      {
        nodeId: "node-1",
        command: "mcp.tools.call.v1",
        params: { server: "docs", tool: "search", arguments: { query: "needle" } },
        timeoutMs: 120_000,
        idempotencyKey: expect.stringContaining("docs_search"),
        sessionKey: "agent:main:node-mcp-code-mode",
      },
      { scopes: ["operator.write"], signal: expect.any(AbortSignal) },
    );
  });

  it("makes empty MCP application results visible", async () => {
    replaceNodePluginTools({
      nodeId: "node-1",
      tools: [
        {
          pluginId: "node-mcp",
          name: "docs_fail",
          description: "Fail without content",
          parameters: { type: "object", properties: {} },
          command: "mcp.tools.call.v1",
          mcp: { server: "docs", tool: "fail" },
        },
      ],
    });
    vi.mocked(callGatewayTool).mockResolvedValueOnce({
      payload: { content: [], isError: true },
    });

    const tool = expectDefined(createNodePluginTools({})[0], "node MCP tool");
    const result = await tool.execute("empty-error", {});

    expect(result.content).toEqual([
      { type: "text", text: "MCP tool failed without returning content." },
    ]);
    expect(isToolResultError(result)).toBe(true);
  });

  it("disambiguates gateway-node and node-node MCP server collisions", async () => {
    for (const [nodeId, displayName, serverName, toolName] of [
      ["node-a", "Node A", "tickets", "search_a"],
      ["node-b", "Node B", "docs", "search_b"],
      ["node-c", "Node C", "docs", "search_c"],
    ] as const) {
      replaceNodePluginTools({
        nodeId,
        displayName,
        tools: [
          {
            pluginId: "node-mcp",
            name: `docs_${toolName}`,
            description: `Search docs from ${displayName}`,
            parameters: { type: "object", properties: {} },
            command: "mcp.tools.call.v1",
            mcp: { server: serverName, tool: toolName },
          },
        ],
      });
    }
    vi.mocked(callGatewayTool).mockResolvedValueOnce({
      payload: { content: [{ type: "text", text: "node-b" }] },
    });

    const { codeModeTools, compacted } = createCodeModeHarness([
      gatewayMcpTool("tickets"),
      ...createNodePluginTools({}),
    ]);
    expect(compacted.tools[0]?.description).toContain(
      "visible servers: nodeATickets (node: Node A), nodeBDocs (node: Node B), nodeCDocs (node: Node C), tickets",
    );

    const details = await runCodeMode(
      codeModeTools,
      `
        const files = await API.list("mcp");
        const called = await MCP.nodeCDocs.searchC({});
        return { files: files.files.map((file) => file.path), called: called.details };
      `,
    );

    expect(details.status, JSON.stringify(details)).toBe("completed");
    expect(details.value).toEqual({
      files: [
        "mcp/index.d.ts",
        "mcp/nodeATickets.d.ts",
        "mcp/nodeBDocs.d.ts",
        "mcp/nodeCDocs.d.ts",
        "mcp/tickets.d.ts",
      ],
      called: { content: [{ type: "text", text: "node-b" }] },
    });
    expect(callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      { timeoutMs: 125_000 },
      expect.objectContaining({
        nodeId: "node-c",
        params: { server: "docs", tool: "search_c", arguments: {} },
      }),
      { scopes: ["operator.write"], signal: expect.any(AbortSignal) },
    );
  });

  it("disambiguates node tools that collide with existing tool names", () => {
    replaceNodePluginTools({
      nodeId: "node-1",
      tools: [
        {
          pluginId: "remote-demo",
          name: "remote_echo",
          description: "Echo through a remote node",
          command: "remote.echo",
        },
      ],
    });

    expect(
      createNodePluginTools({ existingToolNames: new Set(["remote_echo"]) }).map(
        (tool) => tool.name,
      ),
    ).toEqual(["node_1_remote_echo"]);
  });

  it("disambiguates matching tool names from different nodes", async () => {
    replaceNodePluginTools({
      nodeId: "node-a",
      displayName: "Node A",
      tools: [
        {
          pluginId: "remote-demo",
          name: "remote_echo",
          description: "Echo through a remote node",
          command: "remote.echo",
        },
      ],
    });
    replaceNodePluginTools({
      nodeId: "node-b",
      displayName: "Node B",
      tools: [
        {
          pluginId: "remote-demo",
          name: "remote_echo",
          description: "Echo through a remote node",
          command: "remote.echo",
        },
      ],
    });
    vi.mocked(callGatewayTool).mockResolvedValueOnce({
      payload: { ok: true, node: "b" },
    });

    const tools = createNodePluginTools({});
    const result = await expectDefined(tools[1], "tools[1] test invariant").execute("call-2", {
      text: "ping",
    });

    expect(tools.map((tool) => tool.name)).toEqual(["node_a_remote_echo", "node_b_remote_echo"]);
    expect(callGatewayTool).toHaveBeenCalledWith(
      "node.invoke",
      { timeoutMs: 35_000 },
      {
        nodeId: "node-b",
        command: "remote.echo",
        params: { text: "ping" },
        timeoutMs: 30_000,
        idempotencyKey: "call-2",
      },
      { scopes: ["operator.write"] },
    );
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining('"node": "b"'),
    });
  });

  it("honors policy for disambiguated node tool names", () => {
    for (const nodeId of ["node-a", "node-b"]) {
      replaceNodePluginTools({
        nodeId,
        tools: [
          {
            pluginId: "remote-demo",
            name: "remote_echo",
            description: "Echo through a remote node",
            command: "remote.echo",
          },
        ],
      });
    }

    expect(
      createNodePluginTools({
        toolAllowlist: ["node_b_remote_echo"],
      }).map((tool) => tool.name),
    ).toEqual(["node_b_remote_echo"]);
    expect(
      createNodePluginTools({
        toolDenylist: ["node_b_remote_echo"],
      }).map((tool) => tool.name),
    ).toEqual(["node_a_remote_echo"]);
  });

  it("keeps numeric node fragments provider-safe", () => {
    replaceNodePluginTools({
      nodeId: "123",
      tools: [
        {
          pluginId: "remote-demo",
          name: "remote_echo",
          description: "Echo through a remote node",
          command: "remote.echo",
        },
      ],
    });

    expect(
      createNodePluginTools({ existingToolNames: new Set(["remote_echo"]) }).map(
        (tool) => tool.name,
      ),
    ).toEqual(["node_123_remote_echo"]);
  });

  it("keeps numeric disambiguation when node fragments collide", () => {
    for (const nodeId of ["node-a", "node_a"]) {
      replaceNodePluginTools({
        nodeId,
        tools: [
          {
            pluginId: "remote-demo",
            name: "remote_echo",
            description: "Echo through a remote node",
            command: "remote.echo",
          },
        ],
      });
    }

    expect(createNodePluginTools({}).map((tool) => tool.name)).toEqual([
      "node_a_remote_echo",
      "node_a_remote_echo_2",
    ]);
  });

  it("keeps disambiguated node tool names provider-safe", () => {
    const longName = `a${"b".repeat(63)}`;
    for (const nodeId of ["node-a", "node-b"]) {
      replaceNodePluginTools({
        nodeId,
        tools: [
          {
            pluginId: "remote-demo",
            name: longName,
            description: "Echo through a remote node",
            command: "remote.echo",
          },
        ],
      });
    }

    const names = createNodePluginTools({}).map((tool) => tool.name);

    expect(names).toHaveLength(2);
    expect(names.every((name) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name))).toBe(true);
    expect(names[0]).not.toBe(names[1]);
  });

  it("honors plugin tool allow and deny policy", () => {
    replaceNodePluginTools({
      nodeId: "node-1",
      tools: [
        {
          pluginId: "remote-demo",
          name: "remote_echo",
          description: "Echo through a remote node",
          command: "remote.echo",
        },
        {
          pluginId: "remote-demo",
          name: "remote_status",
          description: "Read remote status",
          command: "remote.status",
        },
      ],
      registered: true,
    });

    expect(
      createNodePluginTools({
        toolAllowlist: ["remote-demo"],
        toolDenylist: ["remote_status"],
      }).map((tool) => tool.name),
    ).toEqual(["remote_echo"]);
    expect(createNodePluginTools({ toolAllowlist: ["other-plugin"] })).toEqual([]);
  });

  it("trusts plugin-id allowlist entries only for registered tools and node-mcp", () => {
    const githubDescriptor: NodePluginToolDescriptor = {
      pluginId: "github",
      name: "remote_repo_search",
      description: "Search repositories through a remote node",
      command: "remote.search",
    };

    replaceNodePluginTools({
      nodeId: "node-1",
      tools: [githubDescriptor],
    });
    expect(createNodePluginTools({ toolAllowlist: ["github"] })).toEqual([]);

    replaceNodePluginTools({
      nodeId: "node-1",
      tools: [githubDescriptor],
      registered: true,
    });
    expect(createNodePluginTools({ toolAllowlist: ["github"] }).map((tool) => tool.name)).toEqual([
      "remote_repo_search",
    ]);

    replaceNodePluginTools({
      nodeId: "node-1",
      tools: [{ ...githubDescriptor, pluginId: "node-mcp" }],
    });
    expect(createNodePluginTools({ toolAllowlist: ["node-mcp"] }).map((tool) => tool.name)).toEqual(
      ["remote_repo_search"],
    );

    replaceNodePluginTools({
      nodeId: "node-1",
      tools: [githubDescriptor],
    });
    expect(
      createNodePluginTools({ toolAllowlist: ["remote_repo_search"] }).map((tool) => tool.name),
    ).toEqual(["remote_repo_search"]);
    expect(
      createNodePluginTools({
        toolAllowlist: ["remote_repo_search"],
        toolDenylist: ["github"],
      }),
    ).toEqual([]);
  });
});
