import type { SlackActionMiddlewareArgs } from "@slack/bolt";
import type { Block, KnownBlock } from "@slack/web-api";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/infra-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { SLACK_REPLY_BUTTON_ACTION_ID, SLACK_REPLY_SELECT_ACTION_ID } from "../../blocks-render.js";
import { dispatchSlackPluginInteractiveHandler } from "../../interactive-dispatch.js";
import { authorizeSlackSystemEventSender } from "../auth.js";
import type { SlackMonitorContext } from "../context.js";
import {
  buildPluginBindingResolvedText,
  parsePluginBindingApprovalCustomId,
  resolvePluginConversationBindingApproval,
} from "../conversation.runtime.js";
import { escapeSlackMrkdwn } from "../mrkdwn.js";

type InteractionMessageBlock = {
  type?: string;
  block_id?: string;
  elements?: Array<{ action_id?: string }>;
};

type SelectOption = {
  value?: string;
  text?: { text?: string };
};

type InteractionSelectionFields = {
  blockId?: string;
  callbackId?: string;
  value?: string;
  inputKind?: "number" | "text" | "url" | "email" | "rich_text";
  inputValue?: string;
  inputNumber?: number;
  inputEmail?: string;
  inputUrl?: string;
  richTextValue?: unknown;
  richTextPreview?: string;
  selectedValues?: string[];
  selectedUsers?: string[];
  selectedChannels?: string[];
  selectedConversations?: string[];
  selectedLabels?: string[];
  selectedDate?: string;
  selectedTime?: string;
  selectedDateTime?: number;
  actionType?: string;
  viewId?: string;
  privateMetadata?: string;
  viewHash?: string;
  inputs?: unknown[];
  isCleared?: boolean;
  routedChannelType?: string;
  routedChannelId?: string;
};

export type InteractionSummary = InteractionSelectionFields & {
  interactionType?: "block_action" | "view_submission" | "view_closed";
  actionId: string;
  userId?: string;
  teamId?: string;
  triggerId?: string;
  responseUrl?: string;
  workflowTriggerUrl?: string;
  workflowId?: string;
  channelId?: string;
  messageTs?: string;
  threadTs?: string;
};

type SlackActionSummary = Omit<InteractionSummary, "actionId" | "blockId">;

type SlackBlockActionBody = {
  user?: { id?: string };
  team?: { id?: string };
  trigger_id?: string;
  response_url?: string;
  channel?: { id?: string };
  container?: { channel_id?: string; message_ts?: string; thread_ts?: string };
  message?: { ts?: string; text?: string; blocks?: unknown[] };
};

type SlackBlockActionRespond = NonNullable<SlackActionMiddlewareArgs["respond"]>;

type ParsedSlackBlockAction = {
  typedBody: SlackBlockActionBody;
  typedAction: Record<string, unknown>;
  typedActionWithText: {
    action_id?: string;
    block_id?: string;
    type?: string;
    text?: { text?: string };
  };
  actionId: string;
  blockId?: string;
  userId: string;
  channelId?: string;
  messageTs?: string;
  threadTs?: string;
  actionSummary: SlackActionSummary;
};

function readOptionValues(options: unknown): string[] | undefined {
  if (!Array.isArray(options)) {
    return undefined;
  }
  const values = options
    .map((option) => (option && typeof option === "object" ? (option as SelectOption).value : null))
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0);
  return values.length > 0 ? values : undefined;
}

function readOptionLabels(options: unknown): string[] | undefined {
  if (!Array.isArray(options)) {
    return undefined;
  }
  const labels = options
    .map((option) =>
      option && typeof option === "object" ? ((option as SelectOption).text?.text ?? null) : null,
    )
    .filter((label): label is string => typeof label === "string" && label.trim().length > 0);
  return labels.length > 0 ? labels : undefined;
}

function uniqueNonEmptyStrings(values: string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const entry of values) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    unique.push(trimmed);
  }
  return unique;
}

function collectRichTextFragments(value: unknown, out: string[]): void {
  if (!value || typeof value !== "object") {
    return;
  }
  const typed = value as { text?: unknown; elements?: unknown };
  if (typeof typed.text === "string" && typed.text.trim().length > 0) {
    out.push(typed.text.trim());
  }
  if (Array.isArray(typed.elements)) {
    for (const child of typed.elements) {
      collectRichTextFragments(child, out);
    }
  }
}

