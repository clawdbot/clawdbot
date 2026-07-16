import { Type } from "@sinclair/typebox";
import { createMessageToolCardSchema } from "openclaw/plugin-sdk/channel-actions";
import type {
  ChannelMessageActionAdapter,
  ChannelMessageToolDiscovery,
} from "openclaw/plugin-sdk/channel-contract";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { ChannelMessageActionName, ChannelPlugin } from "./channel-api.js";
import { resolveMSTeamsCredentials } from "./token.js";

const loadMSTeamsChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "msTeamsChannelRuntime",
);

function jsonActionResult(data: Record<string, unknown>) {
  const text = JSON.stringify(data);
  return {
    content: [{ type: "text" as const, text }],
    details: data,
  };
}

function jsonMSTeamsActionResult(action: string, data: Record<string, unknown> = {}) {
  return jsonActionResult({ channel: "msteams", action, ...data });
}

function jsonMSTeamsOkActionResult(action: string, data: Record<string, unknown> = {}) {
  return jsonActionResult({ ok: true, channel: "msteams", action, ...data });
}

function jsonMSTeamsConversationResult(conversationId: string | undefined) {
  return jsonActionResultWithDetails(
    {
      ok: true,
      channel: "msteams",
      conversationId,
    },
    { ok: true, channel: "msteams" },
  );
}

function jsonActionResultWithDetails(
  contentData: Record<string, unknown>,
  details: Record<string, unknown>,
) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(contentData) }],
    details,
  };
}

const MSTEAMS_REACTION_TYPES = ["like", "heart", "laugh", "surprised", "sad", "angry"] as const;

function actionError(message: string) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: message }],
    details: { error: message },
  };
}

function resolveActionTarget(
  params: Record<string, unknown>,
  currentChannelId?: string | null,
): string {
  return typeof params.to === "string"
    ? params.to.trim()
    : typeof params.target === "string"
      ? params.target.trim()
      : (currentChannelId?.trim() ?? "");
}

function resolveGraphActionTarget(
  params: Record<string, unknown>,
  currentChannelId?: string | null,
  currentGraphChannelId?: string | null,
): string {
  return resolveActionTarget(params, currentGraphChannelId ?? currentChannelId);
}

function resolveActionMessageId(params: Record<string, unknown>): string {
  return normalizeOptionalString(params.messageId) ?? "";
}

function resolveActionPinnedMessageId(params: Record<string, unknown>): string {
  return typeof params.pinnedMessageId === "string"
    ? params.pinnedMessageId.trim()
    : typeof params.messageId === "string"
      ? params.messageId.trim()
      : "";
}

function resolveActionQuery(params: Record<string, unknown>): string {
  return normalizeOptionalString(params.query) ?? "";
}

function resolveActionContent(params: Record<string, unknown>): string {
  return typeof params.text === "string"
    ? params.text
    : typeof params.content === "string"
      ? params.content
      : typeof params.message === "string"
        ? params.message
        : "";
}

function resolveActionUploadFilePath(params: Record<string, unknown>): string | undefined {
  for (const key of ["filePath", "path", "media"] as const) {
    if (typeof params[key] === "string") {
      const value = params[key];
      if (value.trim()) {
        return value;
      }
    }
  }
  return undefined;
}

function resolveRequiredActionTarget(params: {
  actionLabel: string;
  toolParams: Record<string, unknown>;
  currentChannelId?: string | null;
  currentGraphChannelId?: string | null;
  graphOnly?: boolean;
}): string | ReturnType<typeof actionError> {
  const to = params.graphOnly
    ? resolveGraphActionTarget(
        params.toolParams,
        params.currentChannelId,
        params.currentGraphChannelId,
      )
    : resolveActionTarget(params.toolParams, params.currentChannelId);
  if (!to) {
    return actionError(`${params.actionLabel} requires a target (to).`);
  }
  return to;
}

