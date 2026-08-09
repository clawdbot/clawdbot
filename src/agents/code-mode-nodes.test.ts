/** Tests the first-class Code Mode nodes API through the real generic nodes tool. */

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolSearchCatalogToolExecutor } from "./tool-search.js";
import type { AnyAgentTool } from "./tools/common.js";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(),
  readGatewayCallOptions: vi.fn(() => ({})),
}));

vi.mock("./tools/gateway.js", () => ({
  callGatewayTool: gatewayMocks.callGatewayTool,
  readGatewayCallOptions: gatewayMocks.readGatewayCallOptions,
}));

const nodeSnapshot = [
  {
    nodeId: "node-1",
    displayName: "Desk",
    platform: "darwin",
    paired: true,
    connected: true,
    commands: ["device.status", "fs.listDir", "computer.act", "danger.read"],
  },
  {
    nodeId: "shadow-id",
    displayName: "Offline",
    platform: "linux",
    paired: false,
    connected: false,
    commands: ["device.status"],
  },
  {
    nodeId: "node-2",
    displayName: "shadow-id",
    paired: true,
    connected: false,
    commands: ["device.status"],
  },
];

let applyCodeModeCatalog: typeof import("./code-mode.js").applyCodeModeCatalog;
let createCodeModeTools: typeof import("./code-mode.js").createCodeModeTools;
let createToolSearchCatalogRef: typeof import("./tool-search.js").createToolSearchCatalogRef;
let createNodesTool: typeof import("./tools/nodes-tool.js").createNodesTool;
let testing: typeof import("./code-mode.test-support.js").testing;

function resultDetails(result: { details?: unknown }): Record<string, unknown> {
  expect(result.details).toBeDefined();
  expect(typeof result.details).toBe("object");
  return result.details as Record<string, unknown>;
}

function createHarness() {
  const catalogRef = createToolSearchCatalogRef();
  const config = { tools: { codeMode: true } } as never;
  const nestedCalls: Parameters<ToolSearchCatalogToolExecutor>[0][] = [];
  const executeTool: ToolSearchCatalogToolExecutor = async (params) => {
    nestedCalls.push(params);
    const result = await params.tool.execute(
      params.toolCallId,
      params.input,
      params.signal,
      params.onUpdate,
      undefined as never,
    );
    return await params.acceptResultBeforeProjection(result);
  };
  const ctx = {
    config,
    runtimeConfig: config,
    sessionId: "session-code-mode-nodes",
    sessionKey: "agent:main:main",
    runId: "run-code-mode-nodes",
    catalogRef,
    executeTool,
  };
  const codeModeTools = createCodeModeTools(ctx);
  const nodesTool = createNodesTool({ agentSessionKey: ctx.sessionKey });
  applyCodeModeCatalog({
    tools: [...codeModeTools, nodesTool],
    config,
    sessionId: ctx.sessionId,
    sessionKey: ctx.sessionKey,
    runId: ctx.runId,
    catalogRef,
  });
  return {
    execTool: expectDefined(codeModeTools[0], "code mode exec tool"),
    waitTool: expectDefined(codeModeTools[1], "code mode wait tool"),
    nestedCalls,
  };
}

async function runUntilCompleted(params: {
  execTool: AnyAgentTool;
  waitTool: AnyAgentTool;
  code: string;
}): Promise<Record<string, unknown>> {
  let details = resultDetails(
    await params.execTool.execute("code-nodes-call", { code: params.code }),
  );
  for (let index = 0; index < 8 && details.status === "waiting"; index += 1) {
    details = resultDetails(
      await params.waitTool.execute(`code-nodes-wait-${index}`, { runId: details.runId }),
    );
  }
  return details;
}

