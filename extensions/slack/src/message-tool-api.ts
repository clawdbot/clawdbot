// Slack API module exposes the plugin public contract.
import type {
  ChannelMessageActionAdapter,
  ChannelMessageActionName,
  ChannelMessageToolDiscovery,
  ChannelMessageToolSchemaContribution,
} from "openclaw/plugin-sdk/channel-contract";
import { Type, type TSchema } from "typebox";
import { listSlackMessageActions } from "./message-actions.js";

const SLACK_MESSAGE_ID_ACTIONS = ["react", "reactions", "edit", "delete", "pin", "unpin"] as const;

function createSlackFileActionSchema(): Record<string, TSchema> {
  return {
    fileId: Type.Optional(
      Type.String({
        description:
          'Slack file id, starting with "F" (for example F0B0LTT8M36). Required for action="download-file". Read it from inbound Slack file metadata at event.files[].id. This is not the Slack message timestamp/messageId.',
      }),
    ),
  };
}

function createSlackReactionEmojiSchema(emojiListAvailable: boolean): Record<string, TSchema> {
  const discoveryHint = emojiListAvailable
    ? ' Discover workspace custom emoji with action:"emoji-list".'
    : "";
  return {
    emoji: Type.Optional(
      Type.String({
        description:
          'Slack standard or workspace custom emoji shortcode (for example "white_check_mark" or "+1") or common emoji character (for example "✅"). Colons are optional.' +
          discoveryHint,
      }),
    ),
  };
}

function createSlackForcedMediaSchema(): Record<string, TSchema> {
  const description =
    "Preserve original image bytes without image optimization. Slack still uploads a regular file; this does not convert it into a Slack document.";
  return {
    forceDocument: Type.Optional(Type.Boolean({ description })),
    asDocument: Type.Optional(
      Type.Boolean({ description: `Alias for forceDocument. ${description}` }),
    ),
  };
}

function createSlackMessageIdActionSchema(): Record<string, TSchema> {
  const description =
    'Slack message timestamp/message id (for example "1777423717.666499"). Used by react, reactions, edit, delete, pin, and unpin actions. React defaults to the current inbound message when available. Not used by download-file, which requires fileId from event.files[].id.';
  return {
    messageId: Type.Optional(Type.String({ description })),
    message_id: Type.Optional(Type.String({ description: `${description} Alias for messageId.` })),
  };
}

function createSlackSendActionSchema(): Record<string, TSchema> {
  return {
    ...createSlackForcedMediaSchema(),
    topLevel: Type.Optional(
      Type.Boolean({
        description:
          'Slack-only opt-out for action="send" from a threaded same-channel context. Set true to post a new parent-channel message instead of inheriting the current Slack thread. `threadId: null` is accepted as the same top-level request.',
      }),
    ),
    replyBroadcast: Type.Optional(
      Type.Boolean({
        description:
          'Slack-only opt-in for action="send" thread replies. Set true with threadId or replyTo on text/block sends to also broadcast the reply to the parent channel. Not supported for media or upload-file.',
      }),
    ),
  };
}

function createSlackTopLevelActionSchema(): Record<string, TSchema> {
  return {
    ...createSlackForcedMediaSchema(),
    topLevel: Type.Optional(
      Type.Boolean({
        description:
          "Slack-only opt-out from threaded same-channel context. Set true to post at the channel root instead of inheriting the current Slack thread.",
      }),
    ),
  };
}

export function describeSlackMessageTool({
  cfg,
  accountId,
}: Parameters<
  NonNullable<ChannelMessageActionAdapter["describeMessageTool"]>
>[0]): ChannelMessageToolDiscovery {
  const actions = listSlackMessageActions(cfg, accountId);
  const capabilities = new Set<"presentation">();
  const schema: ChannelMessageToolSchemaContribution[] = [];
  if (actions.includes("canvas-create")) {
    schema.push({
      actions: ["canvas-create", "canvas-edit"],
      properties: {
        canvasMarkdown: Type.Optional(
          Type.String({
            description:
              "Slack canvas Markdown. Required for canvas-create and canvas-edit except delete. Channel canvas only, not a thread reply. Uses the bot identity; requires canvases:write.",
            minLength: 1,
            maxLength: 1048576,
          }),
        ),
      },
    });
    schema.push({
      actions: ["canvas-create"],
      properties: {
        canvasTitle: Type.Optional(
          Type.String({ description: "Title for the new channel canvas." }),
        ),
      },
    });
    schema.push({
      actions: ["canvas-edit"],
      properties: {
        canvasId: Type.Optional(
          Type.String({
            description:
              "Required canvas ID. Must be the canvas associated with the target channel.",
            pattern: "^F[A-Z0-9]+$",
          }),
        ),
        canvasOperation: Type.Optional(
          Type.String({
            enum: [
              "insert_before",
              "insert_after",
              "insert_at_start",
              "insert_at_end",
              "replace",
              "delete",
            ],
            description:
              "Required: one canvas edit per call. replace without canvasSectionId replaces the entire canvas. delete requires a section and forbids canvasMarkdown.",
          }),
        ),
        canvasSectionId: Type.Optional(
          Type.String({
            description:
              "Known section ID: required for insert_before, insert_after, delete; optional for replace; forbidden for insert_at_start/end. This tool does not discover section IDs.",
          }),
        ),
      },
    });
  }
  if (actions.includes("conversation-open")) {
    schema.push({
      actions: ["conversation-open"],
      visibility: "all-configured",
      properties: {
        userIds: Type.Optional(
          Type.Array(Type.String({ pattern: "^[UW][A-Z0-9]+$" }), {
            minItems: 1,
            maxItems: 8,
            uniqueItems: true,
            description:
              'Slack conversation-open: 1-8 other member IDs. One opens a DM; multiple open or reuse a group DM. Exclude the calling account. Use the returned target with action="send".',
          }),
        ),
        teamId: Type.Optional(
          Type.String({
            pattern: "^T[A-Z0-9]+$",
            description:
              "Slack workspace for conversation-open. Defaults to the trusted current workspace for the selected account; required for detached Enterprise operations.",
          }),
        ),
      },
    });
  }
  if (actions.includes("send")) {
    capabilities.add("presentation");
  }
  if (actions.includes("download-file")) {
    schema.push({
      properties: createSlackFileActionSchema(),
      actions: ["download-file"],
    });
  }
  if (actions.includes("send")) {
    schema.push({
      properties: createSlackSendActionSchema(),
      actions: ["send"],
    });
  }
  if (actions.includes("upload-file")) {
    schema.push({
      properties: createSlackTopLevelActionSchema(),
      actions: ["upload-file"],
    });
  }
  if (actions.includes("react")) {
    schema.push({
      properties: createSlackReactionEmojiSchema(actions.includes("emoji-list")),
      actions: ["react", "reactions"],
    });
  }
  const messageIdActions: ChannelMessageActionName[] = [];
  for (const action of SLACK_MESSAGE_ID_ACTIONS) {
    if (actions.includes(action)) {
      messageIdActions.push(action);
    }
  }
  if (messageIdActions.length > 0) {
    schema.push({
      properties: createSlackMessageIdActionSchema(),
      actions: messageIdActions,
    });
  }
  return {
    actions,
    capabilities: Array.from(capabilities),
    schema: schema.length > 0 ? schema : null,
  };
}
