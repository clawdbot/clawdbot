// Session ids deliberately use per-tab storage: attach is a takeover, so shared
// local storage could let one Control UI window steal another window's shells.

import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  TerminalPanelAction,
  TerminalPanelCatalogReference,
  TerminalPanelSessionTab,
} from "./terminal-panel-session-types.ts";

const TERMINAL_SESSIONS_KEY = "openclaw.terminal.sessions.v1";
const TERMINAL_ACTIONS_KEY = "openclaw.terminal.actions.v1";

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function catalogReference(value: unknown): TerminalPanelCatalogReference | null {
  if (!isRecord(value)) {
    return null;
  }
  return nonEmptyString(value.catalogId) &&
    nonEmptyString(value.hostId) &&
    nonEmptyString(value.threadId)
    ? {
        catalogId: value.catalogId,
        hostId: value.hostId,
        threadId: value.threadId,
      }
    : null;
}

function terminalAction(value: unknown): TerminalPanelAction | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.kind === "attach") {
    return nonEmptyString(value.sessionId) && typeof value.agentOwned === "boolean"
      ? {
          kind: "attach",
          sessionId: value.sessionId,
          agentOwned: value.agentOwned,
        }
      : null;
  }
  const agentId = value.agentId;
  if (agentId !== null && !nonEmptyString(agentId)) {
    return null;
  }
  if (value.kind === "restore" || value.kind === "open") {
    return { kind: value.kind, agentId };
  }
  if (value.kind === "catalog") {
    const catalog = catalogReference(value.catalog);
    return catalog ? { kind: "catalog", agentId, catalog } : null;
  }
  return null;
}

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

function persistTerminalSessionIds(ids: readonly string[]): void {
  try {
    globalThis.sessionStorage?.setItem(TERMINAL_SESSIONS_KEY, JSON.stringify(ids));
  } catch {
    // Storage may be unavailable (private mode); reattach just won't work.
  }
}

export function persistLiveTerminalSessions(tabs: readonly TerminalPanelSessionTab[]): void {
  persistTerminalSessionIds(
    tabs
      .filter((tab) => tab.status === "live" && tab.gatewaySessionId)
      .map((tab) => tab.gatewaySessionId),
  );
}

export function loadPersistedTerminalActions(): TerminalPanelAction[] {
  try {
    const raw = globalThis.sessionStorage?.getItem(TERMINAL_ACTIONS_KEY);
    if (!raw) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.flatMap((value) => {
          const action = terminalAction(value);
          return action ? [action] : [];
        })
      : [];
  } catch {
    return [];
  }
}

export function persistTerminalActions(actions: readonly TerminalPanelAction[]): void {
  try {
    if (actions.length === 0) {
      globalThis.sessionStorage?.removeItem(TERMINAL_ACTIONS_KEY);
      return;
    }
    globalThis.sessionStorage?.setItem(TERMINAL_ACTIONS_KEY, JSON.stringify(actions));
  } catch {
    // In-memory replay still covers an unchanged document when storage is unavailable.
  }
}
