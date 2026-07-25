import type { WorkboardChange } from "@openclaw/workboard-contract";

export function normalizeWorkboardChange(payload: unknown): WorkboardChange | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const epoch = (payload as { epoch?: unknown }).epoch;
  const revision = (payload as { revision?: unknown }).revision;
  const keys = Object.keys(payload);
  return keys.length === 2 &&
    keys.includes("epoch") &&
    keys.includes("revision") &&
    typeof epoch === "string" &&
    epoch.length > 0 &&
    epoch.length <= 128 &&
    typeof revision === "number" &&
    Number.isSafeInteger(revision) &&
    revision > 0
    ? { epoch, revision }
    : null;
}