describe("Code Mode nodes", () => {
  beforeAll(async () => {
    vi.resetModules();
    ({ applyCodeModeCatalog, createCodeModeTools } = await import("./code-mode.js"));
    ({ createToolSearchCatalogRef } = await import("./tool-search.js"));
    ({ createNodesTool } = await import("./tools/nodes-tool.js"));
    ({ testing } = await import("./code-mode.test-support.js"));
  });

  beforeEach(() => {
    gatewayMocks.callGatewayTool.mockReset();
    gatewayMocks.readGatewayCallOptions.mockReset();
    gatewayMocks.readGatewayCallOptions.mockReturnValue({});
    gatewayMocks.callGatewayTool.mockImplementation(async (method, _options, input) => {
      if (method === "node.list") {
        return { nodes: nodeSnapshot };
      }
      if (method === "node.invoke") {
        const invocation = input as {
          nodeId: string;
          command: string;
          params: unknown;
        };
        if (invocation.command === "danger.read") {
          throw new Error(
            'node command not allowed: "danger.read" is blocked by gateway.nodes.commands.deny',
          );
        }
        return {
          payload: {
            nodeId: invocation.nodeId,
            command: invocation.command,
            params: invocation.params,
          },
        };
      }
      throw new Error(`unexpected gateway method: ${String(method)}`);
    });
  });

  afterEach(() => {
    testing.activeRuns.clear();
    testing.resumingRunIds.clear();
  });

  it("lists nodes and returns a callable handle with conditional directory sugar", async () => {
    const harness = createHarness();
    const details = await runUntilCompleted({
      ...harness,
      code: `
        const listed = await nodes.list();
        const node = await nodes.get("Desk");
        const invoked = await node.invoke("device.status", { detail: true });
        const directory = await node.listDir("/tmp");
        return {
          listed,
          id: node.id,
          name: node.name,
          methods: Object.keys(node).sort(),
          invoked,
          directory,
          hasExec: "exec" in node,
        };
      `,
    });

    expect(details.status).toBe("completed");
    expect(details.value).toEqual({
      listed: [
        {
          id: "node-1",
          name: "Desk",
          platform: "darwin",
          connected: true,
          commands: ["device.status", "fs.listDir", "computer.act", "danger.read"],
        },
        {
          id: "node-2",
          name: "shadow-id",
          connected: false,
          commands: ["device.status"],
        },
      ],
      id: "node-1",
      name: "Desk",
      methods: ["id", "invoke", "listDir", "name"],
      invoked: {
        payload: { nodeId: "node-1", command: "device.status", params: { detail: true } },
      },
      directory: {
        payload: { nodeId: "node-1", command: "fs.listDir", params: { path: "/tmp" } },
      },
      hasExec: false,
    });
    expect(harness.nestedCalls).not.toHaveLength(0);
    expect(harness.nestedCalls.every((call) => call.parentToolCallId === "code-nodes-call")).toBe(
      true,
    );
  });

  it("omits listDir when the node does not advertise fs.listDir", async () => {
    const harness = createHarness();
    const details = await runUntilCompleted({
      ...harness,
      code: `const node = await nodes.get("node-2"); return Object.keys(node).sort();`,
    });

    expect(details.value).toEqual(["id", "invoke", "name"]);
  });

  it("surfaces the generic nodes policy refusal with the command name", async () => {
    const harness = createHarness();
    const details = await runUntilCompleted({
      ...harness,
      code: `
        const node = await nodes.get("Desk");
        try {
          await node.invoke("danger.read");
          return "unexpected success";
        } catch (error) {
          return error.message;
        }
      `,
    });

    expect(details.value).toContain('node command not allowed: "danger.read"');
    expect(details.value).toContain("blocked by gateway.nodes.commands.deny");
  });

  it("keeps computer.act blocked by the generic nodes surface", async () => {
    const harness = createHarness();
    const details = await runUntilCompleted({
      ...harness,
      code: `
        const node = await nodes.get("Desk");
        try {
          await node.invoke("computer.act", { action: "left_click", x: 1, y: 1 });
          return "unexpected success";
        } catch (error) {
          return error.message;
        }
      `,
    });

    expect(details.value).toContain('invokeCommand "computer.act"');
    expect(details.value).toContain("use the dedicated computer tool");
    expect(
      gatewayMocks.callGatewayTool.mock.calls.some(
        ([method, , input]) =>
          method === "node.invoke" &&
          (input as { command?: string } | undefined)?.command === "computer.act",
      ),
    ).toBe(false);
  });

  it("rejects an ineligible exact id before matching an eligible node name", async () => {
    const harness = createHarness();
    const details = await runUntilCompleted({
      ...harness,
      code: `
        try {
          await nodes.get("shadow-id");
          return "unexpected success";
        } catch (error) {
          return error.message;
        }
      `,
    });

    expect(details.value).toBe('node "shadow-id" is not paired (paired node ids: node-1, node-2)');
  });
});
