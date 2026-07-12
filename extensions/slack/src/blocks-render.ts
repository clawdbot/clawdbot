// Slack plugin module implements blocks render behavior.
import type { Block, KnownBlock } from "@slack/web-api";
import { parseExecApprovalCommandText } from "openclaw/plugin-sdk/approval-reply-runtime";
import {
  reduceInteractiveReply,
  resolveMessagePresentationButtonAction,
  resolveMessagePresentationOptionAction,
} from "openclaw/plugin-sdk/interactive-runtime";
import type {
  InteractiveReply,
  MessagePresentation,
  MessagePresentationAction,
  MessagePresentationButtonsBlock,
  MessagePresentationChartBlock,
  MessagePresentationSelectBlock,
} from "openclaw/plugin-sdk/interactive-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import { encodeSlackApprovalAction } from "./approval-actions.js";
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
  SLACK_APPROVAL_BUTTON_ACTION_ID,
  SLACK_APPROVAL_SELECT_ACTION_ID,
  SLACK_CALLBACK_BUTTON_ACTION_ID,
  SLACK_CALLBACK_SELECT_ACTION_ID,
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

function buildSlackApprovalButtonActionId(buttonIndex: number, choiceIndex: number): string {
  return `${SLACK_APPROVAL_BUTTON_ACTION_ID}:${String(buttonIndex)}:${String(choiceIndex + 1)}`;
}

function buildSlackApprovalSelectActionId(selectIndex: number): string {
  return `${SLACK_APPROVAL_SELECT_ACTION_ID}:${String(selectIndex)}`;
}

function buildSlackCallbackButtonActionId(buttonIndex: number, choiceIndex: number): string {
  return `${SLACK_CALLBACK_BUTTON_ACTION_ID}:${String(buttonIndex)}:${String(choiceIndex + 1)}`;
}

