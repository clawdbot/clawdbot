// Block-level HTML-island mapping: figures/lists/tables/media/maps/collages
// and island discovery, on top of the fragment parser in rich-blocks-html.ts.
import { tokenizeHtmlTags } from "openclaw/plugin-sdk/text-chunking";
import {
  richTextToPlainString,
  type InputRichBlock,
  type InputRichBlockListItem,
  type RichBlockCaption,
  type RichBlockTableCell,
  type RichText,
} from "./rich-block-model.js";
import {
  htmlNodesToRichText,
  nodeText,
  parseHtmlAttrs,
  parseHtmlFragment,
  VOID_TAGS,
  type HtmlNode,
} from "./rich-blocks-html.js";
import { renderTelegramMonospaceGrid } from "./text-width.js";
// Block-level islands the agent contract documents. A supported open tag with a
// matching close (or a void tag) becomes a typed block; anything else stays text.
const BLOCK_ISLAND_TAGS = new Set([
  "details",
  "table",
  "ul",
  "ol",
  "figure",
  "img",
  "video",
  "audio",
  "blockquote",
  "aside",
  "footer",
  "hr",
  "tg-math-block",
  "tg-map",
  "tg-collage",
  "tg-slideshow",
  // Only an empty <a name> becomes an anchor block; hrefs fall through to the
  // inline path because elementToBlock returns undefined for them.
  "a",
]);

const MEDIA_SRC_RE = /^https:\/\//i;

// True when a container holds meaningful content outside its allowed children;
// such islands stay literal instead of silently dropping the stray content.
function hasStrayContent(nodes: readonly HtmlNode[], allowed: ReadonlySet<string>): boolean {
  return nodes.some((node) =>
    node.kind === "text" ? node.text.trim() !== "" : !allowed.has(node.name),
  );
}

