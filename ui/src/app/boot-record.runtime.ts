import { getSafeLocalStorage } from "../local-storage.ts";
import {
  BOOT_RECORD_MAX_BYTES,
  BOOT_RECORD_PREFIX,
  bootRecordGeneration,
  type BootRecord,
} from "./boot-record.ts";

let timer: ReturnType<typeof setTimeout> | undefined;
let pending: { record: BootRecord; generation: number } | undefined;

function flushBootRecord(): void {
  clearTimeout(timer);
  timer = undefined;
  const write = pending;
  pending = undefined;
  if (!write || write.generation !== bootRecordGeneration) {
    return;
  }
  const { record } = write;
  const storage = getSafeLocalStorage();
  const key = BOOT_RECORD_PREFIX + record.scope;
  try {
    const agents = {
      ...record.agents,
      agents: record.agents.agents.map((agent) => {
        const identity = agent.identity ? { ...agent.identity } : undefined;
        if (identity) {
          delete identity.avatar;
          delete identity.avatarUrl;
        }
        return { ...agent, identity };
      }),
    };
    const json = JSON.stringify({ ...record, agents });
    if (new TextEncoder().encode(json).length > BOOT_RECORD_MAX_BYTES) {
      storage?.removeItem(key);
    } else {
      storage?.setItem(key, json);
    }
  } catch {
    try {
      storage?.removeItem(key);
    } catch {}
  }
}

export function scheduleBootRecord(record: BootRecord): void {
  clearTimeout(timer);
  pending = { record, generation: bootRecordGeneration };
  timer = setTimeout(flushBootRecord, 500);
}

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", flushBootRecord);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      flushBootRecord();
    }
  });
}
