// Telegram plugin module implements interactive fallback behavior.
import {
  adaptMessagePresentationForChannel,
  legacyInteractiveReplyToPresentation,
  isMessagePresentationInteractiveBlock,
  normalizeMessagePresentation,
  normalizeLegacyInteractiveReply,
  renderMessagePresentationFallbackText,
  resolveLegacyInteractiveTextFallback,
  type MessagePresentation,
  type MessagePresentationInteractiveBlock,
} from "openclaw/plugin-sdk/interactive-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { buildTelegramPresentationButtons, resolveTelegramInlineButtons } from "./button-types.js";
import { buildInlineKeyboard } from "./inline-keyboard.js";

const TELEGRAM_CONTROL_ONLY_FALLBACK = "Choose an option.";

export const TELEGRAM_PRESENTATION_CAPABILITIES = {
  supported: true,
  buttons: true,
  selects: true,
  context: true,
  divider: false,
  limits: {
    actions: {
      maxActions: 100,
      maxActionsPerRow: 3,
      maxLabelLength: 64,
      supportsStyles: false,
      supportsDisabled: false,
    },
    selects: {
      maxOptions: 100,
      maxLabelLength: 64,
    },
    text: {
      markdownDialect: "markdown" as const,
    },
  },
};

function canEncodeTelegramPresentationControl(block: MessagePresentationInteractiveBlock): boolean {
  return Boolean(buildTelegramPresentationButtons({ blocks: [block] })?.length);
}

function partitionTelegramPresentationBlocks(params: {
  presentation: MessagePresentation;
  presentationControlsSelected: boolean;
}): {
  fallbackBlocks: MessagePresentation["blocks"];
  nativeControlBlocks: MessagePresentationInteractiveBlock[];
} {
  const fallbackBlocks: MessagePresentation["blocks"] = [];
  const nativeControlBlocks: MessagePresentationInteractiveBlock[] = [];
  for (const block of params.presentation.blocks) {
    if (!isMessagePresentationInteractiveBlock(block)) {
      fallbackBlocks.push(block);
      continue;
    }
    if (!params.presentationControlsSelected) {
      fallbackBlocks.push(block);
      continue;
    }
    if (block.type === "buttons") {
      const nativeButtons: typeof block.buttons = [];
      const fallbackButtons: typeof block.buttons = [];
      for (const button of block.buttons) {
        const target = canEncodeTelegramPresentationControl({ type: "buttons", buttons: [button] })
          ? nativeButtons
          : fallbackButtons;
        target.push(button);
      }
      if (nativeButtons.length > 0) {
        nativeControlBlocks.push({ type: "buttons", buttons: nativeButtons });
      }
      if (fallbackButtons.length > 0) {
        fallbackBlocks.push({ type: "buttons", buttons: fallbackButtons });
      }
      continue;
    }

    const nativeOptions: typeof block.options = [];
    const fallbackOptions: typeof block.options = [];
    for (const option of block.options) {
      const target = canEncodeTelegramPresentationControl({ type: "select", options: [option] })
        ? nativeOptions
        : fallbackOptions;
      target.push(option);
    }
    if (nativeOptions.length > 0) {
      nativeControlBlocks.push({ ...block, options: nativeOptions });
    }
    if (fallbackOptions.length > 0) {
      fallbackBlocks.push({ ...block, options: fallbackOptions });
    } else if (block.placeholder) {
      // Telegram maps selects to buttons, so retain the select prompt in message text.
      fallbackBlocks.push({ type: "text", text: block.placeholder });
    }
  }
  return { fallbackBlocks, nativeControlBlocks };
}

/** Convert portable presentation into the one Telegram payload shape used by every send funnel. */
export function canonicalizeTelegramPresentationPayload(payload: ReplyPayload): ReplyPayload {
  const normalizedPresentation = normalizeMessagePresentation(payload.presentation);
  const telegramData = payload.channelData?.telegram as
    | (Record<string, unknown> & {
        buttons?: Parameters<typeof resolveTelegramInlineButtons>[0]["buttons"];
      })
    | undefined;
  if (!normalizedPresentation) {
    const nativeButtons = resolveTelegramInlineButtons({ buttons: telegramData?.buttons });
    if (!buildInlineKeyboard(nativeButtons) || payload.text?.trim()) {
      return payload;
    }
    // Native-only controls need the same visible message anchor as portable controls.
    return { ...payload, text: TELEGRAM_CONTROL_ONLY_FALLBACK };
  }
  const presentation = adaptMessagePresentationForChannel({
    presentation: normalizedPresentation,
    capabilities: TELEGRAM_PRESENTATION_CAPABILITIES,
  });

  const interactive = normalizeLegacyInteractiveReply(payload.interactive);
  const existingButtons = resolveTelegramInlineButtons({
    buttons: telegramData?.buttons,
    interactive,
  });
  const presentationControlsSelected = existingButtons === undefined;
  const { fallbackBlocks, nativeControlBlocks } = partitionTelegramPresentationBlocks({
    presentation,
    presentationControlsSelected,
  });
  const presentationButtons = buildTelegramPresentationButtons({
    blocks: nativeControlBlocks,
  });
  const buttons = existingButtons ?? presentationButtons;

  const fallbackText = renderMessagePresentationFallbackText({
    presentation: { ...presentation, blocks: fallbackBlocks },
  });
  const currentText =
    resolveLegacyInteractiveTextFallback({ text: payload.text, interactive })?.trim() ?? "";
  const hasFallback =
    fallbackText.length > 0 &&
    (currentText === fallbackText || currentText.endsWith(`\n\n${fallbackText}`));
  const text = hasFallback ? currentText : [currentText, fallbackText].filter(Boolean).join("\n\n");
  const { presentation: _presentation, ...withoutPresentation } = payload;
  const canonical: ReplyPayload = {
    ...withoutPresentation,
    text: text || (buttons ? TELEGRAM_CONTROL_ONLY_FALLBACK : ""),
  };
  if (buttons) {
    canonical.channelData = {
      ...payload.channelData,
      telegram: {
        ...telegramData,
        buttons,
      },
    };
  }
  return canonical;
}

export function resolveTelegramInteractiveTextFallback(params: {
  text?: string | null;
  interactive?: unknown;
  presentation?: unknown;
}): string | undefined {
  const interactive = normalizeLegacyInteractiveReply(params.interactive);
  const text = resolveLegacyInteractiveTextFallback({
    text: params.text ?? undefined,
    interactive,
  });
  if (text?.trim()) {
    return text;
  }
  const presentation = normalizeMessagePresentation(params.presentation);
  if (presentation) {
    const fallback = renderMessagePresentationFallbackText({
      text: params.text ?? undefined,
      presentation,
    });
    if (fallback.trim()) {
      return fallback;
    }
  }
  if (!interactive) {
    return text;
  }
  const interactivePresentation = legacyInteractiveReplyToPresentation(interactive);
  if (!interactivePresentation) {
    return text;
  }
  const fallback = renderMessagePresentationFallbackText({ presentation: interactivePresentation });
  return fallback.trim() ? fallback : text;
}
