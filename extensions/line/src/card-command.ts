import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
// Line plugin module implements card command behavior.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  createActionCard,
  createImageCard,
  createInfoCard,
  createListCard,
} from "./flex-templates/basic-cards.js";
import { createReceiptCard } from "./flex-templates/schedule-cards.js";
import type { CardAction, ListItem } from "./flex-templates/types.js";
import { createFlexMessage } from "./send.js";
import type { LineChannelData } from "./types.js";

const CARD_USAGE = `Usage: /card <type> "title" "body" [options]

Types:
  info "Title" "Body" ["Footer"]
  image "Title" "Caption" --url <image-url>
  action "Title" "Body" --actions "Btn1|url1,Btn2|text2"
  list "Title" "Item1|Desc1,Item2|Desc2"
  receipt "Title" "Item1:$10,Item2:$20" --total "$30"
  confirm "Question?" --yes "Yes|data" --no "No|data"
  buttons "Title" "Text" --actions "Btn1|url1,Btn2|data2"

Escape a separator that the option splits on with a backslash, as in \\, or \\|

Examples:
  /card info "Welcome" "Thanks for joining!"
  /card image "Product" "Check it out" --url https://example.com/img.jpg
  /card action "Menu" "Choose an option" --actions "Order|/order,Help|/help"
  /card action "Links" "Pick one" --actions "Open|https://example.com/a\\,b"`;

function buildLineReply(lineData: LineChannelData): ReplyPayload {
  return {
    channelData: {
      line: lineData,
    },
  };
}

function buildLineFlexReply(
  altText: string,
  contents: Parameters<typeof createFlexMessage>[1],
): ReplyPayload {
  const message = createFlexMessage(altText, contents);
  return buildLineReply({
    flexMessage: { altText: message.altText, contents: message.contents },
  });
}

/** Separators of each card option grammar; a backslash protects only these. */
const CARD_PAIR_LIST_SEPARATORS: ReadonlySet<string> = new Set([",", "|"]);
const CARD_RECEIPT_SEPARATORS: ReadonlySet<string> = new Set([",", ":"]);
const CARD_PAIR_SEPARATORS: ReadonlySet<string> = new Set(["|"]);

/**
 * Split a card option value on its unescaped separators.
 *
 * A backslash is meaningful only before a separator this option splits on.
 * Every other backslash, including one before another backslash, is literal
 * data, so `C:\temp`, `C\:\temp` and `\\server\share` all survive
 * unchanged. Escapes stay inside the returned parts so a later split on a
 * different separator still sees them; `unescapeCardValue` removes them at
 * the leaf.
 */
