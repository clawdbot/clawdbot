import { tokenizeHtmlTags } from "openclaw/plugin-sdk/text-chunking";
import type { MarkdownIR } from "openclaw/plugin-sdk/text-chunking";
import type { InputRichBlock } from "./rich-block-model.js";
import { VOID_TAGS } from "./rich-blocks-html.js";

type StructuralRange = { start: number; end: number };
export type TelegramDetailsRichBlock = Extract<InputRichBlock, { type: "details" }>;
export type TelegramHtmlContainerRichBlock = Extract<
  InputRichBlock,
  { type: "blockquote" | "list" }
>;

export type TelegramDetailsStructuralSegment =
  | {
      kind: "details";
      start: number;
      end: number;
      bodyRanges: readonly StructuralRange[];
      block: TelegramDetailsRichBlock;
    }
  | {
      kind: "html-container";
      start: number;
      end: number;
      block: TelegramHtmlContainerRichBlock;
    };

type TelegramHtmlIsland = {
  start: number;
  end: number;
  blocks: InputRichBlock[];
  detailsBodyRanges?: Array<{ start: number; end: number }>;
};

type TelegramDetailsHtmlIsland = {
  start: number;
  end: number;
  bodyRanges: Array<{ start: number; end: number }>;
  block: TelegramDetailsRichBlock;
};

type TelegramHtmlContainerIsland = {
  start: number;
  end: number;
  block: TelegramHtmlContainerRichBlock;
};

type TelegramDetailsOwnerBlock = TelegramDetailsRichBlock | TelegramHtmlContainerRichBlock;

type TelegramHtmlTag = {
  start: number;
  end: number;
  name: string;
  closing: boolean;
  selfClosing: boolean;
};

type PendingDetailsHtmlIsland = {
  start: number;
  contentStart: number;
  blocked: boolean;
  outputIndex?: number;
  summaryStart?: number;
  summaryDepth: number;
  summaryEnd?: number;
  summarySelfClosing: boolean;
};

type PendingHtmlContainer = {
  name: "blockquote" | "ol" | "ul";
  start: number;
  blocked: boolean;
  outputIndex?: number;
};

const NESTED_DETAILS_CONTAINER_TAGS = new Set(["blockquote", "details", "li", "ol", "ul"]);

function collectNestedDetailsBlocks(blocks: readonly InputRichBlock[]): TelegramDetailsRichBlock[] {
  const result: TelegramDetailsRichBlock[] = [];
  const pending = blocks.toReversed();
  while (pending.length > 0) {
    const block = pending.pop();
    if (!block) {
      continue;
    }
    switch (block.type) {
      case "details":
        result.push(block);
        pending.push(...block.blocks.toReversed());
        break;
      case "blockquote":
      case "collage":
      case "slideshow":
        pending.push(...block.blocks.toReversed());
        break;
      case "list":
        for (let index = block.items.length - 1; index >= 0; index -= 1) {
          const item = block.items[index];
          if (item) {
            pending.push(...item.blocks.toReversed());
          }
        }
        break;
      default:
        break;
    }
  }
  return result;
}

function collectNestedHtmlContainerBlocks(
  blocks: readonly InputRichBlock[],
): TelegramHtmlContainerRichBlock[] {
  const result: TelegramHtmlContainerRichBlock[] = [];
  const pending = blocks.toReversed();
  while (pending.length > 0) {
    const block = pending.pop();
    if (!block) {
      continue;
    }
    switch (block.type) {
      case "blockquote":
      case "list":
        result.push(block);
        if (block.type === "blockquote") {
          pending.push(...block.blocks.toReversed());
        } else {
          for (let index = block.items.length - 1; index >= 0; index -= 1) {
            const item = block.items[index];
            if (item) {
              pending.push(...item.blocks.toReversed());
            }
          }
        }
        break;
      case "details":
      case "collage":
      case "slideshow":
        pending.push(...block.blocks.toReversed());
        break;
      default:
        break;
    }
  }
  return result;
}

function blocksInsideOwner(block: TelegramDetailsOwnerBlock): InputRichBlock[] {
  if (block.type === "list") {
    return block.items.flatMap((item) => item.blocks);
  }
  return block.blocks;
}

export function rebuildTelegramHtmlContainer(
  block: TelegramHtmlContainerRichBlock,
  detailsByBlock: ReadonlyMap<InputRichBlock, TelegramDetailsRichBlock>,
): TelegramHtmlContainerRichBlock {
  const rebuild = (current: InputRichBlock): InputRichBlock => {
    const replacement = detailsByBlock.get(current);
    if (replacement) {
      return replacement;
    }
    switch (current.type) {
      case "blockquote":
      case "collage":
      case "slideshow":
        return { ...current, blocks: current.blocks.map(rebuild) };
      case "list":
        return {
          ...current,
          items: current.items.map((item) => ({ ...item, blocks: item.blocks.map(rebuild) })),
        };
      default:
        return current;
    }
  };
  return rebuild(block) as TelegramHtmlContainerRichBlock;
}

