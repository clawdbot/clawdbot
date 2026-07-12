// Discord plugin module implements shared interactive behavior.
import {
  reduceInteractiveReply,
  resolveMessagePresentationButtonAction,
  resolveMessagePresentationOptionAction,
} from "openclaw/plugin-sdk/interactive-runtime";
import type {
  InteractiveButtonStyle,
  InteractiveReply,
  MessagePresentation,
  MessagePresentationButton,
  MessagePresentationOption,
} from "openclaw/plugin-sdk/interactive-runtime";
import { buildDiscordApprovalCustomId } from "./approval-custom-id.js";
import type {
  DiscordComponentButtonSpec,
  DiscordComponentButtonStyle,
  DiscordComponentMessageSpec,
} from "./components.types.js";

function resolveDiscordInteractiveButtonStyle(
  style?: InteractiveButtonStyle,
): DiscordComponentButtonStyle | undefined {
  return style ?? "secondary";
}

function resolveDiscordSelectOptionValue(option: MessagePresentationOption): string | undefined {
  const action = resolveMessagePresentationOptionAction(option);
  if (action?.type === "command") {
    return action.command;
  }
  if (action?.type === "callback") {
    return action.value;
  }
  return undefined;
}

function resolveDiscordSelectCallbackDataKind(
  options: MessagePresentationOption[],
): "command" | "callback" | "mixed" | undefined {
  const renderableOptions = options.filter((option) => resolveDiscordSelectOptionValue(option));
  if (
    renderableOptions.length > 0 &&
    renderableOptions.every((option) => option.action?.type === "command")
  ) {
    return "command";
  }
  if (
    renderableOptions.length > 0 &&
    renderableOptions.every((option) => option.action?.type === "callback")
  ) {
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
  const components = buttons
    .map((button) => buildDiscordButtonComponent(button))
    .filter((button): button is DiscordComponentButtonSpec => Boolean(button));
  for (let index = 0; index < components.length; index += DISCORD_INTERACTIVE_BUTTON_ROW_SIZE) {
    blocks.push({
      type: "actions",
      buttons: components.slice(index, index + DISCORD_INTERACTIVE_BUTTON_ROW_SIZE),
    });
  }
}

/**
 * @deprecated Use buildDiscordPresentationComponents with MessagePresentation.
 */
export function buildDiscordInteractiveComponents(
  interactive?: InteractiveReply,
): DiscordComponentMessageSpec | undefined {
  const blocks = reduceInteractiveReply(
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
      if (block.type === "select" && block.options.length > 0) {
        const options = block.options
          .map((option) => ({
            label: option.label,
            value: resolveDiscordSelectOptionValue(option),
          }))
          .filter((option): option is { label: string; value: string } => Boolean(option.value));
        if (options.length === 0) {
          return state;
        }
        const callbackDataKind = resolveDiscordSelectCallbackDataKind(block.options);
        if (callbackDataKind === "mixed") {
          return state;
        }
        state.push({
          type: "actions",
          select: {
            type: "string",
            placeholder: block.placeholder,
            options,
            callbackDataKind,
          },
        });
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
  const spec: DiscordComponentMessageSpec = { blocks: [] };
  if (presentation.title) {
    spec.blocks?.push({ type: "text", text: presentation.title });
  }
  for (const block of presentation.blocks) {
    if (block.type === "text" || block.type === "context") {
      const text = block.text.trim();
      if (text) {
        spec.blocks?.push({
          type: "text",
          text: block.type === "context" ? `-# ${text}` : text,
        });
      }
      continue;
    }
    if (block.type === "divider") {
      spec.blocks?.push({ type: "separator" });
      continue;
    }
  }
  for (const block of presentation.blocks) {
    if (block.type === "buttons") {
      appendDiscordPresentationButtonBlocks(spec, block.buttons);
      continue;
    }
    if (block.type === "select" && block.options.length > 0) {
      const options = block.options
        .map((option) => ({
          label: option.label,
          value: resolveDiscordSelectOptionValue(option),
        }))
        .filter((option): option is { label: string; value: string } => Boolean(option.value));
      if (options.length === 0) {
        continue;
      }
      const callbackDataKind = resolveDiscordSelectCallbackDataKind(block.options);
      if (callbackDataKind === "mixed") {
        continue;
      }
      spec.blocks?.push({
        type: "actions",
        select: {
          type: "string",
          placeholder: block.placeholder,
          options,
          callbackDataKind,
        },
      });
    }
  }
  return spec.blocks?.length ? spec : undefined;
}

function appendDiscordPresentationButtonBlocks(
  spec: DiscordComponentMessageSpec,
  buttons: readonly MessagePresentationButton[],
) {
  if (spec.blocks) {
    appendDiscordButtonBlocks(spec.blocks, buttons);
  }
}
