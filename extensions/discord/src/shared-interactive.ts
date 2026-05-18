import { reduceInteractiveReply } from "openclaw/plugin-sdk/interactive-runtime";
import type {
  InteractiveButtonStyle,
  InteractiveReply,
  MessagePresentation,
  MessagePresentationButton,
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
                if (button.value) {
                  spec.callbackData = button.value;
                }
                if (button.url) {
                  spec.url = button.url;
                }
                return spec;
              }),
          });
        }
        return state;
      }
      if (block.type === "select" && block.options.length > 0) {
        state.push({
          type: "actions",
          select: {
            type: "string",
            placeholder: block.placeholder,
            options: block.options.map((option) => ({
              label: option.label,
              value: option.value,
            })),
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
      spec.blocks?.push({
        type: "actions",
        select: {
          type: "string",
          placeholder: block.placeholder,
          options: block.options.map((option) => ({
            label: option.label,
            value: option.value,
          })),
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
        if (button.value) {
          component.callbackData = button.value;
        }
        if (button.url) {
          component.url = button.url;
        }
        return component;
      }),
    });
  }
}
