// Mattermost helper module supports monitor helpers behavior.
import { formatInboundFromLabel as formatInboundFromLabelShared } from "openclaw/plugin-sdk/channel-inbound";
import { resolveThreadSessionKeys as resolveThreadSessionKeysShared } from "openclaw/plugin-sdk/routing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { escapeRegExp } from "openclaw/plugin-sdk/text-utility-runtime";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";

export { rawDataToString };

export const formatInboundFromLabel = formatInboundFromLabelShared;

export function resolveThreadSessionKeys(params: {
  baseSessionKey: string;
  threadId?: string | null;
  parentSessionKey?: string;
  useSuffix?: boolean;
}): { sessionKey: string; parentSessionKey?: string } {
  return resolveThreadSessionKeysShared({
    ...params,
    normalizeThreadId: (threadId) => threadId,
  });
}

// Server mentions allow surrounding sentence punctuation, while punctuation
// followed by username characters belongs to another local or remote account.
function buildMattermostBotMentionPattern(username: string): string {
  return `(?<![a-z0-9_])@${escapeRegExp(username)}(?![a-z0-9_]|[.:-]+[a-z0-9_])`;
}

export function matchesMattermostBotMention(
  text: string,
  botUsername: string | undefined,
): boolean {
  if (!botUsername) {
    return false;
  }
  return new RegExp(buildMattermostBotMentionPattern(botUsername), "i").test(text);
}

/**
 * Strip bot mention from message text while preserving newlines and
 * block-level Markdown formatting (headings, lists, blockquotes).
 */
export function normalizeMention(text: string, mention: string | undefined): string {
  if (!mention) {
    return text.trim();
  }
  const pattern = buildMattermostBotMentionPattern(mention);
  const hasMentionRe = new RegExp(pattern, "i");
  const leadingMentionRe = new RegExp(`^([\\t ]*)${pattern}[\\t ]*`, "i");
  const trailingMentionRe = new RegExp(`[\\t ]*${pattern}[\\t ]*$`, "i");
  const normalizedLines = text.split("\n").map((line) => {
    // Lines without the mention keep their exact bytes: the whitespace collapse
    // below would otherwise destroy code-block and table alignment repo-wide.
    if (!hasMentionRe.test(line)) {
      return { text: line, mentionOnlyBlank: false };
    }
    const normalizedLine = line
      .replace(leadingMentionRe, "$1")
      .replace(trailingMentionRe, "")
      .replace(new RegExp(pattern, "gi"), "")
      .replace(/(\S)[ \t]{2,}/g, "$1 ");
    return {
      text: normalizedLine,
      mentionOnlyBlank: normalizedLine.trim() === "",
    };
  });

  while (normalizedLines[0]?.mentionOnlyBlank) {
    normalizedLines.shift();
  }
  while (normalizedLines.at(-1)?.text.trim() === "") {
    normalizedLines.pop();
  }

  return normalizedLines.map((line) => line.text).join("\n");
}

export function shouldDropEmptyMattermostBody(params: {
  bodyText: string;
  rawText: string;
  botUsername?: string | null;
}): boolean {
  if (/[^\p{White_Space}\p{Cc}\p{Cf}\p{M}]/u.test(params.bodyText)) {
    return false;
  }
  const botUsername = normalizeLowercaseStringOrEmpty(params.botUsername ?? "");
  const bareMention = params.rawText.match(/^[ \t]*(@\S+)[ \t]*$/u)?.[1];
  return !botUsername || normalizeLowercaseStringOrEmpty(bareMention ?? "") !== `@${botUsername}`;
}
