/**
 * message built-in tool.
 *
 * Sends, edits, reacts to, polls, and routes messages through channel plugins and Gateway-backed actions.
 */
import {
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "@openclaw/normalization-core/string-coerce";
import { sortUniqueStrings, uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { Type, type TSchema } from "typebox";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { SourceReplyDeliveryMode } from "../../auto-reply/get-reply-options.types.js";
import {
  hasInboundMetadataSentinel,
  stripInboundMetadata,
} from "../../auto-reply/reply/strip-inbound-meta.js";
import type { InboundEventKind } from "../../channels/inbound-event/kind.js";
import {
  getChannelPlugin,
  getLoadedChannelPlugin,
  listChannelPlugins,
} from "../../channels/plugins/index.js";
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
import {
  getBootEchoContextForSession,
  stripBootEchoFromOutboundText,
} from "../../gateway/boot-echo-guard.js";
import { createAbortError } from "../../infra/abort-signal.js";
import { sha256Base64UrlPrefix } from "../../infra/crypto-digest.js";
import {
  parseInteractiveParam,
  parseJsonMessageParam,
} from "../../infra/outbound/message-action-params.js";
import {
  getToolResult,
  runMessageAction,
  type MessageActionRunResult,
} from "../../infra/outbound/message-action-runner.js";
import { resolveActionDeliveryTargetAlias } from "../../infra/outbound/message-action-spec.js";
import {
  resolveAllowedMessageActions,
  shouldApplyCrossContextMarker,
} from "../../infra/outbound/outbound-policy.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { stringifyRouteThreadId } from "../../plugin-sdk/channel-route.js";
import { POLL_CREATION_PARAM_DEFS, SHARED_POLL_CREATION_PARAM_NAMES } from "../../poll-params.js";
import { normalizeAccountId, parseSessionDeliveryRoute } from "../../routing/session-key.js";
import { stripFormattedReasoningMessage } from "../../shared/text/formatted-reasoning-message.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { listAllChannelSupportedActions, listChannelSupportedActions } from "../channel-tools.js";
import { stripInternalRuntimeContext } from "../internal-runtime-context.js";
import {
  channelTargetSchema,
  channelTargetsSchema,
  optionalNonNegativeIntegerSchema,
  optionalPositiveIntegerSchema,
  stringEnum,
} from "../schema/typebox.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringArrayParam, readStringParam } from "./common.js";
import { gatewayCallOptionSchemaProperties } from "./gateway-schema.js";
import {
  readGatewayCallOptions,
  resolveGatewayOptions,
  type GatewayCallOptions,
} from "./gateway.js";
import { isPollVoteEchoText } from "./poll-vote-echo.js";

const AllMessageActions = CHANNEL_MESSAGE_ACTION_NAMES;
const MESSAGE_TOOL_THREAD_READ_HINT =
  ' Use action="read" with threadId to fetch prior messages in a thread when you need conversation context you do not have yet.';
function actionNeedsExplicitTarget(action: ChannelMessageActionName): boolean {
  return action === "broadcast" || shouldApplyCrossContextMarker(action);
}

function normalizeMessageToolIdempotencyKeyPart(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  return normalized.replace(/[^A-Za-z0-9._:-]+/gu, "_");
}

const MESSAGE_TOOL_IDEMPOTENCY_ENVELOPE_PARAM_NAMES = [
  "gatewayToken",
  "gatewayUrl",
  "idempotencyKey",
  "timeoutMs",
] satisfies Array<keyof GatewayCallOptions | "idempotencyKey">;
const MESSAGE_TOOL_IDEMPOTENCY_ENVELOPE_PARAM_KEYS = new Set<string>(
  MESSAGE_TOOL_IDEMPOTENCY_ENVELOPE_PARAM_NAMES,
);

function stripMessageToolIdempotencyEnvelope(
  params: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(params).toSorted()) {
    if (!MESSAGE_TOOL_IDEMPOTENCY_ENVELOPE_PARAM_KEYS.has(key)) {
      out[key] = params[key];
    }
  }
  return out;
}

function canonicalizeMessageToolIdempotencyValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeMessageToolIdempotencyValue(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).toSorted()) {
    out[key] = canonicalizeMessageToolIdempotencyValue(record[key]);
  }
  return out;
}

