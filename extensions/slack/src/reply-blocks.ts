import {
  normalizeMessagePresentation,
  renderMessagePresentationFallbackText,
  type MessagePresentation,
} from "openclaw/plugin-sdk/interactive-runtime";
// Slack plugin module implements reply blocks behavior.
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  resolveSlackAuthoredTextPlacement,
  type SlackAuthoredTextPlacement,
} from "./authored-text.js";
import { buildSlackBlocksFallbackText, renderSlackBlockFallbackText } from "./blocks-fallback.js";
import { parseSlackBlocksInput, SLACK_MAX_BLOCKS } from "./blocks-input.js";
import {
  buildSlackInteractiveBlocks,
  buildSlackPresentationBlocks,
  canRenderSlackPresentation,
  resolveSlackBlockOffsets,
  type SlackBlock,
  type SlackBlockRenderOptions,
} from "./blocks-render.js";
import { markdownToSlackMrkdwnChunks } from "./format.js";
import {
  appendSlackNativeDataFallbackText,
  buildSlackNativeDataAccessibilityText,
  hasSlackNativeDataBlock,
} from "./native-data-blocks.js";
import { renderSlackMessagePresentationFallbackText } from "./presentation-fallback.js";
import { SLACK_SECTION_TEXT_MAX } from "./presentation.js";
import {
  SLACK_APPROVAL_BUTTON_ACTION_ID,
  SLACK_APPROVAL_SELECT_ACTION_ID,
  SLACK_CALLBACK_BUTTON_ACTION_ID,
  SLACK_CALLBACK_SELECT_ACTION_ID,
  SLACK_REPLY_BUTTON_ACTION_ID,
  SLACK_REPLY_LINK_ACTION_ID,
  SLACK_REPLY_SELECT_ACTION_ID,
} from "./reply-action-ids.js";

export type SlackReplyBlockSegment =
  | { kind: "blocks"; blocks: SlackBlock[] }
  | { kind: "text"; text: string; mrkdwn: false };

export type SlackReplyBlockResolution = {
  authoredTextPlacement: SlackAuthoredTextPlacement;
  segments: SlackReplyBlockSegment[];
};

export function parseSlackReplyBlockSegments(value: unknown): SlackReplyBlockSegment[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error("Slack rendered presentation segments must be an array");
  }
  return value.map((raw): SlackReplyBlockSegment => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Slack rendered presentation segment must be an object");
    }
    const segment = raw as { blocks?: unknown; kind?: unknown; mrkdwn?: unknown; text?: unknown };
    if (segment.kind === "text" && typeof segment.text === "string" && segment.mrkdwn === false) {
      return { kind: "text", text: segment.text, mrkdwn: false };
    }
    if (segment.kind === "blocks") {
      const blocks = parseSlackBlocksInput(segment.blocks) as SlackBlock[] | undefined;
      if (blocks?.length) {
        return { kind: "blocks", blocks };
      }
    }
    throw new Error("Slack rendered presentation segment is invalid");
  });
}

export type SlackReplyDeliveryMessage = {
  text: string;
  blocks?: SlackBlock[];
  authoredTextPlacement?: SlackAuthoredTextPlacement;
  nativeDataFallbackBaseText?: string;
  textIsSlackPlainText?: true;
};

/** Convert compiled segments into ordered sender calls without re-inferring text placement. */
export function resolveSlackReplyDeliveryMessages(params: {
  authoredTextPlacement: SlackAuthoredTextPlacement;
  segments: readonly SlackReplyBlockSegment[];
  text?: string;
}): SlackReplyDeliveryMessage[] {
  const messages: SlackReplyDeliveryMessage[] = [];
  let outsideText =
    params.authoredTextPlacement === "outside-blocks" ? (params.text?.trim() ?? "") : "";
  for (const segment of params.segments) {
    if (segment.kind === "text") {
      const text = [outsideText, segment.text].filter(Boolean).join("\n\n");
      outsideText = "";
      if (text) {
        messages.push({ text, textIsSlackPlainText: true });
      }
      continue;
    }
    const baseText = outsideText;
    outsideText = "";
    const text =
      buildSlackNativeDataAccessibilityText(baseText, segment.blocks) ||
      buildSlackBlocksFallbackText(segment.blocks);
    const authoredTextPlacement: SlackAuthoredTextPlacement = baseText
      ? "outside-blocks"
      : params.authoredTextPlacement === "blocks"
        ? "blocks"
        : "none";
    messages.push({
      text,
      blocks: segment.blocks,
      authoredTextPlacement,
      ...(baseText ? { nativeDataFallbackBaseText: baseText } : {}),
    });
  }
  if (outsideText) {
    messages.push({ text: outsideText });
  }
  return messages;
}

