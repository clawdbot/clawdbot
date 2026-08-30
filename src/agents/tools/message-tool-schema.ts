import { Type, type TSchema } from "typebox";
import { CHANNEL_MESSAGE_ACTION_NAMES } from "../../channels/plugins/message-action-names.js";
import { POLL_CREATION_PARAM_DEFS, SHARED_POLL_CREATION_PARAM_NAMES } from "../../poll-params.js";
import {
  channelTargetSchema,
  channelTargetsSchema,
  optionalNonNegativeIntegerSchema,
  optionalPositiveIntegerSchema,
  stringEnum,
} from "../schema/typebox.js";
import { gatewayCallOptionSchemaProperties } from "./gateway-schema.js";
import {
  buildMessageToolQuerySchemaProperties,
  buildMessageToolSchemaFromActions,
  MESSAGE_TOOL_SEND_TEXT_DESCRIPTION,
  type MessageToolSchemaBuilders,
} from "./message-tool-schema-scoping.js";

const AllMessageActions = CHANNEL_MESSAGE_ACTION_NAMES;
function buildRoutingSchema() {
  return {
    channel: Type.Optional(Type.String()),
    target: Type.Optional(channelTargetSchema()),
    targets: Type.Optional(channelTargetsSchema()),
    accountId: Type.Optional(Type.String()),
    dryRun: Type.Optional(Type.Boolean()),
  };
}

const presentationCommandActionSchema = Type.Object({
  type: Type.Literal("command"),
  command: Type.String(),
});

const presentationCallbackActionSchema = Type.Object({
  type: Type.Literal("callback"),
  value: Type.String(),
});

const presentationCommandOrCallbackActionSchema = Type.Union([
  presentationCommandActionSchema,
  presentationCallbackActionSchema,
]);

// Approval and question actions carry server-issued IDs and are runtime-authored
// only. The message tool exposes the remaining actions models may safely author.
const presentationButtonActionSchema = Type.Union([
  presentationCommandActionSchema,
  presentationCallbackActionSchema,
  Type.Object({
    type: Type.Literal("url"),
    url: Type.String(),
  }),
  Type.Object({
    type: Type.Literal("web-app"),
    url: Type.String(),
    widgetId: Type.Optional(Type.String()),
  }),
  Type.Object({
    type: Type.Literal("web-app"),
    url: Type.Optional(Type.String()),
    widgetId: Type.String(),
  }),
]);

const presentationOptionSchema = Type.Object({
  label: Type.String(),
  action: Type.Optional(presentationCommandOrCallbackActionSchema),
  value: Type.Optional(Type.String()),
});

const presentationButtonSchema = Type.Object({
  label: Type.String(),
  action: Type.Optional(presentationButtonActionSchema),
  value: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  webApp: Type.Optional(Type.Object({ url: Type.String() })),
  web_app: Type.Optional(Type.Object({ url: Type.String() })),
  disabled: Type.Optional(Type.Boolean()),
  reusable: Type.Optional(Type.Boolean()),
  style: Type.Optional(stringEnum(["primary", "secondary", "success", "danger"])),
});

const presentationChartSegmentSchema = Type.Object({
  label: Type.String(),
  value: Type.Number(),
});

const presentationChartSeriesSchema = Type.Object({
  name: Type.String(),
  values: Type.Array(Type.Number(), { minItems: 1 }),
});

// Keep this flat: some provider tool-schema validators reject an anyOf nested
// under presentation.blocks.items. Runtime normalization enforces block shapes.
const presentationBlockSchema = Type.Object({
  type: stringEnum(["text", "context", "divider", "buttons", "select", "chart", "table"]),
  text: Type.Optional(Type.String()),
  buttons: Type.Optional(Type.Array(presentationButtonSchema)),
  placeholder: Type.Optional(Type.String()),
  options: Type.Optional(Type.Array(presentationOptionSchema)),
  chartType: Type.Optional(stringEnum(["pie", "bar", "area", "line"])),
  title: Type.Optional(Type.String()),
  segments: Type.Optional(Type.Array(presentationChartSegmentSchema, { minItems: 1 })),
  categories: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
  series: Type.Optional(Type.Array(presentationChartSeriesSchema, { minItems: 1 })),
  xLabel: Type.Optional(Type.String()),
  yLabel: Type.Optional(Type.String()),
  caption: Type.Optional(Type.String()),
  headers: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
  rows: Type.Optional(
    Type.Array(
      Type.Array(Type.Unsafe<string | number>({ type: ["string", "number"] }), { minItems: 1 }),
      { minItems: 1 },
    ),
  ),
  rowHeaderColumnIndex: Type.Optional(Type.Integer({ minimum: 0 })),
});

