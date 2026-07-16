import { Type } from "typebox";
import { GATEWAY_CLIENT_CAPS } from "../../../packages/gateway-protocol/src/client-info.js";
import type { UiCommand, UiCommandParams } from "../../../packages/gateway-protocol/src/index.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam, ToolInputError } from "./common.js";
import { callInProcessGatewayTool, type InProcessGatewayCaller } from "./in-process-gateway.js";

const ACTIONS = [
  "split_right",
  "split_down",
  "close_pane",
  "focus",
  "sidebar_show",
  "sidebar_hide",
  "terminal_show",
  "terminal_hide",
  "browser_show",
  "browser_hide",
  "navigate",
] as const;

const ScreenToolSchema = Type.Object(
  {
    action: Type.String({ enum: [...ACTIONS], description: "Action" }),
    sessionKey: Type.Optional(Type.String({ description: "Session. Default: current" })),
    dock: Type.Optional(
      Type.String({ enum: ["bottom", "right"], description: "Panel dock on show" }),
    ),
  },
  { additionalProperties: false },
);

type ScreenToolOptions = {
  agentSessionKey?: string;
  callGateway?: InProcessGatewayCaller;
};

function resolveSessionKey(
  params: Record<string, unknown>,
  agentSessionKey: string | undefined,
): string {
  const sessionKey = readStringParam(params, "sessionKey") ?? agentSessionKey?.trim();
  if (!sessionKey) {
    throw new ToolInputError("sessionKey required");
  }
  return sessionKey;
}

function readDock(params: Record<string, unknown>): "bottom" | "right" | undefined {
  const dock = readStringParam(params, "dock");
  if (dock === undefined || dock === "bottom" || dock === "right") {
    return dock;
  }
  throw new ToolInputError("dock must be bottom or right");
}

function commandForAction(
  action: string,
  params: Record<string, unknown>,
  agentSessionKey: string | undefined,
): UiCommand {
  if (action === "split_right" || action === "split_down") {
    return {
      kind: "split",
      direction: action === "split_right" ? "right" : "down",
      sessionKey: resolveSessionKey(params, agentSessionKey),
    };
  }
  if (action === "close_pane" || action === "focus" || action === "navigate") {
    return {
      kind: action === "close_pane" ? "close-pane" : action,
      sessionKey: resolveSessionKey(params, agentSessionKey),
    };
  }
  if (action === "sidebar_show" || action === "sidebar_hide") {
    return { kind: "sidebar", visible: action === "sidebar_show" };
  }
  if (
    action === "terminal_show" ||
    action === "terminal_hide" ||
    action === "browser_show" ||
    action === "browser_hide"
  ) {
    const open = action.endsWith("_show");
    const dock = open ? readDock(params) : undefined;
    return {
      kind: "panel",
      panel: action.startsWith("terminal_") ? "terminal" : "browser",
      open,
      ...(dock ? { dock } : {}),
    };
  }
  throw new ToolInputError(`Unknown action: ${action}`);
}

export function createScreenTool(opts: ScreenToolOptions = {}): AnyAgentTool {
  const gatewayCall = opts.callGateway ?? callInProcessGatewayTool;
  return {
    label: "Screen",
    name: "screen",
    description:
      "Drive operator web UI. Split panes, focus, panels, sidebar, navigate. Needs connected web client.",
    parameters: ScreenToolSchema,
    requiredClientCaps: [GATEWAY_CLIENT_CAPS.UI_COMMANDS],
    execute: async (_toolCallId, rawArgs) => {
      const params = rawArgs as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const payload: UiCommandParams = {
        command: commandForAction(action, params, opts.agentSessionKey),
        ...(opts.agentSessionKey ? { sessionKey: opts.agentSessionKey } : {}),
      };
      return jsonResult(await gatewayCall("ui.command", payload));
    },
  };
}
