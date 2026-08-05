import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import type { BoardCommand, BoardSnapshot } from "../../../packages/gateway-protocol/src/index.js";
import { createDashboardTool } from "./dashboard-tool.js";
import type { InProcessGatewayCaller } from "./in-process-gateway.js";

const snapshot: BoardSnapshot = {
  sessionKey: "agent:main:main",
  revision: 3,
  tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
  widgets: [],
};

function recorder() {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const commands: Array<{ sessionKey: string; command: BoardCommand }> = [];
  const callGateway: InProcessGatewayCaller = async <T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> => {
    calls.push([method, params]);
    return snapshot as T;
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

describe("dashboard tool", () => {
  it("declares every action, no client capability guard, and stable-name/size guidance", () => {
    const tool = createDashboardTool();
    expect(tool.requiredClientCaps).toBeUndefined();
    expect(tool.description).toContain("stable names");
    expect(tool.description).toContain("sm=3x3");
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
});
