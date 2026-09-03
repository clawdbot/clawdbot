import type { Static } from "typebox";
import type * as AgentSchema from "./schema/agent.js";
import type * as BoardSchema from "./schema/board.js";
import type { CommandsListParams } from "./schema/commands.js";
import type * as HumanMentionsSchema from "./schema/human-mentions.js";
import type { LogsTailParams } from "./schema/logs-chat.js";
import type { PortalCloseParams, PortalListParams, PortalOpenParams } from "./schema/portals.js";
import type * as GitHubSchema from "./schema/session-github-publication.js";
import type { UiCommandParams } from "./schema/ui-command.js";
import type * as UsersSchema from "./schema/users.js";

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
  "mentions.list": HumanMentionsSchema.MentionsListParams;
  "mentions.dismiss": HumanMentionsSchema.MentionsDismissParams;
  "portal.close": PortalCloseParams;
  "portal.list": PortalListParams;
  "portal.open": PortalOpenParams;
  "sessions.github.publish": GitHubSchema.SessionGitHubPublishParams;
  "sessions.github.options": Static<typeof GitHubSchema.SessionGitHubOptionsParamsSchema>;
  "sessions.github.status": Static<typeof GitHubSchema.SessionGitHubStatusParamsSchema>;
  "sessions.github.confirm": GitHubSchema.SessionGitHubConfirmParams;
  "users.github.status": Static<typeof UsersSchema.UsersGitHubStatusParamsSchema>;
  "users.github.authorize.start": Static<typeof UsersSchema.UsersGitHubAuthorizeStartParamsSchema>;
  "users.github.authorize.poll": Static<typeof UsersSchema.UsersGitHubAuthorizePollParamsSchema>;
  "users.github.authorize.cancel": Static<
    typeof UsersSchema.UsersGitHubAuthorizeCancelParamsSchema
  >;
  "users.github.disconnect": Static<typeof UsersSchema.UsersGitHubDisconnectParamsSchema>;
  "users.mentionable": HumanMentionsSchema.UsersMentionableParams;
  "ui.command": UiCommandParams;
};