function removeOpenHtmlContainer(containers: string[], name: string): void {
  const openIndex = containers.lastIndexOf(name);
  if (openIndex >= 0) {
    containers.length = openIndex;
  }
}

function detailsBodyRangesFromPending(
  pending: PendingDetailsHtmlIsland,
  contentEnd: number,
): Array<{ start: number; end: number }> {
  if (
    pending.summaryStart === undefined ||
    pending.summarySelfClosing ||
    pending.summaryEnd === undefined
  ) {
    return [{ start: pending.contentStart, end: contentEnd }];
  }
  const ranges: Array<{ start: number; end: number }> = [];
  if (pending.summaryStart > pending.contentStart) {
    ranges.push({ start: pending.contentStart, end: pending.summaryStart });
  }
  if (pending.summaryEnd < contentEnd) {
    ranges.push({ start: pending.summaryEnd, end: contentEnd });
  }
  return ranges;
}

type NestedHtmlScan = {
  details: TelegramDetailsHtmlIsland[];
  containers: TelegramHtmlContainerIsland[];
};

function findNestedHtml(
  tags: readonly TelegramHtmlTag[],
  outerOpenIndex: number,
  outerCloseIndex: number,
  outerBlock: TelegramDetailsOwnerBlock,
): NestedHtmlScan {
  const matches: Array<
    { start: number; end: number; bodyRanges: Array<{ start: number; end: number }> } | undefined
  > = [];
  const containerMatches: Array<
    { start: number; end: number; name: "blockquote" | "ol" | "ul" } | undefined
  > = [];
  const detailsStack: PendingDetailsHtmlIsland[] = [];
  const containerStack: PendingHtmlContainer[] = [];
  const blockedContainers: string[] = [];
  let codeDepth = 0;

  for (let index = outerOpenIndex + 1; index < outerCloseIndex; index += 1) {
    const tag = tags[index];
    if (!tag) {
      continue;
    }
    if (tag.name === "code" || tag.name === "pre") {
      if (tag.closing) {
        codeDepth = Math.max(0, codeDepth - 1);
      } else if (!tag.selfClosing) {
        codeDepth += 1;
      }
      continue;
    }
    if (codeDepth > 0) {
      continue;
    }
    if (tag.closing) {
      if (tag.name === "details") {
        const pending = detailsStack.pop();
        if (pending?.outputIndex !== undefined) {
          matches[pending.outputIndex] = {
            start: pending.start,
            end: tag.end,
            bodyRanges: detailsBodyRangesFromPending(pending, tag.start),
          };
        }
      } else if (tag.name === "blockquote" || tag.name === "ol" || tag.name === "ul") {
        const openIndex = containerStack.findLastIndex((pending) => pending.name === tag.name);
        if (openIndex >= 0) {
          const pending = containerStack[openIndex];
          containerStack.length = openIndex;
          if (pending?.outputIndex !== undefined) {
            containerMatches[pending.outputIndex] = {
              start: pending.start,
              end: tag.end,
              name: pending.name,
            };
          }
        }
      } else if (tag.name === "summary") {
        const pending = detailsStack.at(-1);
        if (pending && !pending.blocked && pending.summaryDepth > 0) {
          pending.summaryDepth -= 1;
          if (pending.summaryDepth === 0) {
            pending.summaryEnd = tag.end;
          }
        }
        removeOpenHtmlContainer(blockedContainers, tag.name);
      } else {
        removeOpenHtmlContainer(blockedContainers, tag.name);
      }
      continue;
    }
    if (tag.name === "details") {
      const pending: PendingDetailsHtmlIsland = {
        start: tag.start,
        contentStart: tag.end,
        blocked: blockedContainers.length > 0,
        summaryDepth: 0,
        summarySelfClosing: false,
      };
      if (!pending.blocked) {
        pending.outputIndex = matches.length;
        matches.push(
          tag.selfClosing
            ? { start: tag.start, end: tag.end, bodyRanges: [{ start: tag.end, end: tag.end }] }
            : undefined,
        );
      }
      if (!tag.selfClosing) {
        detailsStack.push(pending);
      }
      continue;
    }
    if (tag.name === "blockquote" || tag.name === "ol" || tag.name === "ul") {
      const pending: PendingHtmlContainer = {
        name: tag.name,
        start: tag.start,
        blocked: blockedContainers.length > 0,
      };
      if (!pending.blocked) {
        pending.outputIndex = containerMatches.length;
        containerMatches.push(undefined);
      }
      if (!tag.selfClosing) {
        containerStack.push(pending);
      }
      continue;
    }
    if (tag.name === "summary") {
      const pending = detailsStack.at(-1);
      if (pending && !pending.blocked) {
        if (pending.summaryStart === undefined) {
          pending.summaryStart = tag.start;
          if (tag.selfClosing) {
            pending.summarySelfClosing = true;
          } else {
            pending.summaryDepth = 1;
          }
        } else if (pending.summaryDepth > 0 && !tag.selfClosing) {
          pending.summaryDepth += 1;
        }
      }
      if (!tag.selfClosing) {
        blockedContainers.push(tag.name);
      }
      continue;
    }
    if (
      !tag.selfClosing &&
      !VOID_TAGS.has(tag.name) &&
      !NESTED_DETAILS_CONTAINER_TAGS.has(tag.name)
    ) {
      blockedContainers.push(tag.name);
    }
  }

  const spans = matches.filter(
    (
      match,
    ): match is { start: number; end: number; bodyRanges: Array<{ start: number; end: number }> } =>
      match !== undefined,
  );
  const containerSpans = containerMatches.filter(
    (match): match is { start: number; end: number; name: "blockquote" | "ol" | "ul" } =>
      match !== undefined,
  );
  const ownerBlocks = blocksInsideOwner(outerBlock);
  const nestedBlocks = collectNestedDetailsBlocks(ownerBlocks);
  const result: TelegramDetailsHtmlIsland[] = [];
  if (nestedBlocks.length === spans.length) {
    for (let index = 0; index < spans.length; index += 1) {
      const span = spans[index];
      const block = nestedBlocks[index];
      if (span && block) {
        result.push({ ...span, block });
      }
    }
  }
  const nestedContainers = collectNestedHtmlContainerBlocks(ownerBlocks);
  const containers: TelegramHtmlContainerIsland[] = [];
  if (nestedContainers.length === containerSpans.length) {
    for (let index = 0; index < containerSpans.length; index += 1) {
      const span = containerSpans[index];
      const block = nestedContainers[index];
      if (span && block) {
        containers.push({ start: span.start, end: span.end, block });
      }
    }
  }
  return { details: result, containers };
}

