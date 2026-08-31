import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { SessionArchiveVisibility } from "./session-capability.ts";

type ConfirmedArchiveState = Pick<GatewaySessionRow, "archivedAt" | "archivedBy" | "sessionId">;

export function createSessionArchiveState(
  publishedRow: (key: string) => GatewaySessionRow | undefined,
  onChange: () => void,
) {
  const confirmed = new Map<string, ConfirmedArchiveState>();
  const pending = new Set<string>();
  const clear = (key: string) => {
    confirmed.delete(key.trim());
    pending.delete(key.trim());
  };
  return {
    clear,
    clearAll: () => {
      confirmed.clear();
      pending.clear();
    },
    observe: (key: string, archived: boolean | null, row?: GatewaySessionRow): void => {
      const normalizedKey = key.trim();
      if (!normalizedKey || archived === null) {
        return;
      }
      if (!archived) {
        clear(normalizedKey);
        return;
      }
      const previous = confirmed.get(normalizedKey);
      confirmed.set(normalizedKey, {
        archivedAt: row?.archivedAt ?? previous?.archivedAt,
        archivedBy: row?.archivedBy ?? previous?.archivedBy,
        sessionId: row?.sessionId || previous?.sessionId,
      });
    },
    apply: (result: SessionsListResult | null): SessionsListResult | null => {
      if (!result || confirmed.size === 0) {
        return result;
      }
      let changed = false;
      const sessions = result.sessions.map((row) => {
        const archive = confirmed.get(row.key);
        if (!archive) {
          return row;
        }
        if (archive.sessionId && archive.sessionId !== row.sessionId) {
          // An id-less row may be a same-key replacement whose identity has not arrived.
          // Do not transfer archive state; retire it only after a different identity appears.
          if (row.sessionId) {
            confirmed.delete(row.key);
          }
          return row;
        }
        if (row.archived === true) {
          return row;
        }
        changed = true;
        return {
          ...row,
          archived: true,
          ...(archive.archivedAt !== undefined ? { archivedAt: archive.archivedAt } : {}),
          ...(archive.archivedBy ? { archivedBy: archive.archivedBy } : {}),
        };
      });
      return changed ? { ...result, sessions } : result;
    },
    visibility: (key: string): SessionArchiveVisibility | undefined => {
      const normalizedKey = key.trim();
      if (pending.has(normalizedKey)) {
        return "pending";
      }
      const archive = confirmed.get(normalizedKey);
      if (!archive) {
        return undefined;
      }
      const row = publishedRow(normalizedKey);
      // Share the archive confirmation with event-driven actions, but never
      // hide a same-key replacement whose durable identity does not match.
      return archive.sessionId && row && archive.sessionId !== row.sessionId
        ? undefined
        : "archived";
    },
    setPending: (key: string, active: boolean) => {
      const normalizedKey = key.trim();
      if (!normalizedKey || pending.has(normalizedKey) === active) {
        return;
      }
      if (active) {
        pending.add(normalizedKey);
      } else {
        pending.delete(normalizedKey);
      }
      onChange();
    },
  };
}
