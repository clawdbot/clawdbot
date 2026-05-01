import { formatErrorMessage as sharedFormatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeShip } from "../targets.js";

export interface ParsedCite {
  type: "chan" | "group" | "desk" | "bait";
  nest?: string;
  author?: string;
  postId?: string;
  group?: string;
  flag?: string;
  where?: string;
}

// Extract all cites from message content
export function extractCites(content: unknown): ParsedCite[] {
  if (!content || !Array.isArray(content)) {
    return [];
  }

  const cites: ParsedCite[] = [];

  for (const verse of content) {
    if (verse?.block?.cite && typeof verse.block.cite === "object") {
      const cite = verse.block.cite;

      if (cite.chan && typeof cite.chan === "object") {
        const { nest, where } = cite.chan;
        const whereMatch = where?.match(/\/msg\/(~[a-z-]+)\/(.+)/);
        cites.push({
          type: "chan",
          nest,
          where,
          author: whereMatch?.[1],
          postId: whereMatch?.[2],
        });
      } else if (cite.group && typeof cite.group === "string") {
        cites.push({ type: "group", group: cite.group });
      } else if (cite.desk && typeof cite.desk === "object") {
        cites.push({ type: "desk", flag: cite.desk.flag, where: cite.desk.where });
      } else if (cite.bait && typeof cite.bait === "object") {
        cites.push({
          type: "bait",
          group: cite.bait.group,
          nest: cite.bait.graph,
          where: cite.bait.where,
        });
      }
    }
  }

  return cites;
}

