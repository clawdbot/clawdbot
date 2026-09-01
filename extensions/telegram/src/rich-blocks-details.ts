import type { MarkdownIR } from "openclaw/plugin-sdk/text-chunking";
import type { InputRichBlock } from "./rich-block-model.js";

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
  nestedDetails?: Array<{
    start: number;
    end: number;
    bodyRanges: Array<{ start: number; end: number }>;
  }>;
  nestedContainers?: Array<{ start: number; end: number; name: HtmlContainerName }>;
};

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
  if (block.type === "blockquote") {
    return { ...block, blocks: block.blocks.map(rebuild) };
  }
  return {
    ...block,
    items: block.items.map((item) => ({ ...item, blocks: item.blocks.map(rebuild) })),
  };
}

export function collectTelegramDetailsStructuralIslands(
  ir: MarkdownIR,
  start: number,
  end: number,
  islands: readonly TelegramHtmlIsland[],
): TelegramDetailsStructuralSegment[] {
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
    const nested = {
      details: island.nestedDetails ?? [],
      containers: island.nestedContainers ?? [],
    };
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
