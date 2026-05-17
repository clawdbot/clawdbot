import { Type, type TSchema } from "typebox";
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import type { InboundEventKind } from "../../channels/inbound-event/kind.js";
import { listChannelPlugins } from "../../channels/plugins/index.js";
import {
  channelSupportsMessageCapability,
  channelSupportsMessageCapabilityForChannel,
  type ChannelMessageActionDiscoveryInput,
  listCrossChannelSchemaSupportedMessageActions,
  resolveChannelMessageToolSchemaProperties,
} from "../../channels/plugins/message-action-discovery.js";
import { CHANNEL_MESSAGE_ACTION_NAMES } from "../../channels/plugins/message-action-names.js";
import type { ChannelMessageCapability } from "../../channels/plugins/message-capabilities.js";
import type { ChannelMessageActionName } from "../../channels/plugins/types.public.js";
import { resolveCommandSecretRefsViaGateway } from "../../cli/command-secret-gateway.js";
import { getScopedChannelsCommandSecretTargets } from "../../cli/command-secret-targets.js";
import { resolveMessageSecretScope } from "../../cli/message-secret-scope.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../../gateway/protocol/client-info.js";
import { getToolResult, runMessageAction } from "../../infra/outbound/message-action-runner.js";
import { resolveAllowedMessageActions } from "../../infra/outbound/outbound-policy.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { POLL_CREATION_PARAM_DEFS, SHARED_POLL_CREATION_PARAM_NAMES } from "../../poll-params.js";
import { normalizeAccountId } from "../../routing/session-key.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { stripReasoningTagsFromText } from "../../shared/text/reasoning-tags.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { listAllChannelSupportedActions, listChannelSupportedActions } from "../channel-tools.js";
import { channelTargetSchema, channelTargetsSchema, stringEnum } from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import { resolveGatewayOptions } from "./gateway.js";

const AllMessageActions = CHANNEL_MESSAGE_ACTION_NAMES;
const MESSAGE_TOOL_THREAD_READ_HINT =
  ' Use action="read" with threadId to fetch prior messages in a thread when you need conversation context you do not have yet.';
const EXPLICIT_TARGET_ACTIONS = new Set<ChannelMessageActionName>([
  "send",
  "sendWithEffect",
  "sendAttachment",
  "upload-file",
  "reply",
  "thread-reply",
  "broadcast",
]);

function actionNeedsExplicitTarget(action: ChannelMessageActionName): boolean {
  return EXPLICIT_TARGET_ACTIONS.has(action);
}

function stripFormattedReasoningMessage(text: string): string {
  const stripped = stripReasoningTagsFromText(text);
  const lines = stripped.split(/\r?\n/u);
  if (lines[0]?.trim() !== "Reasoning:") {
    return stripped;
  }

  let index = 1;
  while (index < lines.length) {
    const trimmed = lines[index]?.trim() ?? "";
    if (!trimmed || (trimmed.startsWith("_") && trimmed.endsWith("_") && trimmed.length >= 2)) {
      index += 1;
      continue;
    }
    break;
  }
  return lines.slice(index).join("\n").trim();
}

function sanitizePresentationTextFields(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const presentation = { ...(value as Record<string, unknown>) };
  if (typeof presentation.title === "string") {
    presentation.title = stripFormattedReasoningMessage(presentation.title);
  }
  if (Array.isArray(presentation.blocks)) {
    presentation.blocks = presentation.blocks.map((block) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        return block;
      }
      const sanitizedBlock = { ...(block as Record<string, unknown>) };
      for (const field of ["text", "placeholder"]) {
        if (typeof sanitizedBlock[field] === "string") {
          sanitizedBlock[field] = stripFormattedReasoningMessage(sanitizedBlock[field]);
        }
      }
      if (Array.isArray(sanitizedBlock.buttons)) {
        sanitizedBlock.buttons = sanitizedBlock.buttons.map((button) => {
          if (!button || typeof button !== "object" || Array.isArray(button)) {
            return button;
          }
          const sanitizedButton = { ...(button as Record<string, unknown>) };
          if (typeof sanitizedButton.label === "string") {
            sanitizedButton.label = stripFormattedReasoningMessage(sanitizedButton.label);
          }
          return sanitizedButton;
        });
      }
      if (Array.isArray(sanitizedBlock.options)) {
        sanitizedBlock.options = sanitizedBlock.options.map((option) => {
          if (!option || typeof option !== "object" || Array.isArray(option)) {
            return option;
          }
          const sanitizedOption = { ...(option as Record<string, unknown>) };
          if (typeof sanitizedOption.label === "string") {
            sanitizedOption.label = stripFormattedReasoningMessage(sanitizedOption.label);
          }
          return sanitizedOption;
        });
      }
      return sanitizedBlock;
    });
  }
  return presentation;
}