function resolveSlackReplyText(payload: ReplyPayload, text = payload.text): string {
  const presentation = normalizeMessagePresentation(payload.presentation);
  return presentation
    ? renderSlackMessagePresentationFallbackText({ text, presentation })
    : (text ?? "");
}

type SlackReplyRenderPlan =
  | {
      mode: "single";
      text: string;
      blocks?: SlackBlock[];
      textIsSlackMrkdwn?: boolean;
    }
  | {
      mode: "split";
      fallbackText: string;
      blockPart?: { text: string; blocks?: SlackBlock[] };
    };

export function resolveSlackReplyRenderPlan(
  payload: ReplyPayload,
  text = payload.text,
): SlackReplyRenderPlan {
  const hasStructuredContent = hasSlackReplyStructuredContent(payload);
  // Live preview/streaming still consumes this compact plan shape. Derive it
  // from canonical ordered segments so preview/streaming stays conservative
  // without a second renderer.
  const resolution = resolveSlackReplyBlockResolution(
    { ...payload, text },
    { materializeAuthoredText: hasStructuredContent },
  );
  const messages = resolveSlackReplyDeliveryMessages({
    authoredTextPlacement: resolution.authoredTextPlacement,
    segments: resolution.segments,
    text,
  });
  if (messages.length <= 1) {
    const [message] = messages;
    const sourceText = text?.trim() ?? "";
    const blocks =
      message?.authoredTextPlacement === "blocks"
        ? addPreviewVerbatimToAuthoredTextBlocks(message.blocks, sourceText)
        : message?.blocks;
    let renderedText = message?.text ?? resolveSlackReplyText(payload, text);
    let textIsSlackMrkdwn = Boolean(
      message &&
      !message.textIsSlackPlainText &&
      (message.authoredTextPlacement !== "outside-blocks" || message.nativeDataFallbackBaseText),
    );
    if (blocks?.length && sourceText) {
      if (hasSlackNativeDataBlock(blocks)) {
        renderedText = appendSlackNativeDataFallbackText(sourceText, blocks) || renderedText;
        textIsSlackMrkdwn = true;
      } else if (message?.authoredTextPlacement === "blocks") {
        renderedText = sourceText;
        textIsSlackMrkdwn = false;
      }
    }
    return {
      mode: "single",
      text: renderedText,
      ...(blocks ? { blocks } : {}),
      ...(textIsSlackMrkdwn ? { textIsSlackMrkdwn: true } : {}),
    };
  }
  const blockPart = messages.find((message) => message.blocks?.length);
  return {
    mode: "split",
    fallbackText: messages
      .map((message) => message.text)
      .filter(Boolean)
      .join("\n\n"),
    ...(blockPart ? { blockPart: { text: blockPart.text, blocks: blockPart.blocks } } : {}),
  };
}

function readSlackChannelBlocks(payload: ReplyPayload): SlackBlock[] {
  const slackData = payload.channelData?.slack;
  if (!slackData || typeof slackData !== "object" || Array.isArray(slackData)) {
    return [];
  }
  return (parseSlackBlocksInput((slackData as { blocks?: unknown }).blocks) as SlackBlock[]) ?? [];
}

export function hasSlackReplyStructuredContent(payload: ReplyPayload): boolean {
  return Boolean(
    readSlackChannelBlocks(payload).length ||
    normalizeMessagePresentation(payload.presentation) ||
    payload.interactive?.blocks.length,
  );
}

function renderSlackAuthoredTextFragments(blocks: readonly SlackBlock[]): string[] {
  return blocks.flatMap((block) => {
    if ((block as { type?: unknown }).type === "actions") {
      return [];
    }
    const text = renderSlackBlockFallbackText(block, { nativeDataFormat: "plain" });
    return text ? [text] : [];
  });
}

function buildSlackAuthoredTextBlocks(text: string): SlackBlock[] {
  return markdownToSlackMrkdwnChunks(text, SLACK_SECTION_TEXT_MAX).map((chunk) => ({
    type: "section",
    text: { type: "mrkdwn", text: chunk, verbatim: true },
  }));
}

function addPreviewVerbatimToAuthoredTextBlocks(
  blocks: SlackBlock[] | undefined,
  sourceText: string,
): SlackBlock[] | undefined {
  if (!blocks?.length || !sourceText) {
    return blocks;
  }
  const authoredChunks = new Set(markdownToSlackMrkdwnChunks(sourceText, SLACK_SECTION_TEXT_MAX));
  return blocks.map((block) => {
    const text = (block as { text?: { text?: unknown; type?: unknown; verbatim?: unknown } }).text;
    if (
      block.type !== "section" ||
      text?.type !== "mrkdwn" ||
      typeof text.text !== "string" ||
      !authoredChunks.has(text.text)
    ) {
      return block;
    }
    return {
      ...block,
      text: { ...text, verbatim: true },
    } as SlackBlock;
  });
}