function splitCardValue(
  value: string,
  separator: string,
  separators: ReadonlySet<string>,
): string[] {
  const parts: string[] = [];
  let current = "";
  let pendingEscape = false;
  for (const char of value) {
    if (pendingEscape) {
      pendingEscape = false;
      if (separators.has(char)) {
        current += `\\${char}`;
        continue;
      }
      current += "\\";
    }
    if (char === "\\") {
      pendingEscape = true;
      continue;
    }
    if (char === separator) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (pendingEscape) {
    current += "\\";
  }
  parts.push(current);
  return parts;
}

/** Drop the backslashes that protected separators inside a card option value. */
function unescapeCardValue(value: string, separators: ReadonlySet<string>): string {
  let result = "";
  let pendingEscape = false;
  for (const char of value) {
    if (pendingEscape) {
      pendingEscape = false;
      result += separators.has(char) ? char : `\\${char}`;
      continue;
    }
    if (char === "\\") {
      pendingEscape = true;
      continue;
    }
    result += char;
  }
  return pendingEscape ? `${result}\\` : result;
}

/** Split a "Label|data" pair, keeping escaped separators inside either side. */
function splitCardPair(
  part: string,
  separators: ReadonlySet<string>,
): [string, string | undefined] {
  const [label = "", data] = splitCardValue(part, "|", separators).map((piece) =>
    unescapeCardValue(piece.trim(), separators),
  );
  return [label, data];
}

/**
 * Parse action string format: "Label|data,Label2|data2"
 * Data can be a URL (uri action) or plain text (message action) or key=value (postback)
 */
function parseActions(actionsStr: string | undefined): CardAction[] {
  if (!actionsStr) {
    return [];
  }

  const results: CardAction[] = [];

  for (const part of splitCardValue(actionsStr, ",", CARD_PAIR_LIST_SEPARATORS)) {
    const [label, data] = splitCardPair(part, CARD_PAIR_LIST_SEPARATORS);
    if (!label) {
      continue;
    }

    const actionData = data || label;

    const action =
      actionData.startsWith("http://") || actionData.startsWith("https://")
        ? { type: "uri" as const, label, uri: actionData }
        : actionData.includes("=")
          ? { type: "postback" as const, label, data: actionData, displayText: label }
          : { type: "message" as const, label, text: actionData };
    results.push({ label, action });
  }

  return results;
}

/**
 * Parse list items format: "Item1|Subtitle1,Item2|Subtitle2"
 */
function parseListItems(itemsStr: string): ListItem[] {
  return splitCardValue(itemsStr, ",", CARD_PAIR_LIST_SEPARATORS)
    .map((part) => {
      const [title, subtitle] = splitCardPair(part, CARD_PAIR_LIST_SEPARATORS);
      return { title, subtitle };
    })
    .filter((item) => item.title);
}

/**
 * Parse receipt items format: "Item1:$10,Item2:$20"
 */
function parseReceiptItems(itemsStr: string): Array<{ name: string; value: string }> {
  return splitCardValue(itemsStr, ",", CARD_RECEIPT_SEPARATORS)
    .map((part) => {
      // The last unescaped colon separates the entry value, so a name may still
      // contain colons of its own.
      const segments = splitCardValue(part, ":", CARD_RECEIPT_SEPARATORS);
      const value = segments.length > 1 ? segments.pop() : undefined;
      return {
        name: unescapeCardValue(segments.join(":").trim(), CARD_RECEIPT_SEPARATORS),
        value: value === undefined ? "" : unescapeCardValue(value.trim(), CARD_RECEIPT_SEPARATORS),
      };
    })
    .filter((item) => item.name);
}

/**
 * Parse quoted arguments from command string
 * Supports: /card type "arg1" "arg2" "arg3" --flag value
 */
function parseCardArgs(argsStrInput: string): {
  type: string;
  args: string[];
  flags: Record<string, string>;
} {
  let argsStr = argsStrInput;
  const result: { type: string; args: string[]; flags: Record<string, string> } = {
    type: "",
    args: [],
    flags: {},
  };

  // Extract type (first word)
  const typeMatch = argsStr.match(/^(\w+)/);
  if (typeMatch) {
    result.type = normalizeLowercaseStringOrEmpty(typeMatch[1]);
    argsStr = argsStr.slice(typeMatch[0].length).trim();
  }

  // Extract quoted arguments
  const quotedRegex = /"([^"]*?)"/g;
  let match;
  while ((match = quotedRegex.exec(argsStr)) !== null) {
    result.args.push(expectDefined(match[1], "quoted card argument capture"));
  }

  // Extract flags (--key value or --key "value")
  const flagRegex = /--(\w+)\s+(?:"([^"]*?)"|(\S+))/g;
  while ((match = flagRegex.exec(argsStr)) !== null) {
    const key = expectDefined(match[1], "card flag name capture");
    result.flags[key] = expectDefined(match[2] ?? match[3], "card flag value capture");
  }

  return result;
}