function resolveRequiredActionMessageTarget(params: {
  actionLabel: string;
  toolParams: Record<string, unknown>;
  currentChannelId?: string | null;
  currentGraphChannelId?: string | null;
  graphOnly?: boolean;
}): { to: string; messageId: string } | ReturnType<typeof actionError> {
  const to = params.graphOnly
    ? resolveGraphActionTarget(
        params.toolParams,
        params.currentChannelId,
        params.currentGraphChannelId,
      )
    : resolveActionTarget(params.toolParams, params.currentChannelId);
  const messageId = resolveActionMessageId(params.toolParams);
  if (!to || !messageId) {
    return actionError(`${params.actionLabel} requires a target (to) and messageId.`);
  }
  return { to, messageId };
}

function resolveRequiredActionPinnedMessageTarget(params: {
  actionLabel: string;
  toolParams: Record<string, unknown>;
  currentChannelId?: string | null;
  currentGraphChannelId?: string | null;
  graphOnly?: boolean;
}): { to: string; pinnedMessageId: string } | ReturnType<typeof actionError> {
  const to = params.graphOnly
    ? resolveGraphActionTarget(
        params.toolParams,
        params.currentChannelId,
        params.currentGraphChannelId,
      )
    : resolveActionTarget(params.toolParams, params.currentChannelId);
  const pinnedMessageId = resolveActionPinnedMessageId(params.toolParams);
  if (!to || !pinnedMessageId) {
    return actionError(`${params.actionLabel} requires a target (to) and pinnedMessageId.`);
  }
  return { to, pinnedMessageId };
}

async function runWithRequiredActionTarget<T>(params: {
  actionLabel: string;
  toolParams: Record<string, unknown>;
  currentChannelId?: string | null;
  currentGraphChannelId?: string | null;
  graphOnly?: boolean;
  run: (to: string) => Promise<T>;
}): Promise<T | ReturnType<typeof actionError>> {
  const to = resolveRequiredActionTarget({
    actionLabel: params.actionLabel,
    toolParams: params.toolParams,
    currentChannelId: params.currentChannelId,
    currentGraphChannelId: params.currentGraphChannelId,
    graphOnly: params.graphOnly,
  });
  if (typeof to !== "string") {
    return to;
  }
  return await params.run(to);
}

async function runWithRequiredActionMessageTarget<T>(params: {
  actionLabel: string;
  toolParams: Record<string, unknown>;
  currentChannelId?: string | null;
  currentGraphChannelId?: string | null;
  graphOnly?: boolean;
  run: (target: { to: string; messageId: string }) => Promise<T>;
}): Promise<T | ReturnType<typeof actionError>> {
  const target = resolveRequiredActionMessageTarget({
    actionLabel: params.actionLabel,
    toolParams: params.toolParams,
    currentChannelId: params.currentChannelId,
    currentGraphChannelId: params.currentGraphChannelId,
    graphOnly: params.graphOnly,
  });
  if ("isError" in target) {
    return target;
  }
  return await params.run(target);
}

async function runWithRequiredActionPinnedMessageTarget<T>(params: {
  actionLabel: string;
  toolParams: Record<string, unknown>;
  currentChannelId?: string | null;
  currentGraphChannelId?: string | null;
  graphOnly?: boolean;
  run: (target: { to: string; pinnedMessageId: string }) => Promise<T>;
}): Promise<T | ReturnType<typeof actionError>> {
  const target = resolveRequiredActionPinnedMessageTarget({
    actionLabel: params.actionLabel,
    toolParams: params.toolParams,
    currentChannelId: params.currentChannelId,
    currentGraphChannelId: params.currentGraphChannelId,
    graphOnly: params.graphOnly,
  });
  if ("isError" in target) {
    return target;
  }
  return await params.run(target);
}

