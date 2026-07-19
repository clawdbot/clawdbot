import { Type } from "typebox";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import type {
  BoardCommand,
  BoardOp,
  BoardSnapshot,
} from "../../../packages/gateway-protocol/src/index.js";
import type { AnyAgentTool } from "./common.js";
import {
  readNumberParam,
  readStringArrayParam,
  readStringParam,
  textResult,
  ToolInputError,
} from "./common.js";
import {
  callInProcessGatewayTool,
  getInProcessGatewayToolContext,
  type InProcessGatewayCaller,
} from "./in-process-gateway.js";

const DASHBOARD_ACTIONS = [
  "read",
  "tab_create",
  "tab_update",
  "tab_delete",
  "tabs_reorder",
  "widget_move",
  "widget_resize",
  "widget_remove",
  "focus_tab",
  "set_chat_dock",
] as const;
const BOARD_TAB_ID_PATTERN = "^[a-z0-9-]{1,40}$";
const BOARD_TAB_ID_REGEX = /^[a-z0-9-]{1,40}$/;
const BOARD_WIDGET_NAME_PATTERN = "^[a-z0-9][a-z0-9._-]{0,63}$";

const DashboardToolSchema = Type.Object(
  {
    action: Type.String({ enum: [...DASHBOARD_ACTIONS], description: "Dashboard action" }),
    tabId: Type.Optional(
      Type.String({ pattern: BOARD_TAB_ID_PATTERN, description: "Stable tab slug" }),
    ),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "Tab title" })),
    chatDock: Type.Optional(
      Type.String({ enum: ["left", "right", "bottom", "hidden"], description: "Chat dock" }),
    ),
    dock: Type.Optional(
      Type.String({ enum: ["left", "right", "bottom", "hidden"], description: "Chat dock" }),
    ),
    position: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based position" })),
    tabIds: Type.Optional(
      Type.Array(Type.String({ pattern: BOARD_TAB_ID_PATTERN }), {
        description: "Complete tab order",
      }),
    ),
    name: Type.Optional(
      Type.String({ pattern: BOARD_WIDGET_NAME_PATTERN, description: "Stable widget name" }),
    ),
    after: Type.Optional(
      Type.String({
        pattern: BOARD_WIDGET_NAME_PATTERN,
        description: "Place after stable widget name",
      }),
    ),
    sizeW: Type.Optional(Type.Integer({ minimum: 1, maximum: 12 })),
    sizeH: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
  },
  { additionalProperties: false },
);

type DashboardCommandEmitter = (params: { sessionKey: string; command: BoardCommand }) => number;

type DashboardGatewayContext = {
  getClientConnIds?: (
    predicate: (client: { connect: { client: { id: string } } }) => boolean,
  ) => Set<string>;
  broadcastToConnIds: (event: "board.command", payload: unknown, connIds: Set<string>) => void;
};

type DashboardToolOptions = {
  agentSessionKey?: string;
  callGateway?: InProcessGatewayCaller;
  emitCommand?: DashboardCommandEmitter;
};

function requireSessionKey(value: string | undefined): string {
  const sessionKey = value?.trim();
  if (!sessionKey) {
    throw new ToolInputError("agent session required");
  }
  return sessionKey;
}

function readDock(
  params: Record<string, unknown>,
  key: "chatDock" | "dock",
): "left" | "right" | "bottom" | "hidden" | undefined {
  const value = readStringParam(params, key);
  if (
    value === undefined ||
    value === "left" ||
    value === "right" ||
    value === "bottom" ||
    value === "hidden"
  ) {
    return value;
  }
  throw new ToolInputError(`${key} must be left, right, bottom, or hidden`);
}

function requireInteger(params: Record<string, unknown>, key: string): number {
  const value = readNumberParam(params, key, { required: true, integer: true, strict: true });
  if (value === undefined) {
    throw new ToolInputError(`${key} required`);
  }
  return value;
}

function readTabId(params: Record<string, unknown>): string {
  const tabId = readStringParam(params, "tabId", { required: true });
  if (!BOARD_TAB_ID_REGEX.test(tabId)) {
    throw new ToolInputError("tabId must be a lowercase slug up to 40 characters");
  }
  return tabId;
}

