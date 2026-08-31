import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { BoardCommand, BoardSnapshot } from "../../../packages/gateway-protocol/src/index.js";
import {
  createGatewayMethodDescriptorsFromHandlers,
  createGatewayMethodRegistry,
} from "../../gateway/methods/registry.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "../../gateway/server-methods/types.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createDashboardTool } from "./dashboard-tool.js";
import { withGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import type { InProcessGatewayCaller } from "./in-process-gateway.js";

const snapshot: BoardSnapshot = {
  sessionKey: "agent:main:main",
  revision: 3,
  tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
  widgets: [],
};

function recorder(boardSnapshot: BoardSnapshot = snapshot) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const commands: Array<{ sessionKey: string; command: BoardCommand }> = [];
  const callGateway: InProcessGatewayCaller = async <T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> => {
    calls.push([method, params]);
    return boardSnapshot as T;
  };
  return {
    calls,
    commands,
    callGateway,
    emitCommand: (command: { sessionKey: string; command: BoardCommand }) => {
      commands.push(command);
      return 2;
    },
  };
}

function createGatewayAffinityHarness(revision: number) {
  const requests: GatewayRequestHandlerOptions["req"][] = [];
  const broadcastToConnIds = vi.fn();
  const handlers: GatewayRequestHandlers = {
    "board.get": ({ req, respond }) => {
      requests.push(req);
      respond(true, { ...snapshot, revision });
    },
  };
  const methodRegistry = createGatewayMethodRegistry(
    createGatewayMethodDescriptorsFromHandlers({
      handlers,
      owner: { kind: "core", area: "dashboard-affinity-test" },
      defaultScope: "operator.read",
    }),
  );
  const context = {
    broadcastToConnIds,
    getClientConnIds: () => new Set([`control-ui-${revision}`]),
    getGatewayMethodRegistry: () => methodRegistry,
    getRuntimeConfig: () => ({}),
    resolveGatewayContext: () => context,
  } as unknown as GatewayRequestContext;
  return { broadcastToConnIds, context, requests };
}