function buildRoutingSchema() {
  return {
    channel: Type.Optional(Type.String()),
    target: Type.Optional(channelTargetSchema()),
    targets: Type.Optional(channelTargetsSchema()),
    accountId: Type.Optional(Type.String()),
    dryRun: Type.Optional(Type.Boolean()),
  };
}

const presentationOptionSchema = Type.Object({
  label: Type.String(),
  value: Type.String(),
});

const presentationButtonSchema = Type.Object({
  label: Type.String(),
  value: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  webApp: Type.Optional(Type.Object({ url: Type.String() })),
  web_app: Type.Optional(Type.Object({ url: Type.String() })),
  style: Type.Optional(stringEnum(["primary", "secondary", "success", "danger"])),
});

const presentationBlockSchema = Type.Object({
  type: stringEnum(["text", "context", "divider", "buttons", "select"]),
  text: Type.Optional(Type.String()),
  buttons: Type.Optional(Type.Array(presentationButtonSchema)),
  placeholder: Type.Optional(Type.String()),
  options: Type.Optional(Type.Array(presentationOptionSchema)),
});

const presentationMessageSchema = Type.Object(
  {
    title: Type.Optional(Type.String()),
    tone: Type.Optional(stringEnum(["info", "success", "warning", "danger", "neutral"])),
    blocks: Type.Array(presentationBlockSchema),
  },
  {
    description:
      "Shared presentation payload for rich text, buttons, selects, and context. Core degrades unsupported blocks to text.",
  },
);

