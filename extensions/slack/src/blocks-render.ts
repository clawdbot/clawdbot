// Slack plugin module implements blocks render behavior.
import type { Block, KnownBlock } from "@slack/web-api";
import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/approval-reply-runtime";
import {
  reduceInteractiveReply,
  resolveMessagePresentationControlValue,
} from "openclaw/plugin-sdk/interactive-runtime";
import type {
  InteractiveReply,
  MessagePresentation,
  MessagePresentationButtonsBlock,
  MessagePresentationChartBlock,
  MessagePresentationSelectBlock,
} from "openclaw/plugin-sdk/interactive-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import {
  buildSlackDataTableBlock,
  countSlackDataTableBlocksCellCharacters,
  countSlackDataTableCellCharacters,
  SLACK_DATA_TABLE_CELL_CHARACTERS_MAX,
} from "./data-table.js";
import {
  buildSlackDataVisualizationBlock,
  canRenderSlackDataVisualization,
  hasSlackDataVisualizationBlock,
  SLACK_DATA_VISUALIZATION_BLOCKS_MAX,
} from "./data-visualization.js";
import { renderSlackMessagePresentationChartFallbackText } from "./presentation-fallback.js";
import {
  SLACK_ACTION_BLOCK_ELEMENTS_MAX,
  SLACK_ACTION_LABEL_MAX,
  SLACK_BUTTON_VALUE_MAX,
  SLACK_HEADER_TEXT_MAX,
  SLACK_OPTION_VALUE_MAX,
  SLACK_SECTION_TEXT_MAX,
  SLACK_STATIC_SELECT_OPTIONS_MAX,
} from "./presentation.js";
import {
  SLACK_REPLY_BUTTON_ACTION_ID,
  SLACK_REPLY_LINK_ACTION_ID,
  SLACK_REPLY_SELECT_ACTION_ID,
} from "./reply-action-ids.js";
import { truncateSlackText } from "./truncate.js";

const SLACK_BUTTON_URL_MAX = 3000;

export type SlackBlock = Block | KnownBlock;

export type SlackBlockRenderOptions = {
  buttonIndexOffset?: number;
  dataTableCellCharacterCountOffset?: number;
  dataVisualizationCountOffset?: number;
  selectIndexOffset?: number;
};

function buildSlackReplyButtonActionId(buttonIndex: number, choiceIndex: number): string {
  return `${SLACK_REPLY_BUTTON_ACTION_ID}:${String(buttonIndex)}:${String(choiceIndex + 1)}`;
}