function mediaBlockFromElement(
  node: Extract<HtmlNode, { kind: "element" }>,
  caption?: RichBlockCaption,
): InputRichBlock | undefined {
  const attrs = parseHtmlAttrs(node.raw);
  const src = attrs.get("src") ?? "";
  // Media islands are content-free (src only); any authored body — text or
  // nested elements — would be silently lost from rich output and fallback.
  const hasBody = node.children.some((child) =>
    child.kind === "text" ? child.text.trim() !== "" : true,
  );
  if (!MEDIA_SRC_RE.test(src) || hasBody) {
    return undefined;
  }
  const withCaption = caption ? { caption } : {};
  // GIF sources render as looping animations, matching the old rich HTML
  // pipeline where Telegram inferred the media kind from the URL.
  const isGif = /\.gif(?:[?#]|$)/i.test(src);
  if (node.name === "img" || node.name === "video") {
    if (isGif) {
      return { type: "animation", animation: { type: "animation", media: src }, ...withCaption };
    }
    return node.name === "img"
      ? { type: "photo", photo: { type: "photo", media: src }, ...withCaption }
      : { type: "video", video: { type: "video", media: src }, ...withCaption };
  }
  if (node.name === "audio") {
    // OGG/Opus is Telegram's voice-note family; the music `audio` type rejects
    // it (live-verified RICH_MESSAGE_AUDIO_INVALID), and a Vorbis ogg fails
    // under both types, so voice_note strictly dominates for these extensions.
    if (/\.(?:ogg|opus|oga)(?:[?#]|$)/i.test(src)) {
      return {
        type: "voice_note",
        voice_note: { type: "voice_note", media: src },
        ...withCaption,
      };
    }
    return { type: "audio", audio: { type: "audio", media: src }, ...withCaption };
  }
  return undefined;
}

function countChildren(nodes: readonly HtmlNode[], name: string): number {
  return nodes.filter((node) => node.kind === "element" && node.name === name).length;
}

function captionFromFigcaption(nodes: readonly HtmlNode[]): RichBlockCaption | undefined {
  const figcaption = nodes.find(
    (node): node is Extract<HtmlNode, { kind: "element" }> =>
      node.kind === "element" && node.name === "figcaption",
  );
  if (!figcaption) {
    return undefined;
  }
  const cite = figcaption.children.find(
    (node): node is Extract<HtmlNode, { kind: "element" }> =>
      node.kind === "element" && node.name === "cite",
  );
  const textNodes = figcaption.children.filter((node) => node !== cite);
  const text = htmlNodesToRichText(textNodes);
  if (text === "" && !cite) {
    return undefined;
  }
  return {
    text,
    ...(cite ? { credit: htmlNodesToRichText(cite.children) } : {}),
  };
}

const FIGURE_CHILDREN = new Set(["img", "video", "audio", "tg-map", "figcaption"]);

function figureToBlock(node: Extract<HtmlNode, { kind: "element" }>): InputRichBlock | undefined {
  if (hasStrayContent(node.children, FIGURE_CHILDREN)) {
    return undefined;
  }
  // A figure carries exactly one media element and at most one caption;
  // multiples would silently drop authored content.
  const mediaChildren = node.children.filter(
    (child) => child.kind === "element" && child.name !== "figcaption",
  );
  if (mediaChildren.length > 1 || countChildren(node.children, "figcaption") > 1) {
    return undefined;
  }
  const media = node.children.find(
    (child): child is Extract<HtmlNode, { kind: "element" }> =>
      child.kind === "element" &&
      (child.name === "img" ||
        child.name === "video" ||
        child.name === "audio" ||
        child.name === "tg-map"),
  );
  if (!media) {
    return undefined;
  }
  const caption = captionFromFigcaption(node.children);
  if (media.name === "tg-map") {
    const map = mapToBlock(media);
    if (map?.type === "map" && caption) {
      return { ...map, caption };
    }
    return map;
  }
  return mediaBlockFromElement(media, caption);
}

const LIST_CHILDREN = new Set(["li"]);

function listToBlock(node: Extract<HtmlNode, { kind: "element" }>): InputRichBlock | undefined {
  if (hasStrayContent(node.children, LIST_CHILDREN)) {
    return undefined;
  }
  const items: InputRichBlockListItem[] = [];
  for (const child of node.children) {
    if (child.kind !== "element" || child.name !== "li") {
      continue;
    }
    const checkbox = child.children.find(
      (grandchild): grandchild is Extract<HtmlNode, { kind: "element" }> =>
        grandchild.kind === "element" &&
        grandchild.name === "input" &&
        parseHtmlAttrs(grandchild.raw).get("type") === "checkbox",
    );
    const contentNodes = child.children.filter((grandchild) => grandchild !== checkbox);
    const blocks = htmlNodesToBlocks(contentNodes);
    const item: InputRichBlockListItem = {
      blocks: blocks.length > 0 ? blocks : [{ type: "paragraph", text: "" }],
    };
    if (checkbox) {
      item.has_checkbox = true;
      if (parseHtmlAttrs(checkbox.raw).has("checked")) {
        item.is_checked = true;
      }
    }
    items.push(item);
  }
  if (items.length === 0) {
    return undefined;
  }
  return {
    type: "list",
    items: node.name === "ol" ? items.map((item, index) => ({ ...item, value: index + 1 })) : items,
  };
}

function resolveTableCellAlign(value: string | undefined): RichBlockTableCell["align"] {
  return value === "center" || value === "right" ? value : "left";
}

function resolveTableCellValign(value: string | undefined): RichBlockTableCell["valign"] {
  return value === "top" || value === "bottom" ? value : "middle";
}

function tableCellFromElement(
  node: Extract<HtmlNode, { kind: "element" }>,
  inHeader: boolean,
): RichBlockTableCell {
  const attrs = parseHtmlAttrs(node.raw);
  const text = htmlNodesToRichText(node.children);
  const colspan = strictNumber(attrs.get("colspan"), /^\d+$/u) ?? Number.NaN;
  const rowspan = strictNumber(attrs.get("rowspan"), /^\d+$/u) ?? Number.NaN;
  const align = attrs.get("align")?.toLowerCase();
  const valign = attrs.get("valign")?.toLowerCase();
  return {
    align: resolveTableCellAlign(align),
    valign: resolveTableCellValign(valign),
    ...(text !== "" ? { text } : {}),
    ...(node.name === "th" || inHeader ? { is_header: true as const } : {}),
    ...(Number.isSafeInteger(colspan) && colspan > 1 ? { colspan } : {}),
    ...(Number.isSafeInteger(rowspan) && rowspan > 1 ? { rowspan } : {}),
  };
}

// Live-verified: >20 effective columns → RICH_MESSAGE_TABLE_COLS_TOO_MANY.
const TABLE_COLUMN_LIMIT = 20;

function tableColumnCount(cells: readonly RichBlockTableCell[][]): number {
  // Rowspans occupy width in later rows too; ignoring the carryover would
  // under-count and emit tables Telegram rejects with TABLE_COLS_TOO_MANY.
  let carryover: Array<{ span: number; rows: number }> = [];
  let max = 0;
  for (const row of cells) {
    const carried = carryover.reduce((total, cell) => total + cell.span, 0);
    const own = row.reduce((total, cell) => total + (cell.colspan ?? 1), 0);
    max = Math.max(max, carried + own);
    carryover = [
      ...carryover
        .map((cell) => ({ span: cell.span, rows: cell.rows - 1 }))
        .filter((cell) => cell.rows > 0),
      ...row
        .filter((cell) => (cell.rowspan ?? 1) > 1)
        .map((cell) => ({ span: cell.colspan ?? 1, rows: (cell.rowspan ?? 1) - 1 })),
    ];
  }
  return max;
}

const TABLE_CHILDREN = new Set(["caption", "thead", "tbody", "tfoot", "tr"]);
const TABLE_ROW_CHILDREN = new Set(["td", "th"]);

function tableToBlock(node: Extract<HtmlNode, { kind: "element" }>): InputRichBlock | undefined {
  if (hasStrayContent(node.children, TABLE_CHILDREN)) {
    return undefined;
  }
  const cells: RichBlockTableCell[][] = [];
  let caption: RichText | undefined;
  // Stray non-whitespace content anywhere in the table structure rejects the
  // island: silently dropping it would lose agent content from the fallback too.
  let stray = false;
  const visitRows = (parent: Extract<HtmlNode, { kind: "element" }>, inHeader: boolean) => {
    for (const child of parent.children) {
      if (child.kind !== "element") {
        stray ||= child.text.trim() !== "";
        continue;
      }
      if (child.name === "caption") {
        const text = htmlNodesToRichText(child.children);
        if (text !== "") {
          // A second caption would overwrite authored content; reject instead.
          stray ||= caption !== undefined;
          caption = text;
        }
        continue;
      }
      if (child.name === "thead" || child.name === "tbody" || child.name === "tfoot") {
        visitRows(child, child.name === "thead");
        continue;
      }
      if (child.name === "tr") {
        if (hasStrayContent(child.children, TABLE_ROW_CHILDREN)) {
          stray = true;
          continue;
        }
        const row = child.children
          .filter(
            (cell): cell is Extract<HtmlNode, { kind: "element" }> =>
              cell.kind === "element" && (cell.name === "td" || cell.name === "th"),
          )
          .map((cell) => tableCellFromElement(cell, inHeader));
        if (row.length > 0) {
          cells.push(row);
        }
        continue;
      }
      stray = true;
    }
  };
  visitRows(node, false);
  if (stray || cells.length === 0) {
    return undefined;
  }
  if (tableColumnCount(cells) > TABLE_COLUMN_LIMIT) {
    // Mirror the markdown table path: over-wide tables degrade to a readable
    // monospace grid instead of an API-rejected table block.
    const gridRows = cells.map((row) =>
      row.flatMap((cell) =>
        // Colspans consume adjacent columns; rowspans stay row-local rather
        // than growing this fallback into a second table layout engine.
        Array.from(
          { length: Math.min(cell.colspan ?? 1, TABLE_COLUMN_LIMIT + 1) },
          (_value, index) => (index === 0 ? richTextToPlainString(cell.text ?? "") : ""),
        ),
      ),
    );
    const grid = renderTelegramMonospaceGrid(gridRows);
    return {
      type: "pre",
      text: caption !== undefined ? `${richTextToPlainString(caption)}\n${grid}` : grid,
    };
  }
  return {
    type: "table",
    cells,
    is_bordered: true,
    is_striped: true,
    ...(caption !== undefined ? { caption } : {}),
  };
}

// Full-string numeric parse: prefix-tolerant parseFloat would silently map
// malformed coordinates like "48.8north" to an unintended location.
function strictNumber(value: string | undefined, token = /^-?\d+(?:\.\d+)?$/): number | undefined {
  if (value === undefined || !token.test(value.trim())) {
    return undefined;
  }
  return Number.parseFloat(value);
}

function mapToBlock(node: Extract<HtmlNode, { kind: "element" }>): InputRichBlock | undefined {
  const attrs = parseHtmlAttrs(node.raw);
  const latitude = strictNumber(attrs.get("lat"));
  const longitude = strictNumber(attrs.get("long"));
  const inRange =
    latitude !== undefined &&
    longitude !== undefined &&
    Math.abs(latitude) <= 90 &&
    Math.abs(longitude) <= 180;
  if (!inRange) {
    return undefined;
  }
  const zoom = strictNumber(attrs.get("zoom")) ?? Number.NaN;
  return {
    type: "map",
    location: { latitude, longitude },
    zoom: Number.isFinite(zoom) ? Math.min(24, Math.max(0, Math.round(zoom))) : 14,
    // The documented <tg-map> island carries no size; a 16:9 default satisfies
    // the API's total<=10000 and ratio<=20 constraints.
    width: 800,
    height: 450,
  };
}

const COLLAGE_CHILDREN = new Set(["figure", "img", "video", "audio", "figcaption"]);

function collageToBlock(node: Extract<HtmlNode, { kind: "element" }>): InputRichBlock | undefined {
  if (
    hasStrayContent(node.children, COLLAGE_CHILDREN) ||
    countChildren(node.children, "figcaption") > 1
  ) {
    return undefined;
  }
  const blocks: InputRichBlock[] = [];
  for (const child of node.children) {
    if (child.kind !== "element" || child.name === "figcaption") {
      continue;
    }
    const media = child.name === "figure" ? figureToBlock(child) : mediaBlockFromElement(child);
    if (!media) {
      // A child that fails conversion (bad scheme, unsupported tag) rejects the
      // whole island: partial collages would silently drop agent content.
      return undefined;
    }
    blocks.push(media);
  }
  if (blocks.length === 0) {
    return undefined;
  }
  const caption = captionFromFigcaption(node.children);
  return {
    type: node.name === "tg-slideshow" ? "slideshow" : "collage",
    blocks,
    ...(caption ? { caption } : {}),
  };
}

function richTextIsBlank(text: RichText): boolean {
  if (typeof text === "string") {
    return text.trim() === "";
  }
  if (Array.isArray(text)) {
    return text.every(richTextIsBlank);
  }
  if (text.type === "mathematical_expression") {
    return text.expression.trim() === "";
  }
  if (text.type === "custom_emoji") {
    return false;
  }
  return richTextIsBlank(text.text);
}

/** Map island element nodes plus loose text into typed blocks. */
function htmlNodesToBlocks(nodes: readonly HtmlNode[]): InputRichBlock[] {
  const blocks: InputRichBlock[] = [];
  let pendingInline: HtmlNode[] = [];
  const flushInline = () => {
    if (pendingInline.length === 0) {
      return;
    }
    const text = htmlNodesToRichText(pendingInline);
    pendingInline = [];
    // Indentation between child tags collapses to spaces; a whitespace-only
    // run is layout, not content, and must not mint blank paragraphs.
    if (!richTextIsBlank(text)) {
      blocks.push({ type: "paragraph", text });
    }
  };
  for (const node of nodes) {
    const block = node.kind === "element" ? elementToBlock(node) : undefined;
    if (block) {
      flushInline();
      blocks.push(block);
      continue;
    }
    if (node.kind === "element" && node.name === "p") {
      flushInline();
      const text = htmlNodesToRichText(node.children);
      if (text !== "") {
        blocks.push({ type: "paragraph", text });
      }
      continue;
    }
    pendingInline.push(node);
  }
  flushInline();
  return blocks;
}

function elementToBlock(node: Extract<HtmlNode, { kind: "element" }>): InputRichBlock | undefined {
  switch (node.name) {
    case "hr":
      return { type: "divider" };
    case "details": {
      const summary = node.children.find(
        (child): child is Extract<HtmlNode, { kind: "element" }> =>
          child.kind === "element" && child.name === "summary",
      );
      const bodyNodes = node.children.filter((child) => child !== summary);
      const blocks = htmlNodesToBlocks(bodyNodes);
      return {
        type: "details",
        summary: summary ? htmlNodesToRichText(summary.children) : "Details",
        blocks: blocks.length > 0 ? blocks : [{ type: "paragraph", text: "" }],
        ...(parseHtmlAttrs(node.raw).has("open") ? { is_open: true } : {}),
      };
    }
    case "ul":
    case "ol":
      return listToBlock(node);
    case "table":
      return tableToBlock(node);
    case "figure":
      return figureToBlock(node);
    case "img":
    case "video":
    case "audio":
      return mediaBlockFromElement(node);
    case "blockquote": {
      const cite = node.children.find(
        (child): child is Extract<HtmlNode, { kind: "element" }> =>
          child.kind === "element" && child.name === "cite",
      );
      const blocks = htmlNodesToBlocks(node.children.filter((child) => child !== cite));
      if (blocks.length === 0) {
        return undefined;
      }
      const credit = cite ? htmlNodesToRichText(cite.children) : "";
      return credit !== ""
        ? { type: "blockquote", blocks, credit }
        : { type: "blockquote", blocks };
    }
    case "aside": {
      const cite = node.children.find(
        (child): child is Extract<HtmlNode, { kind: "element" }> =>
          child.kind === "element" && child.name === "cite",
      );
      const text = htmlNodesToRichText(node.children.filter((child) => child !== cite));
      if (text === "") {
        return undefined;
      }
      return {
        type: "pullquote",
        text,
        ...(cite ? { credit: htmlNodesToRichText(cite.children) } : {}),
      };
    }
    case "footer": {
      const text = htmlNodesToRichText(node.children);
      return text === "" ? undefined : { type: "footer", text };
    }
    case "tg-math-block": {
      const expression = nodeText(node.children).trim();
      return expression ? { type: "mathematical_expression", expression } : undefined;
    }
    case "tg-map":
      return mapToBlock(node);
    case "tg-collage":
    case "tg-slideshow":
      return collageToBlock(node);
    case "a": {
      const attrs = parseHtmlAttrs(node.raw);
      const name = attrs.get("name");
      // Only an empty named <a> is an anchor block; hrefs are inline islands.
      if (name && !attrs.get("href") && nodeText(node.children).trim() === "") {
        return { type: "anchor", name };
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

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
  nestedContainers?: Array<{ start: number; end: number; name: "blockquote" | "ol" | "ul" }>;
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

type NestedHtmlScan = {
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

function scanTelegramHtmlIsland(
  tags: readonly {
    start: number;
    end: number;
    name: string;
    closing: boolean;
    selfClosing: boolean;
  }[],
  rootIndex: number,
): NestedHtmlScan {
  const root = tags[rootIndex];
  if (!root) {
    return { matched: false, endIndex: -1, end: 0, contentEnd: 0, details: [], containers: [] };
  }
  const detailMatches: Array<NestedHtmlScan["details"][number] | undefined> = [];
  const containerMatches: Array<NestedHtmlScan["containers"][number] | undefined> = [];
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
  ): NestedHtmlScan => ({
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
      (match): match is NestedHtmlScan["details"][number] => match !== undefined,
    ),
    containers: containerMatches.filter(
      (match): match is NestedHtmlScan["containers"][number] => match !== undefined,
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

/**
 * Find supported block islands inside a text range. Returns non-overlapping
 * spans in order; text outside spans stays on the markdown paragraph path.
 */
export function findTelegramHtmlIslands(text: string): TelegramHtmlIsland[] {
  if (!text.includes("<")) {
    return [];
  }
  const islands: TelegramHtmlIsland[] = [];
  const tags = [...tokenizeHtmlTags(text)];
  // Open non-island containers seen at scan level; a supported tag nested in an
  // unsupported wrapper (<custom><hr/></custom>) must stay literal with it.
  const openContainers: string[] = [];
  let index = 0;
  while (index < tags.length) {
    const tag = tags[index];
    if (!tag) {
      index += 1;
      continue;
    }
    const startsIsland =
      !tag.closing && BLOCK_ISLAND_TAGS.has(tag.name) && openContainers.length === 0;
    if (!startsIsland) {
      if (tag.closing) {
        const openIndex = openContainers.lastIndexOf(tag.name);
        if (openIndex >= 0) {
          openContainers.length = openIndex;
        }
      } else if (!tag.selfClosing && !VOID_TAGS.has(tag.name)) {
        openContainers.push(tag.name);
      }
      index += 1;
      continue;
    }
    // Keep matching, summary ownership, and nested block spans in one
    // tolerant tag scan so the HTML tree mapper and Markdown emitter share
    // exactly the same parent/container decisions.
    const scan = scanTelegramHtmlIsland(tags, index);
    if (!scan.matched) {
      // An unclosed supported opener wraps everything after it; treating later
      // tags as islands would extract blocks out of a malformed fragment.
      openContainers.push(tag.name);
      index += 1;
      continue;
    }
    const end = scan.end;
    const contentStart = tag.end;
    const contentEnd = scan.contentEnd;
    if (tag.name === "a") {
      // Only an empty named anchor is a block; href/labelled links stay inline
      // so a mid-sentence link never breaks its paragraph apart.
      const attrs = parseHtmlAttrs(tag.raw);
      const isEmptyNamedAnchor =
        attrs.get("name") !== undefined &&
        attrs.get("href") === undefined &&
        text.slice(contentStart, contentEnd).trim() === "";
      if (!isEmptyNamedAnchor) {
        index += 1;
        continue;
      }
    }
    const blocks = htmlNodesToBlocks(parseHtmlFragment(text.slice(tag.start, end)));
    if (blocks.length > 0) {
      islands.push({
        start: tag.start,
        end,
        blocks,
        ...(scan.detailsBodyRanges ? { detailsBodyRanges: scan.detailsBodyRanges } : {}),
        ...(scan.details.length > 0 ? { nestedDetails: scan.details } : {}),
        ...(scan.containers.length > 0 ? { nestedContainers: scan.containers } : {}),
      });
    }
    index = scan.endIndex + 1;
  }
  return islands;
}
