import {
  normalizeMessagePresentation,
  type MessagePresentation,
  type MessagePresentationBlock,
} from "openclaw/plugin-sdk/interactive-runtime";
// Slack plugin module implements reply blocks behavior.
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import {
  appendSlackBlocksAccessibleFallbackText,
  buildSlackBlocksAccessibleFallbackText,
  buildSlackBlocksCompactAccessibleFallbackText,
  isSlackBlockRepresentedByTextFallback,
  removeSlackBlocksFallbackParagraphs,
  retainSlackDataTablesWithinCompactFallback,
} from "./blocks-fallback.js";
import { parseSlackBlocksInput, SLACK_MAX_BLOCKS } from "./blocks-input.js";
import {
  buildSlackInteractiveBlocks,
  buildSlackPresentationBlocks,
  canRenderSlackPresentation,
  canRenderSlackPresentationTables,
  resolveSlackBlockOffsets,
  type SlackBlock,
} from "./blocks-render.js";
import { hasSlackDataTableBlock } from "./data-table.js";
import { markdownToSlackMrkdwnChunks } from "./format.js";
import { SLACK_TEXT_LIMIT } from "./limits.js";
import {
  appendSlackNativeDataFallbackText,
  hasSlackNativeDataBlock,
} from "./native-data-blocks.js";
import { renderSlackMessagePresentationFallbackText } from "./presentation-fallback.js";
import { SLACK_SECTION_TEXT_MAX } from "./presentation.js";

export function resolveSlackReplyText(payload: ReplyPayload, text = payload.text): string {
  const presentation = normalizeMessagePresentation(payload.presentation);
  return presentation
    ? renderSlackMessagePresentationFallbackText({ text, presentation })
    : (text ?? "");
}

function splitSlackPresentationForTextFallback(
  presentation: MessagePresentation,
  options: ReturnType<typeof resolveSlackBlockOffsets>,
): {
  fallback: MessagePresentation;
  native?: MessagePresentation;
} {
  const nativeBlocks: MessagePresentationBlock[] = [];
  const fallbackBlocks: MessagePresentationBlock[] = [];
  for (const block of presentation.blocks) {
    const isControl = block.type === "buttons" || block.type === "select";
    const isDivider = block.type === "divider";
    if ((isControl || isDivider) && canRenderSlackPresentation({ blocks: [block] }, options)) {
      nativeBlocks.push(block);
    } else {
      fallbackBlocks.push(block);
    }
  }
  return {
    fallback: {
      ...(presentation.title ? { title: presentation.title } : {}),
      blocks: fallbackBlocks,
    },
    ...(nativeBlocks.length > 0 ? { native: { blocks: nativeBlocks } } : {}),
  };
}

type SlackReplyBlockPart = {
  blocks: SlackBlock[];
  text: string;
};

export type SlackReplyRenderPlan =
  | {
      mode: "single";
      textVisibleInBlocks?: true;
      textIsSlackMrkdwn?: true;
      blocks?: SlackBlock[];
      hookText: string;
      text: string;
    }
  | {
      mode: "split";
      blockPart?: SlackReplyBlockPart;
      fallbackText: string;
      hookText: string;
    };

function resolveSlackChannelBlocks(payload: ReplyPayload): SlackBlock[] {
  const slackData = payload.channelData?.slack;
  if (!slackData || typeof slackData !== "object" || Array.isArray(slackData)) {
    return [];
  }
  return (parseSlackBlocksInput((slackData as { blocks?: unknown }).blocks) as SlackBlock[]) ?? [];
}

function buildSlackReplyBlockPart(
  blocks: SlackBlock[],
  compactLimit = SLACK_TEXT_LIMIT,
): SlackReplyBlockPart | undefined {
  if (blocks.length === 0) {
    return undefined;
  }
  let text = buildSlackBlocksAccessibleFallbackText(blocks);
  if (text.length > compactLimit && hasSlackDataTableBlock(blocks)) {
    // The complete row fallback belongs to the following text chunks. This
    // post still names the table and every retained control/media sibling.
    text = buildSlackBlocksCompactAccessibleFallbackText(blocks);
  }
  if (text.length > SLACK_TEXT_LIMIT) {
    throw new Error(
      `Slack retained-block accessibility fallback exceeds OpenClaw's ${String(SLACK_TEXT_LIMIT)}-character limit`,
    );
  }
  return { blocks, text };
}

