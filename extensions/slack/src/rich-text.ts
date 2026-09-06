import {
  asOptionalRecord,
  normalizeOptionalString,
  readNonBlankString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { escapeSlackMrkdwn } from "./monitor/mrkdwn.js";

const RICH_TEXT_CONTAINER_TYPES = new Set<unknown>([
  "rich_text_section",
  "rich_text_preformatted",
  "rich_text_quote",
  "rich_text_list",
]);

export function renderSlackRichText(
  value: unknown,
  mode: "table" | "escaped" | "native-reference",
  separator = "",
): string {
  if (!Array.isArray(value)) {
    return "";
  }
  const table = mode === "table";
  const read = table ? readNonBlankString : normalizeOptionalString;
  const literal = table ? (text: string) => text : escapeSlackMrkdwn;
  const reference = mode === "escaped" ? escapeSlackMrkdwn : (text: string) => text;
  const formatReference = (raw: unknown, prefix: string, suffix: string) => {
    const text = read(raw);
    return text ? reference(`${prefix}${text}${suffix}`) : "";
  };

  return value
    .map((rawElement) => {
      const element = asOptionalRecord(rawElement);
      if (!element) {
        return "";
      }

      // Legacy tables traverse any element container; message fallback accepts only
      // Slack's named containers. Keep that historical trust boundary mode-owned.
      if (
        Array.isArray(element.elements) &&
        (table || RICH_TEXT_CONTAINER_TYPES.has(element.type))
      ) {
        return renderSlackRichText(
          element.elements,
          mode,
          element.type === "rich_text_list" ? "\n" : "",
        );
      }

      // Table cells preserve authored whitespace and display text on unknown leaf shapes.
      if (table) {
        if (element.type === "text" && typeof element.text === "string") {
          return element.text;
        }
        const text = readNonBlankString(element.text);
        if (text) {
          return text;
        }
      }

      switch (element.type) {
        case "text":
          return typeof element.text === "string" ? literal(element.text) : "";
        case "link":
          return literal(read(element.text) ?? read(element.url) ?? "");
        case "user":
          return formatReference(element.user_id, "<@", ">");
        case "channel":
          return formatReference(element.channel_id, "<#", ">");
        case "usergroup":
          return formatReference(element.usergroup_id, "<!subteam^", ">");
        case "broadcast":
          return formatReference(element.range, "<!", ">");
        case "emoji": {
          const name = read(element.name);
          return name ? `:${name}:` : "";
        }
        case "date":
          return literal(read(element.fallback) ?? "");
        default:
          return "";
      }
    })
    .filter(Boolean)
    .join(separator);
}