function readLastBlockSegment(segments: SlackReplyBlockSegment[]): SlackBlock[] {
  const last = segments.at(-1);
  return last?.kind === "blocks" ? last.blocks : [];
}

function readAllNativeBlocks(segments: SlackReplyBlockSegment[]): SlackBlock[] {
  return segments.flatMap((segment) => (segment.kind === "blocks" ? segment.blocks : []));
}

function appendTextSegment(segments: SlackReplyBlockSegment[], text: string): void {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  const last = segments.at(-1);
  if (last?.kind === "text") {
    last.text = `${last.text}\n\n${trimmed}`;
    return;
  }
  segments.push({ kind: "text", text: trimmed, mrkdwn: false });
}

function appendBlockSegment(
  segments: SlackReplyBlockSegment[],
  blocks: SlackBlock[],
  startNew = false,
): void {
  let shouldStartNew = startNew;
  for (const block of blocks) {
    const last = segments.at(-1);
    if (!shouldStartNew && last?.kind === "blocks" && last.blocks.length < SLACK_MAX_BLOCKS) {
      last.blocks.push(block);
    } else {
      segments.push({ kind: "blocks", blocks: [block] });
    }
    shouldStartNew = false;
  }
}

function resolvePresentationRenderOptions(
  segments: SlackReplyBlockSegment[],
  mode: "current" | "new-message",
): SlackBlockRenderOptions {
  const allOffsets = resolveSlackBlockOffsets(readAllNativeBlocks(segments));
  const messageOffsets =
    mode === "current" ? resolveSlackBlockOffsets(readLastBlockSegment(segments)) : {};
  // Control ids span the logical reply, while chart/table limits reset for
  // each Slack message. Sharing one offset would needlessly discard native data.
  return {
    ...messageOffsets,
    buttonIndexOffset: allOffsets.buttonIndexOffset,
    selectIndexOffset: allOffsets.selectIndexOffset,
  };
}

function renderNativePresentation(
  presentation: MessagePresentation,
  options: SlackBlockRenderOptions,
): SlackBlock[] | undefined {
  if (!canRenderSlackPresentation(presentation, options)) {
    return undefined;
  }
  const blocks = buildSlackPresentationBlocks(presentation, options);
  return blocks.length > 0 ? blocks : undefined;
}

function appendPresentationPart(
  segments: SlackReplyBlockSegment[],
  presentation: MessagePresentation,
): void {
  const currentBlocks = readLastBlockSegment(segments);
  const currentRendered = renderNativePresentation(
    presentation,
    resolvePresentationRenderOptions(segments, "current"),
  );
  if (currentRendered && currentBlocks.length + currentRendered.length <= SLACK_MAX_BLOCKS) {
    appendBlockSegment(segments, currentRendered);
    return;
  }

  const freshRendered = renderNativePresentation(
    presentation,
    resolvePresentationRenderOptions(segments, "new-message"),
  );
  if (freshRendered) {
    appendBlockSegment(segments, freshRendered, true);
    return;
  }

  appendTextSegment(
    segments,
    // The caller sends fallback segments with mrkdwn disabled, so preserve
    // authored tokens and command bytes instead of emitting visible entities.
    renderMessagePresentationFallbackText({ presentation }),
  );
}

const SLACK_BUTTON_CONTROL_ACTION_IDS = [
  SLACK_APPROVAL_BUTTON_ACTION_ID,
  SLACK_CALLBACK_BUTTON_ACTION_ID,
  SLACK_REPLY_BUTTON_ACTION_ID,
  SLACK_REPLY_LINK_ACTION_ID,
] as const;
const SLACK_SELECT_CONTROL_ACTION_IDS = [
  SLACK_APPROVAL_SELECT_ACTION_ID,
  SLACK_CALLBACK_SELECT_ACTION_ID,
  SLACK_REPLY_SELECT_ACTION_ID,
] as const;

function readGeneratedSlackControlRowKey(block: SlackBlock): string | undefined {
  const record = block as { block_id?: unknown; elements?: unknown; type?: unknown };
  if (record.type !== "actions" || typeof record.block_id !== "string") {
    return undefined;
  }
  const expectedElementType = /^openclaw_reply_buttons_[1-9]\d*$/.test(record.block_id)
    ? "button"
    : /^openclaw_reply_select_[1-9]\d*$/.test(record.block_id)
      ? "static_select"
      : undefined;
  if (!expectedElementType || !Array.isArray(record.elements) || record.elements.length === 0) {
    return undefined;
  }
  const actionIds =
    expectedElementType === "button"
      ? SLACK_BUTTON_CONTROL_ACTION_IDS
      : SLACK_SELECT_CONTROL_ACTION_IDS;
  const elements = record.elements.map((element) => {
    if (!element || typeof element !== "object" || Array.isArray(element)) {
      return undefined;
    }
    const { action_id: actionId, ...content } = element as Record<string, unknown>;
    const actionFamily =
      typeof actionId === "string"
        ? actionIds.find((candidate) => actionId.startsWith(`${candidate}:`))
        : undefined;
    return actionFamily && content.type === expectedElementType
      ? [actionFamily, content]
      : undefined;
  });
  return elements.some((element) => element === undefined) ? undefined : JSON.stringify(elements);
}

