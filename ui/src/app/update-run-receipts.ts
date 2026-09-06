import { getSafeLocalStorage, getSafeSessionStorage } from "../local-storage.ts";

// Only browser acknowledgments live here. Run identity, progress and outcomes
// always come from the Gateway ledger, including after a bundle reload.
export function createUpdateRunReceipts() {
  const acknowledged = getSafeLocalStorage();
  const triaged = getSafeSessionStorage();
  const read = (storage: Storage | null, key: string): string[] | null => {
    try {
      const raw = storage?.getItem(key);
      if (raw === null || raw === undefined) {
        return [];
      }
      const value: unknown = raw.length < 32_768 ? JSON.parse(raw) : null;
      return Array.isArray(value) && value.every((item): item is string => typeof item === "string")
        ? value.slice(-32)
        : null;
    } catch {
      return null;
    }
  };
  const key = (kind: string) => `openclaw:control-ui:update-${kind}:v1`;
  const id = (gateway: string, profile: string | null, runId: string) =>
    JSON.stringify([gateway, profile, runId]);
  const record = (storage: Storage | null, kind: string, receipt: string) => {
    try {
      if (!storage) {
        return false;
      }
      const previous = read(storage, key(kind));
      // Unreadable history must not authorize another automatic diagnostic turn.
      if (!previous) {
        return false;
      }
      storage.setItem(key(kind), JSON.stringify([...new Set([...previous, receipt])].slice(-32)));
      return true;
    } catch {
      return false;
    }
  };
  return {
    acknowledged: (gateway: string, profile: string | null, runId: string) =>
      (read(acknowledged, key("acknowledged")) ?? []).includes(id(gateway, profile, runId)),
    acknowledge: (gateway: string, profile: string | null, runId: string) =>
      record(acknowledged, "acknowledged", id(gateway, profile, runId)),
    triaged: (gateway: string, profile: string | null, runId: string) =>
      (read(triaged, key("triaged")) ?? []).includes(id(gateway, profile, runId)),
    recordTriage: (gateway: string, profile: string | null, runId: string) =>
      record(triaged, "triaged", id(gateway, profile, runId)),
  };
}
