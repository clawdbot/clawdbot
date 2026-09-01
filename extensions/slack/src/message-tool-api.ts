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

function createSlackCanvasActionSchema(): Record<string, TSchema> {
  return {
    op: Type.Optional(
      Type.String({
        description:
          'Slack canvas operation. "create" creates a channel-attached canvas (optional title and documentContent). "edit" applies changes to a canvas (requires canvasId and a non-empty changes array). "delete" deletes a canvas (requires canvasId). "sections" (default) lists canvas sections filtered by sectionTypes or containsText (requires canvasId plus at least one of sectionTypes/containsText — Slack rejects an empty filter).',
      }),
    ),
    canvasId: Type.Optional(
      Type.String({
        pattern: "^[F][A-Z0-9]{8,}$",
        description:
          'Slack canvas id, F-prefixed (for example F0BU46ESS8J). Required for op="edit", op="delete", and op="sections".',
      }),
    ),
    title: Type.Optional(
      Type.String({
        description: 'Slack canvas title. Optional for op="create".',
      }),
    ),
    documentContent: Type.Optional(
      Type.Object(
        {
          type: Type.Literal("markdown"),
          markdown: Type.String({
            description: "Canvas markdown content. Slack caps each change at 1 MiB.",
          }),
        },
        {
          description:
            'Canvas content for op="create" and change documentContent/titleContent. { type: "markdown", markdown: string }.',
        },
      ),
    ),
    changes: Type.Optional(
      Type.Array(
        Type.Object({
          operation: Type.String({
            description:
              'Canvas edit operation: "insert_at_start", "insert_at_end", "insert_after", "insert_before", "replace", "delete", or "rename". insert_after/insert_before/delete require sectionId; rename requires titleContent; the rest require documentContent.',
          }),
          sectionId: Type.Optional(
            Type.String({
              description:
                'Target section id for insert_after, insert_before, delete, and optional for replace. Read from a prior op="sections" result.',
            }),
          ),
          documentContent: Type.Optional(
            Type.Object({ type: Type.Literal("markdown"), markdown: Type.String() }),
          ),
          titleContent: Type.Optional(
            Type.Object({ type: Type.Literal("markdown"), markdown: Type.String() }),
          ),
        }),
        { minItems: 1, description: 'Canvas changes for op="edit". At least one required.' },
      ),
    ),
    sectionTypes: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'Section type filters for op="sections": any_header, h1, h2, h3, list, table, blockquote, callout, chart, horizontal_line, citation, flexbox, canvas_unfurl, file_unfurl, message_unfurl, sfdc_record_mention, sfdc_record_unfurl, user_mention, user_unfurl. At least one of sectionTypes or containsText is required (Slack rejects an empty criteria).',
      }),
    ),
    containsText: Type.Optional(
      Type.String({
        description:
          'Text filter for op="sections". At least one of sectionTypes or containsText is required (Slack rejects an empty criteria).',
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
  if (actions.includes("canvas")) {
    schema.push({
      properties: createSlackCanvasActionSchema(),
      actions: ["canvas"],
    });
  }
  return {
    actions,
    capabilities: Array.from(capabilities),
    schema: schema.length > 0 ? schema : null,
  };
}
