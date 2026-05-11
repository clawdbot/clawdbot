import type { App } from "@slack/bolt";
import type { Block, KnownBlock } from "@slack/web-api";
import type {
  ChannelApprovalCapabilityHandlerContext,
  ExecApprovalExpiredView,
  ExecApprovalPendingView,
  ExecApprovalResolvedView,
} from "openclaw/plugin-sdk/approval-handler-runtime";
import { createChannelApprovalNativeRuntimeAdapter } from "openclaw/plugin-sdk/approval-handler-runtime";
import { buildChannelApprovalNativeTargetKey } from "openclaw/plugin-sdk/approval-native-runtime";
import { buildApprovalInteractiveReplyFromActionDescriptors } from "openclaw/plugin-sdk/approval-reply-runtime";
import type { ExecApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { logError } from "openclaw/plugin-sdk/logging-core";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  isSlackExecApprovalClientEnabled,
  shouldHandleSlackExecApprovalRequest,
  normalizeSlackApproverId,
} from "./exec-approvals.js";
import { resolveSlackReplyBlocks } from "./reply-blocks.js";
import { sendMessageSlack } from "./send.js";
import { truncateSlackText } from "./truncate.js";

type SlackBlock = Block | KnownBlock;
type SlackPendingApproval = {
  channelId: string;
  messageTs: string;
};
type SlackPendingDelivery = {
  text: string;
  blocks: SlackBlock[];
};

const SLACK_CONTEXT_ELEMENTS_MAX = 10;
const SLACK_CHAT_UPDATE_TEXT_LIMIT = 4000;
const SLACK_TEXT_OBJECT_MAX = 3000;

type SlackExecApprovalConfig = NonNullable<
  NonNullable<NonNullable<OpenClawConfig["channels"]>["slack"]>["execApprovals"]
>;

export type SlackApprovalHandlerContext = {
  app: App;
  config: SlackExecApprovalConfig;
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
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}…`;
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

function buildSlackMetadataLines(metadata: readonly { label: string; value: string }[]): string[] {
  const lines: string[] = [];
  for (const item of metadata) {
    lines.push(formatSlackMetadataLine(item.label, item.value));
  }
  return lines;
}

function buildSlackMetadataContextElements(metadata: readonly { label: string; value: string }[]) {
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

function resolveSlackApprovalDecisionLabel(
  decision: "allow-once" | "allow-always" | "deny",
): string {
  return decision === "allow-once"
    ? "Allowed once"
    : decision === "allow-always"
      ? "Allowed always"
      : "Denied";
}

function buildSlackPendingApprovalText(view: ExecApprovalPendingView): string {
  const metadataLines = buildSlackMetadataLines(view.metadata);
  const lines = [
    "*Exec approval required*",
    "A command needs your approval.",
    "",
    "*Command*",
    buildSlackCodeBlock(view.commandText),
    ...metadataLines,
  ];
  return lines.join("\n");
}

function buildSlackPendingApprovalBlocks(view: ExecApprovalPendingView): SlackBlock[] {
  const metadataElements = buildSlackMetadataContextElements(view.metadata);
  const interactiveBlocks =
    resolveSlackReplyBlocks({
      text: "",
      interactive: buildApprovalInteractiveReplyFromActionDescriptors(view.actions),
    }) ?? [];
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Exec approval required*\nA command needs your approval.",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Command*\n${buildSlackCodeBlock(truncateSlackMrkdwn(view.commandText, 2600))}`,
      },
    },
    ...(metadataElements.length > 0
      ? [
          {
            type: "context",
            elements: metadataElements,
          } satisfies SlackBlock,
        ]
      : []),
    ...interactiveBlocks,
  ];
}

function buildSlackResolvedText(view: ExecApprovalResolvedView): string {
  const resolvedBy = formatSlackApprover(view.resolvedBy);
  const lines = [
    `*Exec approval: ${resolveSlackApprovalDecisionLabel(view.decision)}*`,
    resolvedBy ? `Resolved by ${resolvedBy}.` : "Resolved.",
    "",
    "*Command*",
    buildSlackCodeBlock(view.commandText),
  ];
  return lines.join("\n");
}