const presentationMessageSchema = Type.Object(
  {
    title: Type.Optional(Type.String()),
    tone: Type.Optional(stringEnum(["info", "success", "warning", "danger", "neutral"])),
    blocks: Type.Array(presentationBlockSchema),
  },
  {
    description: "Rich text/chart/table/button/select/context; unsupported degrades to text.",
  },
);

function buildSendSchema(options: {
  includePresentation: boolean;
  includeDeliveryPin: boolean;
  includeBestEffort: boolean;
}) {
  const props: Record<string, TSchema> = {
    message: Type.Optional(Type.String({ description: MESSAGE_TOOL_SEND_TEXT_DESCRIPTION })),
    effectId: Type.Optional(
      Type.String({
        description: "sendWithEffect id/name.",
      }),
    ),
    effect: Type.Optional(Type.String({ description: "Alias for effectId." })),
    media: Type.Optional(
      Type.String({
        description: "Media URL/path. data: use buffer.",
      }),
    ),
    filename: Type.Optional(Type.String()),
    buffer: Type.Optional(
      Type.String({
        description: "Base64/data-URL attachment.",
      }),
    ),
    contentType: Type.Optional(Type.String()),
    mimeType: Type.Optional(Type.String()),
    caption: Type.Optional(Type.String()),
    attachments: Type.Optional(
      Type.Array(
        Type.Object({
          type: Type.Optional(stringEnum(["image", "audio", "video", "file"])),
          media: Type.Optional(Type.String()),
          name: Type.Optional(Type.String()),
          mimeType: Type.Optional(Type.String()),
        }),
        {
          description: "Attachments; each uses media.",
        },
      ),
    ),
    replyTo: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.String()),
    asVoice: Type.Optional(
      Type.Boolean({ description: "Send audio as a voice note; combines with voiceText." }),
    ),
    voiceText: Type.Optional(
      Type.String({ description: "Text to synthesize; message remains visible." }),
    ),
    voiceProvider: Type.Optional(
      Type.String({ description: "Per-send speech provider override." }),
    ),
    voiceId: Type.Optional(Type.String({ description: "Per-send speech voice override." })),
    silent: Type.Optional(Type.Boolean()),
    quoteText: Type.Optional(Type.String({ description: "Telegram reply quote text." })),
    gifPlayback: Type.Optional(Type.Boolean()),
    forceDocument: Type.Optional(
      Type.Boolean({
        description: "Send media as document; no compression.",
      }),
    ),
    asDocument: Type.Optional(
      Type.Boolean({
        description: "Alias for forceDocument.",
      }),
    ),
  };
  if (options.includePresentation) {
    props.presentation = Type.Optional(presentationMessageSchema);
  }
  if (options.includeBestEffort) {
    props.bestEffort = Type.Optional(
      Type.Boolean({
        description: "Ordinary reply omit/true; false only requiring durable delivery.",
      }),
    );
  }
  if (options.includeDeliveryPin) {
    props.delivery = Type.Optional(
      Type.Object(
        {
          pin: Type.Optional(
            Type.Union([
              Type.Boolean(),
              Type.Object({
                enabled: Type.Boolean(),
                notify: Type.Optional(Type.Boolean()),
                required: Type.Optional(Type.Boolean()),
              }),
            ]),
          ),
        },
        {
          description: "Delivery prefs; pin when supported.",
        },
      ),
    );
  }
  return props;
}

