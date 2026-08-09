// Shared recent-session query and presentation used by the TUI and CLI resume picker.
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { formatRelativeTimestamp } from "../infra/format-time/format-relative.ts";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { TuiBackend, TuiSessionList } from "./tui-backend.js";
import {
  TUI_RECENT_SESSIONS_ACTIVE_MINUTES,
  TUI_SESSION_PICKER_LIMIT,
} from "./tui-session-list-policy.js";

type TuiSessionEntry = TuiSessionList["sessions"][number];

/** One recent session rendered consistently across interactive pickers. */
export type SessionPickerChoice = {
  value: string;
  label: string;
  description: string;
  searchText: string;
  matchText: string;
};

export type ResumeResolution =
  | { kind: "match"; session: SessionPickerChoice }
  | { kind: "ambiguous"; candidates: SessionPickerChoice[] }
  | { kind: "none" };

/** Load the same bounded recent-session window used by the TUI Ctrl+P picker. */
export async function loadRecentSessions(
  client: Pick<TuiBackend, "listSessions">,
  options: { agentId?: string; includeGlobal?: boolean } = {},
): Promise<TuiSessionEntry[]> {
  const result = await client.listSessions({
    limit: TUI_SESSION_PICKER_LIMIT,
    activeMinutes: TUI_RECENT_SESSIONS_ACTIVE_MINUTES,
    includeGlobal: options.includeGlobal ?? false,
    includeUnknown: false,
    includeDerivedTitles: true,
    includeLastMessage: true,
    ...(options.agentId ? { agentId: options.agentId } : {}),
  });
  return result.sessions;
}

/** Build labels and matching text for recent-session pickers. */
export function buildSessionChoices(sessions: readonly TuiSessionEntry[]): SessionPickerChoice[] {
  return sessions.map((session) => {
    const title = session.derivedTitle ?? session.displayName;
    const formattedKey = formatSessionKey(session.key);
    const label = title && title !== formattedKey ? `${title} (${formattedKey})` : formattedKey;
    const timePart = session.updatedAt
      ? formatRelativeTimestamp(session.updatedAt, { dateFallback: true, fallback: "" })
      : "";
    const preview = session.lastMessagePreview?.replace(/\s+/g, " ").trim();
    const description = timePart && preview ? `${timePart} · ${preview}` : (preview ?? timePart);
    const searchableNames = [
      session.derivedTitle,
      session.displayName,
      session.label,
      session.subject,
      session.sessionId,
      session.key,
    ].filter((value): value is string => Boolean(value));
    return {
      value: session.key,
      label,
      description,
      searchText: [...searchableNames, session.lastMessagePreview].filter(Boolean).join(" "),
      matchText: searchableNames.join(" "),
    };
  });
}

/** Resolve a recent session by exact key, unique substring, then TUI-style fuzzy matching. */
export function resolveResumeSession(
  sessions: readonly TuiSessionEntry[],
  query: string,
): ResumeResolution {
  const trimmedQuery = query.trim();
  const normalizedQuery = normalizeLowercaseStringOrEmpty(trimmedQuery);
  const choices = buildSessionChoices(sessions);
  const exact = choices.find((choice) => choice.value === trimmedQuery);
  if (exact) {
    return { kind: "match", session: exact };
  }

  const substringMatches = choices.filter((choice) =>
    normalizeLowercaseStringOrEmpty(choice.matchText).includes(normalizedQuery),
  );
  const substringMatch = substringMatches[0];
  if (substringMatches.length === 1 && substringMatch) {
    return { kind: "match", session: substringMatch };
  }
  if (substringMatches.length > 1) {
    return { kind: "ambiguous", candidates: substringMatches };
  }

  const fuzzyMatches = fuzzyFilter(choices, trimmedQuery, (choice) => choice.matchText);
  const fuzzyMatch = fuzzyMatches[0];
  if (fuzzyMatches.length === 1 && fuzzyMatch) {
    return { kind: "match", session: fuzzyMatch };
  }
  if (fuzzyMatches.length > 1) {
    return { kind: "ambiguous", candidates: fuzzyMatches };
  }
  return { kind: "none" };
}

function formatSessionKey(key: string): string {
  return parseAgentSessionKey(key)?.rest ?? key;
}
