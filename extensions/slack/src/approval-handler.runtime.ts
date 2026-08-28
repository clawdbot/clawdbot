// Slack plugin module implements approval handler behavior.
import type { App } from "@slack/bolt";
import type { Block, KnownBlock, WebClient } from "@slack/web-api";
import type {
  ChannelApprovalCapabilityHandlerContext,
  ExpiredApprovalView,
  PendingApprovalView,
  PluginApprovalExpiredView,
  PluginApprovalPendingView,
  PluginApprovalResolvedView,
  ResolvedApprovalView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { createChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import { buildApprovalPresentationFromActionDescriptors } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logError } from "openclaw/plugin-sdk/logging-core";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { SLACK_APPROVAL_HEADER_BLOCK_ID } from "./approval-actions.js";
import {
  isSlackAnyNativeApprovalClientEnabled,
  shouldHandleSlackNativeApprovalRequest,
} from "./approval-native-gates.js";
import { normalizeSlackApproverId } from "./exec-approvals.js";
import { SLACK_EDIT_TEXT_MAX_BYTES } from "./limits.js";
import type { SlackEventScope } from "./monitor/event-scope.js";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";
import { resolveSlackReplyBlocks } from "./reply-blocks.js";
import { sendMessageSlack } from "./send.js";
import { parseSlackTarget } from "./target-parsing.js";
import { truncateSlackTextByUtf8Bytes } from "./truncate.js";

type SlackBlock = Block | KnownBlock;
type SlackPendingApproval = {
  channelId: string;
  messageTs: string;
  teamId?: string;
};
type SlackPendingDelivery = {
  text: string;
  blocks: SlackBlock[];
};
type SlackMetadataItem = {
  label: string;
  value: string;
};
type SlackPluginApprovalView =
  | PluginApprovalPendingView
  | PluginApprovalResolvedView
  | PluginApprovalExpiredView;

const SLACK_CONTEXT_ELEMENTS_MAX = 10;
const SLACK_TEXT_OBJECT_MAX = 3000;

type SlackExecApprovalConfig = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["channels"]>["slack"]>["execApprovals"]
>;

type SlackApprovalHandlerContext = {
  app: App;
  config: SlackExecApprovalConfig;
  resolveClient?: (teamId?: string) => WebClient | undefined;
  enterprise?: {
    apiAppId?: string;
    enterpriseId: string;
  };
};

function resolveHandlerContext(params: ChannelApprovalCapabilityHandlerContext): {
  accountId: string;
  context: SlackApprovalHandlerContext;
} | null {
  const context = params.context as SlackApprovalHandlerContext | undefined;
  const accountId = normalizeOptionalString(params.accountId) ?? "";
  if (!context?.app || !accountId) {
    return null;
  }
  return { accountId, context };
}

function truncateSlackMrkdwn(text: string, maxChars: number): string {
  const limit = Math.max(0, Math.floor(maxChars));
  if (text.length <= limit) {
    return text;
  }
  if (limit <= 1) {
    return truncateUtf16Safe(text, limit);
  }
  return `${truncateUtf16Safe(text, limit - 1)}…`;
}

function buildSlackCodeBlock(text: string): string {
  let fence = "```";
  while (text.includes(fence)) {
    fence += "`";
  }
  return `${fence}\n${text}\n${fence}`;
}

function formatSlackApprover(resolvedBy?: string | null): string | null {
  const normalized = resolvedBy ? normalizeSlackApproverId(resolvedBy) : undefined;
  if (normalized) {
    return `<@${normalized}>`;
  }
  const trimmed = normalizeOptionalString(resolvedBy);
  return trimmed ? trimmed : null;
}

function formatSlackMetadataLine(label: string, value: string): string {
  return `*${label}:* ${value}`;
}

function buildSlackMetadataLines(metadata: readonly SlackMetadataItem[]): string[] {
  const lines: string[] = [];
  for (const item of metadata) {
    lines.push(formatSlackMetadataLine(item.label, item.value));
  }
  return lines;
}

function buildSlackMetadataContextElements(metadata: readonly SlackMetadataItem[]) {
  const lines = buildSlackMetadataLines(metadata);
  const visibleLineCount =
    lines.length > SLACK_CONTEXT_ELEMENTS_MAX ? SLACK_CONTEXT_ELEMENTS_MAX - 1 : lines.length;
  const elements: Array<{ type: "mrkdwn"; text: string }> = [];
  for (let index = 0; index < visibleLineCount; index += 1) {
    const line = lines[index];
    if (line === undefined) {
      continue;
    }
    elements.push({
      type: "mrkdwn",
      text: truncateSlackMrkdwn(line, SLACK_TEXT_OBJECT_MAX),
    });
  }
  if (lines.length > SLACK_CONTEXT_ELEMENTS_MAX) {
    elements.push({
      type: "mrkdwn",
      text: `…+${lines.length - visibleLineCount} more`,
    });
  }
  return elements;
}

function buildSlackMetadataContextBlocks(metadata: readonly SlackMetadataItem[]): SlackBlock[] {
  const metadataElements = buildSlackMetadataContextElements(metadata);
  return metadataElements.length > 0
    ? [
        {
          type: "context",
          elements: metadataElements,
        } satisfies SlackBlock,
      ]
    : [];
}

function resolveSlackApprovalDecisionLabel(
  decision: "allow-once" | "allow-always" | "deny",
): string {
  return decision === "allow-once"
    ? "Allowed once"
    : decision === "allow-always"
      ? "Allowed always"
      : "Denied";
}

function buildSlackPluginMetadata(view: SlackPluginApprovalView): SlackMetadataItem[] {
  return [{ label: "Approval ID", value: view.approvalId }, ...view.metadata];
}

// Plugin approval copy is harness-controlled and the canonical record keeps it
// literal, so mrkdwn escaping happens here. Escape before truncating: entity
// expansion after a length cut could push the block past Slack's text limit.
function escapeSlackPluginApprovalText(value: string): string {
  return escapeSlackMrkdwn(value);
}

function resolveSlackPluginDescription(view: SlackPluginApprovalView): string {
  const description = normalizeOptionalString(view.description);
  return description
    ? escapeSlackPluginApprovalText(description)
    : "A plugin action needs your approval.";
}

function buildSlackPluginRequestBlocks(view: SlackPluginApprovalView): SlackBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Request*\n${truncateSlackMrkdwn(escapeSlackPluginApprovalText(view.title), 2600)}`,
      },
    },
    ...buildSlackMetadataContextBlocks(buildSlackPluginMetadata(view)),
  ];
}

type SlackApprovalRenderInput =
  | { phase: "pending"; view: PendingApprovalView }
  | { phase: "resolved"; view: ResolvedApprovalView }
  | { phase: "expired"; view: ExpiredApprovalView };

function buildSlackApprovalPayload(input: SlackApprovalRenderInput): SlackPendingDelivery {
  const { phase, view } = input;
  const isPlugin = view.approvalKind === "plugin";
  const approvalName = isPlugin ? "Plugin" : "Exec";
  let heading: string;
  let description: string;
  if (phase === "pending") {
    heading = `*${approvalName} approval required*`;
    description =
      view.approvalKind === "plugin"
        ? resolveSlackPluginDescription(view)
        : "A command needs your approval.";
  } else if (phase === "resolved") {
    heading = `*${approvalName} approval: ${resolveSlackApprovalDecisionLabel(view.decision)}*`;
    const resolvedBy = formatSlackApprover(view.resolvedBy);
    description = resolvedBy ? `Resolved by ${resolvedBy}.` : "Resolved.";
  } else {
    heading = `*${approvalName} approval expired*`;
    description = "This approval request expired before it was resolved.";
  }

  const metadata = isPlugin ? buildSlackPluginMetadata(view) : view.metadata;
  const bodyLabel = isPlugin ? "*Request*" : "*Command*";
  const bodyText = isPlugin
    ? escapeSlackPluginApprovalText(view.title)
    : buildSlackCodeBlock(view.commandText);
  const includeMetadata = isPlugin || phase === "pending";
  const text = [
    heading,
    description,
    "",
    bodyLabel,
    bodyText,
    ...(includeMetadata ? buildSlackMetadataLines(metadata) : []),
  ].join("\n");

  const headerDescription =
    isPlugin && phase === "pending" ? truncateSlackMrkdwn(description, 2600) : description;
  const blocks: SlackBlock[] = [
    {
      type: "section",
      ...(phase === "pending" ? { block_id: SLACK_APPROVAL_HEADER_BLOCK_ID } : {}),
      text: {
        type: "mrkdwn",
        text: `${heading}\n${headerDescription}`,
      },
    },
    ...(view.approvalKind === "plugin"
      ? buildSlackPluginRequestBlocks(view)
      : [
          {
            type: "section" as const,
            text: {
              type: "mrkdwn" as const,
              text: `*Command*\n${buildSlackCodeBlock(truncateSlackMrkdwn(view.commandText, 2600))}`,
            },
          },
          ...(phase === "pending" ? buildSlackMetadataContextBlocks(view.metadata) : []),
        ]),
  ];
  if (phase === "pending") {
    blocks.push(
      ...(resolveSlackReplyBlocks({
        text: "",
        presentation: buildApprovalPresentationFromActionDescriptors(view.actions),
      }) ?? []),
    );
  }
  return { text, blocks };
}

async function updateMessage(params: {
  client: WebClient;
  channelId: string;
  messageTs: string;
  text: string;
  blocks: SlackBlock[];
}): Promise<void> {
  try {
    await params.client.chat.update({
      channel: params.channelId,
      ts: params.messageTs,
      text: truncateSlackTextByUtf8Bytes(params.text, SLACK_EDIT_TEXT_MAX_BYTES),
      blocks: params.blocks,
    });
  } catch (err) {
    logError(`slack approvals: failed to update message: ${String(err)}`);
  }
}

export const slackApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  SlackPendingDelivery,
  { to: string; threadTs?: string; teamId?: string },
  SlackPendingApproval,
  never,
  SlackPendingDelivery
>({
  eventKinds: ["exec", "plugin"],
  availability: {
    isConfigured: (params) => {
      const resolved = resolveHandlerContext(params);
      return resolved
        ? isSlackAnyNativeApprovalClientEnabled({
            cfg: params.cfg,
            accountId: resolved.accountId,
          })
        : false;
    },
    shouldHandle: (params) => {
      const resolved = resolveHandlerContext(params);
      if (!resolved) {
        return false;
      }
      return shouldHandleSlackNativeApprovalRequest({
        cfg: params.cfg,
        accountId: resolved.accountId,
        approvalKind: params.approvalKind,
        request: params.request,
      });
    },
  },
  presentation: {
    buildPendingPayload: ({ view }) => buildSlackApprovalPayload({ phase: "pending", view }),
    buildResolvedResult: ({ view }) => ({
      kind: "update",
      payload: buildSlackApprovalPayload({ phase: "resolved", view }),
    }),
    buildExpiredResult: ({ view }) => ({
      kind: "update",
      payload: buildSlackApprovalPayload({ phase: "expired", view }),
    }),
  },
  transport: {
    prepareTarget: ({ plannedTarget }) => {
      const parsed = parseSlackTarget(plannedTarget.target.to, {
        defaultKind: "channel",
      });
      if (!parsed) {
        throw new Error("Slack approval delivery target is missing");
      }
      return {
        dedupeKey: buildChannelApprovalNativeTargetKey(plannedTarget.target),
        target: {
          to: `${parsed.kind}:${parsed.id}`,
          threadTs:
            plannedTarget.target.threadId != null
              ? String(plannedTarget.target.threadId)
              : undefined,
          teamId: parsed.teamId,
        },
      };
    },
    deliverPending: async ({ cfg, accountId, context, preparedTarget, pendingPayload }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return null;
      }
      const client = resolveApprovalClient(resolved.context, preparedTarget.teamId);
      const to = await resolveApprovalChannel(client, preparedTarget.to, preparedTarget.teamId);
      const eventScope = resolveApprovalEventScope(client, preparedTarget.teamId);
      const message = await sendMessageSlack(to, pendingPayload.text, {
        cfg,
        accountId: resolved.accountId,
        threadTs: preparedTarget.threadTs,
        blocks: pendingPayload.blocks,
        client,
        eventScope,
      });
      return {
        channelId: message.channelId,
        messageTs: message.messageId,
        teamId: preparedTarget.teamId,
      };
    },
    updateEntry: async ({ cfg, accountId, context, entry, payload }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return;
      }
      const nextPayload = payload;
      const client = resolveApprovalClient(resolved.context, entry.teamId);
      await updateMessage({
        client,
        channelId: entry.channelId,
        messageTs: entry.messageTs,
        text: nextPayload.text,
        blocks: nextPayload.blocks,
      });
    },
  },
  observe: {
    onDeliveryError: ({ error, request }) => {
      logError(`slack approvals: failed to deliver approval ${request.id}: ${String(error)}`);
    },
  },
});

function resolveApprovalClient(context: SlackApprovalHandlerContext, teamId?: string): WebClient {
  if (!teamId) {
    return context.app.client;
  }
  if (!context.enterprise || !context.resolveClient) {
    throw new Error("Slack Enterprise Grid approval client is unavailable");
  }
  const client = context.resolveClient(teamId);
  if (!client) {
    throw new Error("Slack Enterprise Grid approval client is unavailable");
  }
  return client;
}

function resolveApprovalEventScope(
  client: WebClient,
  teamId?: string,
): SlackEventScope | undefined {
  if (!teamId) {
    return undefined;
  }
  return {
    teamId,
    client,
  };
}

async function resolveApprovalChannel(client: WebClient, target: string, teamId?: string) {
  if (!teamId) {
    return target;
  }
  const parsed = parseSlackTarget(target, { defaultKind: "channel" });
  if (!parsed) {
    throw new Error("Slack approval delivery target is missing");
  }
  if (parsed.kind === "channel") {
    return `channel:${parsed.id}`;
  }
  const opened = await client.conversations.open({ users: parsed.id, return_im: true });
  const channelId = normalizeOptionalString(opened.channel?.id);
  if (!channelId) {
    throw new Error("Slack Enterprise Grid approval DM did not return a channel id");
  }
  return `channel:${channelId}`;
}