function subtractMirroredSlackControlRows(params: {
  interactiveBlocks: readonly SlackBlock[];
  presentationBlocks: readonly SlackBlock[];
}): SlackBlock[] {
  const remainingMirrors = new Map<string, number>();
  for (const block of params.presentationBlocks) {
    const key = readGeneratedSlackControlRowKey(block);
    if (key) {
      remainingMirrors.set(key, (remainingMirrors.get(key) ?? 0) + 1);
    }
  }
  return params.interactiveBlocks.filter((block) => {
    const key = readGeneratedSlackControlRowKey(block);
    const remaining = key ? (remainingMirrors.get(key) ?? 0) : 0;
    if (!key || remaining === 0) {
      return true;
    }
    remainingMirrors.set(key, remaining - 1);
    return false;
  });
}

/**
 * Resolve reply content into transport-order segments. Each blocks segment is
 * one Slack message; text segments carry complete fallback content between it.
 */
export function resolveSlackReplyBlockResolution(
  payload: ReplyPayload,
  options: { materializeAuthoredText?: boolean } = {},
): SlackReplyBlockResolution {
  const segments: SlackReplyBlockSegment[] = [];
  const channelBlocks = readSlackChannelBlocks(payload);
  let compiledChannelBlocks = channelBlocks;
  let authoredTextKnownInBlocks = false;
  if (options.materializeAuthoredText) {
    const rawTextFragments = renderSlackAuthoredTextFragments(channelBlocks);
    const initialPlacement = resolveSlackAuthoredTextPlacement({
      text: payload.text,
      interactive: payload.interactive,
      renderedTextFragments: rawTextFragments,
    });
    authoredTextKnownInBlocks = initialPlacement === "blocks";
    const text = normalizeOptionalString(payload.text);
    if (text && initialPlacement === "outside-blocks") {
      const textBlocks = buildSlackAuthoredTextBlocks(text);
      const compiledText = renderSlackAuthoredTextFragments(textBlocks).join(" ");
      const compiledPlacement = resolveSlackAuthoredTextPlacement({
        text: compiledText,
        renderedTextFragments: rawTextFragments,
      });
      if (compiledPlacement !== "blocks") {
        compiledChannelBlocks = [...channelBlocks, ...textBlocks];
      }
      authoredTextKnownInBlocks = true;
    }
  }
  if (compiledChannelBlocks.length > 0) {
    appendBlockSegment(segments, compiledChannelBlocks);
  }

  const presentation = normalizeMessagePresentation(payload.presentation);
  const presentationBlockOffset = readAllNativeBlocks(segments).length;
  if (presentation?.title) {
    appendPresentationPart(segments, { title: presentation.title, blocks: [] });
  }
  for (const block of presentation?.blocks ?? []) {
    appendPresentationPart(segments, { blocks: [block] });
  }
  const renderedPresentationBlocks = readAllNativeBlocks(segments).slice(presentationBlockOffset);

  const interactiveBlocks = buildSlackInteractiveBlocks(
    payload.interactive,
    resolveSlackBlockOffsets(readAllNativeBlocks(segments)),
  );
  // Compare final Slack rows, not source payloads: fallbacks and transport
  // limits can prevent an apparent source mirror from rendering at all.
  appendBlockSegment(
    segments,
    subtractMirroredSlackControlRows({
      interactiveBlocks,
      presentationBlocks: renderedPresentationBlocks,
    }),
  );
  const renderedTextFragments = segments.flatMap((segment) => {
    if (segment.kind === "text") {
      return [segment.text];
    }
    return renderSlackAuthoredTextFragments(segment.blocks);
  });
  const authoredTextPlacement = resolveSlackAuthoredTextPlacement({
    text: payload.text,
    interactive: payload.interactive,
    renderedTextFragments,
  });
  return {
    authoredTextPlacement: authoredTextKnownInBlocks ? "blocks" : authoredTextPlacement,
    segments,
  };
}

/** Return the single-message native shape when no ordered text fallback is required. */
export function resolveSlackReplyBlocks(payload: ReplyPayload): SlackBlock[] | undefined {
  const { segments } = resolveSlackReplyBlockResolution(payload);
  return segments.length === 1 && segments[0]?.kind === "blocks" ? segments[0].blocks : undefined;
}