function buildSlackAuthoredTextBlocks(text: string | null | undefined): SlackBlock[] {
  const trimmed = text?.trim();
  if (!trimmed) {
    return [];
  }
  return markdownToSlackMrkdwnChunks(trimmed, SLACK_SECTION_TEXT_MAX).map((chunk) => ({
    type: "section",
    text: { type: "mrkdwn", text: chunk, verbatim: true },
  }));
}

function isSlackAuthoredTextRepresentedInInteractive(
  text: string | null | undefined,
  interactive: ReplyPayload["interactive"],
): boolean {
  const target = text?.trim().replace(/\s+/gu, " ");
  if (!target) {
    return false;
  }
  const fragments =
    interactive?.blocks.flatMap((block) =>
      block.type === "text" && block.text.trim().length <= SLACK_SECTION_TEXT_MAX
        ? [block.text.trim().replace(/\s+/gu, " ")]
        : [],
    ) ?? [];
  for (let start = 0; start < fragments.length; start += 1) {
    let combined = "";
    for (let end = start; end < fragments.length; end += 1) {
      combined = `${combined} ${fragments[end]}`.trim().replace(/\s+/gu, " ");
      if (combined === target) {
        return true;
      }
      if (combined.length > target.length) {
        break;
      }
    }
  }
  return false;
}

function renderSlackVisiblePresentationFallback(params: {
  presentation?: MessagePresentation;
  text?: string | null;
}): string {
  const authoredText = params.text?.trim()
    ? markdownToSlackMrkdwnChunks(params.text.trim(), SLACK_TEXT_LIMIT).join("\n")
    : undefined;
  return renderSlackMessagePresentationFallbackText({
    ...(authoredText ? { text: authoredText } : {}),
    ...(params.presentation ? { presentation: params.presentation } : {}),
  });
}

