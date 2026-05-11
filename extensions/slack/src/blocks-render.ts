import type { Block, KnownBlock } from "@slack/web-api";
import {
  presentationToInteractiveControlsReply,
  reduceInteractiveReply,
} from "openclaw/plugin-sdk/interactive-runtime";
import type {
  InteractiveReply,
  MessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { SLACK_REPLY_BUTTON_ACTION_ID, SLACK_REPLY_SELECT_ACTION_ID } from "./reply-action-ids.js";
import { truncateSlackText } from "./truncate.js";

const SLACK_SECTION_TEXT_MAX = 3000;
const SLACK_PLAIN_TEXT_MAX = 75;
const SLACK_OPTION_VALUE_MAX = 150;
const SLACK_BUTTON_VALUE_MAX = 2000;
const SLACK_BUTTON_URL_MAX = 3000;
const SLACK_STATIC_SELECT_OPTIONS_MAX = 100;
const SLACK_ACTION_BLOCK_ELEMENTS_MAX = 25;

export type SlackBlock = Block | KnownBlock;

type SlackInteractiveBlockRenderOptions = {
  buttonIndexOffset?: number;
  selectIndexOffset?: number;
};

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

function isWithinSlackLimit(value: string, maxLength: number): boolean {
  return value.length <= maxLength;
}

function readSlackBlockId(block: SlackBlock): string | undefined {
  const value = (block as { block_id?: unknown }).block_id;
  return typeof value === "string" ? value : undefined;
}

function readSlackOpenClawBlockIndex(blockId: string, prefix: string): number | undefined {
  if (!blockId.startsWith(prefix)) {
    return undefined;
  }
  const value = Number.parseInt(blockId.slice(prefix.length), 10);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

export function resolveSlackInteractiveBlockOffsets(
  blocks?: readonly SlackBlock[],
): SlackInteractiveBlockRenderOptions {
  let buttonIndexOffset = 0;
  let selectIndexOffset = 0;
  for (const block of blocks ?? []) {
    const blockId = readSlackBlockId(block);
    if (!blockId) {
      continue;
    }
    buttonIndexOffset = Math.max(
      buttonIndexOffset,
      readSlackOpenClawBlockIndex(blockId, "openclaw_reply_buttons_") ?? 0,
    );
    selectIndexOffset = Math.max(
      selectIndexOffset,
      readSlackOpenClawBlockIndex(blockId, "openclaw_reply_select_") ?? 0,
    );
  }
  return { buttonIndexOffset, selectIndexOffset };
}

export function buildSlackInteractiveBlocks(
  interactive?: InteractiveReply,
  options: SlackInteractiveBlockRenderOptions = {},
): SlackBlock[] {
  const initialState = {
    blocks: [] as SlackBlock[],
    buttonIndex: options.buttonIndexOffset ?? 0,
    selectIndex: options.selectIndexOffset ?? 0,
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
      const elements = block.buttons
        .flatMap((button, choiceIndex) => {
          const value =
            button.value && isWithinSlackLimit(button.value, SLACK_BUTTON_VALUE_MAX)
              ? button.value
              : undefined;
          const url =
            button.url && isWithinSlackLimit(button.url, SLACK_BUTTON_URL_MAX)
              ? button.url
              : undefined;
          if (!value && !url) {
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
              ...(value ? { value } : {}),
              ...(url ? { url } : {}),
              ...(style ? { style } : {}),
            },
          ];
        })
        .slice(0, SLACK_ACTION_BLOCK_ELEMENTS_MAX);
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
    const options = block.options
      .filter((option) => isWithinSlackLimit(option.value, SLACK_OPTION_VALUE_MAX))
      .slice(0, SLACK_STATIC_SELECT_OPTIONS_MAX);
    if (options.length === 0) {
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
          options: options.map((option, _choiceIndex) => ({
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

export function buildSlackPresentationBlocks(
  presentation?: MessagePresentation,
  options: SlackInteractiveBlockRenderOptions = {},
): SlackBlock[] {
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
  const interactive = presentationToInteractiveControlsReply(presentation);
  blocks.push(...buildSlackInteractiveBlocks(interactive, options));
  return blocks;
}