describe("dashboard tool", () => {
  it("declares every action, no client capability guard, sizing, and the dashboard threshold", () => {
    const tool = createDashboardTool();
    const directoryDescription = tool.description.slice(0, 177);
    expect(tool.requiredClientCaps).toBeUndefined();
    expect(tool.description).toContain("stable names");
    expect(tool.description).toContain("sm=3x3");
    expect(directoryDescription).toMatch(
      /(?:single|one[- ]off|ad hoc).{0,40}visualizations?.{0,40}inline/i,
    );
    expect(directoryDescription).toContain("explicit dashboard request");
    expect(directoryDescription).toContain("multiple non-code visualizations");
    expect(directoryDescription).toMatch(/widget_put.*plugin.*only/i);
    expect(tool.description).not.toMatch(/show_widget|widget_code|\bpin\b/);
    expect(tool.parameters).toMatchObject({
      additionalProperties: false,
      properties: {
        action: {
          enum: [
            "read",
            "tab_create",
            "tab_update",
            "tab_delete",
            "tabs_reorder",
            "widget_put",
            "widget_move",
            "widget_resize",
            "widget_remove",
            "focus_tab",
            "set_chat_dock",
          ],
        },
      },
    });
    expect(Value.Check(tool.parameters, { action: "widget_move", name: "status" })).toBe(true);
    expect(
      Value.Check(tool.parameters, {
        action: "widget_put",
        name: "work-item",
        pluginKind: "workboard:card",
        props: { cardId: "card-123" },
      }),
    ).toBe(true);
    expect(Value.Check(tool.parameters, { action: "unknown" })).toBe(false);
  });

  it("reads a compact text plus JSON snapshot", async () => {
    const harness = recorder();
    const tool = createDashboardTool({
      agentSessionKey: "agent:main:main",
      callGateway: harness.callGateway,
    });
    const result = await tool.execute("read", { action: "read" });
    expect(harness.calls).toEqual([["board.get", { sessionKey: "agent:main:main" }]]);
    expect(result.details).toEqual(snapshot);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining('"revision":3'),
    });
  });

  it("dispatches through the admitted Gateway and fences replacement or retirement", async () => {
    const admitted = createGatewayAffinityHarness(11);
    const replacement = createGatewayAffinityHarness(22);
    let current: GatewayRequestContext | undefined = admitted.context;
    const tool = createDashboardTool({ agentSessionKey: "agent:main:main" });

    await withPluginRuntimeGatewayRequestScope(
      {
        context: replacement.context,
        isWebchatConnect: () => false,
      },
      async () =>
        await withGatewayToolCallerIdentity(
          {
            agentId: "main",
            sessionKey: "agent:main:main",
            gatewayContextResolver: () => current,
          },
          async () => {
            const read = await tool.execute("read", { action: "read" });
            const command = await tool.execute("focus", {
              action: "focus_tab",
              tabId: "main",
            });
            expect(read.details).toMatchObject({ revision: 11 });
            expect(command.details).toEqual({ ok: true, delivered: 1 });

            current = replacement.context;
            await expect(tool.execute("late-read", { action: "read" })).rejects.toThrow(
              /dashboard|Gateway|gateway|unavailable/u,
            );
            current = undefined;
            await expect(
              tool.execute("late-focus", { action: "focus_tab", tabId: "main" }),
            ).rejects.toThrow(/dashboard|Gateway|gateway|unavailable/u);
          },
        ),
    );

    expect(admitted.requests).toEqual([
      expect.objectContaining({
        type: "req",
        id: expect.stringMatching(/^plugin-subagent-/u),
        method: "board.get",
        params: expect.objectContaining({ sessionKey: "agent:main:main" }),
      }),
    ]);
    expect(replacement.requests).toEqual([]);
    expect(admitted.broadcastToConnIds).toHaveBeenCalledOnce();
    expect(replacement.broadcastToConnIds).not.toHaveBeenCalled();
  });

  it("returns content ownership and valid update paths in model-visible snapshot details", async () => {
    const widget = (
      name: string,
      contentKind: BoardSnapshot["widgets"][number]["contentKind"],
      contentOwner: "html" | "mcp-app" | "plugin" | "registered",
      instanceId?: string,
    ): BoardSnapshot["widgets"][number] => ({
      name,
      tabId: "main",
      contentKind,
      contentOwner,
      ...(contentOwner === "registered" ? { registeredContentKind: "diagram" } : {}),
      ...(contentKind === "plugin" ? { pluginKind: `${name}:card` } : {}),
      ...(instanceId ? { instanceId } : {}),
      sizeW: 6,
      sizeH: 4,
      position: 0,
      grantState: "none",
      revision: 1,
    });
    const boardSnapshot: BoardSnapshot = {
      ...snapshot,
      widgets: [
        widget("custom-html", "html", "html", "html-instance"),
        widget("trusted-plugin", "plugin", "plugin", "incidental-instance"),
        widget("registered-source", "plugin", "registered"),
        widget("mcp-app", "mcp-app", "mcp-app", "mcp-instance"),
      ],
    };
    const harness = recorder(boardSnapshot);
    const tool = createDashboardTool({
      agentSessionKey: "agent:main:main",
      callGateway: harness.callGateway,
    });

    const result = await tool.execute("read", { action: "read" });

    expect(result.details).toMatchObject({
      widgets: [
        { name: "custom-html", contentOwner: "html" },
        { name: "trusted-plugin", contentOwner: "plugin" },
        {
          name: "registered-source",
          contentOwner: "registered",
          registeredContentKind: "diagram",
        },
        { name: "mcp-app", contentOwner: "mcp-app" },
      ],
      contentUpdatePaths: {
        html: expect.stringMatching(/authoring.*tool catalog.*same name/i),
        plugin: expect.stringMatching(/widget_put.*same name.*pluginKind/i),
        registered: expect.stringMatching(/authoring.*tool catalog.*same source kind/i),
        "mcp-app": expect.stringMatching(/MCP app/i),
      },
    });
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining('"contentOwner":"registered"'),
    });
    expect(JSON.stringify(result.details)).not.toMatch(/show_widget|widget_code|\bpin\b/);
  });

  it("rejects protocol-invalid focus tab ids before broadcasting", async () => {
    const harness = recorder();
    const tool = createDashboardTool({
      agentSessionKey: "agent:main:main",
      emitCommand: harness.emitCommand,
    });
    await expect(
      tool.execute("focus", { action: "focus_tab", tabId: "Invalid Tab" }),
    ).rejects.toThrow("lowercase slug");
    expect(harness.commands).toEqual([]);
  });

  it.each([
    [
      "tab_create",
      { tabId: "notes", title: "Notes", chatDock: "bottom" },
      { kind: "tab_create", tabId: "notes", title: "Notes", chatDock: "bottom" },
    ],
    [
      "tab_update",
      { tabId: "notes", title: "New", position: 0 },
      { kind: "tab_update", tabId: "notes", title: "New", position: 0 },
    ],
    ["tab_delete", { tabId: "notes" }, { kind: "tab_delete", tabId: "notes" }],
    ["tabs_reorder", { tabIds: ["two", "one"] }, { kind: "tabs_reorder", tabIds: ["two", "one"] }],
    [
      "widget_move",
      { name: "status", tabId: "notes", after: "clock" },
      { kind: "widget_move", name: "status", tabId: "notes", after: "clock" },
    ],
    [
      "widget_resize",
      { name: "status", sizeW: 8, sizeH: 6 },
      { kind: "widget_resize", name: "status", sizeW: 8, sizeH: 6 },
    ],
    ["widget_remove", { name: "status" }, { kind: "widget_remove", name: "status" }],
  ])("maps %s to one board.update op", async (action, args, op) => {
    const harness = recorder();
    const tool = createDashboardTool({
      agentSessionKey: "agent:main:main",
      callGateway: harness.callGateway,
    });
    await tool.execute("mutate", { action, ...args });
    expect(harness.calls).toEqual([["board.update", { sessionKey: "agent:main:main", ops: [op] }]]);
  });

  it("creates a plugin widget through board.widget.put", async () => {
    const harness = recorder();
    const tool = createDashboardTool({
      agentSessionKey: "agent:main:main",
      callGateway: harness.callGateway,
    });
    await tool.execute("put", {
      action: "widget_put",
      name: "work-item",
      title: "Work item",
      pluginKind: "workboard:card",
      props: { cardId: "card-123" },
      tabId: "main",
      size: "sm",
    });
    expect(harness.calls).toEqual([
      [
        "board.widget.put",
        {
          sessionKey: "agent:main:main",
          name: "work-item",
          title: "Work item",
          content: {
            kind: "plugin",
            pluginKind: "workboard:card",
            props: { cardId: "card-123" },
          },
          placement: { tabId: "main", size: "sm" },
        },
      ],
    ]);
  });

  it.each([
    ["focus_tab", { tabId: "notes" }, { kind: "focus_tab", tabId: "notes" }],
    ["set_chat_dock", { dock: "left" }, { kind: "set_chat_dock", dock: "left" }],
  ])("emits board.command for %s", async (action, args, command) => {
    const harness = recorder();
    const tool = createDashboardTool({
      agentSessionKey: "agent:main:main",
      callGateway: harness.callGateway,
      emitCommand: harness.emitCommand,
    });
    const result = await tool.execute("command", { action, ...args });
    expect(harness.calls).toEqual([]);
    expect(harness.commands).toEqual([{ sessionKey: "agent:main:main", command }]);
    expect(result.details).toEqual({ ok: true, delivered: 2 });
  });

  it.each([
    ["focus_tab", { tabId: "notes" }],
    ["set_chat_dock", { dock: "left" }],
  ])("reports %s as unavailable when no Control UI is connected", async (action, args) => {
    const broadcastToConnIds = vi.fn();
    const context = {
      broadcastToConnIds,
      getClientConnIds: () => new Set(),
    } as never;
    await withPluginRuntimeGatewayRequestScope(
      { context, isWebchatConnect: () => false },
      async () => {
        const tool = createDashboardTool({ agentSessionKey: "agent:main:main" });
        const result = await tool.execute("command", { action, ...args });
        expect(result.details).toEqual({
          status: "unavailable",
          code: "UNAVAILABLE",
          message: "Connect Control UI and retry.",
        });
        expect(result.content[0]).toMatchObject({
          text: expect.stringMatching(/Control UI.*retry/i),
        });
        expect(broadcastToConnIds).toHaveBeenCalledWith(
          "board.command",
          expect.any(Object),
          new Set(),
        );
      },
    );
  });
});
