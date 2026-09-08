// Block-level HTML-island mapping: figures/lists/tables/media/maps/collages
// and island discovery, on top of the fragment parser in rich-blocks-html.ts.
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
  type HtmlNode,
} from "./rich-blocks-html.js";
import { renderTelegramMonospaceGrid } from "./text-width.js";
// Block-level islands the agent contract documents. A supported open tag with a
// matching close (or a void tag) becomes a typed block; anything else stays text.
const BLOCK_ISLAND_TAGS = new Set([
  "details",
  "p",
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
type HtmlContentRenderer = (nodes: readonly HtmlNode[]) => InputRichBlock[];

// True when a container holds meaningful content outside its allowed children;
// such islands stay literal instead of silently dropping the stray content.
function hasStrayContent(nodes: readonly HtmlNode[], allowed: ReadonlySet<string>): boolean {
  return nodes.some((node) =>
    node.kind === "text" ? node.text.trim() !== "" : !node.closed || !allowed.has(node.name),
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
      node.kind === "element" && node.closed && node.name === "cite",
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

function listToBlock(
  node: Extract<HtmlNode, { kind: "element" }>,
  renderContent: HtmlContentRenderer,
): InputRichBlock | undefined {
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
    const blocks = renderContent(contentNodes);
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
      if (!child.closed) {
        stray = true;
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

function elementToBlock(
  node: Extract<HtmlNode, { kind: "element" }>,
  renderContent: HtmlContentRenderer,
): InputRichBlock | undefined {
  if (!node.closed) {
    return undefined;
  }
  switch (node.name) {
    case "hr":
      return { type: "divider" };
    case "details": {
      const summary = node.children.find(
        (child): child is Extract<HtmlNode, { kind: "element" }> =>
          child.kind === "element" && child.closed && child.name === "summary",
      );
      const bodyNodes = node.children.filter((child) => child !== summary);
      const blocks = renderContent(bodyNodes);
      return {
        type: "details",
        summary: summary ? htmlNodesToRichText(summary.children) : "Details",
        blocks: blocks.length > 0 ? blocks : [{ type: "paragraph", text: "" }],
        ...(parseHtmlAttrs(node.raw).has("open") ? { is_open: true } : {}),
      };
    }
    case "ul":
    case "ol":
      return listToBlock(node, renderContent);
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
          child.kind === "element" && child.closed && child.name === "cite",
      );
      const blocks = renderContent(node.children.filter((child) => child !== cite));
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
          child.kind === "element" && child.closed && child.name === "cite",
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

export function renderTelegramHtmlIsland(
  node: Extract<HtmlNode, { kind: "element" }>,
  renderContent: HtmlContentRenderer,
): InputRichBlock[] {
  if (node.name === "p") {
    return renderContent(node.children);
  }
  const block = elementToBlock(node, renderContent);
  return block ? [block] : [{ type: "paragraph", text: htmlNodesToRichText([node]) }];
}

/** Select whole authored islands; unsupported and unmatched parents stay literal. */
export function findTelegramHtmlIslands(
  nodes: readonly HtmlNode[],
): Array<Extract<HtmlNode, { kind: "element" }>> {
  return nodes.filter((node): node is Extract<HtmlNode, { kind: "element" }> => {
    if (node.kind !== "element" || !node.closed || !BLOCK_ISLAND_TAGS.has(node.name)) {
      return false;
    }
    if (node.name !== "a") {
      return true;
    }
    const attrs = parseHtmlAttrs(node.raw);
    // Hrefs and labelled links stay inline so they cannot split a sentence.
    return (
      attrs.has("name") &&
      !attrs.has("href") &&
      node.children.every((child) => child.kind === "text" && !child.text.trim())
    );
  });
}