function buildSlackReplyLinkActionId(buttonIndex: number, choiceIndex: number): string {
  return `${SLACK_REPLY_LINK_ACTION_ID}:${String(buttonIndex)}:${String(choiceIndex + 1)}`;
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

function resolveSlackControlValue(control: {
  action?: { type: "command"; command: string } | { type: "callback"; value: string };
  value?: string;
}): string | undefined {
  if (control.action?.type === "command") {
    const command = normalizeOptionalString(control.action.command);
    if (command && parseExecApprovalCommandText(command)) {
      return command;
    }
    const legacyValue = normalizeOptionalString(control.value);
    return legacyValue && parseExecApprovalCommandText(legacyValue) ? legacyValue : undefined;
  }
  return resolveMessagePresentationControlValue(control);
}

function isWithinSlackLimit(value: string, maxLength: number): boolean {
  return value.length <= maxLength;
}

function isRenderableSlackOption(option: {
  label: string;
  value: string | undefined;
}): option is { label: string; value: string } {
  return option.value !== undefined && isWithinSlackLimit(option.value, SLACK_OPTION_VALUE_MAX);
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

/** Resolve existing Block Kit indexes and native-data budgets before appending portable blocks. */
export function resolveSlackBlockOffsets(blocks?: readonly SlackBlock[]): SlackBlockRenderOptions {
  let buttonIndexOffset = 0;
  const dataTableCellCharacterCountOffset =
    countSlackDataTableBlocksCellCharacters(blocks) ?? SLACK_DATA_TABLE_CELL_CHARACTERS_MAX + 1;
  let dataVisualizationCountOffset = 0;
  let selectIndexOffset = 0;
  for (const block of blocks ?? []) {
    if (hasSlackDataVisualizationBlock([block])) {
      dataVisualizationCountOffset += 1;
    }
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
  return {
    buttonIndexOffset,
    dataTableCellCharacterCountOffset,
    dataVisualizationCountOffset,
    selectIndexOffset,
  };
}

/**
 * @deprecated Use buildSlackPresentationBlocks with MessagePresentation.
 */
export function buildSlackInteractiveBlocks(
  interactive?: InteractiveReply,
  options: SlackBlockRenderOptions = {},
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
          const callbackData = resolveSlackControlValue(button);
          const value =
            callbackData && isWithinSlackLimit(callbackData, SLACK_BUTTON_VALUE_MAX)
              ? callbackData
              : undefined;
          const url =
            button.url && isWithinSlackLimit(button.url, SLACK_BUTTON_URL_MAX)
              ? button.url
              : undefined;
          if (!value && !url) {
            return [];
          }
          const target = url ? { url } : { value };
          const style = resolveSlackButtonStyle(button.style);
          return [
            {
              type: "button" as const,
              // Slack emits block_actions even for URL buttons; link-only actions must be ignored.
              action_id: url
                ? buildSlackReplyLinkActionId(state.buttonIndex + 1, choiceIndex)
                : buildSlackReplyButtonActionId(state.buttonIndex + 1, choiceIndex),
              text: {
                type: "plain_text" as const,
                text: truncateSlackText(button.label, SLACK_ACTION_LABEL_MAX),
                emoji: true,
              },
              ...target,
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
    const optionsLocal = block.options
      .map((option) => ({
        label: option.label,
        value: resolveSlackControlValue(option),
      }))
      .filter(isRenderableSlackOption)
      .slice(0, SLACK_STATIC_SELECT_OPTIONS_MAX);
    if (optionsLocal.length === 0) {
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
              SLACK_ACTION_LABEL_MAX,
            ),
            emoji: true,
          },
          options: optionsLocal.map((option, _choiceIndex) => ({
            text: {
              type: "plain_text",
              text: truncateSlackText(option.label, SLACK_ACTION_LABEL_MAX),
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

/** Render portable presentation blocks as Slack Block Kit blocks. */
export function buildSlackPresentationBlocks(
  presentation?: MessagePresentation,
  options: SlackBlockRenderOptions = {},
): SlackBlock[] {
  if (!presentation) {
    return [];
  }
  const renderTablesNatively = canRenderSlackPresentationTables(presentation, options);
  const blocks: SlackBlock[] = [];
  if (presentation.title) {
    blocks.push({
      type: "header",
      text: {
        type: "plain_text",
        text: truncateSlackText(presentation.title, SLACK_HEADER_TEXT_MAX),
        emoji: true,
      },
    });
  }
  let buttonIndex = options.buttonIndexOffset ?? 0;
  let dataTableCellCharacterCount = options.dataTableCellCharacterCountOffset ?? 0;
  let dataVisualizationCount = options.dataVisualizationCountOffset ?? 0;
  let selectIndex = options.selectIndexOffset ?? 0;
  for (const block of presentation.blocks) {
    if (block.type === "text" || block.type === "context") {
      const text = block.text.trim();
      if (!text) {
        continue;
      }
      if (block.type === "context") {
        blocks.push({
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: truncateSlackText(text, SLACK_SECTION_TEXT_MAX),
              verbatim: true,
            },
          ],
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
      continue;
    }
    if (block.type === "buttons") {
      const rendered = buildSlackPresentationButtonBlock(block, buttonIndex + 1);
      if (rendered) {
        buttonIndex += 1;
        blocks.push(rendered);
      }
      continue;
    }
    if (block.type === "chart") {
      const rendered =
        dataVisualizationCount < SLACK_DATA_VISUALIZATION_BLOCKS_MAX
          ? buildSlackPresentationChartBlock(block)
          : undefined;
      if (rendered) {
        dataVisualizationCount += 1;
        blocks.push(rendered);
      } else {
        const fallback = renderSlackMessagePresentationChartFallbackText(block);
        blocks.push(
          ...chunkTextForOutbound(fallback, SLACK_SECTION_TEXT_MAX).map(
            (text): SlackBlock => ({
              type: "context",
              elements: [{ type: "mrkdwn", text, verbatim: true }],
            }),
          ),
        );
      }
      continue;
    }
    if (block.type === "table") {
      if (!renderTablesNatively) {
        continue;
      }
      const rendered = buildSlackDataTableBlock(block, {
        cellCharacterCountOffset: dataTableCellCharacterCount,
      });
      if (rendered) {
        dataTableCellCharacterCount += countSlackDataTableCellCharacters(rendered);
        blocks.push(rendered);
      }
      continue;
    }
    if (block.type === "select") {
      const rendered = buildSlackPresentationSelectBlock(block, selectIndex + 1);
      if (rendered) {
        selectIndex += 1;
        blocks.push(rendered);
      }
    }
  }
  return blocks;
}

function buildSlackPresentationChartBlock(
  block: MessagePresentationChartBlock,
): SlackBlock | undefined {
  return buildSlackDataVisualizationBlock(block);
}

function buildSlackPresentationButtonBlock(
  block: MessagePresentationButtonsBlock,
  buttonIndex: number,
): SlackBlock | undefined {
  const elements = block.buttons
    .flatMap((button, choiceIndex) => {
      const target = resolveSlackPresentationButtonTarget(button);
      if (!target) {
        return [];
      }
      const style = resolveSlackButtonStyle(button.style);
      return [
        {
          type: "button" as const,
          // Slack emits block_actions even for URL buttons; link-only actions must be ignored.
          action_id: target.url
            ? buildSlackReplyLinkActionId(buttonIndex, choiceIndex)
            : buildSlackReplyButtonActionId(buttonIndex, choiceIndex),
          text: {
            type: "plain_text" as const,
            text: truncateSlackText(button.label, SLACK_ACTION_LABEL_MAX),
            emoji: true,
          },
          ...target,
          ...(style ? { style } : {}),
        },
      ];
    })
    .slice(0, SLACK_ACTION_BLOCK_ELEMENTS_MAX);
  return elements.length > 0
    ? {
        type: "actions",
        block_id: `openclaw_reply_buttons_${buttonIndex}`,
        elements,
      }
    : undefined;
}

function resolveSlackPresentationButtonTarget(
  button: MessagePresentationButtonsBlock["buttons"][number],
): { value?: string; url?: string } | undefined {
  const callbackData = resolveSlackControlValue(button);
  const value =
    callbackData && isWithinSlackLimit(callbackData, SLACK_BUTTON_VALUE_MAX)
      ? callbackData
      : undefined;
  const rawUrl = button.url ?? button.webApp?.url ?? button.web_app?.url;
  const url = rawUrl && isWithinSlackLimit(rawUrl, SLACK_BUTTON_URL_MAX) ? rawUrl : undefined;
  return url ? { url } : value ? { value } : undefined;
}

/** True when every portable table fits Slack's native per-message table budget. */
export function canRenderSlackPresentationTables(
  presentation: MessagePresentation,
  options: SlackBlockRenderOptions = {},
): boolean {
  let cellCharacterCount = options.dataTableCellCharacterCountOffset ?? 0;
  for (const block of presentation.blocks) {
    if (block.type !== "table") {
      continue;
    }
    const rendered = buildSlackDataTableBlock(block, {
      cellCharacterCountOffset: cellCharacterCount,
    });
    if (!rendered) {
      return false;
    }
    cellCharacterCount += countSlackDataTableCellCharacters(rendered);
  }
  return true;
}

/** True when native Slack rendering preserves every portable control. */
export function canRenderSlackPresentation(
  presentation: MessagePresentation,
  options: SlackBlockRenderOptions = {},
): boolean {
  if (presentation.title && !isWithinSlackLimit(presentation.title.trim(), SLACK_HEADER_TEXT_MAX)) {
    return false;
  }
  if (!canRenderSlackPresentationTables(presentation, options)) {
    return false;
  }
  let dataVisualizationCount = options.dataVisualizationCountOffset ?? 0;
  for (const block of presentation.blocks) {
    if (block.type === "text" || block.type === "context") {
      if (!isWithinSlackLimit(block.text.trim(), SLACK_SECTION_TEXT_MAX)) {
        return false;
      }
      continue;
    }
    if (block.type === "buttons") {
      const allButtonsRenderable =
        block.buttons.length <= SLACK_ACTION_BLOCK_ELEMENTS_MAX &&
        block.buttons.every(
          (button) =>
            isWithinSlackLimit(button.label, SLACK_ACTION_LABEL_MAX) &&
            resolveSlackPresentationButtonTarget(button) !== undefined,
        );
      if (!allButtonsRenderable) {
        return false;
      }
      continue;
    }
    if (block.type === "select") {
      const placeholder = normalizeOptionalString(block.placeholder) ?? "Choose an option";
      const allOptionsRenderable =
        isWithinSlackLimit(placeholder, SLACK_ACTION_LABEL_MAX) &&
        block.options.length <= SLACK_STATIC_SELECT_OPTIONS_MAX &&
        block.options.every(
          (option) =>
            isWithinSlackLimit(option.label, SLACK_ACTION_LABEL_MAX) &&
            isRenderableSlackOption({
              label: option.label,
              value: resolveSlackControlValue(option),
            }),
        );
      if (!allOptionsRenderable) {
        return false;
      }
      continue;
    }
    if (block.type === "chart") {
      if (
        dataVisualizationCount >= SLACK_DATA_VISUALIZATION_BLOCKS_MAX ||
        !canRenderSlackDataVisualization(block)
      ) {
        return false;
      }
      dataVisualizationCount += 1;
      continue;
    }
    if (block.type === "table") {
      continue;
    }
  }
  return true;
}

/** True when every non-table block survives while tables use text fallback. */
export function canRenderSlackPresentationWithoutTables(
  presentation: MessagePresentation,
  options: SlackBlockRenderOptions = {},
): boolean {
  return canRenderSlackPresentation(
    {
      ...presentation,
      blocks: presentation.blocks.filter((block) => block.type !== "table"),
    },
    options,
  );
}

function buildSlackPresentationSelectBlock(
  block: MessagePresentationSelectBlock,
  selectIndex: number,
): SlackBlock | undefined {
  const options = block.options
    .map((option) => ({
      label: option.label,
      value: resolveSlackControlValue(option),
    }))
    .filter(isRenderableSlackOption)
    .slice(0, SLACK_STATIC_SELECT_OPTIONS_MAX);
  return options.length > 0
    ? {
        type: "actions",
        block_id: `openclaw_reply_select_${selectIndex}`,
        elements: [
          {
            type: "static_select",
            action_id: buildSlackReplySelectActionId(selectIndex),
            placeholder: {
              type: "plain_text",
              text: truncateSlackText(
                normalizeOptionalString(block.placeholder) ?? "Choose an option",
                SLACK_ACTION_LABEL_MAX,
              ),
              emoji: true,
            },
            options: options.map((option) => ({
              text: {
                type: "plain_text",
                text: truncateSlackText(option.label, SLACK_ACTION_LABEL_MAX),
                emoji: true,
              },
              value: option.value,
            })),
          },
        ],
      }
    : undefined;
}
