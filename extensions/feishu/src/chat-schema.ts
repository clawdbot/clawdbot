// Feishu helper module supports chat schema behavior.
import { optionalPositiveIntegerSchema } from "openclaw/plugin-sdk/channel-actions";
import { Type, type Static } from "typebox";

const CHAT_ACTION_VALUES = ["members", "info", "member_info"] as const;
const MEMBER_ID_TYPE_VALUES = ["open_id", "user_id", "union_id"] as const;

export const FeishuChatSchema = Type.Object({
  action: Type.Enum(CHAT_ACTION_VALUES, {
    type: "string",
    description: "Action to run: members | info | member_info",
  }),
  chat_id: Type.Optional(Type.String({ description: "Chat ID (from URL or event payload)" })),
  member_id: Type.Optional(Type.String({ description: "Member ID for member_info lookups" })),
  page_size: optionalPositiveIntegerSchema({
    maximum: 100,
    description: "Page size (1-100, default 50)",
  }),
  page_token: Type.Optional(Type.String({ description: "Pagination token" })),
  member_id_type: Type.Optional(
    Type.Enum(MEMBER_ID_TYPE_VALUES, {
      type: "string",
      description: "Member ID type (default: open_id)",
    }),
  ),
});

export type FeishuChatParams = Static<typeof FeishuChatSchema>;
