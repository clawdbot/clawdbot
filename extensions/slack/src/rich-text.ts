import {
  asNonArrayRecord,
  asOptionalRecord,
  normalizeOptionalString,
  readNonBlankString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  renderMarkdownWithMarkers,
  type MarkdownIR,
  type MarkdownStyle,
} from "openclaw/plugin-sdk/text-chunking";
import {
  escapeSlackMrkdwnSegment,
  isSlackEmphasisStyleSafe,
  SLACK_RENDER_OPTIONS,
} from "./format.js";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";

const styledRenderOptions = { ...SLACK_RENDER_OPTIONS, escapeText: (text: string) => text };

type RichTextOptions = { format: "plain" | "escaped" | "styled"; preserveReferences?: boolean };
const styles: Record<string, MarkdownStyle> = {
  bold: "bold",
  italic: "italic",
  strike: "strikethrough",
  code: "code",
};

const references: Record<string, readonly [string, string]> = {
  user: ["user_id", "@"],
  channel: ["channel_id", "#"],
  usergroup: ["usergroup_id", "!subteam^"],
  broadcast: ["range", "!"],
};

function projectRichText(
  value: unknown,
  options: RichTextOptions,
  preformatted = false,
): MarkdownIR | undefined {
  const element = asNonArrayRecord(value);
  const type = String(element.type);
  const section = type === "rich_text_section" || type === "rich_text_preformatted";
  const styled = options.format === "styled";
  const read = options.format === "plain" ? readNonBlankString : normalizeOptionalString;
  const result: MarkdownIR = { text: "", styles: [], links: [] };
  const style = styled && !preformatted ? asOptionalRecord(element.style) : undefined;
  const styleNames = Object.keys(style ?? {}).filter((name) => style?.[name] === true);
  const supportedStyles = Object.entries(styles).filter(([name]) => styleNames.includes(name));
  const code = styled && (preformatted || styleNames.includes("code"));
  // Native layout, generated dates and unrepresentable styles remain barriers, not flattened facts.
  // Code references and emoji metadata carry rendering facts that literal tokens cannot preserve.
  if (
    styled &&
    ((!section && !["text", "link", "emoji"].includes(type) && !references[type]) ||
      (code && type !== "text") ||
      (type === "emoji" && (element.unicode || element.url)) ||
      supportedStyles.length !== styleNames.length ||
      (styleNames.includes("code") && styleNames.length > 1) ||
      (!preformatted && code && typeof element.text === "string" && element.text.includes("`")))
  ) {
    return undefined;
  }
  if (
    Array.isArray(element.elements) &&
    (options.format === "plain" ||
      section ||
      type === "rich_text_list" ||
      type === "rich_text_quote")
  ) {
    for (const child of element.elements) {
      const part = projectRichText(
        child,
        options,
        preformatted || type === "rich_text_preformatted",
      );
      if (!part) {
        return undefined;
      }
      if (!part.text) {
        continue;
      }
      if (result.text && type === "rich_text_list") {
        result.text += "\n";
      }
      const offset = result.text.length;
      result.text += part.text;
      for (const span of part.styles) {
        const previous = result.styles.findLast((candidate) => candidate.style === span.style);
        if (previous?.end === offset + span.start) {
          previous.end = offset + span.end;
        } else {
          result.styles.push({ ...span, start: span.start + offset, end: span.end + offset });
        }
      }
    }
    if (styled && type === "rich_text_preformatted") {
      if (result.text.includes("```")) {
        return undefined;
      }
      result.styles = [{ start: 0, end: result.text.length, style: "code_block" }];
    }
    return result;
  }

  const literal =
    options.format === "plain"
      ? (text: string) => text
      : code
        ? escapeSlackMrkdwnSegment
        : escapeSlackMrkdwn;
  const label = styled && typeof element.text === "string" ? element.text : read(element.text);
  if (type === "text" && typeof element.text === "string") {
    result.text = literal(element.text);
  } else if (options.format === "plain" && label) {
    result.text = label;
  } else if (type === "link") {
    const url = read(element.url);
    result.text =
      styled && !preformatted && url
        ? `<${escapeSlackMrkdwnSegment(url)}${label && label !== url ? `|${escapeSlackMrkdwnSegment(label)}` : ""}>`
        : literal(label ?? url ?? "");
  } else if (type === "emoji") {
    const name = read(element.name);
    result.text = name ? `:${name}:` : "";
  } else if (type === "date") {
    result.text = literal(read(element.fallback) ?? "");
  } else {
    const [field, prefix] = references[type] ?? [];
    const id = field ? read(element[field]) : undefined;
    const token = id ? `<${prefix}${id}>` : "";
    result.text = styled || options.preserveReferences ? token : literal(token);
  }
  result.styles = supportedStyles.map(([, kind]) => ({
    start: 0,
    end: result.text.length,
    style: kind,
  }));
  return result;
}

/** One native traversal supplies table text, escaped accessibility, and styled comparison views. */
export function renderSlackRichTextFragments(
  value: unknown,
  options: RichTextOptions,
): (string | null)[] {
  return (Array.isArray(value) ? value : []).flatMap((element) => {
    const ir = projectRichText(element, options);
    // Native styles must satisfy Slack's flanks and the marker renderer's nested-span contract.
    if (
      !ir ||
      ir.styles.some((span) => !isSlackEmphasisStyleSafe(ir.text, span)) ||
      ir.styles.some((a) =>
        ir.styles.some((b) => a.start < b.start && b.start < a.end && a.end < b.end),
      )
    ) {
      return [null];
    }
    const rendered =
      options.format === "styled" ? renderMarkdownWithMarkers(ir, styledRenderOptions) : ir.text;
    return rendered ? [rendered] : [];
  });
}
