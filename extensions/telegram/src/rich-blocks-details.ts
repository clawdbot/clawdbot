import { tokenizeHtmlTags } from "openclaw/plugin-sdk/text-chunking";
import type { MarkdownIR } from "openclaw/plugin-sdk/text-chunking";
import type { InputRichBlock } from "./rich-block-model.js";
import { VOID_TAGS } from "./rich-blocks-html.js";

type StructuralRange = { start: number; end: number };
type HtmlContainerName = "blockquote" | "ol" | "ul";
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

type TelegramHtmlTag = {
  start: number;
  end: number;
  name: string;
  closing: boolean;
  selfClosing: boolean;
};

type PendingDetails = {
  start: number;
  contentStart: number;
  blocked: boolean;
  outputIndex?: number;
  summaryStart?: number;
  summaryDepth: number;
  summaryEnd?: number;
  summarySelfClosing: boolean;
};

type PendingContainer = {
  name: HtmlContainerName;
  start: number;
  blocked: boolean;
  outputIndex?: number;
};

type NestedHtmlScan = {
  details: Array<{
    start: number;
    end: number;
    bodyRanges: Array<{ start: number; end: number }>;
  }>;
  containers: Array<{ start: number; end: number; name: HtmlContainerName }>;
};

const NESTED_DETAILS_CONTAINER_TAGS = new Set(["blockquote", "details", "li", "ol", "ul"]);

function collectNestedBlocks(blocks: readonly InputRichBlock[]): InputRichBlock[] {
  const result: InputRichBlock[] = [];
  const pending = blocks.toReversed();
  while (pending.length > 0) {
    const block = pending.pop();
    if (!block) {
      continue;
    }
    switch (block.type) {
      case "details":
      case "blockquote":
      case "list":
        result.push(block);
        if (block.type === "list") {
          for (let index = block.items.length - 1; index >= 0; index -= 1) {
            const item = block.items[index];
            if (item) {
              pending.push(...item.blocks.toReversed());
            }
          }
        } else {
          pending.push(...block.blocks.toReversed());
        }
        break;
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

function blocksInsideOwner(block: TelegramDetailsRichBlock | TelegramHtmlContainerRichBlock) {
  return block.type === "list" ? block.items.flatMap((item) => item.blocks) : block.blocks;
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
  pending: PendingDetails,
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

function findNestedHtml(
  tags: readonly TelegramHtmlTag[],
  outerOpenIndex: number,
  outerCloseIndex: number,
): NestedHtmlScan {
  const detailMatches: Array<NestedHtmlScan["details"][number] | undefined> = [];
  const containerMatches: Array<NestedHtmlScan["containers"][number] | undefined> = [];
  const details: PendingDetails[] = [];
  const containers: PendingContainer[] = [];
  const blocked: string[] = [];
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
        const pending = details.pop();
        if (pending?.outputIndex !== undefined) {
          detailMatches[pending.outputIndex] = {
            start: pending.start,
            end: tag.end,
            bodyRanges: detailsBodyRangesFromPending(pending, tag.start),
          };
        }
      } else if (tag.name === "blockquote" || tag.name === "ol" || tag.name === "ul") {
        const openIndex = containers.findLastIndex((pending) => pending.name === tag.name);
        if (openIndex >= 0) {
          const pending = containers[openIndex];
          containers.length = openIndex;
          if (pending?.outputIndex !== undefined) {
            containerMatches[pending.outputIndex] = {
              start: pending.start,
              end: tag.end,
              name: pending.name,
            };
          }
        }
      } else if (tag.name === "summary") {
        const pending = details.at(-1);
        if (pending && !pending.blocked && pending.summaryDepth > 0) {
          pending.summaryDepth -= 1;
          if (pending.summaryDepth === 0) {
            pending.summaryEnd = tag.end;
          }
        }
        removeOpenHtmlContainer(blocked, tag.name);
      } else {
        removeOpenHtmlContainer(blocked, tag.name);
      }
      continue;
    }
    if (tag.name === "details") {
      const pending: PendingDetails = {
        start: tag.start,
        contentStart: tag.end,
        blocked: blocked.length > 0,
        summaryDepth: 0,
        summarySelfClosing: false,
      };
      if (!pending.blocked) {
        pending.outputIndex = detailMatches.length;
        detailMatches.push(
          tag.selfClosing
            ? { start: tag.start, end: tag.end, bodyRanges: [{ start: tag.end, end: tag.end }] }
            : undefined,
        );
      }
      if (!tag.selfClosing) {
        details.push(pending);
      }
      continue;
    }
    if (tag.name === "blockquote" || tag.name === "ol" || tag.name === "ul") {
      const pending: PendingContainer = {
        name: tag.name,
        start: tag.start,
        blocked: blocked.length > 0,
      };
      if (!pending.blocked) {
        pending.outputIndex = containerMatches.length;
        containerMatches.push(undefined);
      }
      if (!tag.selfClosing) {
        containers.push(pending);
      }
      continue;
    }
    if (tag.name === "summary") {
      const pending = details.at(-1);
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
        blocked.push(tag.name);
      }
      continue;
    }
    if (
      !tag.selfClosing &&
      !VOID_TAGS.has(tag.name) &&
      !NESTED_DETAILS_CONTAINER_TAGS.has(tag.name)
    ) {
      blocked.push(tag.name);
    }
  }

  return {
    details: detailMatches.filter(
      (match): match is NestedHtmlScan["details"][number] => match !== undefined,
    ),
    containers: containerMatches.filter(
      (match): match is NestedHtmlScan["containers"][number] => match !== undefined,
    ),
  };
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
    } else {
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
    const nested = findNestedHtml(tags, openIndex, closeIndex);
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

    const nestedBlocks = collectNestedBlocks(blocksInsideOwner(owner));
    const nestedDetails = nestedBlocks.filter(
      (candidate): candidate is TelegramDetailsRichBlock => candidate.type === "details",
    );
    if (nestedDetails.length === nested.details.length) {
      for (let index = 0; index < nested.details.length; index += 1) {
        const span = nested.details[index];
        const nestedDetail = nestedDetails[index];
        if (!span || !nestedDetail || startsInsideCode(span.start)) {
          continue;
        }
        result.push({
          kind: "details",
          start: start + span.start,
          end: start + span.end,
          bodyRanges: span.bodyRanges.map((range) => ({
            start: start + range.start,
            end: start + range.end,
          })),
          block: nestedDetail,
        });
      }
    }

    const nestedContainers = nestedBlocks.filter(
      (candidate): candidate is TelegramHtmlContainerRichBlock =>
        candidate.type === "blockquote" || candidate.type === "list",
    );
    if (nestedContainers.length === nested.containers.length) {
      for (let index = 0; index < nested.containers.length; index += 1) {
        const span = nested.containers[index];
        const nestedContainer = nestedContainers[index];
        if (
          !span ||
          !nestedContainer ||
          !nested.details.some((detail) => detail.start > span.start && detail.end < span.end)
        ) {
          continue;
        }
        result.push({
          kind: "html-container",
          start: start + span.start,
          end: start + span.end,
          block: nestedContainer,
        });
      }
    }
  }
  return result;
}
