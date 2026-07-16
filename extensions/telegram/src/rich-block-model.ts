// Bot API 10.2 rich block/RichText model: types, size accounting, and the
// plain-text projection shared by the emitter, splitter, and fallback paths.
export type TelegramRichBlocksDegradationReason = "table-ascii";

export type RichText =
  | string
  | RichText[]
  | {
      type:
        | "bold"
        | "italic"
        | "underline"
        | "strikethrough"
        | "code"
        | "spoiler"
        | "marked"
        | "subscript"
        | "superscript";
      text: RichText;
    }
  | {
      type: "url";
      text: RichText;
      url: string;
    }
  | {
      type: "anchor_link";
      text: RichText;
      anchor_name: string;
    }
  | {
      type: "mathematical_expression";
      expression: string;
    }
  | {
      type: "custom_emoji";
      custom_emoji_id: string;
      alternative_text: string;
    };

type RichBlockTableCellAlign = "left" | "center" | "right";

export type RichBlockTableCell = {
  text?: RichText;
  is_header?: true;
  colspan?: number;
  rowspan?: number;
  align?: RichBlockTableCellAlign;
  valign?: "top" | "middle" | "bottom";
};

export type InputRichBlockParagraph = {
  type: "paragraph";
  text: RichText;
};

type InputRichBlockHeading = {
  type: "heading";
  text: RichText;
  size: 1 | 2 | 3 | 4 | 5 | 6;
};

type InputRichBlockPre = {
  type: "pre";
  text: string;
  language?: string;
};

type InputRichBlockBlockquote = {
  type: "blockquote";
  blocks: InputRichBlock[];
  credit?: RichText;
};

type InputRichBlockTable = {
  type: "table";
  cells: RichBlockTableCell[][];
  is_bordered?: true;
  is_striped?: true;
  caption?: RichText;
};

export type RichBlockCaption = {
  text: RichText;
  credit?: RichText;
};

export type InputRichBlockListItem = {
  blocks: InputRichBlock[];
  has_checkbox?: true;
  is_checked?: true;
  value?: number;
  type?: "a" | "A" | "i" | "I" | "1";
};

type InputMediaUrl<K extends string> = { type: K; media: string };

export type InputRichBlock =
  | InputRichBlockParagraph
  | InputRichBlockHeading
  | InputRichBlockPre
  | InputRichBlockBlockquote
  | InputRichBlockTable
  | { type: "divider" }
  | { type: "anchor"; name: string }
  | { type: "footer"; text: RichText }
  | { type: "pullquote"; text: RichText; credit?: RichText }
  | { type: "mathematical_expression"; expression: string }
  | { type: "details"; summary: RichText; blocks: InputRichBlock[]; is_open?: true }
  | { type: "list"; items: InputRichBlockListItem[] }
  | { type: "photo"; photo: InputMediaUrl<"photo">; caption?: RichBlockCaption }
  | { type: "video"; video: InputMediaUrl<"video">; caption?: RichBlockCaption }
  | { type: "audio"; audio: InputMediaUrl<"audio">; caption?: RichBlockCaption }
  | { type: "animation"; animation: InputMediaUrl<"animation">; caption?: RichBlockCaption }
  | { type: "voice_note"; voice_note: InputMediaUrl<"voice_note">; caption?: RichBlockCaption }
  | { type: "collage"; blocks: InputRichBlock[]; caption?: RichBlockCaption }
  | { type: "slideshow"; blocks: InputRichBlock[]; caption?: RichBlockCaption }
  | {
      type: "map";
      location: { latitude: number; longitude: number };
      zoom: number;
      width: number;
      height: number;
      caption?: RichBlockCaption;
    };

export function normalizeRichText(value: RichText): RichText {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const flattened: RichText[] = [];
    for (const item of value) {
      const normalized = normalizeRichText(item);
      if (normalized === "") {
        continue;
      }
      if (Array.isArray(normalized)) {
        flattened.push(...normalized);
      } else {
        flattened.push(normalized);
      }
    }
    if (flattened.length === 0) {
      return "";
    }
    if (flattened.length === 1) {
      return flattened[0] ?? "";
    }
    return flattened;
  }
  if (value.type === "mathematical_expression" || value.type === "custom_emoji") {
    return value;
  }
  return { ...value, text: normalizeRichText(value.text) };
}

export function countRichTextChars(text: RichText): number {
  if (typeof text === "string") {
    return text.length;
  }
  if (Array.isArray(text)) {
    return text.reduce((total, part) => total + countRichTextChars(part), 0);
  }
  if (text.type === "mathematical_expression") {
    return text.expression.length;
  }
  if (text.type === "custom_emoji") {
    return text.alternative_text.length;
  }
  return countRichTextChars(text.text);
}

function countCaptionChars(caption: RichBlockCaption | undefined): number {
  if (!caption) {
    return 0;
  }
  return countRichTextChars(caption.text) + countRichTextChars(caption.credit ?? "");
}