function buildMessageToolDeliveryFingerprint(params: {
  action: ChannelMessageActionName;
  params: Record<string, unknown>;
}): string {
  const canonical = JSON.stringify(
    canonicalizeMessageToolIdempotencyValue({
      action: params.action,
      params: stripMessageToolIdempotencyEnvelope(params.params),
    }),
  );
  return sha256Base64UrlPrefix(canonical, 24);
}

function buildMessageToolAutogeneratedIdempotencyKey(params: {
  runId: string;
  deliveryFingerprint: string;
  operationId: string;
}): string {
  return `${params.runId}:message-tool:${params.deliveryFingerprint}:${params.operationId}`;
}

function normalizeEscapedLineBreaksForVisibleText(text: string): string {
  if (!text.includes("\\")) {
    return text;
  }
  // The send path turns literal "\n" sequences into line breaks later; match
  // that before privacy stripping so escaped delimiter lines cannot bypass it.
  return text.replace(/\\r\\n|\\n|\\r/g, "\n");
}

type VisibleTextSuppressionReason =
  | "internal_runtime_context_echo"
  | "inbound_metadata_echo"
  | "poll_vote_echo";

const POLL_VOTE_ECHO_TTL_MS = 30_000;

// Keyed by agent session (conversation), NOT per message-tool instance: a native
// poll and its accompanying comment arrive as separate inbound messages and are
// processed in separate agent runs, each with a fresh tool instance. An
// instance-local record would be lost before the follow-up text run, so the echo
// (the agent restating its vote in prose) would leak. Session-scoped +
// route-checked storage lets the vote in one run suppress the restatement in the
// next while never crossing conversations. Single slot per session, TTL-bounded.
const recentPollVoteBySession = new Map<
  string,
  { option: string; route: string; recordedAt: number }
>();

function resolvePollVoteEchoRoute(params: {
  action: ChannelMessageActionName;
  args: Record<string, unknown>;
  channel?: string | null;
  accountId?: string;
  currentChannelId?: string;
  currentMessagingTarget?: string;
}): string | undefined {
  const channel = normalizeMessageChannel(params.channel);
  if (!channel) {
    return undefined;
  }
  let deliveryAliasTarget: string | undefined;
  try {
    deliveryAliasTarget = resolveActionDeliveryTargetAlias(params.action, params.args, {
      channel,
      aliasSpec: getChannelPlugin(channel)?.actions?.messageActionTargetAliases?.[params.action],
    });
  } catch {
    return undefined;
  }
  const targets = ["target", "to", "channelId"]
    .map((key) => normalizeOptionalStringifiedId(params.args[key]))
    .concat(deliveryAliasTarget ?? [])
    .filter((value): value is string => Boolean(value));
  if (new Set(targets).size > 1) {
    return undefined;
  }
  const target = targets[0];
  const currentTargets = new Set(
    [params.currentMessagingTarget, params.currentChannelId].filter((value): value is string =>
      Boolean(value),
    ),
  );
  // Plugin-declared aliases keep owner-specific target fields out of core.
  // A route mismatch fails open; provider/account keys prevent cross-send suppression.
  const routeTarget = !target || currentTargets.has(target) ? "<current-source>" : target;
  return `${channel}\0${normalizeAccountId(params.accountId ?? "default")}\0${routeTarget}`;
}

function sanitizeUserVisibleToolTextResult(
  text: string,
  bootPrompt: string | undefined,
): {
  text: string;
  suppressionReason?: VisibleTextSuppressionReason;
} {
  const normalized = normalizeEscapedLineBreaksForVisibleText(text);
  const strippedReasoning = stripFormattedReasoningMessage(normalized);
  const strippedInternal = stripInternalRuntimeContext(strippedReasoning);
  const strippedBoot = stripBootEchoFromOutboundText(strippedInternal, bootPrompt);
  const strippedInbound = hasInboundMetadataSentinel(strippedBoot)
    ? stripInboundMetadata(strippedBoot)
    : strippedBoot;
  const suppressionReason =
    strippedBoot.trim().length === 0 &&
    strippedReasoning.trim().length > 0 &&
    (strippedInternal !== strippedReasoning || strippedBoot !== strippedInternal)
      ? "internal_runtime_context_echo"
      : strippedInbound.trim().length === 0 &&
          strippedBoot.trim().length > 0 &&
          strippedInbound !== strippedBoot
        ? "inbound_metadata_echo"
        : undefined;
  return {
    text: strippedInbound,
    ...(suppressionReason ? { suppressionReason } : {}),
  };
}

