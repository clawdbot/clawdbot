import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { ChannelMessageActionAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { SlackActionContext } from "./action-runtime.js";
import { handleSlackMessageAction } from "./message-action-dispatch.js";
import { extractSlackToolSend } from "./message-actions.js";
import { describeSlackMessageTool } from "./message-tool-api.js";
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

function resolveSlackActionContext(params: {
  toolContext: unknown;
  mediaLocalRoots: readonly string[] | undefined;
  mediaReadFile: ((filePath: string) => Promise<Buffer>) | undefined;
}): SlackActionContext | undefined {
  if (!params.toolContext && !params.mediaLocalRoots && !params.mediaReadFile) {
    return undefined;
  }
  return {
    ...(params.toolContext as SlackActionContext | undefined),
    ...(params.mediaLocalRoots ? { mediaLocalRoots: params.mediaLocalRoots } : {}),
    ...(params.mediaReadFile ? { mediaReadFile: params.mediaReadFile } : {}),
  };
}

export function createSlackActions(
  providerId: string,
  options?: { invoke?: SlackActionInvoke },
): ChannelMessageActionAdapter {
  return {
    describeMessageTool: describeSlackMessageTool,
    extractToolSend: ({ args }) => extractSlackToolSend(args),
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
          });
          return await (options?.invoke
            ? options.invoke(action, cfg, actionContext)
            : (await loadSlackActionRuntime()).handleSlackAction(action, cfg, actionContext));
        },
      });
    },
  };
}