function buildSendSchema(options: { includePresentation: boolean; includeDeliveryPin: boolean }) {
  const props: Record<string, TSchema> = {
    message: Type.Optional(Type.String()),
    effectId: Type.Optional(
      Type.String({
        description: "Message effect name/id for sendWithEffect (e.g., invisible ink).",
      }),
    ),
    effect: Type.Optional(
      Type.String({ description: "Alias for effectId (e.g., invisible-ink, balloons)." }),
    ),
    media: Type.Optional(
      Type.String({
        description: "Media URL or local path. data: URLs are not supported here, use buffer.",
      }),
    ),
    filename: Type.Optional(Type.String()),
    buffer: Type.Optional(
      Type.String({
        description: "Base64 payload for attachments (optionally a data: URL).",
      }),
    ),
    contentType: Type.Optional(Type.String()),
    mimeType: Type.Optional(Type.String()),
    caption: Type.Optional(Type.String()),
    path: Type.Optional(Type.String()),
    filePath: Type.Optional(Type.String()),
    attachments: Type.Optional(
      Type.Array(
        Type.Object({
          type: Type.Optional(stringEnum(["image", "audio", "video", "file"])),
          media: Type.Optional(Type.String()),
          mediaUrl: Type.Optional(Type.String()),
          path: Type.Optional(Type.String()),
          filePath: Type.Optional(Type.String()),
          fileUrl: Type.Optional(Type.String()),
          url: Type.Optional(Type.String()),
          name: Type.Optional(Type.String()),
          mimeType: Type.Optional(Type.String()),
        }),
        {
          description:
            "Structured media attachments to send with the message. Each item needs media/mediaUrl/path/filePath/fileUrl/url.",
        },
      ),
    ),
    replyTo: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.String()),
    asVoice: Type.Optional(Type.Boolean()),
    silent: Type.Optional(Type.Boolean()),
    quoteText: Type.Optional(
      Type.String({ description: "Quote text for Telegram reply_parameters" }),
    ),
    bestEffort: Type.Optional(Type.Boolean()),
    gifPlayback: Type.Optional(Type.Boolean()),
    forceDocument: Type.Optional(
      Type.Boolean({
        description: "Send image/GIF/video as document to avoid channel compression.",
      }),
    ),
    asDocument: Type.Optional(
      Type.Boolean({
        description:
          "Send image/GIF/video as document to avoid channel compression. Alias for forceDocument.",
      }),
    ),
  };
  if (options.includePresentation) {
    props.presentation = Type.Optional(presentationMessageSchema);
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
          description:
            "Shared delivery preferences. pin requests that the sent message be pinned when the channel supports it.",
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
          "Target message id for read, reaction, edit, delete, pin, or unpin. If omitted for reaction-like actions, defaults to the current inbound message id when available.",
      }),
    ),
    message_id: Type.Optional(
      Type.String({
        // Intentional duplicate alias for tool-schema discoverability in LLMs.
        description:
          "snake_case alias of messageId. If omitted for reaction-like actions, defaults to the current inbound message id when available.",
      }),
    ),
    emoji: Type.Optional(Type.String()),
    remove: Type.Optional(Type.Boolean()),
    trackToolCalls: Type.Optional(
      Type.Boolean({
        description:
          "When true for a reaction to the current inbound message, use that reacted message as the status-reaction target for subsequent tool progress when the channel supports it.",
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
    limit: Type.Optional(Type.Number()),
    pageSize: Type.Optional(Type.Number()),
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
        description: "Poll answer id to vote for. Use when the channel exposes stable answer ids.",
      }),
    ),
    pollOptionIds: Type.Optional(
      Type.Array(
        Type.String({
          description:
            "Poll answer ids to vote for in a multiselect poll. Use when the channel exposes stable answer ids.",
        }),
      ),
    ),
    pollOptionIndex: Type.Optional(
      Type.Number({
        description:
          "1-based poll option number to vote for, matching the rendered numbered poll choices.",
      }),
    ),
    pollOptionIndexes: Type.Optional(
      Type.Array(
        Type.Number({
          description:
            "1-based poll option numbers to vote for in a multiselect poll, matching the rendered numbered poll choices.",
        }),
      ),
    ),
  };
  for (const name of SHARED_POLL_CREATION_PARAM_NAMES) {
    const def = POLL_CREATION_PARAM_DEFS[name];
    switch (def.kind) {
      case "string":
        props[name] = Type.Optional(Type.String());
        break;
      case "stringArray":
        props[name] = Type.Optional(Type.Array(Type.String()));
        break;
      case "number":
        props[name] = Type.Optional(Type.Number());
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
    channelId: Type.Optional(
      Type.String({ description: "Channel id filter (search/thread list/event create)." }),
    ),
    chatId: Type.Optional(
      Type.String({ description: "Chat id for chat-scoped metadata actions." }),
    ),
    channelIds: Type.Optional(
      Type.Array(Type.String({ description: "Channel id filter (repeatable)." })),
    ),
    memberId: Type.Optional(Type.String()),
    memberIdType: Type.Optional(Type.String()),
    guildId: Type.Optional(Type.String()),
    userId: Type.Optional(Type.String()),
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
    emojiName: Type.Optional(Type.String()),
    stickerId: Type.Optional(Type.Array(Type.String())),
    stickerName: Type.Optional(Type.String()),
    stickerDesc: Type.Optional(Type.String()),
    stickerTags: Type.Optional(Type.String()),
  };
}

function buildThreadSchema() {
  return {
    threadName: Type.Optional(Type.String()),
    autoArchiveMin: Type.Optional(Type.Number()),
    appliedTags: Type.Optional(Type.Array(Type.String())),
  };
}

function buildEventSchema() {
  return {
    query: Type.Optional(Type.String()),
    eventName: Type.Optional(Type.String()),
    eventType: Type.Optional(Type.String()),
    startTime: Type.Optional(Type.String()),
    endTime: Type.Optional(Type.String()),
    desc: Type.Optional(Type.String()),
    location: Type.Optional(Type.String()),
    image: Type.Optional(
      Type.String({ description: "Cover image URL or local file path for the event." }),
    ),
    durationMin: Type.Optional(Type.Number()),
    until: Type.Optional(Type.String()),
  };
}

function buildModerationSchema() {
  return {
    reason: Type.Optional(Type.String()),
    deleteDays: Type.Optional(Type.Number()),
  };
}

