import type { Block, KnownBlock } from "@slack/web-api";
import { reduceInteractiveReply } from "openclaw/plugin-sdk/interactive-runtime";
import type { InteractiveReply } from "openclaw/plugin-sdk/interactive-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { truncateSlackText } from "./truncate.js";

export const SLACK_REPLY_BUTTON_ACTION_ID = "openclaw:reply_button";
export const SLACK_REPLY_SELECT_ACTION_ID = "openclaw:reply_select";
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
      if (block.buttons.length === 0) {
        return state;
      }
      state.blocks.push({
        type: "actions",
        block_id: `openclaw_reply_buttons_${++state.buttonIndex}`,
        elements: block.buttons.map((button, choiceIndex) => {
          const style = resolveSlackButtonStyle(button.style);
          return {
            type: "button",
            action_id: buildSlackReplyButtonActionId(state.buttonIndex, choiceIndex),
            text: {
              type: "plain_text",
              text: truncateSlackText(button.label, SLACK_PLAIN_TEXT_MAX),
              emoji: true,
            },
            value: button.value,
            ...(style ? { style } : {}),
          };
        }),
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
