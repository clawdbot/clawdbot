/**
 * Prepares the Watched Sessions system-prompt section (openclaw#114797).
 *
 * Ambient group watches make same-agent group sessions readable from the main
 * session, but the model only acts on that when the prompt names them. Prepare
 * runs before synchronous prompt assembly, mirroring prepareAgentMemoryPrompt.
 */
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { loadExactSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { deriveSessionTitle } from "../gateway/session-utils.js";
import { resolveSandboxSessionToolsVisibility } from "../plugin-sdk/session-visibility.js";
import { buildAgentMainSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { listAmbientGroupWatchTargets } from "../sessions/session-state-events.js";
import { sanitizeForPromptLiteral } from "./sanitize-for-prompt.js";

/** Watched-session facts resolved before synchronous prompt assembly. */
export type PreparedWatchedSessionsPrompt = {
  /** Key-sorted capped rows; deterministic bytes keep the prompt cache stable. */
  sessions: Array<{ key: string; title?: string }>;
  /** Watch targets beyond the row cap; rendered as an overflow note. */
  hiddenCount: number;
  /** Granted read tools the section may name, in render order. */
  readToolNames: string[];
  listToolAvailable: boolean;
};

// Caps prompt bytes for pathological watch counts; the render notes the overflow.
const WATCHED_SESSIONS_PROMPT_LIMIT = 20;
// Titles are external group names; clamp so one hostile rename cannot bloat the prompt.
const WATCHED_SESSION_TITLE_MAX_CHARS = 80;

const WATCHED_SESSION_READ_TOOLS = ["sessions_history", "sessions_search"];

/** Resolve watched same-agent group sessions for the current session's prompt. */
export function prepareWatchedSessionsPrompt(params: {
  enabled: boolean;
  config?: OpenClawConfig;
  sessionKey?: string;
  sandboxed?: boolean;
  toolNames: Iterable<string>;
  capabilityToolNames?: Iterable<string>;
}): PreparedWatchedSessionsPrompt | undefined {
  const sessionKey = params.sessionKey?.trim();
  if (!params.enabled || !sessionKey) {
    return undefined;
  }
  // Ambient watch cursors are written only for buildAgentMainSessionKey watchers
  // (registerMainSessionGroupWatch), so any other session key can skip the probe.
  const parsedKey = parseAgentSessionKey(sessionKey);
  if (!parsedKey || buildAgentMainSessionKey({ agentId: parsedKey.agentId }) !== sessionKey) {
    return undefined;
  }
  // Sandboxed sessions with the default "spawned" clamp list/read only spawned
  // rows, so the section would advertise reads that context cannot make. The
  // "all" clamp lifts that restriction and keeps the section.
  if (params.sandboxed && resolveSandboxSessionToolsVisibility(params.config ?? {}) === "spawned") {
    return undefined;
  }
  const availableTools = new Set(
    [...params.toolNames, ...(params.capabilityToolNames ?? [])]
      .map((tool) => tool.trim().toLowerCase())
      .filter(Boolean),
  );
  const readToolNames = WATCHED_SESSION_READ_TOOLS.filter((tool) => availableTools.has(tool));
  if (readToolNames.length === 0) {
    return undefined;
  }
  // Sorted by key, not recency: recency-ordered rows would reshuffle prompt
  // bytes on every group message and defeat provider prompt caching.
  const targets = [...listAmbientGroupWatchTargets(sessionKey)].toSorted();
  if (targets.length === 0) {
    return undefined;
  }
  const sessions = targets.slice(0, WATCHED_SESSIONS_PROMPT_LIMIT).map((key) => {
    const row: { key: string; title?: string } = { key };
    // Exact persisted-key probe: watch cursors store canonical keys, so the
    // alias-resolving loader's full-snapshot scan is wasted work here.
    const entry = loadExactSessionEntryReadOnly({ sessionKey: key, clone: false })?.entry;
    const title = deriveSessionTitle(entry);
    if (title) {
      row.title = truncateUtf16Safe(title, WATCHED_SESSION_TITLE_MAX_CHARS);
    }
    return row;
  });
  return {
    sessions,
    hiddenCount: targets.length - sessions.length,
    readToolNames,
    listToolAvailable: availableTools.has("sessions_list"),
  };
}

/** Renders the shared Watched Sessions block used by every prompt-assembly surface. */
export function buildWatchedSessionsPromptLines(
  prepared?: PreparedWatchedSessionsPrompt,
): string[] {
  if (!prepared || prepared.sessions.length === 0) {
    return [];
  }
  const listHint = prepared.listToolAvailable ? "; rows appear in sessions_list" : "";
  return [
    "## Watched Sessions",
    `Group/topic sessions this session ambiently watches. Readable now (read-only) via ${prepared.readToolNames.join("/")}${listHint}.`,
    ...prepared.sessions.map((session) => {
      const title = session.title ? ` — ${sanitizeForPromptLiteral(session.title)}` : "";
      return `- ${sanitizeForPromptLiteral(session.key)}${title}`;
    }),
    ...(prepared.hiddenCount > 0
      ? [
          prepared.listToolAvailable
            ? `(+${prepared.hiddenCount} more: sessions_list kinds=["group"].)`
            : `(+${prepared.hiddenCount} more.)`,
        ]
      : []),
    "",
  ];
}