function opForAction(action: string, params: Record<string, unknown>): BoardOp {
  const name = () => readStringParam(params, "name", { required: true });
  switch (action) {
    case "tab_create":
      return {
        kind: "tab_create",
        tabId: readTabId(params),
        title: readStringParam(params, "title", { required: true }),
        ...(readDock(params, "chatDock") ? { chatDock: readDock(params, "chatDock") } : {}),
      };
    case "tab_update": {
      const title = readStringParam(params, "title");
      const chatDock = readDock(params, "chatDock");
      const position = readNumberParam(params, "position", { integer: true, strict: true });
      if (title === undefined && chatDock === undefined && position === undefined) {
        throw new ToolInputError("tab_update requires title, chatDock, or position");
      }
      return {
        kind: "tab_update",
        tabId: readTabId(params),
        ...(title !== undefined ? { title } : {}),
        ...(chatDock !== undefined ? { chatDock } : {}),
        ...(position !== undefined ? { position } : {}),
      };
    }
    case "tab_delete":
      return { kind: "tab_delete", tabId: readTabId(params) };
    case "tabs_reorder":
      return {
        kind: "tabs_reorder",
        tabIds: readStringArrayParam(params, "tabIds", { required: true }),
      };
    case "widget_move": {
      const targetTabId = readStringParam(params, "tabId");
      const position = readNumberParam(params, "position", { integer: true, strict: true });
      const after = readStringParam(params, "after");
      if (position !== undefined && after !== undefined) {
        throw new ToolInputError("widget_move accepts either position or after, not both");
      }
      return {
        kind: "widget_move",
        name: name(),
        ...(targetTabId !== undefined ? { tabId: targetTabId } : {}),
        ...(position !== undefined ? { position } : {}),
        ...(after !== undefined ? { after } : {}),
      };
    }
    case "widget_resize":
      return {
        kind: "widget_resize",
        name: name(),
        sizeW: requireInteger(params, "sizeW"),
        sizeH: requireInteger(params, "sizeH"),
      };
    case "widget_remove":
      return { kind: "widget_remove", name: name() };
    default:
      throw new ToolInputError(`Unknown dashboard action: ${action}`);
  }
}

function emitBoardCommand(params: { sessionKey: string; command: BoardCommand }): number {
  const context = getInProcessGatewayToolContext() as DashboardGatewayContext | undefined;
  if (!context) {
    throw new ToolInputError("dashboard command unavailable outside gateway runtime");
  }
  const connIds =
    context.getClientConnIds?.(
      (client) => client.connect.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI,
    ) ?? new Set<string>();
  context.broadcastToConnIds("board.command", params, connIds);
  return connIds.size;
}

function snapshotResult(snapshot: BoardSnapshot) {
  return textResult(
    `Dashboard revision ${snapshot.revision}: ${snapshot.tabs.length} tabs, ${snapshot.widgets.length} widgets\n${JSON.stringify(snapshot)}`,
    snapshot,
  );
}

export function createDashboardTool(opts: DashboardToolOptions = {}): AnyAgentTool {
  const gatewayCall = opts.callGateway ?? callInProcessGatewayTool;
  const emitCommand = opts.emitCommand ?? emitBoardCommand;
  return {
    label: "Dashboard",
    name: "dashboard",
    description:
      "Read and arrange this session dashboard. Widgets use stable names. Sizes: sm=3x3, md=6x4, lg=8x6, xl=12x8, full=12x8 single-widget emphasis.",
    parameters: DashboardToolSchema,
    execute: async (_toolCallId, rawArgs) => {
      const params = rawArgs as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const sessionKey = requireSessionKey(opts.agentSessionKey);
      if (action === "read") {
        return snapshotResult(await gatewayCall<BoardSnapshot>("board.get", { sessionKey }));
      }
      if (action === "focus_tab") {
        const delivered = emitCommand({
          sessionKey,
          command: {
            kind: "focus_tab",
            tabId: readTabId(params),
          },
        });
        return textResult(`Dashboard command sent to ${delivered} client(s)`, {
          ok: true,
          delivered,
        });
      }
      if (action === "set_chat_dock") {
        const dock = readDock(params, "dock");
        if (!dock) {
          throw new ToolInputError("dock required");
        }
        const delivered = emitCommand({ sessionKey, command: { kind: "set_chat_dock", dock } });
        return textResult(`Dashboard command sent to ${delivered} client(s)`, {
          ok: true,
          delivered,
        });
      }
      return snapshotResult(
        await gatewayCall<BoardSnapshot>("board.update", {
          sessionKey,
          ops: [opForAction(action, params)],
        }),
      );
    },
  };
}