export function resolveSlackReplyRenderPlan(
  payload: ReplyPayload,
  text = payload.text,
  options: { includeAuthoredTextBlock?: boolean; textLimit?: number } = {},
): SlackReplyRenderPlan {
  const textLimit = options.textLimit ?? SLACK_TEXT_LIMIT;
  const channelBlocks = resolveSlackChannelBlocks(payload);
  const presentation = normalizeMessagePresentation(payload.presentation);
  const presentationOffsets = resolveSlackBlockOffsets(channelBlocks);
  const hasPresentationTable = presentation?.blocks.some((block) => block.type === "table");
  let usesPresentationTextFallback = Boolean(
    presentation &&
    (!canRenderSlackPresentation(presentation, presentationOffsets) ||
      (hasPresentationTable &&
        !canRenderSlackPresentationTables(presentation, presentationOffsets))),
  );
  const splitPresentation =
    presentation && usesPresentationTextFallback
      ? splitSlackPresentationForTextFallback(presentation, presentationOffsets)
      : undefined;
  let fallbackPresentation = splitPresentation?.fallback;
  const presentationForBlocks = splitPresentation ? splitPresentation.native : presentation;
  const authoredTextRepresentedInInteractive = isSlackAuthoredTextRepresentedInInteractive(
    text,
    payload.interactive,
  );
  const authoredTextRepresentedInChannelBlocks = Boolean(
    text?.trim() && !removeSlackBlocksFallbackParagraphs(text, channelBlocks),
  );
  const authoredTextRepresentedInBlocks =
    authoredTextRepresentedInInteractive || authoredTextRepresentedInChannelBlocks;
  let authoredTextBlocks =
    !usesPresentationTextFallback &&
    options.includeAuthoredTextBlock !== false &&
    (presentation || channelBlocks.length > 0) &&
    !authoredTextRepresentedInBlocks
      ? buildSlackAuthoredTextBlocks(text)
      : [];
  const presentationBlocks = buildSlackPresentationBlocks(
    presentationForBlocks,
    presentationOffsets,
  );
  let interactiveBlocks = buildSlackInteractiveBlocks(
    payload.interactive,
    resolveSlackBlockOffsets([...channelBlocks, ...authoredTextBlocks, ...presentationBlocks]),
  );
  let blocks = [
    ...channelBlocks,
    ...authoredTextBlocks,
    ...presentationBlocks,
    ...interactiveBlocks,
  ];
  if (blocks.length > SLACK_MAX_BLOCKS && presentation) {
    // Portable presentation can degrade completely to text. Raw channel blocks
    // and separately-authored interactive controls remain fail-closed.
    authoredTextBlocks = [];
    interactiveBlocks = buildSlackInteractiveBlocks(
      payload.interactive,
      resolveSlackBlockOffsets(channelBlocks),
    );
    blocks = [...channelBlocks, ...interactiveBlocks];
    usesPresentationTextFallback = true;
    fallbackPresentation = presentation;
  }
  if (blocks.length > SLACK_MAX_BLOCKS) {
    throw new Error(
      `Slack blocks cannot exceed ${SLACK_MAX_BLOCKS} items after interactive render`,
    );
  }
  const hookText = appendSlackBlocksAccessibleFallbackText(resolveSlackReplyText(payload, text), [
    ...channelBlocks,
    ...interactiveBlocks,
  ]);
  if (usesPresentationTextFallback) {
    let fallbackText = appendSlackNativeDataFallbackText(
      renderSlackVisiblePresentationFallback({
        text,
        ...(fallbackPresentation ? { presentation: fallbackPresentation } : {}),
      }),
      blocks,
    );
    let retainedBlocks = blocks.filter((block) => !hasSlackNativeDataBlock([block]));
    if (
      retainedBlocks.length > 0 &&
      buildSlackBlocksAccessibleFallbackText(retainedBlocks).length > SLACK_TEXT_LIMIT
    ) {
      const fallbackBlocks = retainedBlocks.filter(isSlackBlockRepresentedByTextFallback);
      fallbackText = appendSlackBlocksAccessibleFallbackText(fallbackText, fallbackBlocks);
      retainedBlocks = retainedBlocks.filter(
        (block) => !isSlackBlockRepresentedByTextFallback(block),
      );
    }
    const blockPart = buildSlackReplyBlockPart(retainedBlocks, textLimit);
    if (!fallbackText.trim()) {
      return {
        mode: "single",
        ...(blockPart ? { blocks: blockPart.blocks } : {}),
        hookText,
        text: blockPart?.text ?? hookText,
      };
    }
    return {
      mode: "split",
      ...(blockPart ? { blockPart } : {}),
      fallbackText,
      hookText,
    };
  }

  const textIsSlackMrkdwn =
    presentation?.blocks.some((block) => block.type === "chart" || block.type === "table") ||
    hasSlackNativeDataBlock(blocks);
  const singleText = textIsSlackMrkdwn
    ? appendSlackBlocksAccessibleFallbackText(
        renderSlackVisiblePresentationFallback({ presentation, text }),
        blocks,
      )
    : hookText;
  if (blocks.length > 0 && singleText.length > textLimit) {
    // A native-eligible table should remain native even when its expanded row
    // fallback requires multiple messages. Other text-replaceable blocks move
    // completely into those chunks.
    const siblingCandidates = blocks.filter(
      (block) => hasSlackDataTableBlock([block]) || !isSlackBlockRepresentedByTextFallback(block),
    );
    const siblingBlocks = retainSlackDataTablesWithinCompactFallback(siblingCandidates, textLimit);
    const splitText = textIsSlackMrkdwn
      ? singleText
      : appendSlackBlocksAccessibleFallbackText(
          renderSlackVisiblePresentationFallback({ presentation, text }),
          blocks,
        );
    const fallbackText = removeSlackBlocksFallbackParagraphs(
      splitText,
      siblingBlocks.filter((block) => !hasSlackDataTableBlock([block])),
    );
    const blockPart = buildSlackReplyBlockPart(siblingBlocks, textLimit);
    return {
      mode: "split",
      ...(blockPart ? { blockPart } : {}),
      fallbackText,
      hookText,
    };
  }

  return {
    mode: "single",
    ...(authoredTextBlocks.length > 0 || authoredTextRepresentedInBlocks
      ? { textVisibleInBlocks: true as const }
      : {}),
    ...(blocks.length > 0 ? { blocks } : {}),
    ...(textIsSlackMrkdwn ? { textIsSlackMrkdwn: true as const } : {}),
    hookText,
    text: singleText,
  };
}

export function resolveSlackReplyBlocks(payload: ReplyPayload): SlackBlock[] | undefined {
  const plan = resolveSlackReplyRenderPlan(payload);
  return plan.mode === "single" ? plan.blocks : plan.blockPart?.blocks;
}
