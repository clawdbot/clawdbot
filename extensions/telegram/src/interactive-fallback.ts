// Telegram plugin module implements interactive fallback behavior.
import {
  adaptMessagePresentationForChannel,
  legacyInteractiveReplyToPresentation,
  isMessagePresentationInteractiveBlock,
  normalizeMessagePresentation,
  normalizeLegacyInteractiveReply,
  renderMessagePresentationFallbackText,
  resolveLegacyInteractiveTextFallback,
  resolveMessagePresentationButtonAction,
  type MessagePresentation,
  type MessagePresentationButton,
  type MessagePresentationInteractiveBlock,
  type MessagePresentationTableBlock,
} from "openclaw/plugin-sdk/interactive-runtime";
import {
  resolveAskUserQuestionOptionIndices,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import {
  buildTelegramPresentationButtons,
  escapeTelegramCopyTextFallback,
  isValidTelegramCopyText,
  resolveTelegramInlineButtons,
  type TelegramButtonBuildOptions,
} from "./button-types.js";
import { buildInlineKeyboard } from "./inline-keyboard.js";

const TELEGRAM_CONTROL_ONLY_FALLBACK = "Choose an option.";

const TELEGRAM_PRESENTATION_CAPABILITIES = {
  supported: true,
  buttons: true,
  copyTextButtons: true,
  selects: true,
  context: true,
  divider: false,
  // Native table blocks require the account's Bot API 10.3 rich-message path;
  // per-account capability resolution flips this on when richMessages is enabled.
  tables: false,
  limits: {
    actions: {
      maxActions: 100,
      maxActionsPerRow: 3,
      maxLabelLength: 64,
      supportsStyles: true,
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

export function resolveTelegramPresentationCapabilities(params: {
  richMessages: boolean;
}): typeof TELEGRAM_PRESENTATION_CAPABILITIES {
  return params.richMessages
    ? { ...TELEGRAM_PRESENTATION_CAPABILITIES, tables: true }
    : TELEGRAM_PRESENTATION_CAPABILITIES;
}

function escapeTelegramTableCellText(value: string | number): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/\s+/g, " ")
    .trim();
}

// The `<table>` HTML island feeds the existing island -> rich-block converter,
// which emits native Bot API 10.3 table blocks (bordered, striped, native
// caption, header cells) on rich accounts. Markdown pipe tables cannot express
// row-header columns or native captions, so the island form is canonical here.
function renderTelegramTableIsland(block: MessagePresentationTableBlock): string {
  const caption = block.caption.trim()
    ? `<caption>${escapeTelegramTableCellText(block.caption)}</caption>`
    : "";
  const headerRow = block.headers
    .map((header) => `<th>${escapeTelegramTableCellText(header)}</th>`)
    .join("");
  const bodyRows = block.rows
    .map(
      (row) =>
        `<tr>${row
          .map((cell, index) =>
            index === block.rowHeaderColumnIndex
              ? `<th>${escapeTelegramTableCellText(cell)}</th>`
              : `<td>${escapeTelegramTableCellText(cell)}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("");
  return `<table>${caption}<thead><tr>${headerRow}</tr></thead><tbody>${bodyRows}</tbody></table>`;
}

// Context blocks are low-emphasis by contract; italics is Telegram's closest
// native register. Lines already containing markdown emphasis markers stay
// plain so wrapping cannot mis-parse them.
function renderTelegramContextText(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trim();
      return trimmed && !/[_*]/.test(trimmed) ? `_${trimmed}_` : line;
    })
    .join("\n");
}

function renderTelegramRichFallbackText(presentation: MessagePresentation): string {
  const parts: string[] = [];
  if (presentation.title?.trim()) {
    parts.push(`**${presentation.title.trim()}**`);
  }
  for (const block of presentation.blocks) {
    const text =
      block.type === "table"
        ? renderTelegramTableIsland(block)
        : block.type === "context"
          ? renderTelegramContextText(block.text)
          : renderMessagePresentationFallbackText({ presentation: { blocks: [block] } });
    if (text.trim()) {
      parts.push(text);
    }
  }
  return parts.join("\n\n");
}

function canEncodeTelegramPresentationControl(
  block: MessagePresentationInteractiveBlock,
  options?: TelegramButtonBuildOptions,
): boolean {
  return Boolean(buildTelegramPresentationButtons({ blocks: [block] }, options)?.length);
}

function prepareTelegramCopyTextFallbackButton(
  button: MessagePresentationButton,
): MessagePresentationButton {
  const action = resolveMessagePresentationButtonAction(button);
  if (action?.type !== "copy-text" || isValidTelegramCopyText(action.text)) {
    return button;
  }
  return {
    ...button,
    action: { type: "copy-text", text: escapeTelegramCopyTextFallback(action.text) },
  };
}

function renderTelegramControlFallbackText(block: MessagePresentationInteractiveBlock): string {
  const fallbackBlock =
    block.type === "buttons"
      ? { ...block, buttons: block.buttons.map(prepareTelegramCopyTextFallbackButton) }
      : block;
  return renderMessagePresentationFallbackText({ presentation: { blocks: [fallbackBlock] } });
}

/** Remove Telegram-invalid copy actions before core spends the shared action budget. */
export function prepareTelegramPresentationPayloadForCoreAdaptation(
  payload: ReplyPayload,
): ReplyPayload {
  const presentation = normalizeMessagePresentation(payload.presentation);
  if (!presentation) {
    return payload;
  }
  let changed = false;
  const blocks = presentation.blocks.flatMap((block): MessagePresentation["blocks"] => {
    if (block.type !== "buttons") {
      return [block];
    }
    const nativeButtons: typeof block.buttons = [];
    const fallbackButtons: typeof block.buttons = [];
    for (const button of block.buttons) {
      const action = resolveMessagePresentationButtonAction(button);
      const target =
        action?.type === "copy-text" && !isValidTelegramCopyText(action.text)
          ? fallbackButtons
          : nativeButtons;
      target.push(button);
    }
    if (fallbackButtons.length === 0) {
      return [block];
    }
    changed = true;
    return [
      ...(nativeButtons.length > 0 ? [{ ...block, buttons: nativeButtons }] : []),
      {
        type: "context" as const,
        text: renderTelegramControlFallbackText({ type: "buttons", buttons: fallbackButtons }),
      },
    ];
  });
  return changed ? { ...payload, presentation: { ...presentation, blocks } } : payload;
}

function prepareTelegramPresentationForAdaptation(params: {
  presentation: MessagePresentation;
  presentationControlsSelected: boolean;
  buttonOptions: TelegramButtonBuildOptions;
}): MessagePresentation {
  if (!params.presentationControlsSelected) {
    return params.presentation;
  }
  const blocks = params.presentation.blocks.flatMap((block): MessagePresentation["blocks"] => {
    if (!isMessagePresentationInteractiveBlock(block)) {
      return [block];
    }
    if (block.type === "buttons") {
      const nativeButtons = block.buttons.filter((button) =>
        canEncodeTelegramPresentationControl(
          { type: "buttons", buttons: [button] },
          params.buttonOptions,
        ),
      );
      const native = new Set(nativeButtons);
      const fallbackButtons = block.buttons.filter((button) => !native.has(button));
      return [
        ...(nativeButtons.length > 0 ? [{ type: "buttons" as const, buttons: nativeButtons }] : []),
        ...(fallbackButtons.length > 0
          ? [
              {
                type: "context" as const,
                text: renderTelegramControlFallbackText({
                  type: "buttons",
                  buttons: fallbackButtons,
                }),
              },
            ]
          : []),
      ];
    }

    const nativeOptions = block.options.filter((option) =>
      canEncodeTelegramPresentationControl(
        { type: "select", options: [option] },
        params.buttonOptions,
      ),
    );
    const native = new Set(nativeOptions);
    const fallbackOptions = block.options.filter((option) => !native.has(option));
    return [
      ...(nativeOptions.length > 0
        ? [
            {
              ...block,
              options: nativeOptions,
              ...(fallbackOptions.length > 0 ? { placeholder: undefined } : {}),
            },
          ]
        : []),
      ...(fallbackOptions.length > 0
        ? [
            {
              type: "context" as const,
              text: renderTelegramControlFallbackText({ ...block, options: fallbackOptions }),
            },
          ]
        : []),
    ];
  });
  return { ...params.presentation, blocks };
}

function partitionTelegramPresentationBlocks(params: {
  presentation: MessagePresentation;
  presentationControlsSelected: boolean;
  buttonOptions: TelegramButtonBuildOptions;
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
      // An existing provider/legacy keyboard owns the native action budget. Render
      // portable controls through Telegram's fallback sanitizer so invalid copy
      // values stay inspectable instead of being rewritten by TDLib semantics.
      fallbackBlocks.push({
        type: "context",
        text: renderTelegramControlFallbackText(block),
      });
      continue;
    }
    if (block.type === "buttons") {
      const nativeButtons: typeof block.buttons = [];
      const fallbackButtons: typeof block.buttons = [];
      for (const button of block.buttons) {
        const target = canEncodeTelegramPresentationControl(
          { type: "buttons", buttons: [button] },
          params.buttonOptions,
        )
          ? nativeButtons
          : fallbackButtons;
        target.push(button);
      }
      if (nativeButtons.length > 0) {
        nativeControlBlocks.push({ type: "buttons", buttons: nativeButtons });
      }
      if (fallbackButtons.length > 0) {
        fallbackBlocks.push({
          type: "context",
          text: renderTelegramControlFallbackText({ type: "buttons", buttons: fallbackButtons }),
        });
      }
      continue;
    }

    const nativeOptions: typeof block.options = [];
    const fallbackOptions: typeof block.options = [];
    for (const option of block.options) {
      const target = canEncodeTelegramPresentationControl(
        { type: "select", options: [option] },
        params.buttonOptions,
      )
        ? nativeOptions
        : fallbackOptions;
      target.push(option);
    }
    if (nativeOptions.length > 0) {
      nativeControlBlocks.push({ ...block, options: nativeOptions });
    }
    if (fallbackOptions.length > 0) {
      fallbackBlocks.push({
        type: "context",
        text: renderTelegramControlFallbackText({ ...block, options: fallbackOptions }),
      });
    } else if (block.placeholder) {
      // Telegram maps selects to buttons, so retain the select prompt in message text.
      fallbackBlocks.push({ type: "text", text: block.placeholder });
    }
  }
  return { fallbackBlocks, nativeControlBlocks };
}

