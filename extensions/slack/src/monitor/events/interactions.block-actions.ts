// Slack plugin module implements interactions.block actions behavior.
import type { SlackActionMiddlewareArgs } from "@slack/bolt";
import type { Block, KnownBlock } from "@slack/web-api";
import { resolveApprovalOverGateway } from "openclaw/plugin-sdk/approval-gateway-runtime";
import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/approval-reply-runtime";
import { resolveCommandAuthorization } from "openclaw/plugin-sdk/command-auth-native";
import { isApprovalNotFoundError } from "openclaw/plugin-sdk/error-runtime";
import { requestHeartbeat } from "openclaw/plugin-sdk/heartbeat-runtime";
import {
  parseStrictFiniteNumber,
  timestampMsToIsoString,
} from "openclaw/plugin-sdk/number-runtime";
import {
  normalizeOptionalString,
  normalizeUniqueTrimmedStringList,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { decodeSlackApprovalAction, type SlackApprovalAction } from "../../approval-actions.js";
import { isSlackApprovalAuthorizedSender } from "../../approval-auth.js";
import { isSlackExecApprovalAuthorizedSender } from "../../exec-approvals.js";
import { dispatchSlackPluginInteractiveHandler } from "../../interactive-dispatch.js";
import { decodeSlackQuestionAction, resolveSlackQuestionAction } from "../../question-actions.js";
import {
  isSlackApprovalActionId,
  isSlackCallbackActionId,
  isSlackQuestionActionId,
  SLACK_REPLY_BUTTON_ACTION_ID,
  SLACK_REPLY_LINK_ACTION_ID,
  SLACK_REPLY_SELECT_ACTION_ID,
} from "../../reply-action-ids.js";
import { truncateSlackText } from "../../truncate.js";
import {
  authorizeSlackSystemEventSender,
  resolveSlackCommandIngress,
  resolveSlackEffectiveAllowFrom,
} from "../auth.js";
import { resolveSlackChannelConfig } from "../channel-config.js";
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

type InteractionSummary = InteractionSelectionFields & {
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
  message?: { ts?: string; thread_ts?: string; text?: string; blocks?: unknown[] };
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
  return normalizeUniqueTrimmedStringList(values);
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
  return joined.length <= max ? joined : truncateSlackText(joined, max);
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
    actionType === "number_input" && inputValue != null
      ? parseStrictFiniteNumber(inputValue)
      : undefined;
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
    const selectedDateTime = timestampMsToIsoString(params.summary.selectedDateTime * 1000);
    if (selectedDateTime) {
      return selectedDateTime;
    }
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
    isSlackCallbackActionId(actionId) ||
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

function readSlackApprovalAction(parsed: ParsedSlackBlockAction): SlackApprovalAction | null {
  const value =
    normalizeOptionalString(parsed.actionSummary.value) ??
    parsed.actionSummary.selectedValues
      ?.map((entry) => normalizeOptionalString(entry))
      .find((entry): entry is string => Boolean(entry));
  return decodeSlackApprovalAction(value);
}

function isSlackReplyLinkAction(parsed: ParsedSlackBlockAction): boolean {
  if (
    parsed.actionId === SLACK_REPLY_LINK_ACTION_ID ||
    parsed.actionId.startsWith(`${SLACK_REPLY_LINK_ACTION_ID}:`)
  ) {
    return true;
  }
  const legacyUrl = normalizeOptionalString((parsed.typedAction as { url?: unknown }).url);
  return Boolean(legacyUrl && isSlackReplyActionId(parsed.actionId));
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
    threadTs: typedBody.container?.thread_ts ?? typedBody.message?.thread_ts,
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

type SlackApprovalTerminalState =
  | { status: "allowed"; decision: "allow-once" | "allow-always" }
  | { status: "denied"; decision: "deny" }
  | { status: "expired" | "cancelled" };

function resolveSlackApprovalTerminalLabel(approval: SlackApprovalTerminalState): string {
  if (approval.status === "allowed") {
    return approval.decision === "allow-always" ? "Allowed always" : "Allowed once";
  }
  if (approval.status === "denied") {
    return "Denied";
  }
  if (approval.status === "expired") {
    return "Expired";
  }
  return "Cancelled";
}

function removeSlackApprovalControls(blocks: unknown[]): (Block | KnownBlock)[] {
  return blocks.flatMap((block) => {
    if (!block || typeof block !== "object" || Array.isArray(block)) {
      return [block as Block | KnownBlock];
    }
    const typedBlock = block as InteractionMessageBlock;
    if (typedBlock.type !== "actions" || !Array.isArray(typedBlock.elements)) {
      return [block as Block | KnownBlock];
    }
    const elements = typedBlock.elements.filter(
      (element) =>
        typeof element.action_id !== "string" || !isSlackApprovalActionId(element.action_id),
    );
    return elements.length > 0 ? [{ ...block, elements } as Block | KnownBlock] : [];
  });
}

function buildSlackApprovalTerminalBlocks(params: {
  blocks: unknown[] | undefined;
  label: string;
  prefix: "Resolved" | "Already resolved";
}): (Block | KnownBlock)[] {
  const blocks = removeSlackApprovalControls(params.blocks ?? []).filter((block) => {
    const text = (block as { type?: unknown; text?: { text?: unknown } }).text?.text;
    return !(
      (block as { type?: unknown }).type === "section" &&
      typeof text === "string" &&
      /^\*(?:Exec|Plugin) approval required\*/u.test(text)
    );
  });
  return [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${params.prefix}: ${params.label}*` },
    },
    ...blocks,
  ];
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

async function handleSlackApprovalInteraction(params: {
  ctx: SlackMonitorContext;
  parsed: ParsedSlackBlockAction;
  approval: SlackApprovalAction;
  respond?: SlackBlockActionRespond;
}): Promise<boolean> {
  const pluginApprovalAuthorizedSender = isSlackApprovalAuthorizedSender({
    cfg: params.ctx.cfg,
    accountId: params.ctx.accountId,
    senderId: params.parsed.userId,
  });
  const execApprovalAuthorizedSender = isSlackExecApprovalAuthorizedSender({
    cfg: params.ctx.cfg,
    accountId: params.ctx.accountId,
    senderId: params.parsed.userId,
  });
  const authorized =
    params.approval.approvalKind === "plugin"
      ? pluginApprovalAuthorizedSender
      : execApprovalAuthorizedSender;
  if (!authorized) {
    params.ctx.runtime.log?.(
      `slack:interaction drop ${params.approval.approvalKind} approval user=${params.parsed.userId} (not authorized)`,
    );
    await respondEphemeral(params.respond, "You are not authorized to approve this request.");
    return true;
  }

  try {
    const result = await resolveApprovalOverGateway({
      cfg: params.ctx.cfg,
      approvalId: params.approval.approvalId,
      approvalKind: params.approval.approvalKind,
      decision: params.approval.decision,
      senderId: params.parsed.userId,
      clientDisplayName: `Slack approval (${params.parsed.userId.trim() || "unknown"})`,
    });
    const terminalLabel = resolveSlackApprovalTerminalLabel(result.approval);
    const prefix = result.applied ? "Resolved" : "Already resolved";
    let terminalized = false;
    try {
      // Always terminalize the clicked message. Generic forwarding does not retain
      // a receipt for the resolved-event updater, and event/local updates may race.
      const terminalText = `${prefix}: ${terminalLabel}`;
      await updateSlackInteractionMessage({
        ctx: params.ctx,
        channelId: params.parsed.channelId,
        messageTs: params.parsed.messageTs,
        text: truncateSlackText(terminalText, 4000),
        blocks: buildSlackApprovalTerminalBlocks({
          blocks: params.parsed.typedBody.message?.blocks,
          label: terminalLabel,
          prefix,
        }),
      });
      terminalized = true;
    } catch {
      // Best-effort terminal presentation only; canonical Gateway state already won.
    }
    if (!terminalized || !result.applied) {
      await respondEphemeral(
        params.respond,
        result.applied
          ? `Approval resolved: ${terminalLabel}.`
          : `This approval was already resolved: ${terminalLabel}.`,
      );
    }
  } catch (error) {
    params.ctx.runtime.log?.(
      `slack:interaction approval resolve failed id=${params.approval.approvalId}: ${String(error)}`,
    );
    // The clicker must see an outcome: pruned/expired records and gateway
    // outages otherwise ack the click silently (Discord's sibling responds).
    if (isApprovalNotFoundError(error)) {
      await respondEphemeral(params.respond, "This approval is no longer pending.");
      return true;
    }
    await respondEphemeral(
      params.respond,
      "Could not reach the Gateway to resolve this approval. Try again.",
    );
    throw error;
  }
  return true;
}

async function handleSlackLegacyApprovalInteraction(params: {
  ctx: SlackMonitorContext;
  parsed: ParsedSlackBlockAction;
  pluginInteractionData: string;
  respond?: SlackBlockActionRespond;
}): Promise<boolean> {
  const parsedApproval = parseExecApprovalCommandText(params.pluginInteractionData);
  if (!parsedApproval) {
    return false;
  }
  const pluginAuthorized = isSlackApprovalAuthorizedSender({
    cfg: params.ctx.cfg,
    accountId: params.ctx.accountId,
    senderId: params.parsed.userId,
  });
  const execAuthorized = isSlackExecApprovalAuthorizedSender({
    cfg: params.ctx.cfg,
    accountId: params.ctx.accountId,
    senderId: params.parsed.userId,
  });
  const resolveMethods: Array<"exec" | "plugin"> = [];
  if (execAuthorized) {
    resolveMethods.push("exec");
  }
  if (pluginAuthorized) {
    resolveMethods.push("plugin");
  }
  if (resolveMethods.length === 0) {
    params.ctx.runtime.log?.(
      `slack:interaction drop legacy approval user=${params.parsed.userId} (not authorized)`,
    );
    await respondEphemeral(params.respond, "You are not authorized to approve this request.");
    return true;
  }

  for (const [index, resolveMethod] of resolveMethods.entries()) {
    try {
      await resolveApprovalOverGateway({
        cfg: params.ctx.cfg,
        approvalId: parsedApproval.approvalId,
        decision: parsedApproval.decision,
        senderId: params.parsed.userId,
        resolveMethod,
        clientDisplayName: `Slack approval (${params.parsed.userId.trim() || "unknown"})`,
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
        // Best-effort cleanup only for historical command-backed controls.
      }
      return true;
    } catch (error) {
      if (index + 1 < resolveMethods.length && isApprovalNotFoundError(error)) {
        continue;
      }
      params.ctx.runtime.log?.(
        `slack:interaction legacy approval resolve failed id=${parsedApproval.approvalId}: ${String(error)}`,
      );
      throw error;
    }
  }
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

async function resolveSlackBlockActionCommandAuthorized(params: {
  ctx: SlackMonitorContext;
  parsed: ParsedSlackBlockAction;
  auth: { channelType?: "im" | "mpim" | "channel" | "group"; channelName?: string };
}): Promise<boolean> {
  const commandsAllowFrom = params.ctx.cfg.commands?.allowFrom;
  const commandsAllowFromConfigured =
    commandsAllowFrom != null &&
    typeof commandsAllowFrom === "object" &&
    (Array.isArray(commandsAllowFrom.slack) || Array.isArray(commandsAllowFrom["*"]));
  if (commandsAllowFromConfigured) {
    return resolveCommandAuthorization({
      ctx: {
        Provider: "slack",
        Surface: "slack",
        OriginatingChannel: "slack",
        AccountId: params.ctx.accountId,
        ChatType: params.auth.channelType === "im" ? "direct" : "group",
        From: params.parsed.channelId ? `slack:${params.parsed.channelId}` : "slack",
        SenderId: params.parsed.userId,
      },
      cfg: params.ctx.cfg,
      commandAuthorized: false,
    }).isAuthorizedSender;
  }

  const isDirectMessage = params.auth.channelType === "im";
  const isRoom = params.auth.channelType === "channel" || params.auth.channelType === "group";
  const allowFromLower = await resolveSlackEffectiveAllowFrom(params.ctx, {
    includePairingStore: isDirectMessage,
  });
  const sender = await params.ctx.resolveUserName(params.parsed.userId).catch(() => undefined);
  const senderName = sender?.name;

  let channelUsers: Array<string | number> = [];
  if (isRoom && params.parsed.channelId) {
    const channelConfig = resolveSlackChannelConfig({
      channelId: params.parsed.channelId,
      channelName: params.auth.channelName,
      channels: params.ctx.channelsConfig,
      channelKeys: params.ctx.channelsConfigKeys,
      defaultRequireMention: params.ctx.defaultRequireMention,
      allowNameMatching: params.ctx.allowNameMatching,
    });
    channelUsers = Array.isArray(channelConfig?.users) ? channelConfig.users : [];
  }

  const commandIngress = await resolveSlackCommandIngress({
    ctx: params.ctx,
    senderId: params.parsed.userId,
    senderName,
    channelType: params.auth.channelType ?? "channel",
    channelId: params.parsed.channelId ?? "slack-interaction",
    ownerAllowFromLower: allowFromLower,
    channelUsers,
    allowTextCommands: false,
    hasControlCommand: true,
    eventKind: "button",
    modeWhenAccessGroupsOff: "configured",
  });
  return commandIngress.commandAccess.authorized;
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
    threadTs: params.parsed.threadTs,
  });
  const contextParts = [
    "slack:interaction",
    params.parsed.channelId,
    params.parsed.messageTs,
    params.parsed.actionId,
  ].filter(Boolean);
  const queued = enqueueSystemEvent(params.formatSystemEvent(eventPayload), {
    sessionKey,
    contextKey: contextParts.join(":"),
    deliveryContext: {
      channel: "slack",
      to:
        params.auth.channelType === "im"
          ? `user:${params.parsed.userId}`
          : params.parsed.channelId
            ? `channel:${params.parsed.channelId}`
            : undefined,
      accountId: params.ctx.accountId,
      threadId: params.parsed.threadTs,
    },
  });
  if (queued) {
    requestHeartbeat({
      source: "hook",
      intent: "immediate",
      reason: "hook:slack-interaction",
      sessionKey,
      heartbeat: { target: "last" },
    });
  }
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
  return params.originalBlocks.map((block) => {
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
  }) as (Block | KnownBlock)[];
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
  trackEvent?: () => void;
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
  // Slack reports URL-button clicks too; navigation must not enqueue an agent interaction.
  if (isSlackReplyLinkAction(parsed)) {
    return;
  }
  params.trackEvent?.();
  if (isSlackApprovalActionId(parsed.actionId)) {
    const approval = readSlackApprovalAction(parsed);
    if (!approval) {
      params.ctx.runtime.log?.(
        `slack:interaction drop malformed approval action user=${parsed.userId} channel=${parsed.channelId ?? "unknown"}`,
      );
      await respondEphemeral(respond, "This approval action is invalid or expired.");
      return;
    }
    await handleSlackApprovalInteraction({
      ctx: params.ctx,
      parsed,
      approval,
      respond,
    });
    return;
  }
  if (isSlackQuestionActionId(parsed.actionId)) {
    const question = decodeSlackQuestionAction(parsed.actionSummary.value);
    if (!question) {
      await respondEphemeral(respond, "This question action is invalid or expired.");
      return;
    }
    const auth = await authorizeSlackBlockAction({ ctx: params.ctx, parsed, respond });
    if (!auth.allowed) {
      return;
    }
    await resolveSlackQuestionAction({
      action: question,
      cfg: params.ctx.cfg,
      accountId: params.ctx.accountId,
      userId: parsed.userId,
      respond: async (text) => await respondEphemeral(respond, text),
    });
    return;
  }
  const pluginInteractionData = buildSlackPluginInteractionData({
    actionId: parsed.actionId,
    summary: parsed.actionSummary,
  });
  if (pluginInteractionData && isSlackReplyActionId(parsed.actionId)) {
    const handledExecApproval = await handleSlackLegacyApprovalInteraction({
      ctx: params.ctx,
      parsed,
      pluginInteractionData,
      respond,
    });
    if (handledExecApproval) {
      return;
    }
  }
  const auth = await authorizeSlackBlockAction({
    ctx: params.ctx,
    parsed,
    respond,
  });
  if (!auth.allowed) {
    return;
  }
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
    const isAuthorizedSender = await resolveSlackBlockActionCommandAuthorized({
      ctx: params.ctx,
      parsed,
      auth,
    });
    const handled = await dispatchSlackPluginInteraction({
      ctx: params.ctx,
      parsed,
      pluginInteractionData,
      auth: {
        isAuthorizedSender,
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
  trackEvent?: () => void;
  formatSystemEvent: (payload: Record<string, unknown>) => string;
}): void {
  if (typeof params.ctx.app.action !== "function") {
    return;
  }
  params.ctx.app.action(/.+/, async (args: SlackActionMiddlewareArgs) => {
    await handleSlackBlockAction({
      ctx: params.ctx,
      trackEvent: params.trackEvent,
      args,
      formatSystemEvent: params.formatSystemEvent,
    });
  });
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