function summarizeRichTextPreview(value: unknown): string | undefined {
  const fragments: string[] = [];
  collectRichTextFragments(value, fragments);
  if (fragments.length === 0) {
    return undefined;
  }
  const joined = fragments.join(" ").replace(/\s+/g, " ").trim();
  if (!joined) {
    return undefined;
  }
  const max = 120;
  return joined.length <= max ? joined : `${joined.slice(0, max - 1)}…`;
}

function readInteractionAction(raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  return raw as Record<string, unknown>;
}

export function summarizeAction(action: Record<string, unknown>): SlackActionSummary {
  const typed = action as {
    type?: string;
    selected_option?: SelectOption;
    selected_options?: SelectOption[];
    selected_user?: string;
    selected_users?: string[];
    selected_channel?: string;
    selected_channels?: string[];
    selected_conversation?: string;
    selected_conversations?: string[];
    selected_date?: string;
    selected_time?: string;
    selected_date_time?: number;
    value?: string;
    rich_text_value?: unknown;
    workflow?: {
      trigger_url?: string;
      workflow_id?: string;
    };
  };
  const actionType = typed.type;
  const selectedUsers = uniqueNonEmptyStrings([
    ...(typed.selected_user ? [typed.selected_user] : []),
    ...(Array.isArray(typed.selected_users) ? typed.selected_users : []),
  ]);
  const selectedChannels = uniqueNonEmptyStrings([
    ...(typed.selected_channel ? [typed.selected_channel] : []),
    ...(Array.isArray(typed.selected_channels) ? typed.selected_channels : []),
  ]);
  const selectedConversations = uniqueNonEmptyStrings([
    ...(typed.selected_conversation ? [typed.selected_conversation] : []),
    ...(Array.isArray(typed.selected_conversations) ? typed.selected_conversations : []),
  ]);
  const selectedValues = uniqueNonEmptyStrings([
    ...(typed.selected_option?.value ? [typed.selected_option.value] : []),
    ...(readOptionValues(typed.selected_options) ?? []),
    ...selectedUsers,
    ...selectedChannels,
    ...selectedConversations,
  ]);
  const selectedLabels = uniqueNonEmptyStrings([
    ...(typed.selected_option?.text?.text ? [typed.selected_option.text.text] : []),
    ...(readOptionLabels(typed.selected_options) ?? []),
  ]);
  const inputValue = typeof typed.value === "string" ? typed.value : undefined;
  const inputNumber =
    actionType === "number_input" && inputValue != null ? Number.parseFloat(inputValue) : undefined;
  const parsedNumber = Number.isFinite(inputNumber) ? inputNumber : undefined;
  const inputEmail =
    actionType === "email_text_input" && inputValue?.includes("@") ? inputValue : undefined;
  let inputUrl: string | undefined;
  if (actionType === "url_text_input" && inputValue) {
    try {
      inputUrl = new URL(inputValue).toString();
    } catch {
      inputUrl = undefined;
    }
  }
  const richTextValue = actionType === "rich_text_input" ? typed.rich_text_value : undefined;
  const richTextPreview = summarizeRichTextPreview(richTextValue);
  const inputKind =
    actionType === "number_input"
      ? "number"
      : actionType === "email_text_input"
        ? "email"
        : actionType === "url_text_input"
          ? "url"
          : actionType === "rich_text_input"
            ? "rich_text"
            : inputValue != null
              ? "text"
              : undefined;

  return {
    actionType,
    inputKind,
    value: typed.value,
    selectedValues: selectedValues.length > 0 ? selectedValues : undefined,
    selectedUsers: selectedUsers.length > 0 ? selectedUsers : undefined,
    selectedChannels: selectedChannels.length > 0 ? selectedChannels : undefined,
    selectedConversations: selectedConversations.length > 0 ? selectedConversations : undefined,
    selectedLabels: selectedLabels.length > 0 ? selectedLabels : undefined,
    selectedDate: typed.selected_date,
    selectedTime: typed.selected_time,
    selectedDateTime:
      typeof typed.selected_date_time === "number" ? typed.selected_date_time : undefined,
    inputValue,
    inputNumber: parsedNumber,
    inputEmail,
    inputUrl,
    richTextValue,
    richTextPreview,
    workflowTriggerUrl: typed.workflow?.trigger_url,
    workflowId: typed.workflow?.workflow_id,
  };
}

