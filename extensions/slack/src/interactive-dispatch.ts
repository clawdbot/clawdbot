// Slack plugin module implements interactive dispatch behavior.
import {
  createChannelInteractiveDispatcher,
  type PluginConversationBinding,
  type PluginConversationBindingRequestParams,
  type PluginConversationBindingRequestResult,
  type PluginInteractiveRegistration,
} from "openclaw/plugin-sdk/plugin-runtime";
import type { ModalInputSummary } from "./monitor/events/modal-input-summary.js";

type SlackInteractiveHandlerResult = {
  handled?: boolean;
  systemEvent?: {
    summary?: string;
    reference?: string;
    data?: Record<string, unknown>;
  };
} | void;

type SlackBlockInteractivePayload = {
  kind: "button" | "select";
  data: string;
  namespace: string;
  payload: string;
  actionId: string;
  blockId?: string;
  messageTs?: string;
  threadTs?: string;
  value?: string;
  selectedValues?: string[];
  selectedLabels?: string[];
  triggerId?: string;
  responseUrl?: string;
};

type SlackModalInteractivePayload = {
  kind: "view_submission" | "view_closed";
  data: string;
  namespace: string;
  payload: string;
  callbackId: string;
  viewId?: string;
  rootViewId?: string;
  previousViewId?: string;
  externalId?: string;
  isStackedView?: boolean;
  isCleared?: boolean;
  inputs: ModalInputSummary[];
  stateValues?: unknown;
  triggerId?: string;
};

export type SlackInteractiveHandlerContext = {
  channel: "slack";
  accountId: string;
  interactionId: string;
  conversationId: string;
  parentConversationId?: string;
  senderId?: string;
  senderUsername?: string;
  threadId?: string;
  auth: {
    isAuthorizedSender: boolean;
  };
  interaction: SlackBlockInteractivePayload | SlackModalInteractivePayload;
  respond: {
    acknowledge: () => Promise<void>;
    reply: (params: { text: string; responseType?: "ephemeral" | "in_channel" }) => Promise<void>;
    followUp: (params: {
      text: string;
      responseType?: "ephemeral" | "in_channel";
    }) => Promise<void>;
    editMessage: (params: { text?: string; blocks?: unknown[] }) => Promise<void>;
  };
  requestConversationBinding: (
    params?: PluginConversationBindingRequestParams,
  ) => Promise<PluginConversationBindingRequestResult>;
  detachConversationBinding: () => Promise<{ removed: boolean }>;
  getCurrentConversationBinding: () => Promise<PluginConversationBinding | null>;
};

export type SlackInteractiveHandlerRegistration = PluginInteractiveRegistration<
  SlackInteractiveHandlerContext,
  "slack",
  SlackInteractiveHandlerResult
>;

const dispatchSlackInteractive = createChannelInteractiveDispatcher<
  "slack",
  "interaction",
  SlackInteractiveHandlerContext,
  SlackInteractiveHandlerResult
>({
  channel: "slack",
  interactiveKey: "interaction",
});

export async function dispatchSlackPluginInteractiveHandler(params: {
  data: string;
  interactionId: string;
  teamId?: string;
  channelType?: "im" | "mpim" | "channel" | "group";
  ctx: Parameters<typeof dispatchSlackInteractive>[0]["ctx"];
  respond: SlackInteractiveHandlerContext["respond"];
  onMatched?: () => Promise<void> | void;
}) {
  const senderId = params.ctx.senderId?.trim();
  const rawBaseConversationId =
    params.channelType === "im"
      ? senderId
        ? `user:${senderId}`
        : ""
      : params.ctx.conversationId.trim();
  const threadId = params.ctx.threadId?.trim() || undefined;
  const qualify = (value: string) =>
    params.teamId ? `team:${encodeURIComponent(params.teamId)}:${value}` : value;
  const baseConversationId = qualify(rawBaseConversationId);
  const qualifiedThreadId = threadId ? qualify(threadId) : undefined;
  const qualifiedParentConversationId = params.ctx.parentConversationId
    ? qualify(params.ctx.parentConversationId)
    : undefined;

  return await dispatchSlackInteractive({
    ...params,
    dedupeId: qualify(params.interactionId),
    conversation: {
      channel: "slack",
      accountId: params.ctx.accountId,
      conversationId: qualifiedThreadId ?? baseConversationId,
      parentConversationId: qualifiedThreadId
        ? (qualifiedParentConversationId ?? baseConversationId)
        : qualifiedParentConversationId,
      threadId: qualifiedThreadId,
    },
  });
}