function buildSlackResolvedBlocks(view: ExecApprovalResolvedView): SlackBlock[] {
  const resolvedBy = formatSlackApprover(view.resolvedBy);
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Exec approval: ${resolveSlackApprovalDecisionLabel(view.decision)}*\n${
          resolvedBy ? `Resolved by ${resolvedBy}.` : "Resolved."
        }`,
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Command*\n${buildSlackCodeBlock(truncateSlackMrkdwn(view.commandText, 2600))}`,
      },
    },
  ];
}

function buildSlackExpiredText(view: ExecApprovalExpiredView): string {
  return [
    "*Exec approval expired*",
    "This approval request expired before it was resolved.",
    "",
    "*Command*",
    buildSlackCodeBlock(view.commandText),
  ].join("\n");
}

function buildSlackExpiredBlocks(view: ExecApprovalExpiredView): SlackBlock[] {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: "*Exec approval expired*\nThis approval request expired before it was resolved.",
      },
    },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*Command*\n${buildSlackCodeBlock(truncateSlackMrkdwn(view.commandText, 2600))}`,
      },
    },
  ];
}

async function updateMessage(params: {
  app: App;
  channelId: string;
  messageTs: string;
  text: string;
  blocks: SlackBlock[];
}): Promise<void> {
  try {
    await params.app.client.chat.update({
      channel: params.channelId,
      ts: params.messageTs,
      text: truncateSlackText(params.text, SLACK_CHAT_UPDATE_TEXT_LIMIT),
      blocks: params.blocks,
    });
  } catch (err) {
    logError(`slack exec approvals: failed to update message: ${String(err)}`);
  }
}

export const slackApprovalNativeRuntime = createChannelApprovalNativeRuntimeAdapter<
  SlackPendingDelivery,
  { to: string; threadTs?: string },
  SlackPendingApproval,
  never,
  SlackPendingDelivery
>({
  eventKinds: ["exec"],
  availability: {
    isConfigured: (params) => {
      const resolved = resolveHandlerContext(params);
      return resolved
        ? isSlackExecApprovalClientEnabled({
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
      return shouldHandleSlackExecApprovalRequest({
        cfg: params.cfg,
        accountId: resolved.accountId,
        request: params.request as ExecApprovalRequest,
      });
    },
  },
  presentation: {
    buildPendingPayload: ({ view }) => ({
      text: buildSlackPendingApprovalText(view as ExecApprovalPendingView),
      blocks: buildSlackPendingApprovalBlocks(view as ExecApprovalPendingView),
    }),
    buildResolvedResult: ({ view }) => ({
      kind: "update",
      payload: {
        text: buildSlackResolvedText(view as ExecApprovalResolvedView),
        blocks: buildSlackResolvedBlocks(view as ExecApprovalResolvedView),
      },
    }),
    buildExpiredResult: ({ view }) => ({
      kind: "update",
      payload: {
        text: buildSlackExpiredText(view as ExecApprovalExpiredView),
        blocks: buildSlackExpiredBlocks(view as ExecApprovalExpiredView),
      },
    }),
  },
  transport: {
    prepareTarget: ({ plannedTarget }) => ({
      dedupeKey: buildChannelApprovalNativeTargetKey(plannedTarget.target),
      target: {
        to: plannedTarget.target.to,
        threadTs:
          plannedTarget.target.threadId != null ? String(plannedTarget.target.threadId) : undefined,
      },
    }),
    deliverPending: async ({ cfg, accountId, context, preparedTarget, pendingPayload }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return null;
      }
      const message = await sendMessageSlack(preparedTarget.to, pendingPayload.text, {
        cfg,
        accountId: resolved.accountId,
        threadTs: preparedTarget.threadTs,
        blocks: pendingPayload.blocks,
        client: resolved.context.app.client,
      });
      return {
        channelId: message.channelId,
        messageTs: message.messageId,
      };
    },
    updateEntry: async ({ cfg, accountId, context, entry, payload }) => {
      const resolved = resolveHandlerContext({ cfg, accountId, context });
      if (!resolved) {
        return;
      }
      const nextPayload = payload;
      await updateMessage({
        app: resolved.context.app,
        channelId: entry.channelId,
        messageTs: entry.messageTs,
        text: nextPayload.text,
        blocks: nextPayload.blocks,
      });
    },
  },
  observe: {
    onDeliveryError: ({ error, request }) => {
      logError(`slack exec approvals: failed to deliver approval ${request.id}: ${String(error)}`);
    },
  },
});