function buildGatewaySchema() {
  return {
    gatewayUrl: Type.Optional(Type.String()),
    gatewayToken: Type.Optional(Type.String()),
    timeoutMs: Type.Optional(Type.Number()),
  };
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
        description: "Activity name shown in sidebar (e.g. 'with fire'). Ignored for custom type.",
      }),
    ),
    activityUrl: Type.Optional(
      Type.String({
        description:
          "Streaming URL (Twitch or YouTube). Only used with streaming type; may not render for bots.",
      }),
    ),
    activityState: Type.Optional(
      Type.String({
        description:
          "State text. For custom type this is the status text; for others it shows in the flyout.",
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
      Type.Number({
        description:
          "Numeric channel type (e.g. Discord channel type). Renamed from `type` to avoid JSON Schema keyword collisions that break some OpenAI-compatible providers (notably NVIDIA NIM).",
      }),
    ),
    parentId: Type.Optional(Type.String()),
    topic: Type.Optional(Type.String()),
    position: Type.Optional(Type.Number()),
    nsfw: Type.Optional(Type.Boolean()),
    rateLimitPerUser: Type.Optional(Type.Number()),
    categoryId: Type.Optional(Type.String()),
    clearParent: Type.Optional(
      Type.Boolean({
        description: "Clear the parent/category when supported by the provider.",
      }),
    ),
  };
}

