import { Type } from "typebox";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
import type {
  BoardCommand,
  BoardOp,
  BoardSnapshot,
} from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayContextResolver } from "../../gateway/server-methods/types.js";
import type { AnyAgentTool } from "./common.js";
import {
  readNumberParam,
  readStringArrayParam,
  readToolStringParam,
  textResult,
  ToolInputError,
} from "./common.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
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
  "widget_put",
  "widget_move",
  "widget_resize",
  "widget_remove",
  "focus_tab",
  "set_presentation",
] as const;
const BOARD_TAB_ID_PATTERN = "^[a-z0-9-]{1,40}$";
const BOARD_TAB_ID_REGEX = /^[a-z0-9-]{1,40}$/;
const BOARD_WIDGET_NAME_PATTERN = "^[a-z0-9][a-z0-9._-]{0,63}$";
const BOARD_PLUGIN_KIND_PATTERN = "^[a-z0-9][a-z0-9-]{0,63}:[a-z0-9][a-z0-9._-]{0,63}$";
const BOARD_PLUGIN_KIND_REGEX = /^[a-z0-9][a-z0-9-]{0,63}:[a-z0-9][a-z0-9._-]{0,63}$/;

const DashboardToolSchema = Type.Object(
  {
    action: Type.String({
      enum: [...DASHBOARD_ACTIONS],
      description: "Dashboard action; widget_put creates or updates trusted plugin widgets only",
    }),
    tabId: Type.Optional(
      Type.String({ pattern: BOARD_TAB_ID_PATTERN, description: "Stable tab slug" }),
    ),
    title: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "Tab title" })),
    presentation: Type.Optional(
      Type.String({ enum: ["split", "expanded"], description: "Dashboard panel presentation" }),
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
    size: Type.Optional(Type.String({ enum: ["sm", "md", "lg", "xl", "full"] })),
    pluginKind: Type.Optional(
      Type.String({
        pattern: BOARD_PLUGIN_KIND_PATTERN,
        description:
          "Plugin widget kind, for example session:progress, workboard:card, workboard:mini, or workboard:board",
      }),
    ),
    props: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: "Plugin-owned JSON props (maximum 8KB encoded)",
      }),
    ),
  },
  { additionalProperties: false },
);

type DashboardCommandEmitter = (
  params: {
    sessionKey: string;
    agentId?: string;
    command: BoardCommand;
  },
  resolveGatewayContext?: GatewayContextResolver,
) => number;

type DashboardGatewayContext = {
  getClientConnIds?: (
    predicate: (client: { connect: { client: { id: string } } }) => boolean,
  ) => Set<string>;
  broadcastToConnIds: (event: "board.command", payload: unknown, connIds: Set<string>) => void;
};