function buildReactionSchema() {
  return {
    messageId: Type.Optional(
      Type.String({
        description:
          "Target read/react/edit/delete/pin/unpin id; reactions default current inbound.",
      }),
    ),
    message_id: Type.Optional(
      Type.String({
        // Intentional duplicate alias for tool-schema discoverability in LLMs.
        description: "snake_case alias of messageId; same defaults.",
      }),
    ),
    emoji: Type.Optional(
      Type.String({ description: "Unicode emoji; channels may also support custom emoji." }),
    ),
    remove: Type.Optional(Type.Boolean()),
    trackToolCalls: Type.Optional(
      Type.Boolean({
        description: "Use reacted current message for tool-progress reactions.",
      }),
    ),
    track_tool_calls: Type.Optional(
      Type.Boolean({
        description: "snake_case alias of trackToolCalls.",
      }),
    ),
    targetAuthor: Type.Optional(Type.String()),
    targetAuthorUuid: Type.Optional(Type.String()),
    groupId: Type.Optional(Type.String()),
  };
}

function buildFetchSchema() {
  return {
    limit: optionalPositiveIntegerSchema({ description: "Maximum number of results to return." }),
    pageSize: optionalPositiveIntegerSchema(),
    pageToken: Type.Optional(Type.String()),
    before: Type.Optional(Type.String()),
    after: Type.Optional(Type.String()),
    around: Type.Optional(Type.String()),
    fromMe: Type.Optional(Type.Boolean()),
    includeArchived: Type.Optional(Type.Boolean()),
  };
}

function buildPollSchema() {
  const props: Record<string, TSchema> = {
    pollId: Type.Optional(Type.String()),
    pollOptionId: Type.Optional(
      Type.String({
        description: "Poll answer id.",
      }),
    ),
    pollOptionIds: Type.Optional(
      Type.Array(
        Type.String({
          description: "Poll answer ids for multiselect.",
        }),
      ),
    ),
    pollOptionIndex: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "1-based poll option number.",
      }),
    ),
    pollOptionIndexes: Type.Optional(
      Type.Array(
        Type.Integer({
          minimum: 1,
          description: "1-based poll option numbers for multiselect.",
        }),
      ),
    ),
  };
  for (const name of SHARED_POLL_CREATION_PARAM_NAMES) {
    const def = POLL_CREATION_PARAM_DEFS[name];
    if (!def) {
      continue;
    }
    switch (def.kind) {
      case "string":
        props[name] = Type.Optional(Type.String());
        break;
      case "stringArray":
        props[name] = Type.Optional(Type.Array(Type.String()));
        break;
      case "positiveInteger":
        props[name] = optionalPositiveIntegerSchema();
        break;
      case "boolean":
        props[name] = Type.Optional(Type.Boolean());
        break;
    }
  }
  return props;
}

function buildChannelTargetSchema() {
  return {
    channelId: Type.Optional(Type.String({ description: "Channel id filter." })),
    chatId: Type.Optional(Type.String({ description: "Chat id for chat metadata." })),
    channelIds: Type.Optional(Type.Array(Type.String({ description: "Channel id filter." }))),
    memberId: Type.Optional(Type.String()),
    memberIdType: Type.Optional(Type.String()),
    guildId: Type.Optional(Type.String()),
    userId: Type.Optional(
      Type.String({
        description:
          "member-info/moderation/participant user id; member-info uses userId, not target.",
      }),
    ),
    openId: Type.Optional(Type.String()),
    unionId: Type.Optional(Type.String()),
    authorId: Type.Optional(Type.String()),
    authorIds: Type.Optional(Type.Array(Type.String())),
    roleId: Type.Optional(Type.String()),
    roleIds: Type.Optional(Type.Array(Type.String())),
    participant: Type.Optional(Type.String()),
    includeMembers: Type.Optional(Type.Boolean()),
    members: Type.Optional(Type.Boolean()),
    scope: Type.Optional(Type.String()),
    kind: Type.Optional(Type.String()),
  };
}

function buildStickerSchema() {
  return {
    fileId: Type.Optional(Type.String()),
    emojiName: Type.Optional(Type.String({ description: "Name for an uploaded custom emoji." })),
    stickerId: Type.Optional(Type.Array(Type.String())),
    stickerName: Type.Optional(Type.String()),
    stickerDesc: Type.Optional(Type.String()),
    stickerTags: Type.Optional(Type.String()),
  };
}

