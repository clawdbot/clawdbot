import { findCodeRegions, isInsideCode } from "../../shared/text/code-regions.js";

const MAX_DETAILS_RENDER_DEPTH = 32;

type DetailsNode =
  | string
  | {
      type: "details" | "summary";
      children: DetailsNode[];
    };

const DETAILS_TAG_RE = /<\s*(\/?)\s*(details|summary)(?=\s|>)[^>]*>/gi;

function isEscapedMarkdownCharacter(text: string, index: number): boolean {
  let backslashes = 0;
  for (let cursor = index - 1; cursor >= 0 && text.charAt(cursor) === "\\"; cursor -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

function appendNode(target: DetailsNode[], node: DetailsNode): void {
  const previous = target.at(-1);
  if (typeof previous === "string" && typeof node === "string") {
    target[target.length - 1] = previous + node;
    return;
  }
  target.push(node);
}

function trimMarkdownBlankLines(value: string): string {
  const body = value.replace(/^(?:[ \t]*\r?\n)+/, "");
  let end = body.length;
  // Scan backward: an unanchored repeated suffix regex retries internal blank
  // lines quadratically and blocks unrelated sessions on the same event loop.
  for (let cursor = end; cursor > 0;) {
    while (body[cursor - 1] === " " || body[cursor - 1] === "\t") {
      cursor -= 1;
    }
    if (body[cursor - 1] !== "\n") {
      break;
    }
    cursor -= 1;
    if (body[cursor - 1] === "\r") {
      cursor -= 1;
    }
    end = cursor;
  }
  return body.slice(0, end);
}

type MarkdownContainerLayout = { blankPrefix: string; continuationPrefix: string };

function resolveMarkdownContainerLayout(rendered: string): MarkdownContainerLayout | null {
  const currentLine = rendered.slice(rendered.lastIndexOf("\n") + 1);
  if (/^[ \t]+$/.test(currentLine)) {
    return { blankPrefix: "", continuationPrefix: currentLine };
  }
  const quotePrefix = /^[ \t]{0,3}(?:>\s?)+/.exec(currentLine)?.[0] ?? "";
  const remainder = currentLine.slice(quotePrefix.length);
  if (quotePrefix && !remainder) {
    return { blankPrefix: quotePrefix.trimEnd(), continuationPrefix: quotePrefix };
  }
  const listMarker = /^ {0,3}(?:[-+*]|\d{1,9}[.)])[ \t]+$/.exec(remainder)?.[0];
  if (listMarker) {
    return {
      blankPrefix: quotePrefix.trimEnd(),
      continuationPrefix: quotePrefix + " ".repeat(listMarker.length),
    };
  }
  return null;
}

function renderInMarkdownContainer(block: string, layout: MarkdownContainerLayout): string {
  return block
    .split("\n")
    .map((line, index) => {
      if (index === 0) {
        return line;
      }
      return line ? layout.continuationPrefix + line : layout.blankPrefix;
    })
    .join("\n");
}

function stripMarkdownContainerLayout(block: string, layout: MarkdownContainerLayout): string {
  return block
    .split("\n")
    .map((line) => {
      if (line === layout.blankPrefix) {
        return "";
      }
      return line.startsWith(layout.continuationPrefix)
        ? line.slice(layout.continuationPrefix.length)
        : line;
    })
    .join("\n");
}

function collectDetailsText(nodes: readonly DetailsNode[]): string {
  let text = "";
  const pending = [...nodes].toReversed();
  while (pending.length > 0) {
    const node = pending.pop();
    if (typeof node === "string") {
      text += node;
    } else if (node) {
      pending.push(...node.children.toReversed());
    }
  }
  return text;
}

function renderDetailsNodes(nodes: readonly DetailsNode[], depth = 0): string {
  let rendered = "";
  for (const [index, node] of nodes.entries()) {
    if (typeof node === "string") {
      rendered += node;
      continue;
    }
    if (node.type === "summary") {
      rendered +=
        depth >= MAX_DETAILS_RENDER_DEPTH
          ? collectDetailsText(node.children)
          : renderDetailsNodes(node.children, depth + 1);
      continue;
    }

    const summary = node.children.find(
      (child): child is Exclude<DetailsNode, string> =>
        typeof child !== "string" && child.type === "summary",
    );
    const bodyNodes = node.children.filter((child) => child !== summary);
    const container = resolveMarkdownContainerLayout(rendered);
    const renderedBody =
      depth >= MAX_DETAILS_RENDER_DEPTH
        ? collectDetailsText(bodyNodes)
        : renderDetailsNodes(bodyNodes, depth + 1);
    const body = trimMarkdownBlankLines(
      container ? stripMarkdownContainerLayout(renderedBody, container) : renderedBody,
    );
    const label = summary
      ? (depth >= MAX_DETAILS_RENDER_DEPTH
          ? collectDetailsText(summary.children)
          : renderDetailsNodes(summary.children, depth + 1)
        ).trim()
      : "Details";
    const heading = `**${label || "Details"}**`;
    const block = body ? `${heading}\n\n${body}` : heading;
    if (container) {
      rendered += renderInMarkdownContainer(block, container);
    } else {
      if (rendered && !rendered.endsWith("\n\n")) {
        rendered += rendered.endsWith("\n") ? "\n" : "\n\n";
      }
      rendered += block;
    }
    const next = nodes[index + 1];
    if (
      next !== undefined &&
      next !== "" &&
      (typeof next !== "string" || !next.startsWith("\n\n"))
    ) {
      rendered += typeof next === "string" && next.startsWith("\n") ? "\n" : "\n\n";
    }
  }
  return rendered;
}

/** Flattens model-authored details blocks for transports without native disclosure widgets. */
export function flattenMarkdownDetails(text: string): string {
  if (!/<\s*\/?\s*(?:details|summary)(?=\s|>)/i.test(text)) {
    return text;
  }

  const root: DetailsNode[] = [];
  const stack: Array<Extract<DetailsNode, { type: "details" | "summary" }>> = [];
  // CommonMark code ownership protects fenced, inline, and indented examples,
  // including indentation relative to list containers.
  const codeRegions = findCodeRegions(text);
  let cursor = 0;
  for (const match of text.matchAll(DETAILS_TAG_RE)) {
    const start = match.index ?? 0;
    if (isEscapedMarkdownCharacter(text, start) || isInsideCode(start, codeRegions)) {
      continue;
    }

    const target = stack.at(-1)?.children ?? root;
    appendNode(target, text.slice(cursor, start));
    cursor = start + match[0].length;

    const type = match[2]?.toLowerCase();
    if (type !== "details" && type !== "summary") {
      continue;
    }
    if (match[1]) {
      if (
        type === "details" &&
        stack.at(-1)?.type === "summary" &&
        stack.at(-2)?.type === "details"
      ) {
        stack.pop();
      }
      if (stack.at(-1)?.type === type) {
        stack.pop();
      }
      continue;
    }

    const node = { type, children: [] } satisfies Exclude<DetailsNode, string>;
    appendNode(target, node);
    stack.push(node);
  }
  appendNode(stack.at(-1)?.children ?? root, text.slice(cursor));
  return renderDetailsNodes(root);
}
