// Discord plugin module implements shared interactive behavior.
import {
  reduceLegacyInteractiveReply,
  resolveMessagePresentationActionValue,
  resolveMessagePresentationButtonAction,
  resolveMessagePresentationOptionAction,
} from "openclaw/plugin-sdk/interactive-runtime";
import type {
  InteractiveButtonStyle,
  LegacyInteractiveReply,
  MessagePresentation,
  MessagePresentationButton,
  MessagePresentationOption,
  MessagePresentationSelectBlock,
} from "openclaw/plugin-sdk/interactive-runtime";
import { buildDiscordApprovalCustomId } from "./approval-custom-id.js";
import {
  buildDiscordActivityCustomId,
  isValidDiscordActivityWidgetId,
} from "./component-custom-id.js";
import type {
  DiscordComponentButtonSpec,
  DiscordComponentButtonStyle,
  DiscordComponentMessageSpec,
} from "./components.types.js";
import { buildDiscordQuestionCustomId } from "./question-custom-id.js";

function resolveDiscordInteractiveButtonStyle(
  style?: InteractiveButtonStyle,
): DiscordComponentButtonStyle | undefined {
  return style ?? "secondary";
}

function resolveDiscordSelectOptionValue(option: MessagePresentationOption): string | undefined {
  return resolveMessagePresentationActionValue(resolveMessagePresentationOptionAction(option));
}

function resolveDiscordSelectCallbackDataKind(
  options: MessagePresentationOption[],
): "command" | "callback" | "mixed" | undefined {
  const renderableOptions = options.filter((option) => resolveDiscordSelectOptionValue(option));
  if (renderableOptions.length === 0) {
    return undefined;
  }
  if (renderableOptions.every((option) => option.action?.type === "command")) {
    return "command";
  }
  if (renderableOptions.every((option) => option.action?.type === "callback")) {
    return "callback";
  }
  if (renderableOptions.some((option) => option.action)) {
    return "mixed";
  }
  return undefined;
}

const DISCORD_INTERACTIVE_BUTTON_ROW_SIZE = 5;

function buildDiscordButtonComponent(
  button: MessagePresentationButton,
  optionIndex: number,
): DiscordComponentButtonSpec | undefined {
  const action = resolveMessagePresentationButtonAction(button);
  if (!action) {
    return undefined;
  }
  if (action.type === "approval") {
    const internalCustomId = buildDiscordApprovalCustomId(action);
    if (!internalCustomId) {
      return undefined;
    }
    return {
      label: button.label,
      style: resolveDiscordInteractiveButtonStyle(button.style),
      internalCustomId,
      ...(button.disabled === true ? { disabled: true } : {}),
    };
  }
  if (action.type === "question") {
    const internalCustomId = buildDiscordQuestionCustomId({
      questionId: action.questionId,
      optionIndex,
    });
    return internalCustomId
      ? {
          label: button.label,
          style: resolveDiscordInteractiveButtonStyle(button.style),
          internalCustomId,
          ...(button.disabled === true ? { disabled: true } : {}),
        }
      : undefined;
  }
  if (
    action.type === "web-app" &&
    action.widgetId &&
    isValidDiscordActivityWidgetId(action.widgetId)
  ) {
    return {
      label: button.label,
      style: resolveDiscordInteractiveButtonStyle(button.style),
      internalCustomId: buildDiscordActivityCustomId(action.widgetId),
      ...(button.disabled === true ? { disabled: true } : {}),
      ...(button.reusable === true ? { reusable: true } : {}),
    };
  }
  if (action.type === "web-app" && !action.url) {
    return undefined;
  }
  const component: DiscordComponentButtonSpec = {
    label: button.label,
    style:
      action.type === "url" || action.type === "web-app"
        ? "link"
        : resolveDiscordInteractiveButtonStyle(button.style),
  };
  if (action.type === "url" || action.type === "web-app") {
    component.url = action.url;
  } else {
    component.callbackData = action.type === "command" ? action.command : action.value;
    if (button.action?.type === "command" || button.action?.type === "callback") {
      component.callbackDataKind = button.action.type;
    }
  }
  if (button.disabled === true) {
    component.disabled = true;
  }
  if (button.reusable === true) {
    component.reusable = true;
  }
  return component;
}

function appendDiscordButtonBlocks(
  blocks: NonNullable<DiscordComponentMessageSpec["blocks"]>,
  buttons: readonly MessagePresentationButton[],
): void {
  // Index is position in the question's options; core emits one buttons block in option order.
  const components = buttons
    .map((button, optionIndex) => buildDiscordButtonComponent(button, optionIndex))
    .filter((button): button is DiscordComponentButtonSpec => Boolean(button));
  for (let index = 0; index < components.length; index += DISCORD_INTERACTIVE_BUTTON_ROW_SIZE) {
    blocks.push({
      type: "actions",
      buttons: components.slice(index, index + DISCORD_INTERACTIVE_BUTTON_ROW_SIZE),
    });
  }
}

function appendDiscordSelectBlock(
  blocks: NonNullable<DiscordComponentMessageSpec["blocks"]>,
  block: MessagePresentationSelectBlock,
): void {
  const options = block.options
    .map((option) => ({
      label: option.label,
      value: resolveDiscordSelectOptionValue(option),
    }))
    .filter((option): option is { label: string; value: string } => Boolean(option.value));
  if (options.length === 0) {
    return;
  }
  const callbackDataKind = resolveDiscordSelectCallbackDataKind(block.options);
  if (callbackDataKind === "mixed") {
    return;
  }
  blocks.push({
    type: "actions",
    select: {
      type: "string",
      placeholder: block.placeholder,
      options,
      callbackDataKind,
    },
  });
}

/**
 * @deprecated Use buildDiscordPresentationComponents with MessagePresentation.
 */
export function buildDiscordInteractiveComponents(
  interactive?: LegacyInteractiveReply,
): DiscordComponentMessageSpec | undefined {
  const blocks = reduceLegacyInteractiveReply(
    interactive,
    [] as NonNullable<DiscordComponentMessageSpec["blocks"]>,
    (state, block) => {
      if (block.type === "text") {
        const text = block.text.trim();
        if (text) {
          state.push({ type: "text", text });
        }
        return state;
      }
      if (block.type === "buttons") {
        appendDiscordButtonBlocks(state, block.buttons);
        return state;
      }
      if (block.type === "select") {
        appendDiscordSelectBlock(state, block);
      }
      return state;
    },
  );
  return blocks.length > 0 ? { blocks } : undefined;
}

export function buildDiscordPresentationComponents(
  presentation?: MessagePresentation,
): DiscordComponentMessageSpec | undefined {
  if (!presentation) {
    return undefined;
  }
  const blocks: NonNullable<DiscordComponentMessageSpec["blocks"]> = [];
  if (presentation.title) {
    blocks.push({ type: "text", text: presentation.title });
  }
  for (const block of presentation.blocks) {
    if (block.type === "text" || block.type === "context") {
      const text = block.text.trim();
      if (text) {
        blocks.push({
          type: "text",
          text: block.type === "context" ? `-# ${text}` : text,
        });
      }
      continue;
    }
    if (block.type === "divider") {
      blocks.push({ type: "separator" });
      continue;
    }
    if (block.type === "buttons") {
      appendDiscordButtonBlocks(blocks, block.buttons);
      continue;
    }
    if (block.type === "select") {
      appendDiscordSelectBlock(blocks, block);
    }
  }
  return blocks.length ? { blocks } : undefined;
}
