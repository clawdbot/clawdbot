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
import { formatSlackTarget, parseSlackTarget, resolveSlackChannelId } from "./target-parsing.js";

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

function resolveSlackActionContext(
  ctx: ChannelMessageActionContext,
  toolContext: unknown,
): SlackActionContext | undefined {
  if (
    !toolContext &&
    !ctx.mediaAccess &&
    !ctx.mediaLocalRoots &&
    !ctx.mediaReadFile &&
    !ctx.conversationReadOrigin &&
    !ctx.requesterAccountId &&
    !ctx.requesterSenderId
  ) {
    return undefined;
  }
  return {
    ...(toolContext as SlackActionContext | undefined),
    // Authority comes only from the host-owned action context. Overwrite any
    // structurally compatible fields carried by generic tool context.
    mediaAccess: ctx.mediaAccess,
    mediaLocalRoots: ctx.mediaLocalRoots,
    mediaReadFile: ctx.mediaReadFile,
    conversationReadOrigin: ctx.conversationReadOrigin,
    requesterAccountId: ctx.requesterAccountId ?? undefined,
    requesterSenderId: ctx.requesterSenderId ?? undefined,
  };
}

export function createSlackActions(
  providerId: string,
  options?: { invoke?: SlackActionInvoke },
): ChannelMessageActionAdapter {
  return {
    providerOwnedReadGates: true,
    describeMessageTool: describeSlackMessageTool,
    extractToolSend: ({ args }) => extractSlackToolSend(args),
    isToolDeliveryAction: ({ args }) =>
      typeof args.action === "string" && SLACK_TOOL_DELIVERY_ACTIONS.has(args.action),
    prepareSendPayload: ({ ctx, to, payload }) =>
      ctx.action === "send" && !shouldUseWorkspaceAwareSlackActionSend(to, ctx.toolContext)
        ? payload
        : null,
    handleAction: async (ctx) => {
      return await handleSlackMessageAction({
        providerId,
        ctx,
        normalizeChannelId: normalizeSlackActionChannelTarget,
        includeReadThreadId: true,
        invoke: async (action, cfg, toolContext) => {
          const actionContext = resolveSlackActionContext(ctx, toolContext);
          return await (options?.invoke
            ? options.invoke(action, cfg, actionContext)
            : (await loadSlackActionRuntime()).handleSlackAction(action, cfg, actionContext));
        },
      });
    },
  };
}

function normalizeSlackActionChannelTarget(raw: string): string {
  const target = parseSlackTarget(raw, { defaultKind: "channel" });
  const channelId = resolveSlackChannelId(raw);
  return formatSlackTarget({ teamId: target?.teamId, kind: "channel", id: channelId });
}

function shouldUseWorkspaceAwareSlackActionSend(
  rawTarget: string,
  context: ChannelMessageActionContext["toolContext"],
): boolean {
  const target = parseSlackTarget(rawTarget, { defaultKind: "channel" });
  if (!target || target.teamId) {
    return false;
  }
  for (const rawCurrentTarget of [context?.currentChannelId, context?.currentMessagingTarget]) {
    if (!rawCurrentTarget) {
      continue;
    }
    const currentTarget = parseSlackTarget(rawCurrentTarget);
    if (
      currentTarget?.teamId &&
      currentTarget.kind === target.kind &&
      currentTarget.id.toLowerCase() === target.id.toLowerCase()
    ) {
      return true;
    }
  }
  return false;
}
