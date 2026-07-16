import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import {
  type ChannelMessageActionAdapter,
  type ChannelMessageToolDiscovery,
} from "openclaw/plugin-sdk/channel-contract";
import type { SlackActionContext } from "./action-runtime.js";
import { isSlackInteractiveRepliesEnabled } from "./interactive-replies.js";
import { handleSlackMessageAction } from "./message-action-dispatch.js";
import { extractSlackToolSend, listSlackMessageActions } from "./message-actions.js";
import { createSlackMessageToolBlocksSchema } from "./message-tool-schema.js";
import { resolveSlackChannelId } from "./targets.js";

type SlackActionInvoke = (
  action: Record<string, unknown>,
  cfg: unknown,
  toolContext: unknown,
) => Promise<AgentToolResult<unknown>>;

let slackActionRuntimePromise: Promise<typeof import("./action-runtime.runtime.js")> | undefined;

async function loadSlackActionRuntime() {
  slackActionRuntimePromise ??= import("./action-runtime.runtime.js");
  return await slackActionRuntimePromise;
}

export function createSlackActions(
  providerId: string,
  options?: { invoke?: SlackActionInvoke },
): ChannelMessageActionAdapter {
  function describeMessageTool({
    cfg,
    accountId,
  }: Parameters<
    NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>
  >[0]): ChannelMessageToolDiscovery {
    const actions = listSlackMessageActions(cfg, accountId);
    const capabilities = new Set<"blocks" | "interactive">();
    if (actions.includes("send")) {
      capabilities.add("blocks");
    }
    if (isSlackInteractiveRepliesEnabled({ cfg, accountId })) {
      capabilities.add("interactive");
    }
    return {
      actions,
      capabilities: Array.from(capabilities),
      schema: actions.includes("send")
        ? {
            properties: {
              blocks: Type.Optional(createSlackMessageToolBlocksSchema()),
            },
          }
        : null,
    };
  }

  return {
    describeMessageTool,
    extractToolSend: ({ args }) => extractSlackToolSend(args),
    handleAction: async (ctx) => {
      return await handleSlackMessageAction({
        providerId,
        ctx,
        normalizeChannelId: resolveSlackChannelId,
        includeReadThreadId: true,
        invoke: async (action, cfg, toolContext) =>
          await (options?.invoke
            ? options.invoke(action, cfg, toolContext)
            : (await loadSlackActionRuntime()).handleSlackAction(action, cfg, {
                ...(toolContext as SlackActionContext | undefined),
                mediaLocalRoots: ctx.mediaLocalRoots,
                mediaReadFile: ctx.mediaReadFile,
              })),
      });
    },
  };
}
