// Slack plugin module implements channel actions behavior.
import type { AgentToolResult } from "openclaw/plugin-sdk/agent-core";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionContext,
} from "openclaw/plugin-sdk/channel-contract";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { SlackActionContext } from "./action-runtime.js";
import { handleSlackMessageAction } from "./message-action-dispatch.js";
import { extractSlackToolSend } from "./message-actions.js";
import { describeSlackMessageTool } from "./message-tool-api.js";
import { resolveSlackChannelId } from "./targets.js";

type ConversationReadInvocationOrigin = NonNullable<
  ChannelMessageActionContext["conversationReadOrigin"]
>;

type SlackActionInvoke = (
  action: Record<string, unknown>,
  cfg: unknown,
  toolContext: unknown,
) => Promise<AgentToolResult<unknown>>;

const SLACK_TOOL_DELIVERY_ACTIONS = new Set([
  "deleteMessage",
  "editMessage",
  "pinMessage",
  "react",
  "sendMessage",
  "unpinMessage",
  "uploadFile",
]);

const loadSlackActionRuntime = createLazyRuntimeModule(() => import("./action-runtime.runtime.js"));

function resolveSlackActionContext(params: {
  toolContext: unknown;
  mediaLocalRoots: readonly string[] | undefined;
  mediaReadFile: ((filePath: string) => Promise<Buffer>) | undefined;
  conversationReadOrigin?: ConversationReadInvocationOrigin;
  requesterAccountId?: string | null;
  requesterSenderId?: string | null;
}): SlackActionContext | undefined {
  if (
    !params.toolContext &&
    !params.mediaLocalRoots &&
    !params.mediaReadFile &&
    !params.conversationReadOrigin &&
    !params.requesterAccountId &&
    !params.requesterSenderId
  ) {
    return undefined;
  }
  return {
    ...(params.toolContext as SlackActionContext | undefined),
    ...(params.mediaLocalRoots ? { mediaLocalRoots: params.mediaLocalRoots } : {}),
    ...(params.mediaReadFile ? { mediaReadFile: params.mediaReadFile } : {}),
    // Authority comes only from the host-owned action context. Overwrite any
    // structurally compatible fields carried by generic tool context.
    conversationReadOrigin: params.conversationReadOrigin,
    requesterAccountId: params.requesterAccountId ?? undefined,
    requesterSenderId: params.requesterSenderId ?? undefined,
  };
}

export function createSlackActions(
  providerId: string,
  options?: { invoke?: SlackActionInvoke },
): ChannelMessageActionAdapter {
  return {
    describeMessageTool: describeSlackMessageTool,
    extractToolSend: ({ args }) => extractSlackToolSend(args),
    isToolDeliveryAction: ({ args }) =>
      typeof args.action === "string" && SLACK_TOOL_DELIVERY_ACTIONS.has(args.action),
    prepareSendPayload: ({ ctx, payload }) => (ctx.action === "send" ? payload : null),
    handleAction: async (ctx) => {
      return await handleSlackMessageAction({
        providerId,
        ctx,
        normalizeChannelId: resolveSlackChannelId,
        includeReadThreadId: true,
        invoke: async (action, cfg, toolContext) => {
          const actionContext = resolveSlackActionContext({
            toolContext,
            mediaLocalRoots: ctx.mediaLocalRoots,
            mediaReadFile: ctx.mediaReadFile,
            conversationReadOrigin: ctx.conversationReadOrigin,
            requesterAccountId: ctx.requesterAccountId,
            requesterSenderId: ctx.requesterSenderId,
          });
          return await (options?.invoke
            ? options.invoke(action, cfg, actionContext)
            : (await loadSlackActionRuntime()).handleSlackAction(action, cfg, actionContext));
        },
      });
    },
  };
}