function buildThreadSchema() {
  return {
    threadName: Type.Optional(Type.String()),
    autoArchiveMin: optionalPositiveIntegerSchema(),
    appliedTags: Type.Optional(Type.Array(Type.String())),
  };
}

function buildEventSchema() {
  return {
    eventName: Type.Optional(Type.String()),
    eventType: Type.Optional(Type.String()),
    startTime: Type.Optional(Type.String()),
    endTime: Type.Optional(Type.String()),
    desc: Type.Optional(Type.String()),
    location: Type.Optional(Type.String()),
    image: Type.Optional(Type.String({ description: "Event cover image URL/path." })),
  };
}

function buildModerationSchema() {
  return {
    reason: Type.Optional(Type.String()),
    deleteDays: optionalNonNegativeIntegerSchema({ maximum: 7 }),
    durationMin: optionalNonNegativeIntegerSchema(),
    until: Type.Optional(Type.String()),
  };
}

function buildGatewaySchema() {
  return gatewayCallOptionSchemaProperties();
}

function buildPresenceSchema() {
  return {
    activityType: Type.Optional(
      Type.String({
        description: "Activity type: playing, streaming, listening, watching, competing, custom.",
      }),
    ),
    activityName: Type.Optional(
      Type.String({
        description: "Activity name shown in sidebar; ignored for custom.",
      }),
    ),
    activityUrl: Type.Optional(
      Type.String({
        description: "Streaming URL; streaming type only.",
      }),
    ),
    activityState: Type.Optional(
      Type.String({
        description: "State text; custom type uses as status text.",
      }),
    ),
    status: Type.Optional(
      Type.String({ description: "Bot status: online, dnd, idle, invisible." }),
    ),
  };
}

function buildChannelManagementSchema() {
  return {
    name: Type.Optional(Type.String()),
    channelType: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Numeric channel type; avoids schema type collision.",
      }),
    ),
    parentId: Type.Optional(Type.String()),
    topic: Type.Optional(Type.String()),
    position: optionalNonNegativeIntegerSchema(),
    nsfw: Type.Optional(Type.Boolean()),
    rateLimitPerUser: optionalNonNegativeIntegerSchema(),
    categoryId: Type.Optional(Type.String()),
    clearParent: Type.Optional(
      Type.Boolean({
        description: "Clear parent/category when supported.",
      }),
    ),
  };
}

function buildMessageToolSchemaProps(options: {
  includePresentation: boolean;
  includeDeliveryPin: boolean;
  includeBestEffort: boolean;
  extraProperties?: Record<string, TSchema>;
}) {
  return {
    ...buildRoutingSchema(),
    ...buildSendSchema(options),
    ...buildReactionSchema(),
    ...buildFetchSchema(),
    ...buildMessageToolQuerySchemaProperties(),
    ...buildPollSchema(),
    ...buildChannelTargetSchema(),
    ...buildStickerSchema(),
    ...buildThreadSchema(),
    ...buildEventSchema(),
    ...buildModerationSchema(),
    ...buildGatewaySchema(),
    ...buildChannelManagementSchema(),
    ...buildPresenceSchema(),
    ...options.extraProperties,
  };
}

export const MESSAGE_TOOL_SCHEMA_BUILDERS = {
  full: buildMessageToolSchemaProps,
  base: (options) => ({
    ...buildRoutingSchema(),
    ...buildSendSchema(options),
    ...buildGatewaySchema(),
  }),
  groups: {
    reaction: buildReactionSchema,
    fetch: buildFetchSchema,
    query: buildMessageToolQuerySchemaProperties,
    poll: buildPollSchema,
    channelTarget: buildChannelTargetSchema,
    sticker: buildStickerSchema,
    thread: buildThreadSchema,
    event: buildEventSchema,
    moderation: buildModerationSchema,
    channelManagement: buildChannelManagementSchema,
    presence: buildPresenceSchema,
  },
} satisfies MessageToolSchemaBuilders;

export const MessageToolSchema = buildMessageToolSchemaFromActions(
  AllMessageActions,
  {
    includePresentation: true,
    includeDeliveryPin: true,
    includeBestEffort: false,
  },
  MESSAGE_TOOL_SCHEMA_BUILDERS,
);