function isBulkActionsBlock(block: InteractionMessageBlock): boolean {
  return (
    block.type === "actions" &&
    Array.isArray(block.elements) &&
    block.elements.length > 0 &&
    block.elements.every((el) => typeof el.action_id === "string" && el.action_id.includes("_all_"))
  );
}

function formatInteractionSelectionLabel(params: {
  actionId: string;
  summary: SlackActionSummary;
  buttonText?: string;
}): string {
  if (params.summary.actionType === "button" && params.buttonText?.trim()) {
    return params.buttonText.trim();
  }
  if (params.summary.selectedLabels?.length) {
    if (params.summary.selectedLabels.length <= 3) {
      return params.summary.selectedLabels.join(", ");
    }
    return `${params.summary.selectedLabels.slice(0, 3).join(", ")} +${
      params.summary.selectedLabels.length - 3
    }`;
  }
  if (params.summary.selectedValues?.length) {
    if (params.summary.selectedValues.length <= 3) {
      return params.summary.selectedValues.join(", ");
    }
    return `${params.summary.selectedValues.slice(0, 3).join(", ")} +${
      params.summary.selectedValues.length - 3
    }`;
  }
  if (params.summary.selectedDate) {
    return params.summary.selectedDate;
  }
  if (params.summary.selectedTime) {
    return params.summary.selectedTime;
  }
  if (typeof params.summary.selectedDateTime === "number") {
    return new Date(params.summary.selectedDateTime * 1000).toISOString();
  }
  if (params.summary.richTextPreview) {
    return params.summary.richTextPreview;
  }
  if (params.summary.value?.trim()) {
    return params.summary.value.trim();
  }
  return params.actionId;
}

function formatInteractionConfirmationText(params: {
  selectedLabel: string;
  userId?: string;
}): string {
  const userId = normalizeOptionalString(params.userId);
  const actor = userId ? ` by <@${userId}>` : "";
  return `:white_check_mark: *${escapeSlackMrkdwn(params.selectedLabel)}* selected${actor}`;
}

function buildSlackPluginInteractionData(params: {
  actionId: string;
  summary: SlackActionSummary;
}): string | null {
  const actionId = normalizeOptionalString(params.actionId) ?? "";
  if (!actionId) {
    return null;
  }
  const payload =
    normalizeOptionalString(params.summary.value) ||
    params.summary.selectedValues?.map((value) => normalizeOptionalString(value)).find(Boolean) ||
    "";
  if (
    actionId === SLACK_REPLY_BUTTON_ACTION_ID ||
    actionId === SLACK_REPLY_SELECT_ACTION_ID ||
    actionId.startsWith(`${SLACK_REPLY_BUTTON_ACTION_ID}:`) ||
    actionId.startsWith(`${SLACK_REPLY_SELECT_ACTION_ID}:`)
  ) {
    return payload || null;
  }
  return payload ? `${actionId}:${payload}` : actionId;
}

function isSlackReplyActionId(actionId: string): boolean {
  return (
    actionId === SLACK_REPLY_BUTTON_ACTION_ID ||
    actionId === SLACK_REPLY_SELECT_ACTION_ID ||
    actionId.startsWith(`${SLACK_REPLY_BUTTON_ACTION_ID}:`) ||
    actionId.startsWith(`${SLACK_REPLY_SELECT_ACTION_ID}:`)
  );
}

function buildSlackPluginInteractionId(params: {
  userId?: string;
  channelId?: string;
  messageTs?: string;
  triggerId?: string;
  actionId: string;
  summary: SlackActionSummary;
}): string {
  const primaryValue =
    normalizeOptionalString(params.summary.value) ||
    params.summary.selectedValues?.map((value) => normalizeOptionalString(value)).find(Boolean) ||
    "";
  return [
    normalizeOptionalString(params.userId) ?? "",
    normalizeOptionalString(params.channelId) ?? "",
    normalizeOptionalString(params.messageTs) ?? "",
    normalizeOptionalString(params.triggerId) ?? "",
    normalizeOptionalString(params.actionId) ?? "",
    primaryValue,
  ].join(":");
}