function sanitizeStringParam(
  params: Record<string, unknown>,
  field: string,
  bootPrompt: string | undefined,
): VisibleTextSuppressionReason | undefined {
  if (typeof params[field] !== "string") {
    return undefined;
  }
  const sanitized = sanitizeUserVisibleToolTextResult(params[field], bootPrompt);
  params[field] = sanitized.text;
  return sanitized.suppressionReason;
}

function sanitizeStringArrayParam(
  params: Record<string, unknown>,
  field: string,
  bootPrompt: string | undefined,
): VisibleTextSuppressionReason | undefined {
  const value = params[field];
  if (typeof value === "string") {
    const sanitized = sanitizeUserVisibleToolTextResult(value, bootPrompt);
    params[field] = sanitized.text;
    return sanitized.suppressionReason;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  let suppressionReason: VisibleTextSuppressionReason | undefined;
  params[field] = value.map((entry) => {
    if (typeof entry !== "string") {
      return entry;
    }
    const sanitized = sanitizeUserVisibleToolTextResult(entry, bootPrompt);
    suppressionReason ??= sanitized.suppressionReason;
    return sanitized.text;
  });
  return suppressionReason;
}

function sanitizePresentationTextFieldsResult(
  value: unknown,
  bootPrompt: string | undefined,
): { value: unknown; suppressionReason?: VisibleTextSuppressionReason } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { value };
  }
  let suppressionReason: VisibleTextSuppressionReason | undefined;
  const presentation = { ...(value as Record<string, unknown>) };
  if (typeof presentation.title === "string") {
    const sanitized = sanitizeUserVisibleToolTextResult(presentation.title, bootPrompt);
    presentation.title = sanitized.text;
    suppressionReason ??= sanitized.suppressionReason;
  }
  if (Array.isArray(presentation.blocks)) {
    presentation.blocks = presentation.blocks.map((block) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) {
        return block;
      }
      const sanitizedBlock = { ...(block as Record<string, unknown>) };
      for (const field of ["text", "placeholder"]) {
        if (typeof sanitizedBlock[field] === "string") {
          const sanitized = sanitizeUserVisibleToolTextResult(sanitizedBlock[field], bootPrompt);
          sanitizedBlock[field] = sanitized.text;
          suppressionReason ??= sanitized.suppressionReason;
        }
      }
      if (Array.isArray(sanitizedBlock.buttons)) {
        sanitizedBlock.buttons = sanitizedBlock.buttons.map((button) => {
          if (!button || typeof button !== "object" || Array.isArray(button)) {
            return button;
          }
          const sanitizedButton = { ...(button as Record<string, unknown>) };
          if (typeof sanitizedButton.label === "string") {
            const sanitized = sanitizeUserVisibleToolTextResult(sanitizedButton.label, bootPrompt);
            sanitizedButton.label = sanitized.text;
            suppressionReason ??= sanitized.suppressionReason;
          }
          if (typeof sanitizedButton.url === "string") {
            const sanitized = sanitizeUserVisibleToolTextResult(sanitizedButton.url, bootPrompt);
            if (sanitized.text) {
              sanitizedButton.url = sanitized.text;
            } else {
              delete sanitizedButton.url;
            }
            suppressionReason ??= sanitized.suppressionReason;
          }
          for (const webAppField of ["webApp", "web_app"]) {
            const webApp = sanitizedButton[webAppField];
            if (!webApp || typeof webApp !== "object" || Array.isArray(webApp)) {
              continue;
            }
            const sanitizedWebApp = { ...(webApp as Record<string, unknown>) };
            if (typeof sanitizedWebApp.url !== "string") {
              continue;
            }
            const sanitized = sanitizeUserVisibleToolTextResult(sanitizedWebApp.url, bootPrompt);
            if (sanitized.text) {
              sanitizedWebApp.url = sanitized.text;
              sanitizedButton[webAppField] = sanitizedWebApp;
            } else {
              delete sanitizedButton[webAppField];
            }
            suppressionReason ??= sanitized.suppressionReason;
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
            const sanitized = sanitizeUserVisibleToolTextResult(sanitizedOption.label, bootPrompt);
            sanitizedOption.label = sanitized.text;
            suppressionReason ??= sanitized.suppressionReason;
          }
          return sanitizedOption;
        });
      }
      return sanitizedBlock;
    });
  }
  return { value: presentation, ...(suppressionReason ? { suppressionReason } : {}) };
}

