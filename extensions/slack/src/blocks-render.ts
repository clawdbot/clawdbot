import type { Block, KnownBlock } from "@slack/web-api";
import {
  presentationToInteractiveReply,
  reduceInteractiveReply,
} from "openclaw/plugin-sdk/interactive-runtime";
import type {
  InteractiveReply,
  MessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { SLACK_REPLY_BUTTON_ACTION_ID, SLACK_REPLY_SELECT_ACTION_ID } from "./reply-action-ids.js";
import { truncateSlackText } from "./truncate.js";

const SLACK_SECTION_TEXT_MAX = 3000;
const SLACK_PLAIN_TEXT_MAX = 75;

export type SlackBlock = Block | KnownBlock;

function buildSlackReplyButtonActionId(buttonIndex: number, choiceIndex: number): string {
  return `${SLACK_REPLY_BUTTON_ACTION_ID}:${String(buttonIndex)}:${String(choiceIndex + 1)}`;
}

function buildSlackReplySelectActionId(selectIndex: number): string {
  return `${SLACK_REPLY_SELECT_ACTION_ID}:${String(selectIndex)}`;
}

function resolveSlackButtonStyle(
  style: "primary" | "secondary" | "success" | "danger" | undefined,
) {
  if (style === "primary" || style === "danger") {
    return style;
  }
  if (style === "success") {
    return "primary";
  }
  return undefined;
}

export function buildSlackInteractiveBlocks(interactive?: InteractiveReply): SlackBlock[] {
  const initialState = {
    blocks: [] as SlackBlock[],
    buttonIndex: 0,
    selectIndex: 0,
  };
  return reduceInteractiveReply(interactive, initialState, (state, block) => {
    if (block.type === "text") {
      const trimmed = block.text.trim();
      if (!trimmed) {
        return state;
      }
      state.blocks.push({
        type: "section",
        text: {
          type: "mrkdwn",
          text: truncateSlackText(trimmed, SLACK_SECTION_TEXT_MAX),
        },
      });
      return state;
    }
    if (block.type === "buttons") {
      const elements = block.buttons.flatMap((button, choiceIndex) => {
        if (!button.value && !button.url) {
          return [];
        }
        const style = resolveSlackButtonStyle(button.style);
        return [
          {
            type: "button" as const,
            action_id: buildSlackReplyButtonActionId(state.buttonIndex + 1, choiceIndex),
            text: {
              type: "plain_text" as const,
              text: truncateSlackText(button.label, SLACK_PLAIN_TEXT_MAX),
              emoji: true,
            },
            ...(button.value ? { value: button.value } : {}),
            ...(button.url ? { url: button.url } : {}),
            ...(style ? { style } : {}),
          },
        ];
      });
      if (elements.length === 0) {
        return state;
      }
      state.blocks.push({
        type: "actions",
        block_id: `openclaw_reply_buttons_${++state.buttonIndex}`,
        elements,
      });
      return state;
    }
    if (block.options.length === 0) {
      return state;
    }
    state.blocks.push({
      type: "actions",
      block_id: `openclaw_reply_select_${++state.selectIndex}`,
      elements: [
        {
          type: "static_select",
          action_id: buildSlackReplySelectActionId(state.selectIndex),
          placeholder: {
            type: "plain_text",
            text: truncateSlackText(
              normalizeOptionalString(block.placeholder) ?? "Choose an option",
              SLACK_PLAIN_TEXT_MAX,
            ),
            emoji: true,
          },
          options: block.options.map((option, _choiceIndex) => ({
            text: {
              type: "plain_text",
              text: truncateSlackText(option.label, SLACK_PLAIN_TEXT_MAX),
              emoji: true,
            },
            value: option.value,
          })),
        },
      ],
    });
    return state;
  }).blocks;
}

export function buildSlackPresentationBlocks(presentation?: MessagePresentation): SlackBlock[] {
  if (!presentation) {
    return [];
  }
  const blocks: SlackBlock[] = [];
  if (presentation.title) {
    blocks.push({
      type: "header",
      text: {
        type: "plain_text",
        text: truncateSlackText(presentation.title, 150),
        emoji: true,
      },
    });
  }
  for (const block of presentation.blocks) {
    if (block.type === "text" || block.type === "context") {
      const text = block.text.trim();
      if (!text) {
        continue;
      }
      if (block.type === "context") {
        blocks.push({
          type: "context",
          elements: [{ type: "mrkdwn", text: truncateSlackText(text, SLACK_SECTION_TEXT_MAX) }],
        });
      } else {
        blocks.push({
          type: "section",
          text: { type: "mrkdwn", text: truncateSlackText(text, SLACK_SECTION_TEXT_MAX) },
        });
      }
      continue;
    }
    if (block.type === "divider") {
      blocks.push({ type: "divider" });
    }
  }
  const interactive = presentationToInteractiveReply({
    blocks: presentation.blocks.filter(
      (block) => block.type === "buttons" || block.type === "select",
    ),
  });
  blocks.push(...buildSlackInteractiveBlocks(interactive));
  return blocks;
}
