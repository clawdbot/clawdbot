import { stripMarkdown } from "openclaw/plugin-sdk/text-chunking";

export const CODE_HEAVY_SPOKEN_FALLBACK = "I've put the detailed response on screen.";

// At least half fenced-code content is unlikely to produce useful speech after stripping.
// Keep the threshold deterministic so Talk clients and providers hear the same fallback.
const CODE_HEAVY_FENCED_CHAR_RATIO = 0.5;

type CodeFence = {
  marker: "`" | "~";
  length: number;
  blockquoteDepth: number;
  listIndent: number;
};

type FenceContainer = Pick<CodeFence, "blockquoteDepth" | "listIndent">;

function unwrapFenceContainer(line: string): { content: string; container: FenceContainer } {
  let content = line;
  let blockquoteDepth = 0;
  while (true) {
    const match = /^(?: {0,3}>[ \t]?)/u.exec(content);
    if (!match) {
      break;
    }
    content = content.slice(match[0].length);
    blockquoteDepth += 1;
  }

  const indentation = /^ +/u.exec(content)?.[0].length ?? 0;
  const listIndent = indentation > 3 && indentation <= 8 ? indentation : 0;
  if (listIndent > 0) {
    content = content.slice(listIndent);
  }
  return { content, container: { blockquoteDepth, listIndent } };
}

function parseFenceOpener(line: string): CodeFence | undefined {
  const { content, container } = unwrapFenceContainer(line);
  const match = /^(?: {0,3})(`{3,}|~{3,})/u.exec(content);
  const fence = match?.[1];
  if (!fence) {
    return undefined;
  }

  const marker = fence[0];
  if (marker !== "`" && marker !== "~") {
    return undefined;
  }
  return { marker, length: fence.length, ...container };
}

function isFenceCloser(line: string, opener: CodeFence): boolean {
  const { content, container } = unwrapFenceContainer(line);
  if (
    container.blockquoteDepth !== opener.blockquoteDepth ||
    container.listIndent !== opener.listIndent
  ) {
    return false;
  }
  const match = /^(?: {0,3})(`+|~+)([ \t]*)$/u.exec(content);
  const fence = match?.[1];
  return fence !== undefined && fence[0] === opener.marker && fence.length >= opener.length;
}

function unwrapFenceBodyLine(line: string, opener: CodeFence): string {
  let content = line;
  for (let index = 0; index < opener.blockquoteDepth; index += 1) {
    const match = /^(?: {0,3}>[ \t]?)/u.exec(content);
    if (!match) {
      return line;
    }
    content = content.slice(match[0].length);
  }
  if (opener.listIndent > 0 && content.startsWith(" ".repeat(opener.listIndent))) {
    return content.slice(opener.listIndent);
  }
  return content;
}

function countFencedCodeChars(text: string): number {
  // Match common fenced-block containers so fallback and stripping classify the same code.
  // This shallow scanner stops at two list levels; deeply nested exotic containers may misclassify.
  // That only makes speech routing suboptimal, never loses message data.
  const lines = text.split(/\r?\n/u);
  let fencedCodeChars = 0;
  let opener: CodeFence | undefined;
  let bodyLines: string[] = [];

  for (const line of lines) {
    if (!opener) {
      opener = parseFenceOpener(line);
      continue;
    }

    if (isFenceCloser(line, opener)) {
      fencedCodeChars += bodyLines.join("\n").length;
      opener = undefined;
      bodyLines = [];
      continue;
    }

    bodyLines.push(unwrapFenceBodyLine(line, opener));
  }

  if (opener) {
    fencedCodeChars += bodyLines.join("\n").length;
  }
  return fencedCodeChars;
}

export function isCodeHeavySpeechText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  return countFencedCodeChars(trimmed) / trimmed.length >= CODE_HEAVY_FENCED_CHAR_RATIO;
}

export function normalizeSpeechText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }
  return stripMarkdown(trimmed, { linkStyle: "label", mode: "speech" }).trim();
}
