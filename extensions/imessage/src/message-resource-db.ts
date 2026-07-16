// Imessage plugin module verifies provider message ownership in the local Messages database.
import { createRequire } from "node:module";
import { isIMessageEmailChatIdentifier, type IMessageChatContext } from "./chat-context.js";
import { resolveLocalIMessageChatDbPath } from "./cli-path.js";

const require = createRequire(import.meta.url);

type IMessageResourceBinding = "match" | "mismatch" | "unavailable";
type IMessageChatRow = {
  chatGuid: unknown;
  chatId: unknown;
  chatIdentifier: unknown;
};

export function normalizeIMessageMessageGuidForLookup(messageId: string): string {
  const trimmed = messageId.trim();
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 && slash + 1 < trimmed.length ? trimmed.slice(slash + 1) : trimmed;
}

function chatGuidCandidates(raw: string | undefined): string[] {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return [];
  }
  const ordered = [trimmed];
  const parts = trimmed.split(";");
  const service = parts[0]?.toLowerCase();
  const kind = parts[1];
  const identifier = parts[2];
  if (parts.length === 3 && (kind === "+" || kind === "-") && identifier) {
    if (service === "any") {
      ordered.push(`iMessage;${kind};${identifier}`, `SMS;${kind};${identifier}`);
    } else if (service === "imessage") {
      ordered.push(`iMessage;${kind};${identifier}`, `any;${kind};${identifier}`);
    } else if (service === "sms") {
      ordered.push(`SMS;${kind};${identifier}`, `any;${kind};${identifier}`);
    }
  }
  return [...new Set(ordered)];
}

function chatIdentifierCandidates(raw: string | undefined): string[] {
  const trimmed = raw?.trim();
  if (!trimmed) {
    return [];
  }
  const parts = trimmed.split(";");
  const service = parts[0]?.toLowerCase();
  const hasKnownPrefix = service === "imessage" || service === "sms" || service === "any";
  const hasKnownKind = parts[1] === "+" || parts[1] === "-";
  const bareIdentifier =
    parts.length === 3 && hasKnownPrefix && hasKnownKind ? parts[2] : undefined;
  return [...new Set([trimmed, ...(bareIdentifier ? [bareIdentifier] : [])])];
}

function isKnownChatGuid(raw: string | undefined): raw is string {
  const parts = raw?.trim().split(";");
  if (!parts || parts.length !== 3 || (parts[1] !== "+" && parts[1] !== "-") || !parts[2]) {
    return false;
  }
  const service = parts[0]?.toLowerCase();
  return service === "imessage" || service === "sms" || service === "any";
}

function matchesChatCandidate(stored: string, candidate: string): boolean {
  if (stored === candidate) {
    return true;
  }
  return (
    isIMessageEmailChatIdentifier(stored) &&
    isIMessageEmailChatIdentifier(candidate) &&
    stored.toLowerCase() === candidate.toLowerCase()
  );
}

function matchesAnyChatCandidate(stored: unknown, candidates: string[]): boolean {
  if (typeof stored !== "string") {
    return false;
  }
  return candidates.some((candidate) => matchesChatCandidate(stored, candidate));
}

function loadNodeSqlite(): typeof import("node:sqlite") | null {
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } catch {
    return null;
  }
}

export function checkIMessageResourceBinding(params: {
  chatContext: IMessageChatContext;
  cliPath: string;
  dbPath?: string;
  messageId: string;
  remoteHost?: string;
}): IMessageResourceBinding {
  const dbPath = resolveLocalIMessageChatDbPath(params);
  const sqlite = loadNodeSqlite();
  if (!dbPath || !sqlite) {
    return "unavailable";
  }
  const messageGuid = normalizeIMessageMessageGuidForLookup(params.messageId);
  if (!messageGuid) {
    return "mismatch";
  }
  const expectedChatGuids = chatGuidCandidates(params.chatContext.chatGuid);
  const expectedChatIdentifiers = chatIdentifierCandidates(params.chatContext.chatIdentifier);
  const identifierChatGuids = isKnownChatGuid(params.chatContext.chatIdentifier)
    ? chatGuidCandidates(params.chatContext.chatIdentifier)
    : [];
  const chatId = params.chatContext.chatId;
  const hasChatId = typeof chatId === "number" && Number.isSafeInteger(chatId) && chatId > 0;
  if (
    !hasChatId &&
    expectedChatGuids.length === 0 &&
    expectedChatIdentifiers.length === 0 &&
    identifierChatGuids.length === 0
  ) {
    return "unavailable";
  }

  let db: import("node:sqlite").DatabaseSync | undefined;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT cmj.chat_id AS chatId,
                c.guid AS chatGuid,
                c.chat_identifier AS chatIdentifier
         FROM message m
         JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
         JOIN chat c ON c.ROWID = cmj.chat_id
         WHERE m.guid = ?`,
      )
      .all(messageGuid) as unknown as IMessageChatRow[];
    const matched = rows.some(
      (row) =>
        (!hasChatId || row.chatId === chatId) &&
        (expectedChatGuids.length === 0 ||
          matchesAnyChatCandidate(row.chatGuid, expectedChatGuids)) &&
        (expectedChatIdentifiers.length === 0 ||
          matchesAnyChatCandidate(row.chatIdentifier, expectedChatIdentifiers)) &&
        (identifierChatGuids.length === 0 ||
          matchesAnyChatCandidate(row.chatGuid, identifierChatGuids)),
    );
    return matched ? "match" : "mismatch";
  } catch {
    return "unavailable";
  } finally {
    try {
      db?.close();
    } catch {
      // Best-effort cleanup after a read-only authorization query.
    }
  }
}
