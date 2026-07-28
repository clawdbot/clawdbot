import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../../packages/gateway-protocol/src/client-info.js";
import { UiCommandResultSchema } from "../../../packages/gateway-protocol/src/schema/ui-command.js";
import { compactToolOutputHint } from "../tool-schema-hints.js";
import type { InProcessGatewayCaller } from "./in-process-gateway.js";
import { createScreenTool } from "./screen-tool.js";

function createGatewayRecorder() {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const callGateway: InProcessGatewayCaller = async <T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> => {
    calls.push([method, params]);
    return { ok: true } as T;
  };
  return { callGateway, calls };
}

describe("screen tool", () => {
  it("declares the exact ui.command result contract", async () => {
    const { callGateway } = createGatewayRecorder();
    const tool = createScreenTool({ callGateway });
    const result = await tool.execute("contract", { action: "sidebar_show" });

    expect(tool.outputSchema).toBe(UiCommandResultSchema);
    expect(Value.Check(tool.outputSchema!, result.details)).toBe(true);
    expect(compactToolOutputHint(tool.outputSchema)).toBe("{ ok: boolean }");
  });

  it("uses a flat action enum and requires the UI capability", () => {
    const tool = createScreenTool();
    expect(tool.requiredClientCaps).toEqual([GATEWAY_CLIENT_CAPS.UI_COMMANDS]);
    expect(tool.parameters).toMatchObject({
      properties: {
        action: {
          type: "string",
          enum: expect.arrayContaining(["split_right", "terminal_show", "navigate"]),
        },
      },
    });
  });

  it.each([
    ["split_right", { kind: "split", direction: "right", sessionKey: "agent:main:main" }],
    ["split_down", { kind: "split", direction: "down", sessionKey: "agent:main:main" }],
    ["close_pane", { kind: "close-pane", sessionKey: "agent:main:main" }],
    ["focus", { kind: "focus", sessionKey: "agent:main:main" }],
    ["sidebar_show", { kind: "sidebar", visible: true }],
    ["sidebar_hide", { kind: "sidebar", visible: false }],
    ["terminal_hide", { kind: "panel", panel: "terminal", open: false }],
    ["browser_hide", { kind: "panel", panel: "browser", open: false }],
    ["navigate", { kind: "navigate", sessionKey: "agent:main:main" }],
  ])("maps %s to a UI command", async (action, command) => {
    const { callGateway, calls } = createGatewayRecorder();
    const tool = createScreenTool({
      agentSessionKey: "agent:main:main",
      callGateway,
    });

    await tool.execute("call", { action });

    expect(calls).toEqual([["ui.command", { command, sessionKey: "agent:main:main" }]]);
  });

  it.each(["terminal_show", "browser_show"])("passes dock for %s", async (action) => {
    const { callGateway, calls } = createGatewayRecorder();
    const tool = createScreenTool({ callGateway });

    await tool.execute("call", { action, dock: "right" });

    expect(calls).toEqual([
      [
        "ui.command",
        {
          command: {
            kind: "panel",
            panel: action === "terminal_show" ? "terminal" : "browser",
            open: true,
            dock: "right",
          },
        },
      ],
    ]);
  });
});
