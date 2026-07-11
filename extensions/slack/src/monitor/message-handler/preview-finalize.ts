// Slack plugin module implements preview finalize behavior.
import type { Block, KnownBlock, WebClient } from "@slack/web-api";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { editSlackMessage } from "../../actions.js";
import { buildSlackBlocksFallbackText } from "../../blocks-fallback.js";
import { buildSlackEditTextPayload } from "../../edit-text.js";
import { normalizeSlackOutboundText } from "../../format.js";
import { SLACK_EDIT_TEXT_LIMIT } from "../../limits.js";
import { hasSlackNativeDataBlock } from "../../native-data-blocks.js";
import { buildSlackNativeDataDeliveryPlan } from "../../native-data-fallback.js";
import { truncateSlackText } from "../../truncate.js";

type SlackReadbackMessage = {
  ts?: string;
  text?: string;
  blocks?: unknown[];
};

function buildExpectedSlackEditText(params: {
  text: string;
  blocks?: (Block | KnownBlock)[];
}): string {
  const trimmedText = params.text.trim();
  if (trimmedText) {
    return normalizeSlackOutboundText(trimmedText);
  }
  if (params.blocks?.length) {
    return normalizeSlackOutboundText(buildSlackBlocksFallbackText(params.blocks));
  }
  return " ";
}

function buildAcceptedSlackEditTexts(params: {
  text: string;
  blocks?: (Block | KnownBlock)[];
}): Set<string> {
  const expected = buildExpectedSlackEditText(params);
  const texts = new Set([
    expected,
    normalizeSlackOutboundText(truncateSlackText(expected, SLACK_EDIT_TEXT_LIMIT)),
    normalizeSlackOutboundText(buildSlackEditTextPayload(params.text, params.blocks)),
  ]);
  if (params.blocks?.length && hasSlackNativeDataBlock(params.blocks)) {
    const fallbackPlan = buildSlackNativeDataDeliveryPlan({
      baseText: params.text,
      blocks: params.blocks,
    });
    for (const message of fallbackPlan.fallbackMessages) {
      texts.add(normalizeSlackOutboundText(message.text));
    }
  }
  return texts;
}

function blocksMatch(expected?: (Block | KnownBlock)[], actual?: unknown[]): boolean {
  if (!expected?.length) {
    return !actual?.length;
  }
  if (!actual?.length) {
    if (!hasSlackNativeDataBlock(expected)) {
      return false;
    }
    const fallbackPlan = buildSlackNativeDataDeliveryPlan({
      blocks: expected,
    });
    return fallbackPlan.fallbackMessages.every((message) => !message.blocks?.length);
  }
  if (JSON.stringify(expected) === JSON.stringify(actual)) {
    return true;
  }
  if (!hasSlackNativeDataBlock(expected)) {
    return false;
  }
  try {
    const fallbackPlan = buildSlackNativeDataDeliveryPlan({
      blocks: expected,
    });
    const fallbackBlocks = fallbackPlan.fallbackMessages.flatMap((message) => message.blocks ?? []);
    if (JSON.stringify(fallbackBlocks) === JSON.stringify(actual)) {
      return true;
    }
    const fallbackText = fallbackPlan.fallbackMessages
      .map((message) => message.text)
      .filter(Boolean)
      .join("\n\n");
    const actualText = buildSlackBlocksFallbackText(actual);
    return normalizeSlackOutboundText(actualText) === normalizeSlackOutboundText(fallbackText);
  } catch {
    return false;
  }
}

async function readSlackMessageAfterEditError(params: {
  client: WebClient;
  token: string;
  channelId: string;
  messageId: string;
  threadTs?: string;
}): Promise<SlackReadbackMessage | null> {
  if (params.threadTs) {
    const replyResult = await params.client.conversations.replies({
      token: params.token,
      channel: params.channelId,
      ts: params.threadTs,
      latest: params.messageId,
      inclusive: true,
      limit: 100,
    });
    const reply = (replyResult.messages ?? []).find(
      (message) => (message as SlackReadbackMessage | undefined)?.ts === params.messageId,
    ) as SlackReadbackMessage | undefined;
    return reply ?? null;
  }

  const historyResult = await params.client.conversations.history({
    token: params.token,
    channel: params.channelId,
    latest: params.messageId,
    oldest: params.messageId,
    inclusive: true,
    limit: 1,
  });
  const message = historyResult.messages?.[0] as SlackReadbackMessage | undefined;
  if (!message?.ts || message.ts !== params.messageId) {
    return null;
  }
  return message;
}

async function didSlackPreviewEditApplyAfterError(params: {
  client: WebClient;
  token: string;
  channelId: string;
  messageId: string;
  text: string;
  blocks?: (Block | KnownBlock)[];
  threadTs?: string;
}): Promise<boolean> {
  const readback = await readSlackMessageAfterEditError(params);
  if (!readback) {
    return false;
  }
  const expectedText = buildExpectedSlackEditText({
    text: params.text,
    blocks: params.blocks,
  });
  const acceptedTexts = buildAcceptedSlackEditTexts({
    text: params.text,
    blocks: params.blocks,
  });
  const actualText = normalizeSlackOutboundText((readback.text ?? "").trim());
  if (params.blocks?.length) {
    return acceptedTexts.has(actualText) && blocksMatch(params.blocks, readback.blocks);
  }
  return actualText === expectedText;
}

export async function finalizeSlackPreviewEdit(params: {
  client: WebClient;
  token: string;
  accountId?: string;
  channelId: string;
  messageId: string;
  text: string;
  blocks?: (Block | KnownBlock)[];
  threadTs?: string;
}): Promise<void> {
  try {
    await editSlackMessage(params.channelId, params.messageId, params.text, {
      token: params.token,
      accountId: params.accountId,
      client: params.client,
      ...(params.blocks?.length ? { blocks: params.blocks } : {}),
    });
  } catch (err) {
    try {
      const applied = await didSlackPreviewEditApplyAfterError({
        client: params.client,
        token: params.token,
        channelId: params.channelId,
        messageId: params.messageId,
        text: params.text,
        blocks: params.blocks,
        threadTs: params.threadTs,
      });
      if (applied) {
        logVerbose(
          `slack: preview final edit response failed but readback matched message ${params.channelId}/${params.messageId}; suppressing duplicate fallback send`,
        );
        return;
      }
    } catch (readbackErr) {
      logVerbose(`slack: preview final edit readback failed (${String(readbackErr)})`);
    }
    throw err;
  }
}

export const testing = {
  buildExpectedSlackEditText,
  blocksMatch,
  didSlackPreviewEditApplyAfterError,
  readSlackMessageAfterEditError,
};
export { testing as __testing };
