// Mattermost helper module supports monitor helpers behavior.
import { formatInboundFromLabel as formatInboundFromLabelShared } from "openclaw/plugin-sdk/channel-inbound";
import { resolveThreadSessionKeys as resolveThreadSessionKeysShared } from "openclaw/plugin-sdk/routing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
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

// Mattermost usernames match ^[a-z0-9.\-_]+$ (server model/user.go), so "." and
// "-" are username characters, not boundaries. \b or a bare substring check makes
// "@claw" match inside "@claw.dia"/"@clawdia"/"bob@claw.com" — waking the bot on
// other users' mentions and stripping fragments out of their handles.
const MATTERMOST_USERNAME_BOUNDARY_BEFORE = "(?<![a-z0-9._-])";
const MATTERMOST_USERNAME_BOUNDARY_AFTER = "(?![a-z0-9._-])";

function escapeMentionPattern(mention: string): string {
  return mention.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchesMattermostBotMention(
  text: string,
  botUsername: string | undefined,
): boolean {
  if (!botUsername) {
    return false;
  }
  const pattern = `${MATTERMOST_USERNAME_BOUNDARY_BEFORE}@${escapeMentionPattern(botUsername)}${MATTERMOST_USERNAME_BOUNDARY_AFTER}`;
  return new RegExp(pattern, "i").test(text);
}

/**
 * Strip bot mention from message text while preserving newlines and
 * block-level Markdown formatting (headings, lists, blockquotes).
 */
export function normalizeMention(text: string, mention: string | undefined): string {
  if (!mention) {
    return text.trim();
  }
  const escaped = escapeMentionPattern(mention);
  const after = MATTERMOST_USERNAME_BOUNDARY_AFTER;
  const before = MATTERMOST_USERNAME_BOUNDARY_BEFORE;
  const hasMentionRe = new RegExp(`${before}@${escaped}${after}`, "i");
  const leadingMentionRe = new RegExp(`^([\\t ]*)@${escaped}${after}[\\t ]*`, "i");
  const trailingMentionRe = new RegExp(`[\\t ]*${before}@${escaped}${after}[\\t ]*$`, "i");
  const normalizedLines = text.split("\n").map((line) => {
    // Lines without the mention keep their exact bytes: the whitespace collapse
    // below would otherwise destroy code-block and table alignment repo-wide.
    if (!hasMentionRe.test(line)) {
      return { text: line, mentionOnlyBlank: false };
    }
    const normalizedLine = line
      .replace(leadingMentionRe, "$1")
      .replace(trailingMentionRe, "")
      .replace(new RegExp(`${before}@${escaped}${after}`, "gi"), "")
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
