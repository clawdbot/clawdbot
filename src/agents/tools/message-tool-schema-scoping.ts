import { Type, type TSchema } from "typebox";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import { stringEnum } from "../schema/typebox.js";

type SchemaProperties = Record<string, TSchema>;
type SchemaPropertiesBuilder = () => SchemaProperties;

export const MESSAGE_TOOL_SEND_TEXT_DESCRIPTION =
  'Text for action="send". A send needs message or another send payload such as media, attachments, or presentation.';

export function buildMessageToolQuerySchemaProperties(): SchemaProperties {
  return { query: Type.Optional(Type.String()) };
}

type SchemaGroup =
  | "reaction"
  | "fetch"
  | "query"
  | "poll"
  | "channelTarget"
  | "sticker"
  | "thread"
  | "event"
  | "moderation"
  | "channelManagement"
  | "presence";

type MessageToolSchemaBuilderOptions = {
  includePresentation: boolean;
  includeDeliveryPin: boolean;
  includeBestEffort: boolean;
  scopeToActions?: boolean;
  extraProperties?: SchemaProperties;
};

export type MessageToolSchemaBuilders = {
  full: (options: MessageToolSchemaBuilderOptions) => SchemaProperties;
  base: (options: MessageToolSchemaBuilderOptions) => SchemaProperties;
  groups: Record<SchemaGroup, SchemaPropertiesBuilder>;
};

const SCOPED_ACTION_GROUPS: ReadonlyArray<{
  group: SchemaGroup;
  actions: readonly ChannelMessageActionName[];
}> = [
  {
    group: "reaction",
    actions: [
      "react",
      "reactions",
      "read",
      "edit",
      "delete",
      "unsend",
      "pin",
      "unpin",
      "reply",
      "thread-create",
    ],
  },
  {
    group: "fetch",
    actions: [
      "read",
      "reactions",
      "search",
      "thread-list",
      "channel-list",
      "channel-info",
      "list-pins",
      "event-list",
      "sticker-search",
      "emoji-list",
    ],
  },
  {
    // Include only actions whose handlers read query. Discord event-list historically
    // advertised query through the event schema but ignores it at dispatch.
    group: "query",
    actions: ["search", "sticker-search", "channel-list"],
  },
  { group: "poll", actions: ["poll", "poll-vote"] },
  {
    group: "channelTarget",
    actions: [
      "search",
      "thread-list",
      "thread-create",
      "thread-reply",
      "channel-info",
      "channel-list",
      "channel-create",
      "channel-edit",
      "channel-delete",
      "channel-move",
      "category-create",
      "category-edit",
      "category-delete",
      "topic-create",
      "topic-edit",
      "permissions",
      "member-info",
      "role-info",
      "role-add",
      "role-remove",
      "addParticipant",
      "removeParticipant",
      "renameGroup",
      "setGroupIcon",
      "leaveGroup",
      "event-create",
      "event-list",
      "timeout",
      "kick",
      "ban",
      "emoji-list",
      "emoji-upload",
      "sticker-upload",
      "voice-status",
      "download-file",
    ],
  },
  {
    group: "sticker",
    actions: [
      "sticker",
      "sticker-search",
      "sticker-upload",
      "emoji-list",
      "emoji-upload",
      "download-file",
      "upload-file",
    ],
  },
  { group: "thread", actions: ["thread-create", "thread-list", "thread-reply"] },
  { group: "event", actions: ["event-create", "event-list"] },
  { group: "moderation", actions: ["timeout", "kick", "ban", "delete", "unsend"] },
  {
    // Keep every action that reads channel-management fields here; omission hides valid params.
    group: "channelManagement",
    actions: [
      "channel-create",
      "channel-edit",
      "channel-move",
      "category-create",
      "category-edit",
      "category-delete",
      "topic-create",
      "topic-edit",
      "renameGroup",
      "setGroupIcon",
    ],
  },
  { group: "presence", actions: ["set-presence", "set-profile", "voice-status"] },
];

function isSendOnly(actions: readonly string[]): boolean {
  return actions.length > 0 && actions.every((action) => action === "send");
}

function buildScopedProperties(params: {
  actions: readonly string[];
  options: MessageToolSchemaBuilderOptions;
  builders: MessageToolSchemaBuilders;
}): SchemaProperties {
  const activeActions = new Set(params.actions);
  const properties = params.builders.base(params.options);
  for (const entry of SCOPED_ACTION_GROUPS) {
    if (entry.actions.some((action) => activeActions.has(action))) {
      Object.assign(properties, params.builders.groups[entry.group]());
    }
  }
  Object.assign(properties, params.options.extraProperties);
  return properties;
}

export function buildMessageToolSchemaFromActions(
  actions: readonly string[],
  options: MessageToolSchemaBuilderOptions,
  builders: MessageToolSchemaBuilders,
) {
  // Keep one flat object: provider adapters reject per-action anyOf/oneOf schemas.
  // Groups prune unavailable fields; runtime still validates each action payload.
  const properties = isSendOnly(actions)
    ? Object.assign(builders.base(options), options.extraProperties)
    : options.scopeToActions && actions.length > 0
      ? buildScopedProperties({ actions, options, builders })
      : builders.full(options);
  return Type.Object({
    action: stringEnum(actions, {
      description:
        'Select one action. For action="send", provide message or another send payload; fields for other actions do not count as send content.',
    }),
    ...properties,
  });
}