function parseSlackBlockAction(params: {
  body: unknown;
  action: unknown;
  log?: (message: string) => void;
}): ParsedSlackBlockAction | null {
  const typedBody = params.body as SlackBlockActionBody;
  const typedAction = readInteractionAction(params.action);
  if (!typedAction) {
    params.log?.(
      `slack:interaction malformed action payload channel=${typedBody.channel?.id ?? typedBody.container?.channel_id ?? "unknown"} user=${
        typedBody.user?.id ?? "unknown"
      }`,
    );
    return null;
  }
  const typedActionWithText = typedAction as {
    action_id?: string;
    block_id?: string;
    type?: string;
    text?: { text?: string };
  };
  return {
    typedBody,
    typedAction,
    typedActionWithText,
    actionId:
      typeof typedActionWithText.action_id === "string" ? typedActionWithText.action_id : "unknown",
    blockId: typedActionWithText.block_id,
    userId: typedBody.user?.id ?? "unknown",
    channelId: typedBody.channel?.id ?? typedBody.container?.channel_id,
    messageTs: typedBody.message?.ts ?? typedBody.container?.message_ts,
    threadTs: typedBody.container?.thread_ts,
    actionSummary: summarizeAction(typedAction),
  };
}

async function respondEphemeral(
  respond: SlackBlockActionRespond | undefined,
  text: string,
): Promise<void> {
  if (!respond) {
    return;
  }
  try {
    await respond({
      text,
      response_type: "ephemeral",
    });
  } catch {
    // Best-effort feedback only.
  }
}

async function updateSlackInteractionMessage(params: {
  ctx: SlackMonitorContext;
  channelId?: string;
  messageTs?: string;
  text: string;
  blocks?: (Block | KnownBlock)[];
}): Promise<void> {
  if (!params.channelId || !params.messageTs) {
    return;
  }
  await params.ctx.app.client.chat.update({
    channel: params.channelId,
    ts: params.messageTs,
    text: params.text,
    ...(params.blocks ? { blocks: params.blocks } : {}),
  });
}

async function authorizeSlackBlockAction(params: {
  ctx: SlackMonitorContext;
  parsed: ParsedSlackBlockAction;
  respond?: SlackBlockActionRespond;
}): Promise<
  | {
      allowed: true;
      channelType?: "im" | "mpim" | "channel" | "group";
    }
  | { allowed: false }
> {
  const auth = await authorizeSlackSystemEventSender({
    ctx: params.ctx,
    senderId: params.parsed.userId,
    channelId: params.parsed.channelId,
    // Block action sender identity is verified by Slack's request signing.
    // Pass the Slack-verified userId as expectedSenderId to satisfy the
    // mandatory actor-binding requirement for interactive events.
    expectedSenderId: params.parsed.userId,
    interactiveEvent: true,
  });
  if (auth.allowed) {
    return auth;
  }
  params.ctx.runtime.log?.(
    `slack:interaction drop action=${params.parsed.actionId} user=${params.parsed.userId} channel=${params.parsed.channelId ?? "unknown"} reason=${auth.reason ?? "unauthorized"}`,
  );
  await respondEphemeral(params.respond, "You are not authorized to use this control.");
  return { allowed: false };
}

async function handleSlackPluginBindingApproval(params: {
  ctx: SlackMonitorContext;
  parsed: ParsedSlackBlockAction;
  pluginInteractionData: string;
  respond?: SlackBlockActionRespond;
}): Promise<boolean> {
  const pluginBindingApproval = parsePluginBindingApprovalCustomId(params.pluginInteractionData);
  if (!pluginBindingApproval) {
    return false;
  }
  const resolved = await resolvePluginConversationBindingApproval({
    approvalId: pluginBindingApproval.approvalId,
    decision: pluginBindingApproval.decision,
    senderId: params.parsed.userId,
  });
  try {
    await updateSlackInteractionMessage({
      ctx: params.ctx,
      channelId: params.parsed.channelId,
      messageTs: params.parsed.messageTs,
      text: params.parsed.typedBody.message?.text ?? "",
      blocks: [],
    });
  } catch {
    // Best-effort cleanup only; continue with follow-up feedback.
  }
  await respondEphemeral(params.respond, buildPluginBindingResolvedText(resolved));
  return true;
}

