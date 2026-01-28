import type { MoltbotPluginApi, LineChannelData, ReplyPayload } from "clawdbot/plugin-sdk";
import {
  createActionCard,
  createImageCard,
  createInfoCard,
  createListCard,
  createReceiptCard,
  type CardAction,
  type ListItem,
} from "clawdbot/plugin-sdk";

const CARD_USAGE = `Usage: /card <type> "title" "body" [options]

Types:
  info "Title" "Body" ["Footer"]
  image "Title" "Caption" --url <image-url>
  action "Title" "Body" --actions "Btn1|url1,Btn2|text2"
  list "Title" "Item1|Desc1,Item2|Desc2"
  receipt "Title" "Item1:$10,Item2:$20" --total "$30"
  confirm "Question?" --yes "Yes|data" --no "No|data"
  buttons "Title" "Text" --actions "Btn1|url1,Btn2|data2"

Examples:
  /card info "Welcome" "Thanks for joining!"
  /card image "Product" "Check it out" --url https://example.com/img.jpg
  /card action "Menu" "Choose an option" --actions "Order|/order,Help|/help"`;

function buildLineReply(lineData: LineChannelData): ReplyPayload {
  return {
    channelData: {
      line: lineData,
    },
  };
}

/**
 * Parse action string format: "Label|data,Label2|data2"
 * Data can be a URL (uri action) or plain text (message action) or key=value (postback)
 */
function parseActions(actionsStr: string | undefined): CardAction[] {
  if (!actionsStr) return [];

  const results: CardAction[] = [];

  for (const part of actionsStr.split(",")) {
    const [label, data] = part
      .trim()
      .split("|")
      .map((s) => s.trim());
    if (!label) continue;

    const actionData = data || label;

    if (actionData.startsWith("http://") || actionData.startsWith("https://")) {
      results.push({
        label,
        action: { type: "uri", label: label.slice(0, 20), uri: actionData },
      });
    } else if (actionData.includes("=")) {
      results.push({
        label,
        action: {
          type: "postback",
          label: label.slice(0, 20),
          data: actionData.slice(0, 300),
          displayText: label,
        },
      });
    } else {
      results.push({
        label,
        action: { type: "message", label: label.slice(0, 20), text: actionData },
      });
    }
  }

  return results;
}

/**
 * Parse list items format: "Item1|Subtitle1,Item2|Subtitle2"
 */
function parseListItems(itemsStr: string): ListItem[] {
  return itemsStr
    .split(",")
    .map((part) => {
      const [title, subtitle] = part
        .trim()
        .split("|")
        .map((s) => s.trim());
      return { title: title || "", subtitle };
    })
    .filter((item) => item.title);
}

/**
 * Parse receipt items format: "Item1:$10,Item2:$20"
 */
function parseReceiptItems(itemsStr: string): Array<{ name: string; value: string }> {
  return itemsStr
    .split(",")
    .map((part) => {
      const colonIndex = part.lastIndexOf(":");
      if (colonIndex === -1) {
        return { name: part.trim(), value: "" };
      }
      return {
        name: part.slice(0, colonIndex).trim(),
        value: part.slice(colonIndex + 1).trim(),
      };
    })
    .filter((item) => item.name);
}

/**
 * Parse quoted arguments from command string
 * Supports: /card type "arg1" "arg2" "arg3" --flag value
 */
function parseCardArgs(argsStr: string): {
  type: string;
  args: string[];
  flags: Record<string, string>;
} {
  const result: { type: string; args: string[]; flags: Record<string, string> } = {
    type: "",
    args: [],
    flags: {},
  };

  // Extract type (first word)
  const typeMatch = argsStr.match(/^(\w+)/);
  if (typeMatch) {
    result.type = typeMatch[1].toLowerCase();
    argsStr = argsStr.slice(typeMatch[0].length).trim();
  }

  // Extract quoted arguments
  const quotedRegex = /"([^"]*?)"/g;
  let match;
  while ((match = quotedRegex.exec(argsStr)) !== null) {
    result.args.push(match[1]);
  }

  // Extract flags (--key value or --key "value")
  const flagRegex = /--(\w+)\s+(?:"([^"]*?)"|(\S+))/g;
  while ((match = flagRegex.exec(argsStr)) !== null) {
    result.flags[match[1]] = match[2] ?? match[3];
  }

  return result;
}

export function registerLineCardCommand(api: MoltbotPluginApi): void {
  api.registerCommand({
    name: "card",
    description: "Send a rich card message (LINE).",
    acceptsArgs: true,
    requireAuth: false,
    handler: async (ctx) => {
      const argsStr = ctx.args?.trim() ?? "";
      if (!argsStr) return { text: CARD_USAGE };

      const parsed = parseCardArgs(argsStr);
      const { type, args, flags } = parsed;

      if (!type) return { text: CARD_USAGE };

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
            return buildLineReply({
              flexMessage: {
                altText: `${title}: ${body}`.slice(0, 400),
                contents: bubble,
              },
            });
          }

          case "image": {
            const [title = "Image", caption = ""] = args;
            const imageUrl = flags.url || flags.image;
            if (!imageUrl) {
              return { text: "Error: Image card requires --url <image-url>" };
            }
            const bubble = createImageCard(imageUrl, title, caption);
            return buildLineReply({
              flexMessage: {
                altText: `${title}: ${caption}`.slice(0, 400),
                contents: bubble,
              },
            });
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
            return buildLineReply({
              flexMessage: {
                altText: `${title}: ${body}`.slice(0, 400),
                contents: bubble,
              },
            });
          }

          case "list": {
            const [title = "List", itemsStr = ""] = args;
            const items = parseListItems(itemsStr || flags.items || "");
            if (items.length === 0) {
              return {
                text:
                  'Error: List card requires items. Usage: /card list "Title" "Item1|Desc1,Item2|Desc2"',
              };
            }
            const bubble = createListCard(title, items);
            return buildLineReply({
              flexMessage: {
                altText: `${title}: ${items.map((i) => i.title).join(", ")}`.slice(0, 400),
                contents: bubble,
              },
            });
          }

          case "receipt": {
            const [title = "Receipt", itemsStr = ""] = args;
            const items = parseReceiptItems(itemsStr || flags.items || "");
            const total = flags.total ? { label: "Total", value: flags.total } : undefined;
            const footer = flags.footer;

            if (items.length === 0) {
              return {
                text:
                  'Error: Receipt card requires items. Usage: /card receipt "Title" "Item1:$10,Item2:$20" --total "$30"',
              };
            }

            const bubble = createReceiptCard({ title, items, total, footer });
            return buildLineReply({
              flexMessage: {
                altText: `${title}: ${items.map((i) => `${i.name} ${i.value}`).join(", ")}`.slice(
                  0,
                  400,
                ),
                contents: bubble,
              },
            });
          }

          case "confirm": {
            const [question = "Confirm?"] = args;
            const yesStr = flags.yes || "Yes|yes";
            const noStr = flags.no || "No|no";

            const [yesLabel, yesData] = yesStr.split("|").map((s) => s.trim());
            const [noLabel, noData] = noStr.split("|").map((s) => s.trim());

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