export function describeMSTeamsMessageTool({
  cfg,
}: Parameters<
  NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>
>[0]): ChannelMessageToolDiscovery {
  const enabled =
    cfg.channels?.msteams?.enabled !== false &&
    Boolean(resolveMSTeamsCredentials(cfg.channels?.msteams));
  return {
    actions: enabled
      ? ([
          "upload-file",
          "poll",
          "edit",
          "delete",
          "pin",
          "unpin",
          "list-pins",
          "read",
          "react",
          "reactions",
          "search",
          "member-info",
          "channel-list",
          "channel-info",
        ] satisfies ChannelMessageActionName[])
      : [],
    capabilities: enabled ? ["cards"] : [],
    schema: enabled
      ? {
          properties: {
            card: createMessageToolCardSchema(),
            pinnedMessageId: Type.Optional(
              Type.String({
                description:
                  "Pinned message resource ID for unpin (from pin or list-pins, not the chat message ID).",
              }),
            ),
          },
        }
      : null,
  };
}

export const msteamsActionsAdapter: NonNullable<ChannelPlugin["actions"]> = {
  describeMessageTool: describeMSTeamsMessageTool,
  handleAction: async (ctx) => {
    if (ctx.action === "send" && ctx.params.card) {
      const card = ctx.params.card as Record<string, unknown>;
      return await runWithRequiredActionTarget({
        actionLabel: "Card send",
        toolParams: ctx.params,
        run: async (to) => {
          const { sendAdaptiveCardMSTeams } = await loadMSTeamsChannelRuntime();
          const result = await sendAdaptiveCardMSTeams({
            cfg: ctx.cfg,
            to,
            card,
          });
          return jsonActionResultWithDetails(
            {
              ok: true,
              channel: "msteams",
              messageId: result.messageId,
              conversationId: result.conversationId,
            },
            { ok: true, channel: "msteams", messageId: result.messageId },
          );
        },
      });
    }
    if (ctx.action === "upload-file") {
      const mediaUrl = resolveActionUploadFilePath(ctx.params);
      if (!mediaUrl) {
        return actionError("Upload-file requires media, filePath, or path.");
      }
      return await runWithRequiredActionTarget({
        actionLabel: "Upload-file",
        toolParams: ctx.params,
        currentChannelId: ctx.toolContext?.currentChannelId,
        run: async (to) => {
          const { sendMessageMSTeams } = await loadMSTeamsChannelRuntime();
          const result = await sendMessageMSTeams({
            cfg: ctx.cfg,
            to,
            text: resolveActionContent(ctx.params),
            mediaUrl,
            filename:
              normalizeOptionalString(ctx.params.filename) ??
              normalizeOptionalString(ctx.params.title),
            mediaLocalRoots: ctx.mediaLocalRoots,
            mediaReadFile: ctx.mediaReadFile,
          });
          return jsonActionResultWithDetails(
            {
              ok: true,
              channel: "msteams",
              action: "upload-file",
              messageId: result.messageId,
              conversationId: result.conversationId,
              ...(result.pendingUploadId ? { pendingUploadId: result.pendingUploadId } : {}),
            },
            {
              ok: true,
              channel: "msteams",
              messageId: result.messageId,
              ...(result.pendingUploadId ? { pendingUploadId: result.pendingUploadId } : {}),
            },
          );
        },
      });
    }
    if (ctx.action === "edit") {
      const content = resolveActionContent(ctx.params);
      if (!content) {
        return actionError("Edit requires content.");
      }
      return await runWithRequiredActionMessageTarget({
        actionLabel: "Edit",
        toolParams: ctx.params,
        currentChannelId: ctx.toolContext?.currentChannelId,
        run: async (target) => {
          const { editMessageMSTeams } = await loadMSTeamsChannelRuntime();
          const result = await editMessageMSTeams({
            cfg: ctx.cfg,
            to: target.to,
            activityId: target.messageId,
            text: content,
          });
          return jsonMSTeamsConversationResult(result.conversationId);
        },
      });
    }

    if (ctx.action === "delete") {
      return await runWithRequiredActionMessageTarget({
        actionLabel: "Delete",
        toolParams: ctx.params,
        currentChannelId: ctx.toolContext?.currentChannelId,
        run: async (target) => {
          const { deleteMessageMSTeams } = await loadMSTeamsChannelRuntime();
          const result = await deleteMessageMSTeams({
            cfg: ctx.cfg,
            to: target.to,
            activityId: target.messageId,
          });
          return jsonMSTeamsConversationResult(result.conversationId);
        },
      });
    }

    if (ctx.action === "read") {
      return await runWithRequiredActionMessageTarget({
        actionLabel: "Read",
        toolParams: ctx.params,
        currentChannelId: ctx.toolContext?.currentChannelId,
        currentGraphChannelId: ctx.toolContext?.currentGraphChannelId,
        graphOnly: true,
        run: async (target) => {
          const { getMessageMSTeams } = await loadMSTeamsChannelRuntime();
          const message = await getMessageMSTeams({
            cfg: ctx.cfg,
            to: target.to,
            messageId: target.messageId,
          });
          return jsonMSTeamsOkActionResult("read", { message });
        },
      });
    }

    if (ctx.action === "pin") {
      return await runWithRequiredActionMessageTarget({
        actionLabel: "Pin",
        toolParams: ctx.params,
        currentChannelId: ctx.toolContext?.currentChannelId,
        currentGraphChannelId: ctx.toolContext?.currentGraphChannelId,
        graphOnly: true,
        run: async (target) => {
          const { pinMessageMSTeams } = await loadMSTeamsChannelRuntime();
          const result = await pinMessageMSTeams({
            cfg: ctx.cfg,
            to: target.to,
            messageId: target.messageId,
          });
          return jsonMSTeamsActionResult("pin", result);
        },
      });
    }

    if (ctx.action === "unpin") {
      return await runWithRequiredActionPinnedMessageTarget({
        actionLabel: "Unpin",
        toolParams: ctx.params,
        currentChannelId: ctx.toolContext?.currentChannelId,
        currentGraphChannelId: ctx.toolContext?.currentGraphChannelId,
        graphOnly: true,
        run: async (target) => {
          const { unpinMessageMSTeams } = await loadMSTeamsChannelRuntime();
          const result = await unpinMessageMSTeams({
            cfg: ctx.cfg,
            to: target.to,
            pinnedMessageId: target.pinnedMessageId,
          });
          return jsonMSTeamsActionResult("unpin", result);
        },
      });
    }

    if (ctx.action === "list-pins") {
      return await runWithRequiredActionTarget({
        actionLabel: "List-pins",
        toolParams: ctx.params,
        currentChannelId: ctx.toolContext?.currentChannelId,
        currentGraphChannelId: ctx.toolContext?.currentGraphChannelId,
        graphOnly: true,
        run: async (to) => {
          const { listPinsMSTeams } = await loadMSTeamsChannelRuntime();
          const result = await listPinsMSTeams({ cfg: ctx.cfg, to });
          return jsonMSTeamsOkActionResult("list-pins", result);
        },
      });
    }

    if (ctx.action === "react") {
      return await runWithRequiredActionMessageTarget({
        actionLabel: "React",
        toolParams: ctx.params,
        currentChannelId: ctx.toolContext?.currentChannelId,
        currentGraphChannelId: ctx.toolContext?.currentGraphChannelId,
        graphOnly: true,
        run: async (target) => {
          const emoji = normalizeOptionalString(ctx.params.emoji) ?? "";
          const remove = typeof ctx.params.remove === "boolean" ? ctx.params.remove : false;
          if (!emoji) {
            return {
              isError: true,
              content: [
                {
                  type: "text" as const,
                  text: `React requires an emoji (reaction type). Valid types: ${MSTEAMS_REACTION_TYPES.join(", ")}.`,
                },
              ],
              details: {
                error: "React requires an emoji (reaction type).",
                validTypes: [...MSTEAMS_REACTION_TYPES],
              },
            };
          }
          if (remove) {
            const { unreactMessageMSTeams } = await loadMSTeamsChannelRuntime();
            const result = await unreactMessageMSTeams({
              cfg: ctx.cfg,
              to: target.to,
              messageId: target.messageId,
              reactionType: emoji,
            });
            return jsonMSTeamsActionResult("react", {
              removed: true,
              reactionType: emoji,
              ...result,
            });
          }
          const { reactMessageMSTeams } = await loadMSTeamsChannelRuntime();
          const result = await reactMessageMSTeams({
            cfg: ctx.cfg,
            to: target.to,
            messageId: target.messageId,
            reactionType: emoji,
          });
          return jsonMSTeamsActionResult("react", {
            reactionType: emoji,
            ...result,
          });
        },
      });
    }

    if (ctx.action === "reactions") {
      return await runWithRequiredActionMessageTarget({
        actionLabel: "Reactions",
        toolParams: ctx.params,
        currentChannelId: ctx.toolContext?.currentChannelId,
        currentGraphChannelId: ctx.toolContext?.currentGraphChannelId,
        graphOnly: true,
        run: async (target) => {
          const { listReactionsMSTeams } = await loadMSTeamsChannelRuntime();
          const result = await listReactionsMSTeams({
            cfg: ctx.cfg,
            to: target.to,
            messageId: target.messageId,
          });
          return jsonMSTeamsOkActionResult("reactions", result);
        },
      });
    }

    if (ctx.action === "search") {
      return await runWithRequiredActionTarget({
        actionLabel: "Search",
        toolParams: ctx.params,
        currentChannelId: ctx.toolContext?.currentChannelId,
        currentGraphChannelId: ctx.toolContext?.currentGraphChannelId,
        graphOnly: true,
        run: async (to) => {
          const query = resolveActionQuery(ctx.params);
          if (!query) {
            return actionError("Search requires a target (to) and query.");
          }
          const limit = typeof ctx.params.limit === "number" ? ctx.params.limit : undefined;
          const from = normalizeOptionalString(ctx.params.from);
          const { searchMessagesMSTeams } = await loadMSTeamsChannelRuntime();
          const result = await searchMessagesMSTeams({
            cfg: ctx.cfg,
            to,
            query,
            from: from || undefined,
            limit,
          });
          return jsonMSTeamsOkActionResult("search", result);
        },
      });
    }

    if (ctx.action === "member-info") {
      const userId = normalizeOptionalString(ctx.params.userId) ?? "";
      if (!userId) {
        return actionError("member-info requires a userId.");
      }
      const { getMemberInfoMSTeams } = await loadMSTeamsChannelRuntime();
      const result = await getMemberInfoMSTeams({ cfg: ctx.cfg, userId });
      return jsonMSTeamsOkActionResult("member-info", result);
    }

    if (ctx.action === "channel-list") {
      const teamId = normalizeOptionalString(ctx.params.teamId) ?? "";
      if (!teamId) {
        return actionError("channel-list requires a teamId.");
      }
      const { listChannelsMSTeams } = await loadMSTeamsChannelRuntime();
      const result = await listChannelsMSTeams({ cfg: ctx.cfg, teamId });
      return jsonMSTeamsOkActionResult("channel-list", result);
    }

    if (ctx.action === "channel-info") {
      const teamId = normalizeOptionalString(ctx.params.teamId) ?? "";
      const channelId = normalizeOptionalString(ctx.params.channelId) ?? "";
      if (!teamId || !channelId) {
        return actionError("channel-info requires teamId and channelId.");
      }
      const { getChannelInfoMSTeams } = await loadMSTeamsChannelRuntime();
      const result = await getChannelInfoMSTeams({
        cfg: ctx.cfg,
        teamId,
        channelId,
      });
      return jsonMSTeamsOkActionResult("channel-info", {
        channelInfo: result.channel,
      });
    }

    return null as never;
  },
};