export function registerLineCardCommand(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: "card",
    description: "Send a rich card message (LINE).",
    acceptsArgs: true,
    requireAuth: false,
    handler: async (ctx) => {
      const argsStr = ctx.args?.trim() ?? "";
      if (!argsStr) {
        return { text: CARD_USAGE };
      }

      const parsed = parseCardArgs(argsStr);
      const { type, args, flags } = parsed;

      if (!type) {
        return { text: CARD_USAGE };
      }

      // Only LINE supports rich cards; fallback to text elsewhere.
      if (ctx.channel !== "line") {
        const fallbackText = args.join(" - ");
        return { text: `[${type} card] ${fallbackText}`.trim() };
      }

      try {
        switch (type) {
          case "info": {
            const [title = "Info", body = "", footer] = args;
            const bubble = createInfoCard(title, body, footer);
            return buildLineFlexReply(`${title}: ${body}`, bubble);
          }

          case "image": {
            const [title = "Image", caption = ""] = args;
            const imageUrl = flags.url || flags.image;
            if (!imageUrl) {
              return { text: "Error: Image card requires --url <image-url>" };
            }
            const bubble = createImageCard(imageUrl, title, caption);
            return buildLineFlexReply(`${title}: ${caption}`, bubble);
          }

          case "action": {
            const [title = "Actions", body = ""] = args;
            const actions = parseActions(flags.actions);
            if (actions.length === 0) {
              return { text: 'Error: Action card requires --actions "Label1|data1,Label2|data2"' };
            }
            const bubble = createActionCard(title, body, actions, {
              imageUrl: flags.url || flags.image,
            });
            return buildLineFlexReply(`${title}: ${body}`, bubble);
          }

          case "list": {
            const [title = "List", itemsStr = ""] = args;
            const items = parseListItems(itemsStr || flags.items || "");
            if (items.length === 0) {
              return {
                text: 'Error: List card requires items. Usage: /card list "Title" "Item1|Desc1,Item2|Desc2"',
              };
            }
            const bubble = createListCard(title, items);
            return buildLineFlexReply(
              `${title}: ${items.map((item) => item.title).join(", ")}`,
              bubble,
            );
          }

          case "receipt": {
            const [title = "Receipt", itemsStr = ""] = args;
            const items = parseReceiptItems(itemsStr || flags.items || "");
            const total = flags.total ? { label: "Total", value: flags.total } : undefined;
            const footer = flags.footer;

            if (items.length === 0) {
              return {
                text: 'Error: Receipt card requires items. Usage: /card receipt "Title" "Item1:$10,Item2:$20" --total "$30"',
              };
            }

            const bubble = createReceiptCard({ title, items, total, footer });
            return buildLineFlexReply(
              `${title}: ${items.map((item) => `${item.name} ${item.value}`).join(", ")}`,
              bubble,
            );
          }

          case "confirm": {
            const [question = "Confirm?"] = args;
            const yesStr = flags.yes || "Yes|yes";
            const noStr = flags.no || "No|no";

            const [yesLabel, yesData] = splitCardPair(yesStr, CARD_PAIR_SEPARATORS);
            const [noLabel, noData] = splitCardPair(noStr, CARD_PAIR_SEPARATORS);

            return buildLineReply({
              templateMessage: {
                type: "confirm",
                text: question,
                confirmLabel: yesLabel || "Yes",
                confirmData: yesData || "yes",
                cancelLabel: noLabel || "No",
                cancelData: noData || "no",
                altText: question,
              },
            });
          }

          case "buttons": {
            const [title = "Menu", text = "Choose an option"] = args;
            const actionsStr = flags.actions || "";
            const actionParts = parseActions(actionsStr);

            if (actionParts.length === 0) {
              return { text: 'Error: Buttons card requires --actions "Label1|data1,Label2|data2"' };
            }

            const templateActions: Array<{
              type: "message" | "uri" | "postback";
              label: string;
              data?: string;
              uri?: string;
            }> = actionParts.map((a) => {
              const action = a.action;
              const label = action.label ?? a.label;
              if (action.type === "uri") {
                return { type: "uri" as const, label, uri: (action as { uri: string }).uri };
              }
              if (action.type === "postback") {
                return {
                  type: "postback" as const,
                  label,
                  data: (action as { data: string }).data,
                };
              }
              return {
                type: "message" as const,
                label,
                data: (action as { text: string }).text,
              };
            });

            return buildLineReply({
              templateMessage: {
                type: "buttons",
                title,
                text,
                thumbnailImageUrl: flags.url || flags.image,
                actions: templateActions,
              },
            });
          }

          default:
            return {
              text: `Unknown card type: "${type}". Available types: info, image, action, list, receipt, confirm, buttons`,
            };
        }
      } catch (err) {
        return { text: `Error creating card: ${String(err)}` };
      }
    },
  });
}