async function dispatchSlackPluginInteraction(params: {
  ctx: SlackMonitorContext;
  parsed: ParsedSlackBlockAction;
  pluginInteractionData: string;
  auth: { isAuthorizedSender: boolean };
  respond?: SlackBlockActionRespond;
}): Promise<boolean> {
  const pluginInteractionId = buildSlackPluginInteractionId({
    userId: params.parsed.userId,
    channelId: params.parsed.channelId,
    messageTs: params.parsed.messageTs,
    triggerId: params.parsed.typedBody.trigger_id,
    actionId: params.parsed.actionId,
    summary: params.parsed.actionSummary,
  });
  if (
    await handleSlackPluginBindingApproval({
      ctx: params.ctx,
      parsed: params.parsed,
      pluginInteractionData: params.pluginInteractionData,
      respond: params.respond,
    })
  ) {
    return true;
  }
  const pluginResult = await dispatchSlackPluginInteractiveHandler({
    data: params.pluginInteractionData,
    interactionId: pluginInteractionId,
    ctx: {
      accountId: params.ctx.accountId,
      interactionId: pluginInteractionId,
      conversationId: params.parsed.channelId ?? "",
      parentConversationId: undefined,
      threadId: params.parsed.threadTs,
      senderId: params.parsed.userId,
      senderUsername: undefined,
      auth: params.auth,
      interaction: {
        kind: params.parsed.actionSummary.actionType === "button" ? "button" : "select",
        actionId: params.parsed.actionId,
        blockId: params.parsed.blockId,
        messageTs: params.parsed.messageTs,
        threadTs: params.parsed.threadTs,
        value: params.parsed.actionSummary.value,
        selectedValues: params.parsed.actionSummary.selectedValues,
        selectedLabels: params.parsed.actionSummary.selectedLabels,
        triggerId: params.parsed.typedBody.trigger_id,
        responseUrl: params.parsed.typedBody.response_url,
      },
    },
    respond: {
      acknowledge: async () => {},
      reply: async ({ text, responseType }) => {
        if (!text) {
          return;
        }
        await params.respond?.({
          text,
          response_type: responseType ?? "ephemeral",
        });
      },
      followUp: async ({ text, responseType }) => {
        if (!text) {
          return;
        }
        await params.respond?.({
          text,
          response_type: responseType ?? "ephemeral",
        });
      },
      editMessage: async ({ text, blocks }) => {
        await updateSlackInteractionMessage({
          ctx: params.ctx,
          channelId: params.parsed.channelId,
          messageTs: params.parsed.messageTs,
          text: text ?? params.parsed.typedBody.message?.text ?? "",
          blocks: Array.isArray(blocks) ? (blocks as (Block | KnownBlock)[]) : undefined,
        });
      },
    },
  });
  return pluginResult.matched && pluginResult.handled;
}

function enqueueSlackBlockActionEvent(params: {
  ctx: SlackMonitorContext;
  parsed: ParsedSlackBlockAction;
  auth: { channelType?: "im" | "mpim" | "channel" | "group" };
  formatSystemEvent: (payload: Record<string, unknown>) => string;
}): void {
  const eventPayload: InteractionSummary = {
    interactionType: "block_action",
    actionId: params.parsed.actionId,
    blockId: params.parsed.blockId,
    ...params.parsed.actionSummary,
    userId: params.parsed.userId,
    teamId: params.parsed.typedBody.team?.id,
    triggerId: params.parsed.typedBody.trigger_id,
    responseUrl: params.parsed.typedBody.response_url,
    channelId: params.parsed.channelId,
    messageTs: params.parsed.messageTs,
    threadTs: params.parsed.threadTs,
  };
  params.ctx.runtime.log?.(
    `slack:interaction action=${params.parsed.actionId} type=${params.parsed.actionSummary.actionType ?? "unknown"} user=${params.parsed.userId} channel=${params.parsed.channelId}`,
  );
  const sessionKey = params.ctx.resolveSlackSystemEventSessionKey({
    channelId: params.parsed.channelId,
    channelType: params.auth.channelType,
    senderId: params.parsed.userId,
  });
  const contextParts = [
    "slack:interaction",
    params.parsed.channelId,
    params.parsed.messageTs,
    params.parsed.actionId,
  ].filter(Boolean);
  enqueueSystemEvent(params.formatSystemEvent(eventPayload), {
    sessionKey,
    contextKey: contextParts.join(":"),
  });
}

