// Discord plugin module implements shared interactive behavior.
import {
  reduceInteractiveReply,
  resolveMessagePresentationControlValue,
} from "openclaw/plugin-sdk/interactive-runtime";
import type {
  InteractiveButtonStyle,
  InteractiveReply,
  MessagePresentation,
  MessagePresentationButton,
  MessagePresentationOption,
} from "openclaw/plugin-sdk/interactive-runtime";
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

function applyDiscordButtonCallback(
  spec: DiscordComponentButtonSpec,
  button: MessagePresentationButton,
): void {
  const callbackData = resolveMessagePresentationControlValue(button);
  if (!callbackData) {
    return;
  }
  spec.callbackData = callbackData;
  if (button.action?.type === "command" || button.action?.type === "callback") {
    spec.callbackDataKind = button.action.type;
  }
}

function resolveDiscordSelectOptionValue(option: MessagePresentationOption): string | undefined {
  return resolveMessagePresentationControlValue(option);
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
        if (block.buttons.length === 0) {
          return state;
        }
        for (
          let index = 0;
          index < block.buttons.length;
          index += DISCORD_INTERACTIVE_BUTTON_ROW_SIZE
        ) {
          state.push({
            type: "actions",
            buttons: block.buttons
              .slice(index, index + DISCORD_INTERACTIVE_BUTTON_ROW_SIZE)
              .map((button) => {
                const spec: DiscordComponentButtonSpec = {
                  label: button.label,
                  style: button.url ? "link" : resolveDiscordInteractiveButtonStyle(button.style),
                };
                applyDiscordButtonCallback(spec, button);
                if (button.url) {
                  spec.url = button.url;
                }
                if (button.disabled === true) {
                  spec.disabled = true;
                }
                if (button.reusable === true) {
                  spec.reusable = true;
                }
                return spec;
              }),
          });
        }
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
  if (buttons.length === 0) {
    return;
  }
  for (let index = 0; index < buttons.length; index += DISCORD_INTERACTIVE_BUTTON_ROW_SIZE) {
    spec.blocks?.push({
      type: "actions",
      buttons: buttons.slice(index, index + DISCORD_INTERACTIVE_BUTTON_ROW_SIZE).map((button) => {
        const component: DiscordComponentButtonSpec = {
          label: button.label,
          style: button.url ? "link" : resolveDiscordInteractiveButtonStyle(button.style),
        };
        applyDiscordButtonCallback(component, button);
        if (button.url) {
          component.url = button.url;
        }
        if (button.disabled === true) {
          component.disabled = true;
        }
        if (button.reusable === true) {
          component.reusable = true;
        }
        return component;
      }),
    });
  }
}