type DashboardToolOptions = {
  agentSessionKey?: string;
  agentId?: string;
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

function requireInteger(params: Record<string, unknown>, key: string): number {
  const value = readNumberParam(params, key, { required: true, integer: true, strict: true });
  if (value === undefined) {
    throw new ToolInputError(`${key} required`);
  }
  return value;
}

function readTabId(params: Record<string, unknown>): string {
  const tabId = readToolStringParam(params, "tabId", { required: true });
  if (!BOARD_TAB_ID_REGEX.test(tabId)) {
    throw new ToolInputError("tabId must be a lowercase slug up to 40 characters");
  }
  return tabId;
}

function readOptionalTabId(params: Record<string, unknown>): string | undefined {
  const tabId = readToolStringParam(params, "tabId");
  if (tabId !== undefined && !BOARD_TAB_ID_REGEX.test(tabId)) {
    throw new ToolInputError("tabId must be a lowercase slug up to 40 characters");
  }
  return tabId;
}

function readPluginProps(params: Record<string, unknown>): Record<string, unknown> | undefined {
  const props = params.props;
  if (props === undefined) {
    return undefined;
  }
  if (!props || typeof props !== "object" || Array.isArray(props)) {
    throw new ToolInputError("props must be an object");
  }
  return props as Record<string, unknown>;
}

function opForAction(action: string, params: Record<string, unknown>): BoardOp {
  const name = () => readToolStringParam(params, "name", { required: true });
  switch (action) {
    case "tab_create":
      return {
        kind: "tab_create",
        tabId: readTabId(params),
        title: readToolStringParam(params, "title", { required: true }),
      };
    case "tab_update": {
      const title = readToolStringParam(params, "title");
      const position = readNumberParam(params, "position", { integer: true, strict: true });
      if (title === undefined && position === undefined) {
        throw new ToolInputError("tab_update requires title or position");
      }
      return {
        kind: "tab_update",
        tabId: readTabId(params),
        ...(title !== undefined ? { title } : {}),
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
      const targetTabId = readToolStringParam(params, "tabId");
      const position = readNumberParam(params, "position", { integer: true, strict: true });
      const after = readToolStringParam(params, "after");
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

function emitBoardCommand(
  params: {
    sessionKey: string;
    agentId?: string;
    command: BoardCommand;
  },
  resolveGatewayContext?: GatewayContextResolver,
): number {
  const context = getInProcessGatewayToolContext(resolveGatewayContext) as
    | DashboardGatewayContext
    | undefined;
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

const WIDGET_CONTENT_UPDATE_PATHS = {
  html: "Use its HTML authoring capability; discover it in the tool catalog and update the same name.",
  plugin: "Use widget_put with the same name and pluginKind.",
  registered:
    "Use its registered-source authoring capability; discover it in the tool catalog and update the same source kind and name.",
  "mcp-app": "Update through the originating MCP app.",
} as const;

function snapshotResult(snapshot: BoardSnapshot) {
  const contentUpdatePaths: Record<string, string> = {};
  for (const widget of snapshot.widgets) {
    if (!widget.contentOwner) {
      throw new ToolInputError(`dashboard widget ${widget.name} is missing content ownership`);
    }
    contentUpdatePaths[widget.contentOwner] = WIDGET_CONTENT_UPDATE_PATHS[widget.contentOwner];
  }
  const details = {
    ...snapshot,
    tabs: snapshot.tabs.map(({ tabId, title, position }) => ({ tabId, title, position })),
    ...(snapshot.widgets.length > 0 ? { contentUpdatePaths } : {}),
  };
  return textResult(
    `Dashboard revision ${snapshot.revision}: ${snapshot.tabs.length} tabs, ${snapshot.widgets.length} widgets\n${JSON.stringify(details)}`,
    details,
  );
}

function commandResult(delivered: number) {
  return delivered === 0
    ? textResult("Dashboard unavailable. Connect Control UI and retry.", {
        status: "unavailable",
        code: "UNAVAILABLE",
        message: "Connect Control UI and retry.",
      })
    : textResult(`Dashboard command sent to ${delivered} client(s)`, { ok: true, delivered });
}

export function createDashboardTool(opts: DashboardToolOptions = {}): AnyAgentTool {
  const gatewayCall = opts.callGateway ?? callInProcessGatewayTool;
  const emitCommand = opts.emitCommand ?? emitBoardCommand;
  return {
    label: "Dashboard",
    name: "dashboard",
    description:
      "Keep one ad hoc visualization inline; use only for an explicit dashboard request or multiple non-code visualizations. Read layout; widget_put updates plugin widgets only. Read and arrange this session dashboard: read snapshot; tab_create/tab_update/tab_delete/tabs_reorder; widget_put/widget_move/widget_resize/widget_remove; focus_tab opens the dashboard side panel; set_presentation shows the dashboard alongside chat (split) or across the task area (expanded). focus_tab and set_presentation require a connected Control UI. Widgets use stable names. widget_put creates or updates trusted plugin widgets only; update other content through its owning authoring capability discovered in the tool catalog. Plugin examples: session:progress props {sessionKey?} renders the session's live progress card (omit sessionKey for the current session), workboard:card props {cardId}, workboard:mini props {boardId, limit}, workboard:board props {boardId}. Sizes: sm=3x3, md=6x4, lg=8x6, xl=12x8, full=12x8 single-widget emphasis.",
    parameters: DashboardToolSchema,
    execute: async (_toolCallId, rawArgs) => {
      const params = rawArgs as Record<string, unknown>;
      const action = readToolStringParam(params, "action", { required: true });
      const sessionKey = requireSessionKey(opts.agentSessionKey);
      const admittedResolver = getGatewayToolCallerIdentity()?.gatewayContextResolver;
      const gatewayOptions = admittedResolver
        ? { resolveGatewayContext: admittedResolver }
        : undefined;
      const callGateway = <T>(method: string, gatewayParams: Record<string, unknown>) =>
        gatewayCall<T>(method, gatewayParams, gatewayOptions);
      if (action === "read") {
        return snapshotResult(
          await callGateway<BoardSnapshot>("board.get", {
            sessionKey,
            agentId: opts.agentId,
          }),
        );
      }
      if (action === "focus_tab") {
        const delivered = emitCommand(
          {
            sessionKey,
            agentId: opts.agentId,
            command: {
              kind: "focus_tab",
              tabId: readTabId(params),
            },
          },
          admittedResolver,
        );
        return commandResult(delivered);
      }
      if (action === "set_presentation") {
        const presentation = readToolStringParam(params, "presentation", { required: true });
        if (presentation !== "split" && presentation !== "expanded") {
          throw new ToolInputError("presentation must be split or expanded");
        }
        const delivered = emitCommand(
          {
            sessionKey,
            agentId: opts.agentId,
            // Keep the shipped BoardCommand wire format; the panel owns its dock position.
            command: {
              kind: "set_chat_dock",
              dock: presentation === "expanded" ? "hidden" : "right",
            },
          },
          admittedResolver,
        );
        return commandResult(delivered);
      }
      if (action === "widget_put") {
        const pluginKind = readToolStringParam(params, "pluginKind", { required: true });
        if (!BOARD_PLUGIN_KIND_REGEX.test(pluginKind)) {
          throw new ToolInputError("pluginKind must use the <pluginId>:<name> format");
        }
        const title = readToolStringParam(params, "title");
        const tabId = readOptionalTabId(params);
        const size = readToolStringParam(params, "size");
        const after = readToolStringParam(params, "after");
        const props = readPluginProps(params);
        return snapshotResult(
          await callGateway<BoardSnapshot>("board.widget.put", {
            sessionKey,
            agentId: opts.agentId,
            name: readToolStringParam(params, "name", { required: true }),
            ...(title !== undefined ? { title } : {}),
            content: {
              kind: "plugin",
              pluginKind,
              ...(props !== undefined ? { props } : {}),
            },
            ...(tabId || size || after
              ? {
                  placement: {
                    ...(tabId ? { tabId } : {}),
                    ...(size ? { size } : {}),
                    ...(after ? { after } : {}),
                  },
                }
              : {}),
          }),
        );
      }
      return snapshotResult(
        await callGateway<BoardSnapshot>("board.update", {
          sessionKey,
          agentId: opts.agentId,
          ops: [opForAction(action, params)],
        }),
      );
    },
  };
}
