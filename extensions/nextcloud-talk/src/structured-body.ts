import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { resolveNextcloudTalkBotActorId } from "./webhook-url.js";

type NextcloudTalkMentionEntry = {
  key: string;
  type?: string;
  id?: string;
  mentionId?: string;
  name?: string;
};

type ParsedNextcloudTalkBody = {
  /** Human-readable text with `{mentionN}` placeholders stripped or substituted. */
  text: string;
  /** User-authored text for command parsing, without rich-object metadata. */
  commandText: string;
  /** True when the original message was structured JSON (as opposed to plain text). */
  structured: boolean;
  mentionEntries: NextcloudTalkMentionEntry[];
};

export function parseStructuredNextcloudTalkBody(
  raw: string,
  botIds?: ReadonlySet<string>,
): ParsedNextcloudTalkBody {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) {
    return { text: raw, commandText: raw, structured: false, mentionEntries: [] };
  }

  try {
    const parsed = JSON.parse(trimmed) as {
      message?: unknown;
      parameters?: Record<
        string,
        {
          type?: unknown;
          id?: unknown;
          name?: unknown;
          "mention-id"?: unknown;
          mentionId?: unknown;
        }
      >;
    };
    const rawMessage = typeof parsed.message === "string" ? parsed.message : raw;
    const parameters =
      parsed.parameters && typeof parsed.parameters === "object" ? parsed.parameters : {};
    const mentionEntries = Object.entries(parameters)
      .filter(([key]) => rawMessage.includes(`{${key}}`))
      .map(([key, value]) => ({
        key,
        type: typeof value?.type === "string" ? value.type : undefined,
        id: typeof value?.id === "string" ? value.id : undefined,
        mentionId:
          typeof value?.["mention-id"] === "string"
            ? value["mention-id"]
            : typeof value?.mentionId === "string"
              ? value.mentionId
              : undefined,
        name: typeof value?.name === "string" ? value.name : undefined,
      }));
    const botMentionKeys = new Set(
      mentionEntries
        .filter((entry) => {
          const isUser = (entry.type ?? "").toLowerCase() === "user";
          return (
            isUser &&
            botIds !== undefined &&
            [entry.id, entry.mentionId]
              .filter((value): value is string =>
                Boolean(typeof value === "string" && value.trim()),
              )
              .some((value) => botIds.has(value.trim().toLowerCase()))
          );
        })
        .map((entry) => entry.key),
    );
    // Strip the bot's own mention placeholder so agent dispatch sees clean
    // text. Preserve other rich objects with the text shown in the chat UI.
    const text = mentionEntries
      .reduce((acc, entry) => {
        const replacement = botMentionKeys.has(entry.key) ? "" : (entry.name ?? "");
        return acc.replaceAll(`{${entry.key}}`, () => replacement);
      }, rawMessage)
      .trim();
    // Rich-object names are server-provided metadata. Use a neutral marker for
    // non-bot objects so neither their names nor their removal can form a command.
    const commandText = mentionEntries
      .reduce(
        (acc, entry) =>
          acc.replaceAll(`{${entry.key}}`, () => (botMentionKeys.has(entry.key) ? "" : "_")),
        rawMessage,
      )
      .trim();
    return { text, commandText, structured: true, mentionEntries };
  } catch {
    return { text: raw, commandText: raw, structured: false, mentionEntries: [] };
  }
}

export function resolveExplicitNextcloudTalkMention(params: {
  mentionEntries: NextcloudTalkMentionEntry[];
  account: ResolvedNextcloudTalkAccount;
}): boolean {
  const expectedIds = new Set([resolveNextcloudTalkBotActorId(params.account.config)]);
  return params.mentionEntries.some((entry) => {
    if ((entry.type ?? "").toLowerCase() !== "user") {
      return false;
    }
    const candidates = [entry.id, entry.mentionId]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.trim().toLowerCase());
    return candidates.some((candidate) => expectedIds.has(candidate));
  });
}
