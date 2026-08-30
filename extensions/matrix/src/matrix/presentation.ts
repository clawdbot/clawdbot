import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-contract";
import {
  adaptMessagePresentationForChannel,
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
  type MessagePresentation,
  type MessagePresentationBlock,
} from "openclaw/plugin-sdk/interactive-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MatrixExtraContentFields } from "./send/types.js";

const MATRIX_OPENCLAW_PRESENTATION_KEY = "com.openclaw.presentation" as const;
const MATRIX_OPENCLAW_PRESENTATION_TYPE = "message.presentation" as const;
const MATRIX_EMPTY_PRESENTATION_FALLBACK_TEXT = "---";

export const MATRIX_PRESENTATION_CAPABILITIES = {
  supported: true,
  buttons: true,
  selects: true,
  context: true,
  divider: true,
  limits: {
    text: {
      markdownDialect: "markdown",
      supportsEdit: true,
    },
  },
} satisfies NonNullable<ChannelOutboundAdapter["presentationCapabilities"]>;

function resolveMatrixChannelData(payload: ReplyPayload): Record<string, unknown> {
  const raw = asOptionalRecord(payload.channelData)?.matrix;
  return asOptionalRecord(raw) ?? {};
}

function buildMatrixPresentationContent(presentation: MessagePresentation) {
  return {
    ...presentation,
    version: 1,
    type: MATRIX_OPENCLAW_PRESENTATION_TYPE,
  };
}

function resolveMatrixPresentationContent(
  payload: ReplyPayload,
): Record<string, unknown> | undefined {
  const extraContent = asOptionalRecord(resolveMatrixChannelData(payload).extraContent);
  const presentation = asOptionalRecord(extraContent?.[MATRIX_OPENCLAW_PRESENTATION_KEY]);
  if (
    !presentation ||
    presentation.version !== 1 ||
    presentation.type !== MATRIX_OPENCLAW_PRESENTATION_TYPE
  ) {
    return undefined;
  }
  return presentation;
}

export function renderMatrixPresentationPayload(params: {
  payload: ReplyPayload;
  presentation: MessagePresentation;
}): ReplyPayload {
  const matrixData = resolveMatrixChannelData(params.payload);
  const fallbackText = renderMessagePresentationFallbackText({
    text: params.payload.text,
    presentation: params.presentation,
    emptyFallback: MATRIX_EMPTY_PRESENTATION_FALLBACK_TEXT,
  });
  return {
    ...params.payload,
    text: fallbackText,
    channelData: {
      ...params.payload.channelData,
      matrix: {
        ...matrixData,
        extraContent: {
          [MATRIX_OPENCLAW_PRESENTATION_KEY]: buildMatrixPresentationContent(params.presentation),
        },
      },
    },
  };
}

function countMatrixUnsupportedDataBlocks(blocks: readonly MessagePresentationBlock[]): number {
  return blocks.filter((block) => block.type === "table" || block.type === "chart").length;
}

export function prepareMatrixReplyPayload(payload: ReplyPayload): ReplyPayload {
  const presentation = normalizeMessagePresentation(payload.presentation);
  if (!presentation) {
    return payload;
  }
  const adaptedPresentation = adaptMessagePresentationForChannel({
    presentation,
    capabilities: MATRIX_PRESENTATION_CAPABILITIES,
  });
  const textIsFallback = payload.presentationTextMode === "fallback";
  const hasInteractiveBlocks = presentation.blocks.some(
    (block) => block.type === "buttons" || block.type === "select",
  );
  const {
    presentation: _presentation,
    presentationTextMode: _presentationTextMode,
    ...withoutPresentation
  } = payload;
  const unsupportedDataBlockCount = countMatrixUnsupportedDataBlocks(presentation.blocks);
  const preservesAuthoredDataFallback = Boolean(
    textIsFallback &&
    payload.text?.trim() &&
    !hasInteractiveBlocks &&
    unsupportedDataBlockCount > 0 &&
    countMatrixUnsupportedDataBlocks(adaptedPresentation.blocks) === 0,
  );
  if (preservesAuthoredDataFallback && unsupportedDataBlockCount === presentation.blocks.length) {
    return withoutPresentation;
  }
  const renderedPayload = renderMatrixPresentationPayload({
    payload: textIsFallback ? { ...withoutPresentation, text: undefined } : withoutPresentation,
    presentation: adaptedPresentation,
  });
  return preservesAuthoredDataFallback
    ? { ...renderedPayload, text: payload.text }
    : renderedPayload;
}

export function resolveMatrixPayloadText(payload: ReplyPayload): string {
  const text = payload.text ?? "";
  if (text.trim() || !resolveMatrixPresentationContent(payload)) {
    return text;
  }
  return MATRIX_EMPTY_PRESENTATION_FALLBACK_TEXT;
}

export function resolveMatrixExtraContent(
  payload: ReplyPayload,
): MatrixExtraContentFields | undefined {
  const presentation = resolveMatrixPresentationContent(payload);
  return presentation ? { [MATRIX_OPENCLAW_PRESENTATION_KEY]: presentation } : undefined;
}
