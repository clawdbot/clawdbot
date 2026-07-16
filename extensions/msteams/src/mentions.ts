/**
 * MS Teams mention handling utilities.
 *
 * Mentions in Teams require:
 * 1. Text containing <at>Name</at> tags
 * 2. entities array with mention metadata
 */

export type MentionEntity = {
  type: "mention";
  text: string;
  mentioned: {
    id: string;
    name: string;
  };
};

export type MentionInfo = {
  /** User/bot ID (e.g., "28:xxx" or AAD object ID) */
  id: string;
  /** Display name */
  name: string;
};

/**
 * Check whether an ID looks like a valid Teams user/bot identifier.
 * Accepts:
 * - Bot Framework IDs: "28:xxx..." / "29:xxx..." / "8:orgid:..."
 * - AAD object IDs (UUIDs): "d5318c29-33ac-4e6b-bd42-57b8b793908f"
 *
 * Keep this permissive enough for real Teams IDs while still rejecting
 * documentation placeholders like `@[表示名](ユーザーID)`.
 */
const TEAMS_BOT_ID_PATTERN = /^\d+:[a-z0-9._=-]+(?::[a-z0-9._=-]+)*$/i;
const AAD_OBJECT_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function isValidTeamsId(id: string): boolean {
  return TEAMS_BOT_ID_PATTERN.test(id) || AAD_OBJECT_ID_PATTERN.test(id);
}

/**
 * Parse mentions from text in the format @[Name](id).
 * Example: "Hello @[John Doe](28:xxx-yyy-zzz)!"
 *
 * Only matches where the id looks like a real Teams user/bot ID are treated
 * as mentions. This avoids false positives from documentation or code samples
 * embedded in the message (e.g. `@[表示名](ユーザーID)` in backticks).
 *
 * Returns both the formatted text with <at> tags and the entities array.
 */
export function parseMentions(text: string): {
  text: string;
  entities: MentionEntity[];
} {
  const mentionPattern = /@\[([^\]]+)\]\(([^)]+)\)/g;
  const entities: MentionEntity[] = [];

  // Replace @[Name](id) with <at>Name</at> only for valid Teams IDs
  const formattedText = text.replace(mentionPattern, (match, name, id) => {
    const trimmedId = id.trim();

    // Skip matches where the id doesn't look like a real Teams identifier
    if (!isValidTeamsId(trimmedId)) {
      return match;
    }

    const trimmedName = name.trim();
    const mentionTag = `<at>${trimmedName}</at>`;
    entities.push({
      type: "mention",
      text: mentionTag,
      mentioned: {
        id: trimmedId,
        name: trimmedName,
      },
    });
    return mentionTag;
  });

  return {
    text: formattedText,
    entities,
  };
}

/**
 * Build mention entities array from a list of mentions.
 * Use this when you already have the mention info and formatted text.
 */
export function buildMentionEntities(mentions: MentionInfo[]): MentionEntity[] {
  return mentions.map((mention) => ({
    type: "mention",
    text: `<at>${mention.name}</at>`,
    mentioned: {
      id: mention.id,
      name: mention.name,
    },
  }));
}

/**
 * Format text with mentions using <at> tags.
 * This is a convenience function when you want to manually format mentions.
 */
export function formatMentionText(text: string, mentions: MentionInfo[]): string {
  let formatted = text;
  for (const mention of mentions) {
    // Replace @Name or @name with <at>Name</at>
    const escapedName = mention.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const namePattern = new RegExp(`@${escapedName}`, "gi");
    formatted = formatted.replace(namePattern, `<at>${mention.name}</at>`);
  }
  return formatted;
}
