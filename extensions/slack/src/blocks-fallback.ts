import type { Block, KnownBlock } from "@slack/web-api";

type PlainTextObject = { text?: string };

type SlackBlockWithFields = {
  type?: string;
  text?: PlainTextObject & { type?: string };
  title?: PlainTextObject;
  alt_text?: string;
  elements?: Array<{ text?: string; type?: string }>;
};

function cleanCandidate(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readSectionText(block: SlackBlockWithFields): string | undefined {
  return cleanCandidate(block.text?.text);
}

function readHeaderText(block: SlackBlockWithFields): string | undefined {
  return cleanCandidate(block.text?.text);
}

function readImageText(block: SlackBlockWithFields): string | undefined {
  return cleanCandidate(block.alt_text) ?? cleanCandidate(block.title?.text);
}

function readVideoText(block: SlackBlockWithFields): string | undefined {
  return cleanCandidate(block.title?.text) ?? cleanCandidate(block.alt_text);
}

function readContextText(block: SlackBlockWithFields): string | undefined {
  if (!Array.isArray(block.elements)) {
    return undefined;
  }
  const textParts = block.elements
    .map((element) => cleanCandidate(element.text))
    .filter((value): value is string => Boolean(value));
  return textParts.length > 0 ? textParts.join(" ") : undefined;
}

export function buildSlackBlocksFallbackText(blocks: (Block | KnownBlock)[]): string {
  for (const raw of blocks) {
    const block = raw as SlackBlockWithFields;
    switch (block.type) {
      case "header": {
        const text = readHeaderText(block);
        if (text) {
          return text;
        }
        break;
      }
      case "section": {
        const text = readSectionText(block);
        if (text) {
          return text;
        }
        break;
      }
      case "image": {
        const text = readImageText(block);
        if (text) {
          return text;
        }
        return "Shared an image";
      }
      case "video": {
        const text = readVideoText(block);
        if (text) {
          return text;
        }
        return "Shared a video";
      }
      case "file": {
        return "Shared a file";
      }
      case "context": {
        const text = readContextText(block);
        if (text) {
          return text;
        }
        break;
      }
      default:
        break;
    }
  }

  return "Shared a Block Kit message";
}
