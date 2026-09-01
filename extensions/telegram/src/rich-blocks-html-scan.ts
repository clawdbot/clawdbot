import { VOID_TAGS } from "./rich-blocks-html.js";

export type TelegramHtmlScan = {
  matched: boolean;
  endIndex: number;
  end: number;
  contentEnd: number;
  detailsBodyRanges?: Array<{ start: number; end: number }>;
  details: Array<{
    start: number;
    end: number;
    bodyRanges: Array<{ start: number; end: number }>;
  }>;
  containers: Array<{ start: number; end: number; name: "blockquote" | "ol" | "ul" }>;
};

type DetailsSummaryState = {
  summaryStart?: number;
  summaryEnd?: number;
  summaryDepth: number;
  summarySelfClosing: boolean;
};

type PendingDetails = DetailsSummaryState & {
  start: number;
  contentStart: number;
  openTagDepth: number;
  blocked: boolean;
  outputIndex?: number;
};

type PendingHtmlContainer = {
  name: "blockquote" | "ol" | "ul";
  start: number;
  blocked: boolean;
  outputIndex?: number;
};

const NESTED_DETAILS_CONTAINER_TAGS = new Set(["blockquote", "details", "li", "ol", "ul"]);

function recordDetailsSummaryTag(
  state: DetailsSummaryState,
  tag: { start: number; end: number; name: string; closing: boolean; selfClosing: boolean },
  directChild: boolean,
): void {
  if (tag.name !== "summary") {
    return;
  }
  if (tag.closing) {
    if (state.summaryDepth > 0) {
      state.summaryDepth -= 1;
      if (state.summaryDepth === 0) {
        state.summaryEnd = tag.end;
      }
    }
    return;
  }
  if (state.summaryStart === undefined && directChild) {
    state.summaryStart = tag.start;
    state.summarySelfClosing = tag.selfClosing;
    if (!tag.selfClosing) {
      state.summaryDepth = 1;
    }
    return;
  }
  if (state.summaryDepth > 0 && !tag.selfClosing) {
    state.summaryDepth += 1;
  }
}

function detailsBodyRangesFromSummary(
  state: DetailsSummaryState,
  contentStart: number,
  contentEnd: number,
): Array<{ start: number; end: number }> {
  if (
    state.summaryStart === undefined ||
    state.summarySelfClosing ||
    state.summaryEnd === undefined
  ) {
    return [{ start: contentStart, end: contentEnd }];
  }
  const ranges: Array<{ start: number; end: number }> = [];
  if (state.summaryStart > contentStart) {
    ranges.push({ start: contentStart, end: state.summaryStart });
  }
  if (state.summaryEnd < contentEnd) {
    ranges.push({ start: state.summaryEnd, end: contentEnd });
  }
  return ranges;
}

function removeOpenHtmlContainer(containers: string[], name: string): void {
  const openIndex = containers.lastIndexOf(name);
  if (openIndex >= 0) {
    containers.length = openIndex;
  }
}

function updateOpenHtmlTagStack(
  openTags: string[],
  tag: { name: string; closing: boolean; selfClosing: boolean },
): void {
  if (tag.closing) {
    const openIndex = openTags.lastIndexOf(tag.name);
    if (openIndex >= 0) {
      openTags.length = openIndex;
    }
    return;
  }
  if (!tag.selfClosing && !VOID_TAGS.has(tag.name)) {
    openTags.push(tag.name);
  }
}

