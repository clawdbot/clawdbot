import type * as AgentSchema from "./schema/agent.js";
import type * as BoardSchema from "./schema/board.js";
import type { CommandsListParams } from "./schema/commands.js";
import type { LogsTailParams } from "./schema/logs-chat.js";
import type { PortalCloseParams, PortalListParams, PortalOpenParams } from "./schema/portals.js";
import type { UiCommandParams } from "./schema/ui-command.js";

/** Schema-derived payload ownership for statically validated core Gateway methods. */
export type GatewayCoreRequestParams = {
  "board.action": BoardSchema.BoardActionParams;
  "board.data.read": BoardSchema.BoardDataReadParams;
  "board.event": BoardSchema.BoardEventParams;
  "board.get": BoardSchema.BoardGetParams;
  "board.prompt.authorize": BoardSchema.BoardPromptAuthorizeParams;
  "board.update": BoardSchema.BoardUpdateParams;
  "board.widget.appView": BoardSchema.BoardWidgetAppViewParams;
  "board.widget.grant": BoardSchema.BoardWidgetGrantParams;
  "board.widget.put": BoardSchema.BoardWidgetPutParams;
  "commands.list": CommandsListParams;
  "conversations.list": AgentSchema.ConversationListParams;
  "conversations.send": AgentSchema.ConversationSendParams;
  "conversations.turn": AgentSchema.ConversationTurnParams;
  "conversations.turn.cancel": AgentSchema.ConversationTurnCancelParams;
  "logs.tail": LogsTailParams;
  "portal.close": PortalCloseParams;
  "portal.list": PortalListParams;
  "portal.open": PortalOpenParams;
  "ui.command": UiCommandParams;
};
