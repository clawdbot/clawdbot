import { expectDefined } from "@openclaw/normalization-core";
import MarkdownIt from "markdown-it";

export type MarkdownImageSpan = {
  start: number;
  end: number;
  destination: string;
};

/** Finds inline image destinations without treating code or escaped syntax as media. */
export function findMarkdownImageSpans(markdown: string): MarkdownImageSpan[] {
  const md = new MarkdownIt("commonmark");
  md.inline.ruler.enableOnly(["image"]);
  const parseImage = expectDefined(md.inline.ruler.getRules("")[0], "Markdown image rule");
  md.configure("commonmark");
  // Media normalization owns URL spelling and allowlist matching, not the renderer.
  md.normalizeLink = (url) => url;
  md.validateLink = () => true;
  const environment = {};
  const blocks = md.parse(markdown, environment);
  const lineOffsets = [0];
  // Block maps count CRLF and bare CR as line breaks before source normalization.
  for (const newline of markdown.matchAll(/\r\n?|\n/g)) {
    lineOffsets.push(newline.index + newline[0].length);
  }
  const sourceLines = markdown.replace(/\0/g, "\uFFFD").split(/\r\n?|\n/);

  const images: MarkdownImageSpan[] = [];
  let source = "";
  let inlineLines: Array<{ start: number; offset: number }> = [];
  let inlineLine = 0;
  const sourceOffset = (position: number) => {
    for (
      let next = inlineLines[inlineLine + 1];
      next && next.start <= position;
      next = inlineLines[inlineLine + 1]
    ) {
      inlineLine += 1;
    }
    return position + expectDefined(inlineLines[inlineLine], "Markdown inline line").offset;
  };
  md.inline.ruler.at("image", (state, silent) => {
    const start = state.pos;
    const matched = parseImage(state, silent);
    // Image labels recurse into the inline parser; only the outer source owns offsets.
    if (matched && !silent && state.src === source) {
      const token = expectDefined(state.tokens.at(-1), "Parsed Markdown image");
      if (token.meta?.label) {
        return matched;
      }
      images.push({
        start: sourceOffset(start),
        end: sourceOffset(state.pos),
        destination: String(expectDefined(token.attrGet("src"), "Markdown image destination")),
      });
    }
    return matched;
  });
  // Parse the same inline content as the renderer. Reintroducing container
  // markers can change inline HTML/code semantics and hide valid images.
  for (const block of blocks) {
    if (
      block.type !== "inline" ||
      !block.map ||
      !block.children?.some((token) => token.type === "image")
    ) {
      continue;
    }
    source = block.content;
    const firstLine = block.map[0];
    let start = 0;
    inlineLines = source.split("\n").map((content, index) => {
      const original = expectDefined(sourceLines[firstLine + index], "Markdown source line");
      const text = content.trimStart();
      // Block parsing removes container prefixes and can expand leading tabs;
      // the non-whitespace inline bytes retain their position within that line.
      const offset =
        expectDefined(lineOffsets[firstLine + index], "Markdown source offset") +
        original.indexOf(text) -
        (content.length - text.length) -
        start;
      const line = { start, offset };
      start += content.length + 1;
      return line;
    });
    inlineLine = 0;
    // Reference images remain text; only explicit inline destinations become attachments.
    md.inline.parse(source, md, environment, []);
  }
  return images;
}
