// Slack owns one terminal lifecycle for every delivered native question surface.
import type { Block, KnownBlock } from "@slack/web-api";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { SLACK_EDIT_TEXT_MAX_BYTES } from "./limits.js";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";
import { countSlackTextUtf8Bytes, truncateSlackTextByUtf8Bytes } from "./truncate.js";

type SlackQuestionMessageUpdate = {
  channelId: string;
  messageTs: string;
  text: string;
  blocks: (Block | KnownBlock)[];
};

const SLACK_CONTEXT_ELEMENTS_MAX = 10;
const SLACK_CONTEXT_TEXT_MAX_CHARS = 3_000;

function buildSlackQuestionStatusContextBlocks(statusLine: string): (Block | KnownBlock)[] {
  const elements: Array<{ type: "mrkdwn"; text: string }> = [];
  let text = "";
  let characterCount = 0;

  for (const character of statusLine) {
    // Escape complete code points before packing so entities and surrogate pairs never split.
    const escapedCharacter = escapeSlackMrkdwn(character);
    const escapedCharacterCount = Array.from(escapedCharacter).length;
    if (characterCount + escapedCharacterCount > SLACK_CONTEXT_TEXT_MAX_CHARS) {
      elements.push({ type: "mrkdwn", text });
      text = "";
      characterCount = 0;
    }
    text += escapedCharacter;
    characterCount += escapedCharacterCount;
  }

  if (text) {
    elements.push({ type: "mrkdwn", text });
  }

  const blocks: (Block | KnownBlock)[] = [];
  for (let index = 0; index < elements.length; index += SLACK_CONTEXT_ELEMENTS_MAX) {
    blocks.push({
      type: "context",
      elements: elements.slice(index, index + SLACK_CONTEXT_ELEMENTS_MAX),
    });
  }
  return blocks;
}

export function registerSlackQuestionDelivery(params: {
  questionId: string;
  accountId?: string;
  channelId: string;
  messageId: string;
  text: string;
  blocks: (Block | KnownBlock)[];
  update: (message: SlackQuestionMessageUpdate) => Promise<void>;
}): void {
  questionGatewayRuntime.registerChannelDelivery({
    questionId: params.questionId,
    deliveryId: `slack:${params.accountId ?? "default"}:${params.channelId}:${params.messageId}`,
    finalize: async (statusLine) => {
      const escapedStatusLine = escapeSlackMrkdwn(statusLine);
      const statusSuffix = `\n\n${escapedStatusLine}`;
      // Reserve the complete outcome first; notifications must never lose terminal state.
      const originalText = truncateSlackTextByUtf8Bytes(
        params.text,
        SLACK_EDIT_TEXT_MAX_BYTES - countSlackTextUtf8Bytes(statusSuffix),
      );
      await params.update({
        channelId: params.channelId,
        messageTs: params.messageId,
        text: originalText ? `${originalText}${statusSuffix}` : escapedStatusLine,
        blocks: [
          ...params.blocks.filter((block) => block.type !== "actions"),
          ...buildSlackQuestionStatusContextBlocks(statusLine),
        ],
      });
    },
  });
}
