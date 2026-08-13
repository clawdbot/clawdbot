// Session ids deliberately use per-tab storage: attach is a takeover, so shared
// local storage could let one Control UI window steal another window's shells.

const TERMINAL_SESSIONS_KEY = "openclaw.terminal.sessions.v1";

export function loadPersistedTerminalSessionIds(): string[] {
  try {
    const raw = globalThis.sessionStorage?.getItem(TERMINAL_SESSIONS_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string" && id.length > 0)
      : [];
  } catch {
    return [];
  }
}

export function persistTerminalSessionIds(ids: readonly string[]): void {
  try {
    globalThis.sessionStorage?.setItem(TERMINAL_SESSIONS_KEY, JSON.stringify(ids));
  } catch {
    // Storage may be unavailable (private mode); reattach just won't work.
  }
}