function buildSlackConfirmationBlocks(params: {
  parsed: ParsedSlackBlockAction;
  originalBlocks: unknown[];
}): (Block | KnownBlock)[] {
  const selectedLabel = formatInteractionSelectionLabel({
    actionId: params.parsed.actionId,
    summary: params.parsed.actionSummary,
    buttonText: params.parsed.typedActionWithText.text?.text,
  });
  let updatedBlocks = params.originalBlocks.map((block) => {
    const typedBlock = block as InteractionMessageBlock;
    if (typedBlock.type === "actions" && typedBlock.block_id === params.parsed.blockId) {
      return {
        type: "context",
        elements: [
          {
            type: "mrkdwn",
            text: formatInteractionConfirmationText({
              selectedLabel,
              userId: params.parsed.userId,
            }),
          },
        ],
      };
    }
    return block;
  });
  const hasRemainingIndividualActionRows = updatedBlocks.some((block) => {
    const typedBlock = block as InteractionMessageBlock;
    return typedBlock.type === "actions" && !isBulkActionsBlock(typedBlock);
  });
  if (!hasRemainingIndividualActionRows) {
    updatedBlocks = updatedBlocks.filter((block, index) => {
      const typedBlock = block as InteractionMessageBlock;
      if (isBulkActionsBlock(typedBlock)) {
        return false;
      }
      if (typedBlock.type !== "divider") {
        return true;
      }
      const next = updatedBlocks[index + 1] as InteractionMessageBlock | undefined;
      return !next || !isBulkActionsBlock(next);
    });
  }
  return updatedBlocks as (Block | KnownBlock)[];
}

async function updateSlackLegacyBlockAction(params: {
  ctx: SlackMonitorContext;
  parsed: ParsedSlackBlockAction;
  respond?: SlackBlockActionRespond;
}): Promise<void> {
  const originalBlocks = params.parsed.typedBody.message?.blocks;
  if (
    !Array.isArray(originalBlocks) ||
    !params.parsed.channelId ||
    !params.parsed.messageTs ||
    !params.parsed.blockId
  ) {
    return;
  }
  try {
    await updateSlackInteractionMessage({
      ctx: params.ctx,
      channelId: params.parsed.channelId,
      messageTs: params.parsed.messageTs,
      text: params.parsed.typedBody.message?.text ?? "",
      blocks: buildSlackConfirmationBlocks({
        parsed: params.parsed,
        originalBlocks,
      }),
    });
  } catch {
    await respondEphemeral(params.respond, `Button "${params.parsed.actionId}" clicked!`);
  }
}

async function handleSlackBlockAction(params: {
  ctx: SlackMonitorContext;
  args: SlackActionMiddlewareArgs;
  formatSystemEvent: (payload: Record<string, unknown>) => string;
}): Promise<void> {
  const { ack, body, action, respond } = params.args;
  await ack();
  if (params.ctx.shouldDropMismatchedSlackEvent?.(body)) {
    params.ctx.runtime.log?.("slack:interaction drop block action payload (mismatched app/team)");
    return;
  }
  const parsed = parseSlackBlockAction({
    body,
    action,
    log: params.ctx.runtime.log,
  });
  if (!parsed) {
    return;
  }
  const auth = await authorizeSlackBlockAction({
    ctx: params.ctx,
    parsed,
    respond,
  });
  if (!auth.allowed) {
    return;
  }
  const pluginInteractionData = buildSlackPluginInteractionData({
    actionId: parsed.actionId,
    summary: parsed.actionSummary,
  });
  if (pluginInteractionData && isSlackReplyActionId(parsed.actionId)) {
    const handledBindingApproval = await handleSlackPluginBindingApproval({
      ctx: params.ctx,
      parsed,
      pluginInteractionData,
      respond,
    });
    if (handledBindingApproval) {
      return;
    }
  } else if (pluginInteractionData) {
    const handled = await dispatchSlackPluginInteraction({
      ctx: params.ctx,
      parsed,
      pluginInteractionData,
      auth: {
        isAuthorizedSender: true,
      },
      respond,
    });
    if (handled) {
      return;
    }
  }
  enqueueSlackBlockActionEvent({
    ctx: params.ctx,
    parsed,
    auth,
    formatSystemEvent: params.formatSystemEvent,
  });
  await updateSlackLegacyBlockAction({
    ctx: params.ctx,
    parsed,
    respond,
  });
}

export function registerSlackBlockActionHandler(params: {
  ctx: SlackMonitorContext;
  formatSystemEvent: (payload: Record<string, unknown>) => string;
}): void {
  if (typeof params.ctx.app.action !== "function") {
    return;
  }
  params.ctx.app.action(/.+/, async (args: SlackActionMiddlewareArgs) => {
    await handleSlackBlockAction({
      ctx: params.ctx,
      args,
      formatSystemEvent: params.formatSystemEvent,
    });
  });
}