/** Convert portable presentation into the one Telegram payload shape used by every send funnel. */
export function canonicalizeTelegramPresentationPayload(
  payload: ReplyPayload,
  options?: {
    allowWebAppButtons?: boolean;
    onDroppedControl?: TelegramButtonBuildOptions["onDroppedControl"];
    richTables?: boolean;
  },
): ReplyPayload {
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
  const interactive = normalizeLegacyInteractiveReply(payload.interactive);
  const buttonOptions: TelegramButtonBuildOptions = {
    allowWebAppButtons: options?.allowWebAppButtons === true,
    onDroppedControl: options?.onDroppedControl,
    questionOptionIndices: resolveAskUserQuestionOptionIndices(payload),
  };
  const existingButtons = resolveTelegramInlineButtons(
    {
      buttons: telegramData?.buttons,
      interactive,
    },
    buttonOptions,
  );
  const presentationControlsSelected = existingButtons === undefined;
  const richTables = options?.richTables === true;
  const presentation = adaptMessagePresentationForChannel({
    presentation: prepareTelegramPresentationForAdaptation({
      presentation: normalizedPresentation,
      presentationControlsSelected,
      buttonOptions,
    }),
    capabilities: resolveTelegramPresentationCapabilities({ richMessages: richTables }),
  });
  const { fallbackBlocks, nativeControlBlocks } = partitionTelegramPresentationBlocks({
    presentation,
    presentationControlsSelected,
    buttonOptions,
  });
  const presentationButtons = buildTelegramPresentationButtons(
    {
      blocks: nativeControlBlocks,
    },
    buttonOptions,
  );
  const buttons = existingButtons ?? presentationButtons;

  const fallbackText = richTables
    ? renderTelegramRichFallbackText({ ...presentation, blocks: fallbackBlocks })
    : renderMessagePresentationFallbackText({
        presentation: { ...presentation, blocks: fallbackBlocks },
      });
  const currentText =
    resolveLegacyInteractiveTextFallback({ text: payload.text, interactive })?.trim() ?? "";
  const textIsFallback = payload.presentationTextMode === "fallback";
  const hasFallback =
    fallbackText.length > 0 &&
    (currentText === fallbackText || currentText.endsWith(`\n\n${fallbackText}`));
  // presentationTextMode "fallback" marks payload.text as the authored plain
  // rendering of the same presentation: rich accounts replace it with the
  // native block rendering, plain accounts keep it and drop the generic flatten.
  const text = textIsFallback
    ? richTables
      ? fallbackText || currentText
      : currentText || fallbackText
    : hasFallback
      ? currentText
      : [currentText, fallbackText].filter(Boolean).join("\n\n");
  const {
    presentation: _presentation,
    presentationTextMode: _presentationTextMode,
    ...withoutPresentation
  } = payload;
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
