import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AgentsListResult } from "../api/types.ts";
import type { SessionGroupSettings } from "../lib/sessions/custom-groups.ts";
import { getSafeLocalStorage } from "../local-storage.ts";
import { scheduleBootRecord } from "./boot-record.runtime.ts";

export const BOOT_RECORD_PREFIX = "openclaw.control.bootRecord.v1:";
export const BOOT_RECORD_MAX_BYTES = 64 * 1024;
const BOOT_RECORD_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
export let bootRecordGeneration = 0;

export type BootRecord = {
  version: 1;
  savedAt: number;
  scope: string;
  profileId: string | null;
  agents: AgentsListResult;
  groups: SessionGroupSettings[];
  sectionOrder: string[];
};

function isBootRecord(value: unknown): value is BootRecord {
  if (!isRecord(value) || !isRecord(value.agents)) {
    return false;
  }
  const agents = value.agents;
  return (
    value.version === 1 &&
    typeof value.savedAt === "number" &&
    Number.isFinite(value.savedAt) &&
    value.savedAt >= 0 &&
    typeof value.scope === "string" &&
    (value.profileId === null || typeof value.profileId === "string") &&
    typeof agents.defaultId === "string" &&
    agents.defaultId.trim().length > 0 &&
    typeof agents.mainKey === "string" &&
    agents.mainKey.trim().length > 0 &&
    (agents.scope === "per-sender" || agents.scope === "global") &&
    Array.isArray(agents.agents) &&
    agents.agents.every((agent: unknown) => isRecord(agent) && typeof agent.id === "string") &&
    Array.isArray(value.groups) &&
    value.groups.every(
      (group: unknown) =>
        isRecord(group) && typeof group.name === "string" && typeof group.position === "number",
    ) &&
    Array.isArray(value.sectionOrder) &&
    value.sectionOrder.every((section: unknown) => typeof section === "string")
  );
}

export function readBootRecord(scope: string): BootRecord | null {
  const storage = getSafeLocalStorage();
  const key = BOOT_RECORD_PREFIX + scope;
  try {
    const json = storage?.getItem(key);
    if (json == null) {
      return null;
    }
    if (new TextEncoder().encode(json).length <= BOOT_RECORD_MAX_BYTES) {
      const record: unknown = JSON.parse(json);
      if (
        isBootRecord(record) &&
        record.scope === scope &&
        Date.now() - record.savedAt <= BOOT_RECORD_MAX_AGE
      ) {
        return record;
      }
    }
  } catch {
    // Browser storage is optional; malformed records must never prevent startup.
  }
  try {
    storage?.removeItem(key);
  } catch {}
  return null;
}

export function persistBootRecord(record: BootRecord): void {
  scheduleBootRecord(record);
}

export function clearBootRecords(): void {
  bootRecordGeneration += 1;
  try {
    const storage = getSafeLocalStorage();
    if (!storage) {
      return;
    }
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith(BOOT_RECORD_PREFIX)) {
        storage.removeItem(key);
      }
    }
  } catch {}
}