export function collectTelegramDetailsStructuralIslands(
  ir: MarkdownIR,
  start: number,
  end: number,
  islands: readonly TelegramHtmlIsland[],
): TelegramDetailsStructuralSegment[] {
  const text = ir.text.slice(start, end);
  const tags = [...tokenizeHtmlTags(text)];
  const openIndexes = new Map<number, number>();
  const closeIndexes = new Map<number, number>();
  for (const [index, tag] of tags.entries()) {
    if (!tag.closing) {
      openIndexes.set(tag.start, index);
    }
    if (tag.closing) {
      closeIndexes.set(tag.end, index);
    }
  }
  const codeRanges = ir.styles.filter(
    (span) =>
      (span.style === "code" || span.style === "code_block") &&
      span.end > start &&
      span.start < end,
  );
  const startsInsideCode = (relativeStart: number) =>
    codeRanges.some(
      (range) => start + relativeStart >= range.start && start + relativeStart < range.end,
    );
  const result: TelegramDetailsStructuralSegment[] = [];

  for (const island of islands) {
    const block = island.blocks.length === 1 ? island.blocks[0] : undefined;
    const owner =
      block?.type === "details" && island.detailsBodyRanges !== undefined
        ? block
        : block?.type === "blockquote" || block?.type === "list"
          ? block
          : undefined;
    if (!owner) {
      continue;
    }
    const openIndex = openIndexes.get(island.start);
    const closeIndex = closeIndexes.get(island.end);
    if (openIndex === undefined || closeIndex === undefined || closeIndex <= openIndex) {
      continue;
    }
    const nested = findNestedHtml(tags, openIndex, closeIndex, owner);
    if (owner.type === "details") {
      result.push({
        kind: "details",
        start: start + island.start,
        end: start + island.end,
        bodyRanges: island.detailsBodyRanges!.map((range) => ({
          start: start + range.start,
          end: start + range.end,
        })),
        block: owner,
      });
    } else if (nested.details.length > 0) {
      result.push({
        kind: "html-container",
        start: start + island.start,
        end: start + island.end,
        block: owner,
      });
    }
    for (const nestedDetail of nested.details) {
      if (startsInsideCode(nestedDetail.start)) {
        continue;
      }
      result.push({
        kind: "details",
        start: start + nestedDetail.start,
        end: start + nestedDetail.end,
        bodyRanges: nestedDetail.bodyRanges.map((range) => ({
          start: start + range.start,
          end: start + range.end,
        })),
        block: nestedDetail.block,
      });
    }
    for (const container of nested.containers) {
      if (
        !nested.details.some(
          (detail) => detail.start > container.start && detail.end < container.end,
        )
      ) {
        continue;
      }
      result.push({
        kind: "html-container",
        start: start + container.start,
        end: start + container.end,
        block: container.block,
      });
    }
  }
  return result;
}