function readFirstStringParam(params: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = readStringParam(params, key);
    if (value) {
      return value;
    }
  }
  return "";
}

function readStructuredAttachmentMediaParams(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const values: string[] = [];
  for (const attachment of value) {
    if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
      continue;
    }
    const record = attachment as Record<string, unknown>;
    for (const key of ["media", "mediaUrl", "path", "filePath", "fileUrl", "url"]) {
      const candidate = readStringParam(record, key);
      if (candidate) {
        values.push(candidate);
      }
    }
  }
  return values;
}

function hasSanitizedSendPayloadContent(params: Record<string, unknown>): boolean {
  const text = ["message", "text", "content", "caption", "SendMessage"]
    .map((field) => (typeof params[field] === "string" ? params[field] : ""))
    .filter((value) => value.trim())
    .join("\n");
  const mediaUrls = [
    ...(readStringArrayParam(params, "mediaUrls") ?? []),
    ...readStructuredAttachmentMediaParams(params.attachments),
  ];
  return hasReplyPayloadContent(
    {
      text,
      mediaUrl: readFirstStringParam(params, ["media", "mediaUrl", "path", "filePath", "fileUrl"]),
      mediaUrls,
      presentation: params.presentation,
      interactive: params.interactive,
    },
    { trimText: true },
  );
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

const presentationActionSchema = Type.Union([
  Type.Object({
    type: Type.Literal("command"),
    command: Type.String(),
  }),
  Type.Object({
    type: Type.Literal("callback"),
    value: Type.String(),
  }),
]);

const presentationOptionSchema = Type.Object({
  label: Type.String(),
  action: Type.Optional(presentationActionSchema),
  value: Type.Optional(Type.String()),
});

const presentationButtonSchema = Type.Object({
  label: Type.String(),
  action: Type.Optional(presentationActionSchema),
  value: Type.Optional(Type.String()),
  url: Type.Optional(Type.String()),
  webApp: Type.Optional(Type.Object({ url: Type.String() })),
  web_app: Type.Optional(Type.Object({ url: Type.String() })),
  disabled: Type.Optional(Type.Boolean()),
  reusable: Type.Optional(Type.Boolean()),
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
      "Rich message payload: text/buttons/selects/context. Unsupported blocks degrade to text.",
  },
);

function buildSendSchema(options: {
  includePresentation: boolean;
  includeDeliveryPin: boolean;
  includeBestEffort: boolean;
}) {
  const props: Record<string, TSchema> = {
    message: Type.Optional(Type.String()),
    effectId: Type.Optional(
      Type.String({
        description: "Effect id/name for sendWithEffect.",
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
        description: "Base64 attachment payload; data URL ok.",
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
          description: "Structured attachments; each entry uses media.",
        },
      ),
    ),
    replyTo: Type.Optional(Type.String()),
    threadId: Type.Optional(Type.String()),
    asVoice: Type.Optional(Type.Boolean()),
    silent: Type.Optional(Type.Boolean()),
    quoteText: Type.Optional(Type.String({ description: "Telegram reply quote text." })),
    gifPlayback: Type.Optional(Type.Boolean()),
    forceDocument: Type.Optional(
      Type.Boolean({
        description: "Send image/GIF/video as document; avoids compression.",
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
        description:
          "Optional delivery mode. Omit or set true for ordinary replies. Set false only when required durable delivery is necessary.",
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
          description: "Delivery prefs. pin requests pin when channel supports it.",
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
          "Target message id for read/react/edit/delete/pin/unpin. Reaction-like defaults current inbound id when available.",
      }),
    ),
    message_id: Type.Optional(
      Type.String({
        // Intentional duplicate alias for tool-schema discoverability in LLMs.
        description: "snake_case alias of messageId; same defaults.",
      }),
    ),
    emoji: Type.Optional(Type.String()),
    remove: Type.Optional(Type.Boolean()),
    trackToolCalls: Type.Optional(
      Type.Boolean({
        description:
          "For current-message reaction, make reacted message the tool-progress reaction target.",
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
    limit: optionalPositiveIntegerSchema(),
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
          "User id for member-info and channel-specific moderation or participant actions. For member-info, pass userId directly; the action does not accept target.",
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
    autoArchiveMin: optionalPositiveIntegerSchema(),
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
    image: Type.Optional(Type.String({ description: "Event cover image URL/path." })),
    durationMin: optionalNonNegativeIntegerSchema(),
    until: Type.Optional(Type.String()),
  };
}

function buildModerationSchema() {
  return {
    reason: Type.Optional(Type.String()),
    deleteDays: optionalNonNegativeIntegerSchema({ maximum: 7 }),
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
        description: "Numeric channel type, e.g. Discord. Avoids JSON Schema `type` collision.",
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
  includeBestEffort: boolean;
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
    includeBestEffort: boolean;
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
  includeBestEffort: false,
});

type MessageToolOptions = {
  agentAccountId?: string;
  agentSessionKey?: string;
  runId?: string;
  sessionId?: string;
  agentId?: string;
  config?: OpenClawConfig;
  getRuntimeConfig?: () => OpenClawConfig;
  getScopedChannelsCommandSecretTargets?: typeof getScopedChannelsCommandSecretTargets;
  resolveCommandSecretRefsViaGateway?: typeof resolveCommandSecretRefsViaGateway;
  runMessageAction?: typeof runMessageAction;
  currentChannelId?: string;
  currentMessagingTarget?: string;
  currentChannelProvider?: string;
  currentThreadTs?: string;
  agentThreadId?: string | number;
  currentMessageId?: string | number;
  currentInboundAudio?: boolean;
  hasCurrentInboundAudio?: () => boolean;
  replyToMode?: "off" | "first" | "all" | "batched";
  hasRepliedRef?: { value: boolean };
  sameChannelThreadRequired?: boolean;
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

type InferredSessionDelivery = {
  accountId?: string;
  channel: string;
  threadId?: string;
  to: string;
};

const USER_PREFIXED_DIRECT_TARGET_CHANNELS = new Set(["discord", "mattermost", "msteams", "slack"]);

function formatSessionDeliveryTarget(channel: string, peerKind: string, to: string): string {
  return (peerKind === "direct" || peerKind === "dm") &&
    USER_PREFIXED_DIRECT_TARGET_CHANNELS.has(channel)
    ? `user:${to}`
    : to;
}

function inferDeliveryFromSessionKey(
  sessionKey: string | undefined,
): InferredSessionDelivery | null {
  const route = parseSessionDeliveryRoute(sessionKey);
  if (!route) {
    return null;
  }
  const channel = normalizeMessageChannel(route.channel);
  if (!channel) {
    return null;
  }
  const accountId = route.accountId ? resolveAgentAccountId(route.accountId) : undefined;
  return {
    accountId,
    channel,
    threadId: route.threadId,
    to: formatSessionDeliveryTarget(channel, route.peerKind, route.peerId),
  };
}

function resolveEffectiveCurrentChannelContext(options?: MessageToolOptions): {
  accountId?: string;
  currentChannelId?: string;
  currentMessagingTarget?: string;
  currentChannelProvider?: string;
  currentThreadTs?: string;
} {
  const currentChannelProvider = options?.currentChannelProvider;
  const currentChannelId = options?.currentChannelId;
  const sessionDelivery = inferDeliveryFromSessionKey(options?.agentSessionKey);
  const sessionDeliveryChannel = normalizeMessageChannel(sessionDelivery?.channel);
  const preferSessionDeliveryContext =
    normalizeMessageChannel(currentChannelProvider) === "webchat" &&
    sessionDeliveryChannel !== undefined &&
    sessionDeliveryChannel !== "webchat" &&
    Boolean(sessionDelivery?.to);

  if (!preferSessionDeliveryContext) {
    return {
      currentChannelProvider,
      currentChannelId,
      currentMessagingTarget: options?.currentMessagingTarget,
    };
  }
  return {
    accountId: sessionDelivery?.accountId,
    currentChannelProvider: sessionDeliveryChannel,
    currentChannelId: sessionDelivery?.to,
    currentMessagingTarget: sessionDelivery?.to,
    currentThreadTs: sessionDelivery?.threadId,
  };
}

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
  return uniqueValues<ChannelMessageActionName>(["send", "broadcast", ...pluginActions]);
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

function resolveIncludeBestEffort(params: MessageToolDiscoveryParams): boolean {
  const currentChannel = normalizeMessageChannel(params.currentChannelProvider);
  if (!currentChannel) {
    return false;
  }
  const adapter =
    listChannelPlugins().find((plugin) => plugin.id === currentChannel)?.message ??
    getLoadedChannelPlugin(currentChannel as Parameters<typeof getLoadedChannelPlugin>[0])
      ?.message ??
    getChannelPlugin(currentChannel as Parameters<typeof getChannelPlugin>[0])?.message;
  return (
    adapter?.durableFinal?.capabilities?.reconcileUnknownSend === true &&
    typeof adapter.durableFinal.reconcileUnknownSend === "function"
  );
}

function buildMessageToolSchema(params: MessageToolDiscoveryParams) {
  const actions = resolveMessageToolActionSchemaActions(params);
  const includePresentation = resolveIncludePresentation(params);
  const includeDeliveryPin = resolveIncludeDeliveryPin(params);
  const includeBestEffort = resolveIncludeBestEffort(params);
  const extraProperties = resolveChannelMessageToolSchemaProperties(
    buildMessageActionDiscoveryInput(
      params,
      normalizeMessageChannel(params.currentChannelProvider) ?? undefined,
    ),
  );
  return buildMessageToolSchemaFromActions(actions.length > 0 ? actions : ["send"], {
    includePresentation,
    includeDeliveryPin,
    includeBestEffort,
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
  const baseDescription = "Send/delete/manage channel messages.";
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
      const sortedActions = sortUniqueStrings(actions) as Array<ChannelMessageActionName | "send">;
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
    : "target defaults to the current source conversation; omit unless sending elsewhere.";
  return `${description} This turn: use action="send" with message for visible replies to the current source conversation. ${targetGuidance} Normal final answers stay private.`;
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
  let generatedIdempotencyCounter = 0;
  // Poll-vote echo record lives in the session-scoped map (recentPollVoteBySession)
  // so it survives the run boundary between the vote and the follow-up text; a
  // null session key disables the guard.
  const pollEchoSessionKey = options?.agentSessionKey?.trim() || undefined;
  const failedAutogeneratedIdempotencyKeys = new Map<string, string>();
  const effectiveCurrentChannel = resolveEffectiveCurrentChannelContext(options);
  const currentThreadTs =
    options?.currentThreadTs ??
    (options?.agentThreadId != null
      ? stringifyRouteThreadId(options.agentThreadId)
      : effectiveCurrentChannel.currentThreadTs);
  const replyToMode = options?.replyToMode ?? (currentThreadTs ? "all" : undefined);
  const agentAccountId =
    resolveAgentAccountId(options?.agentAccountId) ?? effectiveCurrentChannel.accountId;
  const currentChannelIsInternal =
    normalizeMessageChannel(effectiveCurrentChannel.currentChannelProvider) ===
    INTERNAL_MESSAGE_CHANNEL;
  // WebChat tool sends use the private sink without changing the run-level
  // contract: ordinary final answers must remain automatic and visible.
  const sourceReplySinkDeliveryMode = currentChannelIsInternal
    ? "message_tool_only"
    : options?.sourceReplyDeliveryMode;
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
        currentChannelProvider: effectiveCurrentChannel.currentChannelProvider,
        currentChannelId: effectiveCurrentChannel.currentChannelId,
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
    currentChannel: effectiveCurrentChannel.currentChannelProvider,
    currentChannelId: effectiveCurrentChannel.currentChannelId,
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
    execute: async (toolCallId, args, signal) => {
      if (signal?.aborted) {
        throw createAbortError("Message send aborted");
      }
      // Shallow-copy so we don't mutate the original event args (used for logging/dedup).
      const params = { ...(args as Record<string, unknown>) };

      // Sanitize outbound text fields in three layers:
      //
      // 1. `stripFormattedReasoningMessage` — drops reasoning blocks
      //    that some models emit into tool arguments.
      // 2. `stripInternalRuntimeContext` — removes internal-runtime-context
      //    delimited blocks (the same strip applied to final replies via
      //    `sanitizeUserFacingText`). Catches wrapped BOOT.md or webchat
      //    runtime-context echoes that preserve the marker lines.
      // 3. `stripBootEchoFromOutboundText` — defense-in-depth check against
      //    the active boot prompt for this session. Catches verbatim echoes
      //    that paraphrase out the wrapper markers but reproduce a
      //    substantial chunk of the boot prompt content. Refs #53732.
      const bootPromptForSession = getBootEchoContextForSession(options?.agentSessionKey);
      let suppressedVisiblePayloadReason: VisibleTextSuppressionReason | undefined;
      parseJsonMessageParam(params, "presentation");
      parseInteractiveParam(params);
      for (const field of [
        "text",
        "content",
        "message",
        "caption",
        "SendMessage",
        "quoteText",
        "quote_text",
      ]) {
        const suppressionReason = sanitizeStringParam(params, field, bootPromptForSession);
        suppressedVisiblePayloadReason ??= suppressionReason;
      }
      for (const field of ["pollQuestion", "poll_question"]) {
        const suppressionReason = sanitizeStringParam(params, field, bootPromptForSession);
        suppressedVisiblePayloadReason ??= suppressionReason;
      }
      for (const field of ["pollOption", "poll_option"]) {
        const suppressionReason = sanitizeStringArrayParam(params, field, bootPromptForSession);
        suppressedVisiblePayloadReason ??= suppressionReason;
      }
      const sanitizedPresentation = sanitizePresentationTextFieldsResult(
        params.presentation,
        bootPromptForSession,
      );
      params.presentation = sanitizedPresentation.value;
      suppressedVisiblePayloadReason ??= sanitizedPresentation.suppressionReason;
      const sanitizedInteractive = sanitizePresentationTextFieldsResult(
        params.interactive,
        bootPromptForSession,
      );
      params.interactive = sanitizedInteractive.value;
      suppressedVisiblePayloadReason ??= sanitizedInteractive.suppressionReason;

      const action = readStringParam(params, "action", {
        required: true,
      }) as ChannelMessageActionName;
      if (
        suppressedVisiblePayloadReason &&
        action === "send" &&
        !hasSanitizedSendPayloadContent(params)
      ) {
        return jsonResult({
          status: "suppressed",
          reason: suppressedVisiblePayloadReason,
          message:
            suppressedVisiblePayloadReason === "inbound_metadata_echo"
              ? "Suppressed outbound message text because it matched inbound runtime metadata."
              : "Suppressed outbound message text because it matched internal runtime context.",
        });
      }
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

      const gatewayOpts = readGatewayCallOptions(params);
      const rawConfig = options?.config ?? loadConfigForTool();
      const scope = resolveMessageSecretScope({
        channel: params.channel,
        target: params.target,
        targets: params.targets,
        fallbackChannel: effectiveCurrentChannel.currentChannelProvider,
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
      const pollVoteEchoRoute = resolvePollVoteEchoRoute({
        action,
        args: params,
        channel: scope.channel ?? effectiveCurrentChannel.currentChannelProvider,
        accountId,
        currentChannelId: effectiveCurrentChannel.currentChannelId,
        currentMessagingTarget: effectiveCurrentChannel.currentMessagingTarget,
      });
      const recentPollVote = pollEchoSessionKey
        ? recentPollVoteBySession.get(pollEchoSessionKey)
        : undefined;
      if (
        recentPollVote &&
        pollEchoSessionKey &&
        sourceReplySinkDeliveryMode === "message_tool_only" &&
        (action === "send" || action === "reply")
      ) {
        if (Date.now() - recentPollVote.recordedAt > POLL_VOTE_ECHO_TTL_MS) {
          recentPollVoteBySession.delete(pollEchoSessionKey);
        } else if (pollVoteEchoRoute === recentPollVote.route) {
          const vote = recentPollVote;
          recentPollVoteBySession.delete(pollEchoSessionKey);
          const outboundText =
            readStringParam(params, "text") ??
            readStringParam(params, "message") ??
            readStringParam(params, "content");
          if (outboundText && isPollVoteEchoText(vote.option, outboundText)) {
            return jsonResult({
              status: "suppressed",
              reason: "poll_vote_echo" satisfies VisibleTextSuppressionReason,
              message: "Suppressed outbound text because it only restated the poll vote just cast.",
            });
          }
        }
      }

      const gatewayResolved = resolveGatewayOptions(gatewayOpts);
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
        effectiveCurrentChannel.currentChannelId ||
        effectiveCurrentChannel.currentChannelProvider ||
        effectiveCurrentChannel.currentMessagingTarget ||
        currentThreadTs ||
        hasCurrentMessageId ||
        replyToMode ||
        options?.hasRepliedRef ||
        options?.sameChannelThreadRequired
          ? {
              currentChannelId: effectiveCurrentChannel.currentChannelId,
              currentMessagingTarget: effectiveCurrentChannel.currentMessagingTarget,
              currentChannelProvider: effectiveCurrentChannel.currentChannelProvider,
              currentThreadTs,
              currentMessageId: options?.currentMessageId,
              replyToMode,
              hasRepliedRef: options?.hasRepliedRef,
              sameChannelThreadRequired: options?.sameChannelThreadRequired,
              // Direct tool invocations should not add cross-context decoration.
              // The agent is composing a message, not forwarding from another chat.
              skipCrossContextDecoration: true,
            }
          : undefined;

      let autogeneratedDeliveryFingerprint: string | undefined;
      let actionIdempotencyKey = normalizeOptionalString(params.idempotencyKey);
      if (!actionIdempotencyKey && options?.runId) {
        autogeneratedDeliveryFingerprint = buildMessageToolDeliveryFingerprint({ action, params });
        actionIdempotencyKey = failedAutogeneratedIdempotencyKeys.get(
          autogeneratedDeliveryFingerprint,
        );
        if (!actionIdempotencyKey) {
          const operationId =
            normalizeMessageToolIdempotencyKeyPart(toolCallId) ??
            String(++generatedIdempotencyCounter);
          actionIdempotencyKey = buildMessageToolAutogeneratedIdempotencyKey({
            runId: normalizeMessageToolIdempotencyKeyPart(options.runId) ?? options.runId,
            deliveryFingerprint: autogeneratedDeliveryFingerprint,
            operationId,
          });
        }
      }
      const actionParams = actionIdempotencyKey
        ? { ...params, idempotencyKey: actionIdempotencyKey }
        : params;

      let result: MessageActionRunResult;
      try {
        result = await runMessageActionForTool({
          cfg,
          action,
          params: actionParams,
          defaultAccountId: accountId ?? undefined,
          requesterAccountId: agentAccountId,
          requesterSenderId: options?.requesterSenderId,
          senderIsOwner: options?.senderIsOwner,
          gateway,
          toolContext,
          sessionKey: options?.agentSessionKey,
          sessionId: options?.sessionId,
          agentId: resolvedAgentId,
          sandboxRoot: options?.sandboxRoot,
          sourceReplyDeliveryMode: sourceReplySinkDeliveryMode,
          inboundEventKind: options?.inboundEventKind,
          inboundAudio: options?.hasCurrentInboundAudio?.() ?? options?.currentInboundAudio,
          abortSignal: signal,
        });
      } catch (error) {
        if (autogeneratedDeliveryFingerprint && actionIdempotencyKey) {
          failedAutogeneratedIdempotencyKeys.set(
            autogeneratedDeliveryFingerprint,
            actionIdempotencyKey,
          );
        }
        throw error;
      }
      if (
        autogeneratedDeliveryFingerprint &&
        failedAutogeneratedIdempotencyKeys.get(autogeneratedDeliveryFingerprint) ===
          actionIdempotencyKey
      ) {
        failedAutogeneratedIdempotencyKeys.delete(autogeneratedDeliveryFingerprint);
      }

      const toolResult = getToolResult(result);
      if (
        action === "poll-vote" &&
        pollVoteEchoRoute &&
        pollEchoSessionKey &&
        sourceReplySinkDeliveryMode === "message_tool_only"
      ) {
        const details = toolResult?.details as { pollVotedOption?: unknown } | undefined;
        const option =
          typeof details?.pollVotedOption === "string" ? details.pollVotedOption.trim() : "";
        if (option) {
          const recordedAt = Date.now();
          // Prune expired entries on write so a session that votes but never
          // sends a follow-up text can't leak a record forever in a long-lived
          // gateway; the map stays bounded to sessions that voted within the TTL.
          for (const [key, entry] of recentPollVoteBySession) {
            if (recordedAt - entry.recordedAt > POLL_VOTE_ECHO_TTL_MS) {
              recentPollVoteBySession.delete(key);
            }
          }
          recentPollVoteBySession.set(pollEchoSessionKey, {
            option,
            route: pollVoteEchoRoute,
            recordedAt,
          });
        }
      }
      if (toolResult) {
        return toolResult;
      }
      return jsonResult(result.payload);
    },
  };
}