export function formatModelName(modelString?: string | null): string {
  if (!modelString) {
    return "AI";
  }
  const modelName = modelString.includes("/") ? modelString.split("/")[1] : modelString;
  const modelMappings: Record<string, string> = {
    "claude-opus-4-5": "Claude Opus 4.5",
    "claude-sonnet-4-5": "Claude Sonnet 4.5",
    "claude-sonnet-3-5": "Claude Sonnet 3.5",
    "gpt-4o": "GPT-4o",
    "gpt-4-turbo": "GPT-4 Turbo",
    "gpt-4": "GPT-4",
    "gemini-2.0-flash": "Gemini 2.0 Flash",
    "gemini-pro": "Gemini Pro",
  };

  if (modelMappings[modelName]) {
    return modelMappings[modelName];
  }
  return modelName
    .replace(/-/g, " ")
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function isBotMentioned(
  messageText: string,
  botShipName: string,
  nickname?: string,
): boolean {
  if (!messageText || !botShipName) {
    return false;
  }

  // Check for @all mention
  if (/@all\b/i.test(messageText)) {
    return true;
  }

  // Check for ship mention
  const normalizedBotShip = normalizeShip(botShipName);
  const escapedShip = normalizedBotShip.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const mentionPattern = new RegExp(`(^|\\s)${escapedShip}(?=\\s|$)`, "i");
  if (mentionPattern.test(messageText)) {
    return true;
  }

  // Check for nickname mention (case-insensitive, word boundary)
  if (nickname) {
    const escapedNickname = nickname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const nicknamePattern = new RegExp(`(^|\\s)${escapedNickname}(?=\\s|$|[,!?.])`, "i");
    if (nicknamePattern.test(messageText)) {
      return true;
    }
  }

  return false;
}

/**
 * Strip bot ship mention from message text for command detection.
 * "~bot-ship /status" → "/status"
 */
export function stripBotMention(messageText: string, botShipName: string): string {
  if (!messageText || !botShipName) {
    return messageText;
  }
  return messageText.replace(normalizeShip(botShipName), "").trim();
}

export function isDmAllowed(senderShip: string, allowlist: string[] | undefined): boolean {
  if (!allowlist || allowlist.length === 0) {
    return false;
  }
  const normalizedSender = normalizeShip(senderShip);
  return allowlist.map((ship) => normalizeShip(ship)).some((ship) => ship === normalizedSender);
}

/**
 * Check if a group invite from a ship should be auto-accepted.
 *
 * SECURITY: Fail-safe to deny. If allowlist is empty or undefined,
 * ALL invites are rejected - even if autoAcceptGroupInvites is enabled.
 * This prevents misconfigured bots from accepting malicious invites.
 */
export function isGroupInviteAllowed(
  inviterShip: string,
  allowlist: string[] | undefined,
): boolean {
  // SECURITY: Fail-safe to deny when no allowlist configured
  if (!allowlist || allowlist.length === 0) {
    return false;
  }
  const normalizedInviter = normalizeShip(inviterShip);
  return allowlist.map((ship) => normalizeShip(ship)).some((ship) => ship === normalizedInviter);
}

/**
 * Resolve quoted/cited content only after the caller has passed authorization.
 * Unauthorized paths must keep raw text and must not trigger cross-channel cite fetches.
 */
export async function resolveAuthorizedMessageText(params: {
  rawText: string;
  content: unknown;
  authorizedForCites: boolean;
  resolveAllCites: (content: unknown) => Promise<string>;
}): Promise<string> {
  const { rawText, content, authorizedForCites, resolveAllCites } = params;
  if (!authorizedForCites) {
    return rawText;
  }
  const citedContent = await resolveAllCites(content);
  return citedContent + rawText;
}

export const asRecord = asNullableObjectRecord;
export const formatErrorMessage = sharedFormatErrorMessage;
export const readString = readStringField;

function asNullableObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readStringField(
  record: Record<string, unknown> | null | undefined,
  field: string,
): string | undefined {
  const value = record?.[field];
  return typeof value === "string" ? value : undefined;
}

// Helper to recursively extract text from inline content
function renderInlineItem(
  item: unknown,
  options?: {
    linkMode?: "content-or-href" | "href";
    allowBreak?: boolean;
    allowBlockquote?: boolean;
  },
): string {
  if (typeof item === "string") {
    return item;
  }
  const record = asRecord(item);
  if (!record) {
    return "";
  }
  const ship = readString(record, "ship");
  if (ship) {
    return ship;
  }
  if ("sect" in record) {
    const sect = record.sect;
    if (typeof sect === "string") {
      return `@${sect || "all"}`;
    }
    if (sect === null) {
      return "@all";
    }
  }
  if (options?.allowBreak && "break" in record) {
    return "\n";
  }
  const inlineCode = readString(record, "inline-code");
  if (inlineCode) {
    return `\`${inlineCode}\``;
  }
  const code = readString(record, "code");
  if (code) {
    return `\`${code}\``;
  }
  const link = asRecord(record.link);
  const linkHref = link ? readString(link, "href") : undefined;
  if (link && linkHref) {
    const linkContent = readString(link, "content");
    return options?.linkMode === "href" ? linkHref : linkContent || linkHref;
  }
  if (Array.isArray(record.bold)) {
    return `**${extractInlineText(record.bold)}**`;
  }
  if (Array.isArray(record.italics)) {
    return `*${extractInlineText(record.italics)}*`;
  }
  if (Array.isArray(record.strike)) {
    return `~~${extractInlineText(record.strike)}~~`;
  }
  if (options?.allowBlockquote && Array.isArray(record.blockquote)) {
    return `> ${extractInlineText(record.blockquote)}`;
  }
  return "";
}

function extractInlineText(items: readonly unknown[]): string {
  return items.map((item) => renderInlineItem(item)).join("");
}

export function extractMessageText(content: unknown): string {
  if (!content || !Array.isArray(content)) {
    return "";
  }

  return content
    .map((verse) => {
      const verseRecord = asRecord(verse);
      if (!verseRecord) {
        return "";
      }

      // Handle inline content (text, ships, links, etc.)
      if (Array.isArray(verseRecord.inline)) {
        return verseRecord.inline
          .map((item) =>
            renderInlineItem(item, {
              linkMode: "href",
              allowBreak: true,
              allowBlockquote: true,
            }),
          )
          .join("");
      }

      // Handle block content (images, code blocks, etc.)
      const block = asRecord(verseRecord.block);
      if (block) {
        const image = asRecord(block.image);

        // Image blocks
        if (image) {
          const imageSrc = readString(image, "src");
          if (imageSrc) {
            const altText = readString(image, "alt");
            const alt = altText ? ` (${altText})` : "";
            return `\n${imageSrc}${alt}\n`;
          }
        }

        // Code blocks
        const codeBlock = asRecord(block.code);
        if (codeBlock) {
          const lang = readString(codeBlock, "lang") ?? "";
          const code = readString(codeBlock, "code") ?? "";
          return `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
        }

        // Header blocks
        const header = asRecord(block.header);
        if (header) {
          const headerContent = Array.isArray(header.content) ? header.content : [];
          const text =
            headerContent.map((item) => (typeof item === "string" ? item : "")).join("") || "";
          return `\n## ${text}\n`;
        }

        // Cite/quote blocks - parse the reference structure
        const cite = asRecord(block.cite);
        if (cite) {
          const chanCite = asRecord(cite.chan);

          // ChanCite - reference to a channel message
          if (chanCite) {
            const nest = readString(chanCite, "nest");
            const where = readString(chanCite, "where");
            // where is typically /msg/~author/timestamp
            const whereMatch = where?.match(/\/msg\/(~[a-z-]+)\/(.+)/);
            if (whereMatch) {
              const [, author, _postId] = whereMatch;
              return `\n> [quoted: ${author} in ${nest}]\n`;
            }
            return `\n> [quoted from ${nest}]\n`;
          }

          // GroupCite - reference to a group
          const group = readString(cite, "group");
          if (group) {
            return `\n> [ref: group ${group}]\n`;
          }

          // DeskCite - reference to an app/desk
          const desk = asRecord(cite.desk);
          if (desk) {
            const flag = readString(desk, "flag");
            if (flag) {
              return `\n> [ref: ${flag}]\n`;
            }
          }

          // BaitCite - reference with group+graph context
          const bait = asRecord(cite.bait);
          if (bait) {
            const graph = readString(bait, "graph");
            const groupName = readString(bait, "group");
            if (graph && groupName) {
              return `\n> [ref: ${graph} in ${groupName}]\n`;
            }
          }

          return `\n> [quoted message]\n`;
        }
      }

      return "";
    })
    .join("\n")
    .trim();
}

export function isSummarizationRequest(messageText: string): boolean {
  const patterns = [
    /summarize\s+(this\s+)?(channel|chat|conversation)/i,
    /what\s+did\s+i\s+miss/i,
    /catch\s+me\s+up/i,
    /channel\s+summary/i,
    /tldr/i,
  ];
  return patterns.some((pattern) => pattern.test(messageText));
}