export function scanTelegramHtmlIsland(
  tags: readonly {
    start: number;
    end: number;
    name: string;
    closing: boolean;
    selfClosing: boolean;
  }[],
  rootIndex: number,
): TelegramHtmlScan {
  const root = tags[rootIndex];
  if (!root) {
    return { matched: false, endIndex: -1, end: 0, contentEnd: 0, details: [], containers: [] };
  }
  const detailMatches: Array<TelegramHtmlScan["details"][number] | undefined> = [];
  const containerMatches: Array<TelegramHtmlScan["containers"][number] | undefined> = [];
  const details: PendingDetails[] = [];
  const containers: PendingHtmlContainer[] = [];
  const blocked: string[] = [];
  const openTags = root.selfClosing || VOID_TAGS.has(root.name) ? [] : [root.name];
  const rootDetails: PendingDetails | undefined =
    root.name === "details" && !root.selfClosing
      ? {
          start: root.start,
          contentStart: root.end,
          openTagDepth: 0,
          blocked: false,
          summaryDepth: 0,
          summarySelfClosing: false,
        }
      : undefined;
  if (rootDetails) {
    details.push(rootDetails);
  }
  const finish = (
    index: number,
    tag: { start: number; end: number },
    matched: boolean,
  ): TelegramHtmlScan => ({
    matched,
    endIndex: index,
    end: tag.end,
    contentEnd: tag.start,
    ...(rootDetails
      ? {
          detailsBodyRanges: detailsBodyRangesFromSummary(
            rootDetails,
            rootDetails.contentStart,
            tag.start,
          ),
        }
      : {}),
    details: detailMatches.filter(
      (match): match is TelegramHtmlScan["details"][number] => match !== undefined,
    ),
    containers: containerMatches.filter(
      (match): match is TelegramHtmlScan["containers"][number] => match !== undefined,
    ),
  });
  if (root.selfClosing || VOID_TAGS.has(root.name)) {
    return {
      matched: true,
      endIndex: rootIndex,
      end: root.end,
      contentEnd: root.end,
      ...(root.name === "details"
        ? { detailsBodyRanges: [{ start: root.end, end: root.end }] }
        : {}),
      details: [],
      containers: [],
    };
  }

  let depth = 1;
  let codeDepth = 0;
  for (let index = rootIndex + 1; index < tags.length; index += 1) {
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
      const closesRoot = tag.name === root.name;
      if (closesRoot) {
        depth -= 1;
      }
      if (tag.name === "details") {
        const pending = details.pop();
        if (pending === rootDetails) {
          return finish(index, tag, closesRoot && depth === 0);
        }
        if (pending?.outputIndex !== undefined) {
          detailMatches[pending.outputIndex] = {
            start: pending.start,
            end: tag.end,
            bodyRanges: detailsBodyRangesFromSummary(pending, pending.contentStart, tag.start),
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
        if (pending && !pending.blocked) {
          recordDetailsSummaryTag(pending, tag, false);
        }
        removeOpenHtmlContainer(blocked, tag.name);
      } else {
        removeOpenHtmlContainer(blocked, tag.name);
      }
      updateOpenHtmlTagStack(openTags, tag);
      if (closesRoot && depth === 0) {
        return finish(index, tag, true);
      }
      continue;
    }

    if (tag.name === root.name && !tag.selfClosing) {
      depth += 1;
    }
    if (tag.name === "details") {
      const pending: PendingDetails = {
        start: tag.start,
        contentStart: tag.end,
        openTagDepth: openTags.length,
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
    } else if (tag.name === "blockquote" || tag.name === "ol" || tag.name === "ul") {
      const pending: PendingHtmlContainer = {
        name: tag.name,
        start: tag.start,
        blocked: blocked.length > 0,
      };
      if (!pending.blocked && !tag.selfClosing) {
        pending.outputIndex = containerMatches.length;
        containerMatches.push(undefined);
      }
      if (!tag.selfClosing) {
        containers.push(pending);
      }
    } else if (tag.name === "summary") {
      const pending = details.at(-1);
      if (pending && !pending.blocked) {
        recordDetailsSummaryTag(pending, tag, openTags.length === pending.openTagDepth + 1);
      }
      if (!tag.selfClosing) {
        blocked.push(tag.name);
      }
    } else if (
      !tag.selfClosing &&
      !VOID_TAGS.has(tag.name) &&
      !NESTED_DETAILS_CONTAINER_TAGS.has(tag.name)
    ) {
      blocked.push(tag.name);
    }
    updateOpenHtmlTagStack(openTags, tag);
  }

  return {
    matched: false,
    endIndex: -1,
    end: root.end,
    contentEnd: root.end,
    details: [],
    containers: [],
  };
}