function buildSlackCallbackSelectActionId(selectIndex: number): string {
  return `${SLACK_CALLBACK_SELECT_ACTION_ID}:${String(selectIndex)}`;
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

type SlackActionTarget =
  | { kind: "approval"; value: string }
  | { kind: "callback"; value: string }
  | { kind: "link"; url: string }
  | { kind: "reply"; value: string };

function resolveSlackActionTarget(
  action: MessagePresentationAction | undefined,
): SlackActionTarget | undefined {
  if (!action) {
    return undefined;
  }
  if (action.type === "approval") {
    return { kind: "approval", value: encodeSlackApprovalAction(action) };
  }
  if (action.type === "url" || action.type === "web-app") {
    const url = normalizeOptionalString(action.url);
    return url ? { kind: "link", url } : undefined;
  }
  if (action.type === "callback") {
    const value = normalizeOptionalString(action.value);
    return value ? { kind: "callback", value } : undefined;
  }
  const command = normalizeOptionalString(action.command);
  // Command-backed approvals are a shipped legacy input with no trustworthy
  // owner field. Keep them on the kind-specific compatibility resolver.
  return command && parseExecApprovalCommandText(command)
    ? { kind: "reply", value: command }
    : undefined;
}

function resolveSlackButtonTarget(
  button: MessagePresentationButtonsBlock["buttons"][number],
): SlackActionTarget | undefined {
  if (button.action !== undefined) {
    const action = resolveMessagePresentationButtonAction(button);
    return action ? resolveSlackActionTarget(action) : undefined;
  }

  // Legacy buttons could carry both a URL and callback fallback. Preserve the
  // callback when Slack cannot accept the URL; typed actions stay authoritative.
  const legacyUrl = normalizeOptionalString(
    button.url ?? button.webApp?.url ?? button.web_app?.url,
  );
  if (legacyUrl && isWithinSlackLimit(legacyUrl, SLACK_BUTTON_URL_MAX)) {
    return { kind: "link", url: legacyUrl };
  }
  const legacyValue = normalizeOptionalString(button.value);
  if (legacyValue) {
    return { kind: "reply", value: legacyValue };
  }
  return legacyUrl ? { kind: "link", url: legacyUrl } : undefined;
}

function resolveSlackOptionTarget(
  option: MessagePresentationSelectBlock["options"][number],
): Exclude<SlackActionTarget, { kind: "link" }> | undefined {
  if (option.action !== undefined) {
    const action = resolveMessagePresentationOptionAction(option);
    const target = action ? resolveSlackActionTarget(action) : undefined;
    return target?.kind === "link" ? undefined : target;
  }
  const value = normalizeOptionalString(option.value);
  return value ? { kind: "reply", value } : undefined;
}

function isWithinSlackLimit(value: string, maxLength: number): boolean {
  return value.length <= maxLength;
}

function isRenderableSlackOption(option: {
  kind: "approval" | "callback" | "reply";
  label: string;
  value: string;
}): boolean {
  return isWithinSlackLimit(option.value, SLACK_OPTION_VALUE_MAX);
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
          const target = resolveSlackButtonTarget(button);
          if (
            !target ||
            (target.kind === "link"
              ? !isWithinSlackLimit(target.url, SLACK_BUTTON_URL_MAX)
              : !isWithinSlackLimit(target.value, SLACK_BUTTON_VALUE_MAX))
          ) {
            return [];
          }
          const style = resolveSlackButtonStyle(button.style);
          return [
            {
              type: "button" as const,
              // Slack emits block_actions even for URL buttons; link-only actions must be ignored.
              action_id:
                target.kind === "link"
                  ? buildSlackReplyLinkActionId(state.buttonIndex + 1, choiceIndex)
                  : target.kind === "approval"
                    ? buildSlackApprovalButtonActionId(state.buttonIndex + 1, choiceIndex)
                    : target.kind === "callback"
                      ? buildSlackCallbackButtonActionId(state.buttonIndex + 1, choiceIndex)
                      : buildSlackReplyButtonActionId(state.buttonIndex + 1, choiceIndex),
              text: {
                type: "plain_text" as const,
                text: truncateSlackText(button.label, SLACK_ACTION_LABEL_MAX),
                emoji: true,
              },
              ...(target.kind === "link" ? { url: target.url } : { value: target.value }),
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
      .flatMap((option) => {
        const target = resolveSlackOptionTarget(option);
        return target ? [{ label: option.label, ...target }] : [];
      })
      .filter(isRenderableSlackOption)
      .slice(0, SLACK_STATIC_SELECT_OPTIONS_MAX);
    const optionKinds = new Set(optionsLocal.map((option) => option.kind));
    if (optionsLocal.length === 0 || optionKinds.size !== 1) {
      return state;
    }
    state.blocks.push({
      type: "actions",
      block_id: `openclaw_reply_select_${++state.selectIndex}`,
      elements: [
        {
          type: "static_select",
          action_id:
            optionsLocal[0]?.kind === "approval"
              ? buildSlackApprovalSelectActionId(state.selectIndex)
              : optionsLocal[0]?.kind === "callback"
                ? buildSlackCallbackSelectActionId(state.selectIndex)
                : buildSlackReplySelectActionId(state.selectIndex),
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
      const target = resolveSlackButtonTarget(button);
      if (
        !target ||
        (target.kind === "link"
          ? !isWithinSlackLimit(target.url, SLACK_BUTTON_URL_MAX)
          : !isWithinSlackLimit(target.value, SLACK_BUTTON_VALUE_MAX))
      ) {
        return [];
      }
      const style = resolveSlackButtonStyle(button.style);
      return [
        {
          type: "button" as const,
          // Slack emits block_actions even for URL buttons; link-only actions must be ignored.
          action_id:
            target.kind === "link"
              ? buildSlackReplyLinkActionId(buttonIndex, choiceIndex)
              : target.kind === "approval"
                ? buildSlackApprovalButtonActionId(buttonIndex, choiceIndex)
                : target.kind === "callback"
                  ? buildSlackCallbackButtonActionId(buttonIndex, choiceIndex)
                  : buildSlackReplyButtonActionId(buttonIndex, choiceIndex),
          text: {
            type: "plain_text" as const,
            text: truncateSlackText(button.label, SLACK_ACTION_LABEL_MAX),
            emoji: true,
          },
          ...(target.kind === "link" ? { url: target.url } : { value: target.value }),
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
        block.buttons.every((button) => {
          if (!isWithinSlackLimit(button.label, SLACK_ACTION_LABEL_MAX)) {
            return false;
          }
          const target = resolveSlackButtonTarget(button);
          return target
            ? target.kind === "link"
              ? isWithinSlackLimit(target.url, SLACK_BUTTON_URL_MAX)
              : isWithinSlackLimit(target.value, SLACK_BUTTON_VALUE_MAX)
            : false;
        });
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
        (!block.placeholder || isWithinSlackLimit(block.placeholder, SLACK_ACTION_LABEL_MAX)) &&
        block.options.every((option) => {
          if (!isWithinSlackLimit(option.label, SLACK_ACTION_LABEL_MAX)) {
            return false;
          }
          const target = resolveSlackOptionTarget(option);
          return target ? isRenderableSlackOption({ label: option.label, ...target }) : false;
        }) &&
        new Set(block.options.map((option) => resolveSlackOptionTarget(option)?.kind)).size === 1;
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
    .flatMap((option) => {
      const target = resolveSlackOptionTarget(option);
      return target ? [{ label: option.label, ...target }] : [];
    })
    .filter(isRenderableSlackOption)
    .slice(0, SLACK_STATIC_SELECT_OPTIONS_MAX);
  const optionKinds = new Set(options.map((option) => option.kind));
  return options.length > 0 && optionKinds.size === 1
    ? {
        type: "actions",
        block_id: `openclaw_reply_select_${selectIndex}`,
        elements: [
          {
            type: "static_select",
            action_id:
              options[0]?.kind === "approval"
                ? buildSlackApprovalSelectActionId(selectIndex)
                : options[0]?.kind === "callback"
                  ? buildSlackCallbackSelectActionId(selectIndex)
                  : buildSlackReplySelectActionId(selectIndex),
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
