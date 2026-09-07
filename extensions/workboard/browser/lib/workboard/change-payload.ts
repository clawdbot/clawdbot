import type { WorkboardChange } from "@openclaw/workboard-contract";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export function normalizeWorkboardChange(payload: unknown): WorkboardChange | null {
  if (!isRecord(payload)) {
    return null;
  }
  const epoch = payload.epoch;
  const revision = payload.revision;
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