function buildMessageToolSchemaProps(options: {
  includePresentation: boolean;
  includeDeliveryPin: boolean;
  extraProperties?: Record<string, TSchema>;
}) {
  return {
    ...buildRoutingSchema(),
    ...buildSendSchema(options),
    ...buildReactionSchema(),
    ...buildFetchSchema(),
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

function isSendOnlyActions(actions: readonly string[]): boolean {
  const uniqueActions = new Set(actions);
  return uniqueActions.size === 1 && uniqueActions.has("send");
}

function buildSendOnlyMessageToolSchemaProps(options: {
  includePresentation: boolean;
  includeDeliveryPin: boolean;
  extraProperties?: Record<string, TSchema>;
}) {
  return {
    ...buildRoutingSchema(),
    ...buildSendSchema(options),
    ...buildGatewaySchema(),
    ...options.extraProperties,
  };
}

function buildMessageToolSchemaFromActions(
  actions: readonly string[],
  options: {
    includePresentation: boolean;
    includeDeliveryPin: boolean;
    extraProperties?: Record<string, TSchema>;
  },
) {
  const props = isSendOnlyActions(actions)
    ? buildSendOnlyMessageToolSchemaProps(options)
    : buildMessageToolSchemaProps(options);
  return Type.Object({
    action: stringEnum(actions),
    ...props,
  });
}

const MessageToolSchema = buildMessageToolSchemaFromActions(AllMessageActions, {
  includePresentation: true,
  includeDeliveryPin: true,
});

type MessageToolOptions = {
  agentAccountId?: string;
  agentSessionKey?: string;
  sessionId?: string;
  agentId?: string;
  config?: OpenClawConfig;
  getRuntimeConfig?: () => OpenClawConfig;
  getScopedChannelsCommandSecretTargets?: typeof getScopedChannelsCommandSecretTargets;
  resolveCommandSecretRefsViaGateway?: typeof resolveCommandSecretRefsViaGateway;
  runMessageAction?: typeof runMessageAction;
  currentChannelId?: string;
  currentChannelProvider?: string;
  currentThreadTs?: string;
  agentThreadId?: string | number;
  currentMessageId?: string | number;
  replyToMode?: "off" | "first" | "all" | "batched";
  hasRepliedRef?: { value: boolean };
  sandboxRoot?: string;
  requireExplicitTarget?: boolean;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  inboundEventKind?: InboundEventKind;
  requesterSenderId?: string;
  senderIsOwner?: boolean;
};

type MessageToolDiscoveryParams = {
  cfg: OpenClawConfig;
  currentChannelProvider?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  currentAccountId?: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  requesterSenderId?: string;
  senderIsOwner?: boolean;
};

type MessageActionDiscoveryInput = Omit<ChannelMessageActionDiscoveryInput, "cfg" | "channel"> & {
  cfg: OpenClawConfig;
  channel?: string;
};

function buildMessageActionDiscoveryInput(
  params: MessageToolDiscoveryParams,
  channel?: string,
): MessageActionDiscoveryInput {
  return {
    cfg: params.cfg,
    ...(channel ? { channel } : {}),
    currentChannelId: params.currentChannelId,
    currentThreadTs: params.currentThreadTs,
    currentMessageId: params.currentMessageId,
    accountId: params.currentAccountId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
    requesterSenderId: params.requesterSenderId,
    senderIsOwner: params.senderIsOwner,
  };
}

function resolveMessageToolSchemaActions(params: MessageToolDiscoveryParams): string[] {
  const currentChannel = normalizeMessageChannel(params.currentChannelProvider);
  if (currentChannel) {
    const scopedActions = listChannelSupportedActions(
      buildMessageActionDiscoveryInput(params, currentChannel),
    );
    const allActions = new Set<string>(["send", ...scopedActions]);
    // Include actions from other configured channels so isolated/cron agents
    // can invoke cross-channel actions without validation errors.
    for (const plugin of listChannelPlugins()) {
      if (plugin.id === currentChannel) {
        continue;
      }
      for (const action of listCrossChannelSchemaSupportedMessageActions(
        buildMessageActionDiscoveryInput(params, plugin.id),
      )) {
        allActions.add(action);
      }
    }
    return Array.from(allActions);
  }
  return listAllMessageToolActions(params);
}

function resolveMessageToolActionSchemaActions(params: MessageToolDiscoveryParams): string[] {
  const discoveredActions = resolveMessageToolSchemaActions(params);
  const allowedActions = resolveAllowedMessageActions({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (!allowedActions) {
    return discoveredActions;
  }
  const allow = new Set(allowedActions);
  const filtered = discoveredActions.filter((action) => allow.has(action));
  return filtered.length > 0 ? filtered : allowedActions;
}

function listAllMessageToolActions(params: MessageToolDiscoveryParams): ChannelMessageActionName[] {
  const pluginActions = listAllChannelSupportedActions(buildMessageActionDiscoveryInput(params));
  return Array.from(new Set<ChannelMessageActionName>(["send", "broadcast", ...pluginActions]));
}

function resolveIncludeCapability(
  params: MessageToolDiscoveryParams,
  capability: ChannelMessageCapability,
): boolean {
  const currentChannel = normalizeMessageChannel(params.currentChannelProvider);
  if (currentChannel) {
    return channelSupportsMessageCapabilityForChannel(
      buildMessageActionDiscoveryInput(params, currentChannel),
      capability,
    );
  }
  return channelSupportsMessageCapability(params.cfg, capability);
}

function resolveIncludePresentation(params: MessageToolDiscoveryParams): boolean {
  return resolveIncludeCapability(params, "presentation");
}

function resolveIncludeDeliveryPin(params: MessageToolDiscoveryParams): boolean {
  return resolveIncludeCapability(params, "delivery-pin");
}

function buildMessageToolSchema(params: MessageToolDiscoveryParams) {
  const actions = resolveMessageToolActionSchemaActions(params);
  const includePresentation = resolveIncludePresentation(params);
  const includeDeliveryPin = resolveIncludeDeliveryPin(params);
  const extraProperties = resolveChannelMessageToolSchemaProperties(
    buildMessageActionDiscoveryInput(
      params,
      normalizeMessageChannel(params.currentChannelProvider) ?? undefined,
    ),
  );
  return buildMessageToolSchemaFromActions(actions.length > 0 ? actions : ["send"], {
    includePresentation,
    includeDeliveryPin,
    extraProperties,
  });
}

function resolveAgentAccountId(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  return normalizeAccountId(trimmed);
}

function buildMessageToolDescription(options?: {
  config?: OpenClawConfig;
  currentChannel?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  currentAccountId?: string;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  requireExplicitTarget?: boolean;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  requesterSenderId?: string;
  senderIsOwner?: boolean;
}): string {
  const baseDescription = "Send, delete, and manage messages via channel plugins.";
  const resolvedOptions = options ?? {};
  const messageToolDiscoveryParams = resolvedOptions.config
    ? {
        cfg: resolvedOptions.config,
        currentChannelProvider: resolvedOptions.currentChannel,
        currentChannelId: resolvedOptions.currentChannelId,
        currentThreadTs: resolvedOptions.currentThreadTs,
        currentMessageId: resolvedOptions.currentMessageId,
        currentAccountId: resolvedOptions.currentAccountId,
        sessionKey: resolvedOptions.sessionKey,
        sessionId: resolvedOptions.sessionId,
        agentId: resolvedOptions.agentId,
        requesterSenderId: resolvedOptions.requesterSenderId,
        senderIsOwner: resolvedOptions.senderIsOwner,
      }
    : undefined;

  if (messageToolDiscoveryParams) {
    const actions = resolveMessageToolActionSchemaActions(messageToolDiscoveryParams);
    if (actions.length > 0) {
      const sortedActions = Array.from(new Set(actions)).toSorted() as Array<
        ChannelMessageActionName | "send"
      >;
      return appendMessageToolReadHint(
        appendMessageToolVisibleReplyHint(
          `${baseDescription} Supports actions: ${sortedActions.join(", ")}.`,
          resolvedOptions.sourceReplyDeliveryMode,
          resolvedOptions.requireExplicitTarget,
        ),
        sortedActions,
      );
    }
  }

  return appendMessageToolVisibleReplyHint(
    `${baseDescription} Supports actions: send, delete, react, poll, pin, threads, and more.`,
    resolvedOptions.sourceReplyDeliveryMode,
    resolvedOptions.requireExplicitTarget,
  );
}

function appendMessageToolVisibleReplyHint(
  description: string,
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode,
  requireExplicitTarget?: boolean,
): string {
  if (sourceReplyDeliveryMode !== "message_tool_only") {
    return description;
  }
  const targetGuidance = requireExplicitTarget
    ? "Include target when sending."
    : "The target defaults to the current source conversation, so omit target unless sending elsewhere.";
  return `${description} For this turn, use action="send" with message for visible replies to the current source conversation. ${targetGuidance} Normal final answers stay private.`;
}

function appendMessageToolReadHint(
  description: string,
  actions: Iterable<ChannelMessageActionName | "send">,
): string {
  for (const action of actions) {
    if (action === "read") {
      return `${description}${MESSAGE_TOOL_THREAD_READ_HINT}`;
    }
  }
  return description;
}

export function createMessageTool(options?: MessageToolOptions): AnyAgentTool {
  const loadConfigForTool = options?.getRuntimeConfig ?? getRuntimeConfig;
  const getScopedSecretTargetsForTool =
    options?.getScopedChannelsCommandSecretTargets ?? getScopedChannelsCommandSecretTargets;
  const resolveSecretRefsForTool =
    options?.resolveCommandSecretRefsViaGateway ?? resolveCommandSecretRefsViaGateway;
  const runMessageActionForTool = options?.runMessageAction ?? runMessageAction;
  const agentAccountId = resolveAgentAccountId(options?.agentAccountId);
  const currentThreadTs =
    options?.currentThreadTs ??
    (options?.agentThreadId != null ? stringifyRouteThreadId(options.agentThreadId) : undefined);
  const replyToMode = options?.replyToMode ?? (currentThreadTs ? "all" : undefined);
  const resolvedAgentId =
    options?.agentId ??
    (options?.agentSessionKey
      ? resolveSessionAgentId({
          sessionKey: options.agentSessionKey,
          config: options?.config,
        })
      : undefined);
  const schema = options?.config
    ? buildMessageToolSchema({
        cfg: options.config,
        currentChannelProvider: options.currentChannelProvider,
        currentChannelId: options.currentChannelId,
        currentThreadTs,
        currentMessageId: options.currentMessageId,
        currentAccountId: agentAccountId,
        sessionKey: options.agentSessionKey,
        sessionId: options.sessionId,
        agentId: resolvedAgentId,
        requesterSenderId: options.requesterSenderId,
        senderIsOwner: options.senderIsOwner,
      })
    : MessageToolSchema;
  const description = buildMessageToolDescription({
    config: options?.config,
    currentChannel: options?.currentChannelProvider,
    currentChannelId: options?.currentChannelId,
    currentThreadTs,
    currentMessageId: options?.currentMessageId,
    currentAccountId: agentAccountId,
    sessionKey: options?.agentSessionKey,
    sessionId: options?.sessionId,
    agentId: resolvedAgentId,
    requireExplicitTarget: options?.requireExplicitTarget,
    sourceReplyDeliveryMode: options?.sourceReplyDeliveryMode,
    requesterSenderId: options?.requesterSenderId,
    senderIsOwner: options?.senderIsOwner,
  });

  return {
    label: "Message",
    name: "message",
    displaySummary: "Send and manage messages across configured channels.",
    description,
    parameters: schema,
    execute: async (_toolCallId, args, signal) => {
      // Check if already aborted before doing any work
      if (signal?.aborted) {
        const err = new Error("Message send aborted");
        err.name = "AbortError";
        throw err;
      }
      // Shallow-copy so we don't mutate the original event args (used for logging/dedup).
      const params = { ...(args as Record<string, unknown>) };

      // Strip reasoning tags from text fields — models may include <think>…</think>
      // in tool arguments, and the messaging tool send path has no other tag filtering.
      for (const field of ["text", "content", "message", "caption"]) {
        if (typeof params[field] === "string") {
          params[field] = stripFormattedReasoningMessage(params[field]);
        }
      }
      params.presentation = sanitizePresentationTextFields(params.presentation);

      const action = readStringParam(params, "action", {
        required: true,
      }) as ChannelMessageActionName;
      const requireExplicitTarget = options?.requireExplicitTarget === true;
      if (requireExplicitTarget && actionNeedsExplicitTarget(action)) {
        const explicitTarget =
          (typeof params.target === "string" && params.target.trim().length > 0) ||
          (typeof params.to === "string" && params.to.trim().length > 0) ||
          (typeof params.channelId === "string" && params.channelId.trim().length > 0) ||
          (Array.isArray(params.targets) &&
            params.targets.some((value) => typeof value === "string" && value.trim().length > 0));
        if (!explicitTarget) {
          throw new Error(
            "Explicit message target required for this run. Provide target/targets (and channel when needed).",
          );
        }
      }

      const rawConfig = options?.config ?? loadConfigForTool();
      const scope = resolveMessageSecretScope({
        channel: params.channel,
        target: params.target,
        targets: params.targets,
        fallbackChannel: options?.currentChannelProvider,
        accountId: params.accountId,
        fallbackAccountId: agentAccountId,
      });
      const scopedTargets = getScopedSecretTargetsForTool({
        config: rawConfig,
        channel: scope.channel,
        accountId: scope.accountId,
      });
      const cfg = (
        await resolveSecretRefsForTool({
          config: rawConfig,
          commandName: "tools.message",
          targetIds: scopedTargets.targetIds,
          ...(scopedTargets.allowedPaths ? { allowedPaths: scopedTargets.allowedPaths } : {}),
          mode: "enforce_resolved",
        })
      ).resolvedConfig;

      const accountId = readStringParam(params, "accountId") ?? agentAccountId;
      if (accountId) {
        params.accountId = accountId;
      }

      const gatewayResolved = resolveGatewayOptions({
        gatewayUrl: readStringParam(params, "gatewayUrl", { trim: false }),
        gatewayToken: readStringParam(params, "gatewayToken", { trim: false }),
        timeoutMs: readNumberParam(params, "timeoutMs"),
      });
      const gateway = {
        url: gatewayResolved.url,
        token: gatewayResolved.token,
        timeoutMs: gatewayResolved.timeoutMs,
        clientName: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        clientDisplayName: "agent",
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      };
      const hasCurrentMessageId =
        typeof options?.currentMessageId === "number" ||
        (typeof options?.currentMessageId === "string" &&
          options.currentMessageId.trim().length > 0);

      const toolContext =
        options?.currentChannelId ||
        options?.currentChannelProvider ||
        currentThreadTs ||
        hasCurrentMessageId ||
        replyToMode ||
        options?.hasRepliedRef
          ? {
              currentChannelId: options?.currentChannelId,
              currentChannelProvider: options?.currentChannelProvider,
              currentThreadTs,
              currentMessageId: options?.currentMessageId,
              replyToMode,
              hasRepliedRef: options?.hasRepliedRef,
              // Direct tool invocations should not add cross-context decoration.
              // The agent is composing a message, not forwarding from another chat.
              skipCrossContextDecoration: true,
            }
          : undefined;

      const result = await runMessageActionForTool({
        cfg,
        action,
        params,
        defaultAccountId: accountId ?? undefined,
        requesterSenderId: options?.requesterSenderId,
        senderIsOwner: options?.senderIsOwner,
        gateway,
        toolContext,
        sessionKey: options?.agentSessionKey,
        sessionId: options?.sessionId,
        agentId: resolvedAgentId,
        sandboxRoot: options?.sandboxRoot,
        sourceReplyDeliveryMode: options?.sourceReplyDeliveryMode,
        inboundEventKind: options?.inboundEventKind,
        abortSignal: signal,
      });

      const toolResult = getToolResult(result);
      if (toolResult) {
        return toolResult;
      }
      return jsonResult(result.payload);
    },
  };
}