export function countInputRichBlockChars(block: InputRichBlock): number {
  switch (block.type) {
    case "paragraph":
    case "heading":
    case "footer":
      return countRichTextChars(block.text);
    case "pre":
      return block.text.length;
    case "mathematical_expression":
      return block.expression.length;
    case "pullquote":
      return countRichTextChars(block.text) + countRichTextChars(block.credit ?? "");
    case "blockquote":
      return (
        block.blocks.reduce((total, item) => total + countInputRichBlockChars(item), 0) +
        countRichTextChars(block.credit ?? "")
      );
    case "collage":
    case "slideshow":
      return (
        block.blocks.reduce((total, item) => total + countInputRichBlockChars(item), 0) +
        countCaptionChars(block.caption)
      );
    case "details":
      return (
        countRichTextChars(block.summary) +
        block.blocks.reduce((total, item) => total + countInputRichBlockChars(item), 0)
      );
    case "list":
      return block.items.reduce(
        (total, item) =>
          total + item.blocks.reduce((inner, child) => inner + countInputRichBlockChars(child), 0),
        0,
      );
    case "table":
      return (
        countRichTextChars(block.caption ?? "") +
        block.cells.reduce(
          (rowTotal, row) =>
            rowTotal +
            row.reduce((cellTotal, cell) => cellTotal + countRichTextChars(cell.text ?? ""), 0),
          0,
        )
      );
    case "photo":
    case "video":
    case "audio":
    case "animation":
    case "voice_note":
    case "map":
      return countCaptionChars(block.caption);
    // divider and anchor carry no text.
    default:
      return 0;
  }
}

/** Media elements per block, for the wire's 50-media message cap. */
export function countInputRichBlockMedia(block: InputRichBlock): number {
  switch (block.type) {
    // Maps are excluded: 51 maps in one message were accepted live, so they
    // do not consume the 50-attachment budget.
    case "photo":
    case "video":
    case "audio":
    case "animation":
    case "voice_note":
      return 1;
    case "collage":
    case "slideshow":
    case "blockquote":
    case "details":
      return block.blocks.reduce((total, item) => total + countInputRichBlockMedia(item), 0);
    case "list":
      return block.items.reduce(
        (total, item) =>
          total + item.blocks.reduce((inner, child) => inner + countInputRichBlockMedia(child), 0),
        0,
      );
    default:
      return 0;
  }
}

export function richTextToPlainString(text: RichText): string {
  if (typeof text === "string") {
    return text;
  }
  if (Array.isArray(text)) {
    return text.map(richTextToPlainString).join("");
  }
  if (text.type === "mathematical_expression") {
    return text.expression;
  }
  if (text.type === "custom_emoji") {
    return text.alternative_text;
  }
  return richTextToPlainString(text.text);
}

function captionToPlainText(caption: RichBlockCaption | undefined): string {
  if (!caption) {
    return "";
  }
  const credit = caption.credit ? ` — ${richTextToPlainString(caption.credit)}` : "";
  return `${richTextToPlainString(caption.text)}${credit}`.trim();
}

export function inputRichBlocksToPlainText(blocks: readonly InputRichBlock[]): string {
  const parts: string[] = [];
  const push = (value: string) => {
    if (value) {
      parts.push(value);
    }
  };
  for (const block of blocks) {
    switch (block.type) {
      case "paragraph":
      case "heading":
      case "footer":
        push(richTextToPlainString(block.text));
        break;
      case "pre":
        push(block.text);
        break;
      case "mathematical_expression":
        push(block.expression);
        break;
      case "pullquote":
        push(
          block.credit
            ? `${richTextToPlainString(block.text)} — ${richTextToPlainString(block.credit)}`
            : richTextToPlainString(block.text),
        );
        break;
      case "blockquote":
        push(inputRichBlocksToPlainText(block.blocks));
        if (block.credit) {
          push(`— ${richTextToPlainString(block.credit)}`);
        }
        break;
      case "collage":
      case "slideshow":
        push(inputRichBlocksToPlainText(block.blocks));
        push(captionToPlainText(block.caption));
        break;
      case "details":
        push(richTextToPlainString(block.summary));
        push(inputRichBlocksToPlainText(block.blocks));
        break;
      case "list":
        for (const item of block.items) {
          const marker = item.has_checkbox
            ? item.is_checked
              ? "[x] "
              : "[ ] "
            : item.value !== undefined
              ? `${item.value}. `
              : "• ";
          push(`${marker}${inputRichBlocksToPlainText(item.blocks)}`);
        }
        break;
      case "table":
        if (block.caption !== undefined) {
          push(richTextToPlainString(block.caption));
        }
        for (const row of block.cells) {
          push(row.map((cell) => richTextToPlainString(cell.text ?? "")).join(" | "));
        }
        break;
      // Fallback text keeps BOTH caption and source so a degraded delivery
      // still lets the user reach the media.
      case "photo":
        push(`${captionToPlainText(block.caption)} ${block.photo.media}`.trim());
        break;
      case "video":
        push(`${captionToPlainText(block.caption)} ${block.video.media}`.trim());
        break;
      case "audio":
        push(`${captionToPlainText(block.caption)} ${block.audio.media}`.trim());
        break;
      case "animation":
        push(`${captionToPlainText(block.caption)} ${block.animation.media}`.trim());
        break;
      case "voice_note":
        push(`${captionToPlainText(block.caption)} ${block.voice_note.media}`.trim());
        break;
      case "map":
        push(
          `${captionToPlainText(block.caption)} ${block.location.latitude},${block.location.longitude}`.trim(),
        );
        break;
      case "divider":
      case "anchor":
        break;
    }
  }
  return parts.join("\n");
}

export function boldRichText(text: string): RichText {
  return { type: "bold", text };
}

export function codeRichText(text: string): RichText {
  return { type: "code", text };
}

export function italicRichText(text: string): RichText {
  return { type: "italic", text };
}

export function paragraphBlock(text: RichText): InputRichBlockParagraph {
  return { type: "paragraph", text };
}
