import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getSafeLocalStorage, getSafeSessionStorage } from "../local-storage.ts";

// Only browser acknowledgments live here. Run identity, progress and outcomes
// always come from the Gateway ledger, including after a bundle reload.
type ReceiptKind = "acknowledged" | "triaged";
const TRIAGED_KEY = "openclaw:control-ui:update:v1";
const ARRAY_TRIAGED_KEY = "openclaw:control-ui:update-triaged:v1";

export function createUpdateRunReceipts() {
  const acknowledged = getSafeLocalStorage();
  const triaged = getSafeSessionStorage();
  const key = (kind: ReceiptKind) =>
    kind === "triaged" ? TRIAGED_KEY : "openclaw:control-ui:update-acknowledged:v1";
  const read = (storage: Storage | null, storageKey: string): string[] | null => {
    try {
      const raw = storage?.getItem(storageKey);
      if (raw === null || raw === undefined) {
        return [];
      }
      // v2026.9.1 shipped tab-scoped triage receipts in this object and size bound.
      const objectFormat = storageKey === TRIAGED_KEY;
      const limit = objectFormat ? 4_096 * 33 : 32_768 - 1;
      const saved: unknown = raw.length <= limit ? JSON.parse(raw) : null;
      const value = objectFormat
        ? isRecord(saved)
          ? saved.triaged === undefined
            ? []
            : saved.triaged
          : null
        : saved;
      return Array.isArray(value) && value.every((item): item is string => typeof item === "string")
        ? value.slice(-32)
        : null;
    } catch {
      return null;
    }
  };
  const readTriage = () => {
    // Both 2026.9.1's object and 2026.9.2's array are shipped tab receipt formats.
    const previous = read(triaged, TRIAGED_KEY);
    const newer = read(triaged, ARRAY_TRIAGED_KEY);
    return previous && newer ? [...new Set([...previous, ...newer])].slice(-32) : null;
  };
  const id = (gateway: string, profile: string | null, runId: string) =>
    JSON.stringify([gateway, profile, runId]);
  const record = (storage: Storage | null, kind: ReceiptKind, receipt: string) => {
    try {
      if (!storage) {
        return false;
      }
      const previous = kind === "triaged" ? readTriage() : read(storage, key(kind));
      // Unreadable history must not authorize another automatic diagnostic turn.
      if (!previous) {
        return false;
      }
      const receipts = [...new Set([...previous, receipt])].slice(-32);
      storage.setItem(
        key(kind),
        JSON.stringify(kind === "triaged" ? { triaged: receipts } : receipts),
      );
      if (kind === "triaged") {
        storage.removeItem(ARRAY_TRIAGED_KEY);
      }
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
      (readTriage() ?? []).includes(id(gateway, profile, runId)),
    recordTriage: (gateway: string, profile: string | null, runId: string) =>
      record(triaged, "triaged", id(gateway, profile, runId)),
  };
}
